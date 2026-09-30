import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DealFlowConfig } from '../config/config';
import { BusinessError, classifyError } from '../errors';
import type { StructuredLogger } from '../observability/logger';
import type { RuntimeMetrics } from '../observability/metrics';
import type { AuditLogStore, DealStateStore, ExceptionQueueStore, LeadStateStore, PendingActionStore } from '../stores/interfaces';
import type { WorkflowEngine } from '../workflow/engine';
import { bearerTokenMatches } from './auth';
import type { RateLimiter } from './rate-limit';
import { errorMessage, readJsonBody, sendJson } from './respond';

/**
 * 控制面入口：人工审核、控制操作与只读查询。
 *
 * 没有它，Human Review 分支在真实服务里是死路：`WorkflowEngine.approve/reject` 只存在于进程内，
 * 外部系统无法推进 `needs_review` 的流程，异常队列也只能靠直连数据库处理。
 *
 * 路由：
 * - `GET  /workflows` / `GET /workflows/:id`：实例查询（含待审批动作，供审核界面取 action_id）
 * - `POST /workflows/:id/approve`：批准待审核动作并交给 Executor（动作已失效时改为重新规划）
 * - `POST /workflows/:id/reject`：拒绝并基于新约束重新规划
 * - `POST /workflows/:id/replan`：作废待审动作，按当前事实重新规划（不做批准/拒绝的结论）
 * - `POST /workflows/:id/cancel`：取消实例
 * - `POST /workflows/:id/retry`：重试失败实例（分类与 submitted 规则由引擎判定）
 * - `GET  /leads` / `GET /leads/:id`：销售读端点，按负责人/状态查看线索当前事实
 * - `GET  /deals` / `GET /deals/:id`：销售读端点，按负责人/阶段/线索查看商机当前事实
 * - `GET  /audit`：只追加审计日志查询
 * - `GET  /exceptions` / `POST /exceptions/:id/resolve` / `POST /exceptions/:id/discard`
 *
 * 与 Webhook 的区别：控制面是内部运维接口，不做 HMAC 签名校验，但必须配置 Bearer Token；
 * 未配置任何 Token 时控制面默认**关闭**（返回 404），避免无鉴权的审批入口被暴露。
 */
export interface ControlPlaneDeps {
  readonly engine: WorkflowEngine;
  readonly audit_log: AuditLogStore;
  readonly exception_queue: ExceptionQueueStore;
  readonly pending_action_store: PendingActionStore;
  /**
   * 销售读端点的数据来源：State 只存当前事实，`GET /leads` / `GET /deals`
   * 直接读 Lead / Deal 的当前状态，不从事件流或 Workflow 实例反推。
   */
  readonly lead_store: LeadStateStore;
  readonly deal_store: DealStateStore;
  readonly config: DealFlowConfig;
  readonly metrics?: RuntimeMetrics;
  /** 未识别异常的归宿：客户端只拿到通用文案，真实原因进日志。 */
  readonly logger?: StructuredLogger;
  /**
   * 控制面独立限流桶。审批/取消/重试都是有副作用的写接口，
   * 不限流意味着拿到 token 的人可以无限次重放审批；与 webhook 共用一个桶
   * 又会让 webhook 突发把审批入口一起打成 429，所以必须分开。
   */
  readonly rate_limiter?: RateLimiter;
}

export type ControlPlaneHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  /** 由 Webhook 入口解析出的来源 key（已按 `trust_proxy_headers` 决定是否采用代理头）。 */
  clientKey: string,
) => Promise<boolean>;

interface Route {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly handle: (context: RouteContext) => Promise<void>;
}

/**
 * 列表查询的默认与最大页大小。
 * 审计与 Workflow 都会长期累积，未加限制的 `GET /audit` 会把整张表构造成 JSON，
 * 控制面自己是运维接口，不能成为内存与延迟的风险点。
 */
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1_000;

interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: readonly string[];
  readonly url: URL;
  readonly deps: ControlPlaneDeps;
}

const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/workflows$/, handle: listWorkflows },
  { method: 'GET', pattern: /^\/workflows\/([^/]+)$/, handle: getWorkflow },
  { method: 'POST', pattern: /^\/workflows\/([^/]+)\/approve$/, handle: approve },
  { method: 'POST', pattern: /^\/workflows\/([^/]+)\/reject$/, handle: reject },
  { method: 'POST', pattern: /^\/workflows\/([^/]+)\/replan$/, handle: replan },
  { method: 'POST', pattern: /^\/workflows\/([^/]+)\/cancel$/, handle: cancel },
  { method: 'POST', pattern: /^\/workflows\/([^/]+)\/retry$/, handle: retry },
  { method: 'POST', pattern: /^\/workflows\/([^/]+)\/reconcile$/, handle: reconcile },
  { method: 'GET', pattern: /^\/leads$/, handle: listLeads },
  { method: 'GET', pattern: /^\/leads\/([^/]+)$/, handle: getLead },
  { method: 'GET', pattern: /^\/deals$/, handle: listDeals },
  { method: 'GET', pattern: /^\/deals\/([^/]+)$/, handle: getDeal },
  { method: 'GET', pattern: /^\/audit$/, handle: listAudit },
  { method: 'GET', pattern: /^\/exceptions$/, handle: listExceptions },
  { method: 'POST', pattern: /^\/exceptions\/([^/]+)\/resolve$/, handle: resolveException },
  { method: 'POST', pattern: /^\/exceptions\/([^/]+)\/discard$/, handle: discardException },
  { method: 'POST', pattern: /^\/exceptions\/([^/]+)\/replay$/, handle: replayException },
];

export function createControlPlaneHandler(deps: ControlPlaneDeps): ControlPlaneHandler {
  const token = deps.config.control_plane.bearer_token ?? deps.config.webhook.bearer_token;
  const enabled = deps.config.control_plane.enabled;

  return async (req, res, url, clientKey) => {
    // 没有任何 Token 时不暴露控制面：审批入口不能是「默认无鉴权」的。
    if (!enabled || token === null) {
      return false;
    }

    const method = req.method === 'GET' || req.method === 'POST' ? req.method : null;
    if (method === null) {
      return false;
    }

    const matched = ROUTES.find(
      (route) => route.method === method && route.pattern.test(url.pathname),
    );

    if (matched === undefined) {
      return false;
    }

    /**
     * 限流必须排在鉴权**之前**：否则暴力猜 token 的请求根本不计数，
     * 猜测速度只受网络延迟限制。放在路由匹配之后则保证未匹配路径不消耗配额。
     */
    const decision = deps.rate_limiter?.check(clientKey);
    if (decision !== undefined && !decision.allowed) {
      deps.metrics?.recordAction('rate_limited');
      sendJson(res, 429, { error: 'rate limited' }, {
        'retry-after': String(decision.retry_after_seconds),
        'x-ratelimit-limit': String(decision.limit),
        'x-ratelimit-remaining': '0',
      });
      return true;
    }

    if (!bearerTokenMatches(req.headers.authorization, token)) {
      deps.metrics?.recordAction('unauthorized');
      sendJson(res, 401, { error: 'unauthorized' }, {
        ...(decision === undefined ? {} : { 'x-ratelimit-remaining': String(decision.remaining) }),
      });
      return true;
    }

    const params = matched.pattern.exec(url.pathname)?.slice(1) ?? [];

    try {
      await matched.handle({ req, res, params, url, deps });
    } catch (error) {
      /**
       * 业务拒绝回 4xx + 原因；未识别异常（SQLite busy、TypeError…）按服务端故障回 500 +
       * 通用文案，原因只进日志。一律回 409 会让真实故障伪装成「业务冲突」，
       * 客户端照着重试逻辑处理永远不会成功，同时把内部错误文本泄露出去。
       */
      const failure = classifyError(error);
      deps.metrics?.recordAction('failed');
      deps.logger?.log('error', 'control_plane.failed', {
        method: req.method ?? 'UNKNOWN',
        path: url.pathname,
        status: failure.status,
        error: errorMessage(error),
      });
      sendJson(res, failure.status, { error: failure.message });
    }

    return true;
  };
}

async function listWorkflows({ res, url, deps }: RouteContext): Promise<void> {
  const status = url.searchParams.get('status');
  const limit = parseLimit(url.searchParams.get('limit'));
  // 多取一条用于判断 has_more：limit/offset 与状态过滤都下推到存储层，
  // 否则每次翻页都要物化全部实例再在内存里截断。
  const rows = deps.engine.listWorkflows({
    ...(status === null ? {} : { status }),
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((workflow) => summarize(workflow, deps));

  deps.metrics?.recordAction('list_workflows');
  sendJson(res, 200, {
    items,
    count: items.length,
    total: deps.engine.countWorkflows(status ?? undefined),
    has_more: hasMore,
    limit,
  });
}

async function getWorkflow({ res, params, deps }: RouteContext): Promise<void> {
  const workflow = deps.engine.getWorkflow(params[0]!);
  if (workflow === undefined) {
    sendJson(res, 404, { error: 'workflow not found' });
    return;
  }

  deps.metrics?.recordAction('get_workflow');
  sendJson(res, 200, summarize(workflow, deps));
}

function summarize(
  workflow: ReturnType<WorkflowEngine['listWorkflows']>[number],
  deps: ControlPlaneDeps,
): Record<string, unknown> {
  const pending = deps.pending_action_store.getPending(workflow.workflow_instance_id);

  return {
    workflow_instance_id: workflow.workflow_instance_id,
    workflow_type: workflow.workflow_type,
    subject_type: workflow.subject_type,
    subject_id: workflow.subject_id,
    status: workflow.status,
    current_step: workflow.current_step,
    awaiting_event_types: workflow.awaiting_event_types,
    plan_version: workflow.plan_version,
    failure_classification: workflow.failure_classification,
    failure_submitted: workflow.failure_submitted,
    failure_retry_after: workflow.failure_retry_after,
    updated_at: workflow.updated_at,
    // 对外语义是「这条建议现在是否需要人工批准」，取 Policy 的有效结论：
    // 实例停在 needs_review 就说明 Policy 判了 Human Review；Decider 的草案标记只在
    // 「被人工拒绝后重新提出」时为 true，不能回答这个问题（见 docs/operations.md 第 4 节）。
    pending_action:
      pending === undefined
        ? null
        : {
            ...pending.action,
            requires_approval: pending.action.requires_approval || workflow.status === 'needs_review',
          },
  };
}

/**
 * 销售读端点：线索与商机是销售每天要看的当前事实（谁负责、到哪一步、多少钱）。
 *
 * 过滤与分页在控制面内存里完成：这些是人发起的低频查询，不值得为它给 `StateStore`
 * 增加按字段查询的接口；事件处理路径上的热读（`#context` 反查 Deal 阶段）仍然
 * 走存储层索引，见 `stores/interfaces.ts` 的 `DealStateStore`。
 */
async function listLeads({ res, url, deps }: RouteContext): Promise<void> {
  const owner = url.searchParams.get('owner_id');
  const status = url.searchParams.get('status');
  const paging = pagingFrom(url);

  const matched = deps.lead_store.list().filter((lead) =>
    (owner === null || lead.owner_id === owner) && (status === null || lead.status === status));

  sendPage(res, deps, 'list_leads', matched, paging);
}

async function getLead({ res, params, deps }: RouteContext): Promise<void> {
  const lead = deps.lead_store.get(params[0]!);
  if (lead === undefined) {
    sendJson(res, 404, { error: 'lead not found' });
    return;
  }

  deps.metrics?.recordAction('get_lead');
  sendJson(res, 200, lead);
}

async function listDeals({ res, url, deps }: RouteContext): Promise<void> {
  const owner = url.searchParams.get('owner_id');
  const stage = url.searchParams.get('stage');
  const leadId = url.searchParams.get('lead_id');
  const paging = pagingFrom(url);

  const matched = deps.deal_store.list().filter((deal) =>
    (owner === null || deal.owner_id === owner)
    && (stage === null || deal.stage === stage)
    && (leadId === null || deal.lead_id === leadId));

  sendPage(res, deps, 'list_deals', matched, paging);
}

async function getDeal({ res, params, deps }: RouteContext): Promise<void> {
  const deal = deps.deal_store.get(params[0]!);
  if (deal === undefined) {
    sendJson(res, 404, { error: 'deal not found' });
    return;
  }

  deps.metrics?.recordAction('get_deal');
  sendJson(res, 200, deal);
}

interface PageOptions {
  readonly limit: number;
  readonly offset: number;
}

function pagingFrom(url: URL): PageOptions {
  return { limit: parseLimit(url.searchParams.get('limit')), offset: parseOffset(url.searchParams.get('offset')) };
}

/** 统一的列表响应：`total` 是过滤后的总数，`has_more` 按当前页是否还有下一条判断。 */
function sendPage<T>(
  res: ServerResponse,
  deps: ControlPlaneDeps,
  action: string,
  rows: readonly T[],
  paging: PageOptions,
): void {
  const page = rows.slice(paging.offset, paging.offset + paging.limit);
  deps.metrics?.recordAction(action);
  sendJson(res, 200, {
    items: page,
    count: page.length,
    total: rows.length,
    has_more: paging.offset + page.length < rows.length,
    limit: paging.limit,
    offset: paging.offset,
  });
}

async function approve({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const actionId = requireString(body.value, 'action_id');
  const actorId = optionalString(body.value, 'actor_id') ?? 'control_plane';
  const outcome = await deps.engine.approve(params[0]!, actionId, actorId);

  deps.metrics?.recordAction('approve');
  sendJson(res, 200, {
    ...summarize(outcome.workflow, deps),
    stale_action_replanned: outcome.stale_action_replanned,
  });
}

async function reject({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const actionId = requireString(body.value, 'action_id');
  const reason = optionalString(body.value, 'reason');
  if (reason === null) {
    sendJson(res, 400, { error: 'reason is required' });
    return;
  }

  const actorId = optionalString(body.value, 'actor_id') ?? 'control_plane';
  const outcome = await deps.engine.reject(params[0]!, actionId, actorId, reason);

  deps.metrics?.recordAction('reject');
  sendJson(res, 200, {
    ...summarize(outcome.workflow, deps),
    stale_action_replanned: outcome.stale_action_replanned,
  });
}

async function replan({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const workflow = await deps.engine.replan(params[0]!, optionalString(body.value, 'actor_id') ?? 'control_plane');

  deps.metrics?.recordAction('replan');
  sendJson(res, 200, summarize(workflow, deps));
}

async function cancel({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const workflow = deps.engine.cancel(params[0]!, optionalString(body.value, 'actor_id') ?? 'control_plane');

  deps.metrics?.recordAction('cancel');
  sendJson(res, 200, summarize(workflow, deps));
}

async function retry({ res, params, deps }: RouteContext): Promise<void> {
  const workflow = await deps.engine.retry(params[0]!);

  deps.metrics?.recordAction('retry');
  sendJson(res, 200, summarize(workflow, deps));
}

async function listAudit({ res, url, deps }: RouteContext): Promise<void> {
  const limit = parseLimit(url.searchParams.get('limit'));
  const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';

  // 多取一条用于判断是否还有更多，避免为了 has_more 再查一次总数。
  const rows = deps.audit_log.query({
    ...auditFiltersFrom(url),
    limit: limit + 1,
    order,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  deps.metrics?.recordAction('list_audit');
  sendJson(res, 200, { items, count: items.length, has_more: hasMore, limit, order });
}

/** 只把显式传入的过滤条件放进查询，避免把 undefined 当成「等于 undefined」。 */
function auditFiltersFrom(url: URL): {
  workflow_instance_id?: string;
  event_id?: string;
  action_id?: string;
} {
  const filters: { workflow_instance_id?: string; event_id?: string; action_id?: string } = {};

  const workflowInstanceId = url.searchParams.get('workflow_instance_id');
  const eventId = url.searchParams.get('event_id');
  const actionId = url.searchParams.get('action_id');

  if (workflowInstanceId !== null) filters.workflow_instance_id = workflowInstanceId;
  if (eventId !== null) filters.event_id = eventId;
  if (actionId !== null) filters.action_id = actionId;

  return filters;
}

async function listExceptions({ res, url, deps }: RouteContext): Promise<void> {
  const status = url.searchParams.get('status') ?? 'open';
  const limit = parseLimit(url.searchParams.get('limit'));
  const rows =
    status === 'all'
      ? deps.exception_queue.list({ limit: limit + 1 })
      : deps.exception_queue.listOpen({ limit: limit + 1 });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  deps.metrics?.recordAction('list_exceptions');
  sendJson(res, 200, {
    items,
    count: items.length,
    total: deps.exception_queue.count(status === 'all' ? undefined : 'open'),
    has_more: hasMore,
    limit,
  });
}

/**
 * Provider 对账：`failure_submitted === 'unknown'` 的失败实例必须先对账再决定是否重试。
 * 结论由引擎给出（submitted / not_submitted / indeterminate），这里只负责暴露入口。
 */
async function reconcile({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const result = await deps.engine.reconcile(params[0]!, optionalString(body.value, 'actor_id') ?? 'control_plane');

  deps.metrics?.recordAction(`reconcile_${result.outcome}`);
  sendJson(res, 200, {
    ...summarize(result.workflow, deps),
    reconcile: {
      outcome: result.outcome,
      provider_reference: result.provider_reference,
      exception_id: result.exception_id ?? null,
    },
  });
}

/**
 * 异常处理结论：结论与处理人写入异常记录，同时由引擎追加只追加审计
 * （`exception_resolved` / `exception_discarded` / `exception_replayed`）。
 */
function exceptionDecision(body: Record<string, unknown>, deps: ControlPlaneDeps): {
  resolution: string;
  reason?: string;
  actor_id: string;
} {
  const reason = optionalString(body, 'reason');

  return {
    resolution: requireString(body, 'resolution'),
    actor_id: optionalString(body, 'actor_id') ?? 'control_plane',
    ...(reason === null ? {} : { reason }),
  };
}

async function resolveException({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const record = deps.engine.resolveException(params[0]!, exceptionDecision(body.value, deps));

  deps.metrics?.recordAction('resolve_exception');
  sendJson(res, 200, record);
}

async function discardException({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const record = deps.engine.discardException(params[0]!, exceptionDecision(body.value, deps));

  deps.metrics?.recordAction('discard_exception');
  sendJson(res, 200, record);
}

/**
 * 异常重放：把异常记录里的原始事件副本重新交给正常 Workflow 路径。
 * 事件存储按 `idempotency_key` 去重，因此重复重放不会产生第二次业务效果。
 */
async function replayException({ req, res, params, deps }: RouteContext): Promise<void> {
  const body = await readJsonBody(req, deps.config.webhook.max_body_bytes);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }

  const decision = exceptionDecision(body.value, deps);
  const result = await deps.engine.replayException(params[0]!, decision);
  const workflow = result.workflow_id === null ? null : deps.engine.getWorkflow(result.workflow_id);

  deps.metrics?.recordAction(`replay_${result.event_status}`);
  sendJson(res, 200, {
    exception: result.exception,
    event_status: result.event_status,
    workflow: workflow === undefined || workflow === null ? null : summarize(workflow, deps),
  });
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BusinessError(`${key} is required`, 400);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseLimit(value: string | null): number {
  if (value === null) {
    return DEFAULT_PAGE_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

function parseOffset(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
