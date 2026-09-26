import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

import { loadConfig } from '../config/config';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuntimeMetrics } from '../observability/metrics';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import {
  InMemoryAuditLog,
  InMemoryEventStore,
  InMemoryExceptionQueue,
  InMemoryPendingActionStore,
  InMemoryStateStore,
  InMemoryWorkflowStateStore,
} from '../stores/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import {
  contactRecordedEvent,
  contactState,
  dealCreatedEvent,
  dealStageChangedEvent,
  emailRepliedEvent,
  emailSentEvent,
  leadAssignedEvent,
  leadCreatedEvent,
} from '../testing/fixtures';
import { WorkflowEngine, type WorkflowEngineOptions } from '../workflow/engine';
import { ProviderAdapterExecutor } from '../provider/executor';
import { InMemoryProviderAdapter } from '../provider/in-memory';
import { createControlPlaneHandler } from './control-plane';
import { FixedWindowRateLimiter } from './rate-limit';
import { createWebhookServer } from './webhook';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  vi.restoreAllMocks();
});

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';

function buildStack(executorOverride?: WorkflowEngineOptions['executor']) {
  const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
  const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const pendingActions = new InMemoryPendingActionStore();
  const executor = executorOverride ?? new InMemoryExecutor();
  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    pending_action_store: pendingActions,
    executor,
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => contactState(),
  });
  return { engine, workflows, audit, exceptions, pendingActions, leads, contacts, deals };
}

async function startServer(
  options: {
    token?: string | null;
    enabled?: boolean;
    executor?: WorkflowEngineOptions['executor'];
    /** 装配控制面限流器；不传表示完全不限流。 */
    controlPlaneRateLimit?: number;
    /** 是否信任 X-Forwarded-For 作为来源，默认 false。 */
    trustProxyHeaders?: boolean;
  } = {},
) {
  const stack = buildStack(options.executor);
  const config = loadConfig({
    control_plane: { enabled: options.enabled ?? true, bearer_token: options.token ?? null },
    ...(options.trustProxyHeaders === undefined
      ? {}
      : { webhook: { trust_proxy_headers: options.trustProxyHeaders } }),
  });
  const metrics = new RuntimeMetrics({
    workflow_store: stack.workflows,
    exception_queue: stack.exceptions,
    audit_log: stack.audit,
  });
  const server = createWebhookServer({
    engine: stack.engine,
    config,
    metrics,
    control_plane: createControlPlaneHandler({
      engine: stack.engine,
      audit_log: stack.audit,
      exception_queue: stack.exceptions,
      pending_action_store: stack.pendingActions,
      lead_store: stack.leads,
      deal_store: stack.deals,
      config,
      metrics,
      ...(options.controlPlaneRateLimit === undefined
        ? {}
        : {
            rate_limiter: new FixedWindowRateLimiter({
              limit_per_window: options.controlPlaneRateLimit,
              window_ms: 60_000,
            }),
          }),
    }),
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { ...stack, config, baseUrl: `http://127.0.0.1:${port}` };
}

/** 把 Workflow 推到 needs_review：需要人工审核「安排会议」。 */
async function driveToReview(engine: WorkflowEngine): Promise<string> {
  await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
  await engine.handleEvent(leadAssignedEvent());
  await engine.handleEvent(emailSentEvent());
  await engine.handleEvent(emailRepliedEvent());

  return engine.pendingAction(WORKFLOW_ID)?.action_id ?? '';
}

async function call(
  baseUrl: string,
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe('控制面 HTTP 入口', () => {
  it('未配置 token 时控制面不暴露，避免无鉴权的审批入口', async () => {
    const { baseUrl } = await startServer();

    expect((await call(baseUrl, '/workflows')).status).toBe(404);
  });

  it('control_plane.enabled=false 时控制面路由不存在', async () => {
    const { baseUrl } = await startServer({ enabled: false, token: 'secret' });

    expect((await call(baseUrl, '/workflows', { token: 'secret' })).status).toBe(404);
  });

  it('配置 token 后必须携带 Bearer Token', async () => {
    const { baseUrl } = await startServer({ token: 'secret' });

    expect((await call(baseUrl, '/workflows')).status).toBe(401);
    expect((await call(baseUrl, '/workflows', { token: 'secret' })).status).toBe(200);
  });

  it('查询实例时返回待审批动作，供审核界面取 action_id', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    const actionId = await driveToReview(engine);

    const listed = await (await call(baseUrl, '/workflows', { token: 'secret' })).json() as {
      items: Array<{ status: string; pending_action: { action_id: string } | null }>;
      count: number;
    };
    expect(listed.count).toBe(1);
    expect(listed.items[0]?.status).toBe('needs_review');
    expect(listed.items[0]?.pending_action?.action_id).toBe(actionId);

    const single = await call(baseUrl, `/workflows/${WORKFLOW_ID}`, { token: 'secret' });
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({ status: 'needs_review' });

    expect((await call(baseUrl, '/workflows/wf_missing', { token: 'secret' })).status).toBe(404);
  });

  it('Policy 拒绝的动作不出现在待审批列表里', async () => {
    const { engine, baseUrl, pendingActions } = await startServer({ token: 'secret' });
    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await engine.handleEvent(
      contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, contactability: 'unsubscribed' } }),
    );
    await engine.handleEvent(leadAssignedEvent());

    const listed = await (await call(baseUrl, '/workflows', { token: 'secret' })).json() as {
      items: Array<{ status: string; pending_action: { action_id: string } | null }>;
    };
    expect(listed.items[0]).toMatchObject({ status: 'waiting_result', pending_action: null });
    expect(engine.pendingAction(WORKFLOW_ID)).toBeNull();

    const policyRejected = pendingActions.list().filter((record) => record.decision === 'policy_rejected');
    expect(policyRejected).toHaveLength(1);
    expect(policyRejected[0]).toMatchObject({ status: 'decided', decided_by: 'policy' });
  });

  it('POST approve 让 Human Review 分支真正执行动作', async () => {
    const { engine, workflows, pendingActions, baseUrl } = await startServer({ token: 'secret' });
    const actionId = await driveToReview(engine);

    const response = await call(baseUrl, `/workflows/${WORKFLOW_ID}/approve`, {
      method: 'POST',
      token: 'secret',
      body: { action_id: actionId, actor_id: 'user_7' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['meeting.scheduled'],
      pending_action: null,
      stale_action_replanned: false,
    });
    expect(pendingActions.get(actionId)).toMatchObject({ status: 'decided', decision: 'approved', decided_by: 'user_7' });
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('waiting_result');
  });

  it('POST reject 记录原因并基于新约束重新规划', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    const actionId = await driveToReview(engine);

    const missingReason = await call(baseUrl, `/workflows/${WORKFLOW_ID}/reject`, {
      method: 'POST',
      token: 'secret',
      body: { action_id: actionId },
    });
    expect(missingReason.status).toBe(400);

    const rejected = await call(baseUrl, `/workflows/${WORKFLOW_ID}/reject`, {
      method: 'POST',
      token: 'secret',
      body: { action_id: actionId, actor_id: 'user_7', reason: '客户暂不需要会议' },
    });

    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ status: 'waiting_result', pending_action: null });
  });

  it('审批动作不可用时返回 409 而不是 500', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await driveToReview(engine);

    const response = await call(baseUrl, `/workflows/${WORKFLOW_ID}/approve`, {
      method: 'POST',
      token: 'secret',
      body: { action_id: 'action_x' },
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('审核动作不可用');
  });

  it('POST approve 遇到失效动作时改为重新规划并标记 stale_action_replanned', async () => {
    const { engine, pendingActions, audit, baseUrl } = await startServer({ token: 'secret' });
    const actionId = await driveToReview(engine);

    // 审核期间联系人退订，Policy 判定待审动作已失效
    await engine.handleEvent(
      contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, contactability: 'unsubscribed' } }),
    );

    const response = await call(baseUrl, `/workflows/${WORKFLOW_ID}/approve`, {
      method: 'POST',
      token: 'secret',
      body: { action_id: actionId, actor_id: 'user_7' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stale_action_replanned: true, pending_action: null });
    expect(pendingActions.get(actionId)).toMatchObject({ status: 'decided', decision: null, decided_by: 'user_7' });
    expect(audit.list().some((entry) => entry.action === 'action_stale' && entry.action_id === actionId)).toBe(true);
  });

  it('POST /workflows/:id/replan 作废旧待审动作并重新规划', async () => {
    const { engine, pendingActions, baseUrl } = await startServer({ token: 'secret' });
    const actionId = await driveToReview(engine);

    const response = await call(baseUrl, `/workflows/${WORKFLOW_ID}/replan`, {
      method: 'POST',
      token: 'secret',
      body: { actor_id: 'user_7' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'needs_review' });
    expect(pendingActions.get(actionId)).toMatchObject({ status: 'decided', decision: null, decided_by: 'user_7' });
    expect(engine.pendingAction(WORKFLOW_ID)?.action_id).not.toBe(actionId);
  });

  it('POST /replan 对非待审实例返回 409，缺 Token 返回 401', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await engine.handleEvent(leadCreatedEvent());

    expect(
      (await call(baseUrl, `/workflows/${WORKFLOW_ID}/replan`, { method: 'POST', body: { actor_id: 'user_7' } })).status,
    ).toBe(401);

    const conflict = await call(baseUrl, `/workflows/${WORKFLOW_ID}/replan`, {
      method: 'POST',
      token: 'secret',
      body: { actor_id: 'user_7' },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toContain('只有待审核实例可以重新规划');
  });

  it('实例不存在时返回 404，与状态冲突的 409 区分开', async () => {
    const { baseUrl } = await startServer({ token: 'secret' });

    const response = await call(baseUrl, '/workflows/wf_missing/approve', {
      method: 'POST',
      token: 'secret',
      body: { action_id: 'action_x' },
    });

    expect(response.status).toBe(404);
  });

  it('未识别异常按服务端故障返回 500，只回通用文案不泄露内部错误', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await driveToReview(engine);
    vi.spyOn(engine, 'approve').mockImplementation(async () => {
      throw new TypeError('SQLITE_BUSY: database is locked');
    });

    const response = await call(baseUrl, `/workflows/${WORKFLOW_ID}/approve`, {
      method: 'POST',
      token: 'secret',
      body: { action_id: 'action_x' },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
  });

  it('POST cancel / retry 暴露控制面操作', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await engine.handleEvent(leadCreatedEvent());

    const cancelled = await call(baseUrl, `/workflows/${WORKFLOW_ID}/cancel`, {
      method: 'POST',
      token: 'secret',
      body: { actor_id: 'user_7' },
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });

    const retry = await call(baseUrl, `/workflows/${WORKFLOW_ID}/retry`, { method: 'POST', token: 'secret' });
    expect(retry.status).toBe(409);
  });

  it('GET audit 支持按实例与事件过滤，并可限制条数', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await driveToReview(engine);

    const all = await (await call(baseUrl, '/audit', { token: 'secret' })).json() as { count: number };
    expect(all.count).toBeGreaterThan(0);

    const filtered = await (
      await call(baseUrl, `/audit?workflow_instance_id=${WORKFLOW_ID}`, { token: 'secret' })
    ).json() as { items: Array<{ subject: { workflow_instance_id: string | null } }> };
    expect(filtered.items.every((entry) => entry.subject.workflow_instance_id === WORKFLOW_ID)).toBe(true);

    const limited = await (await call(baseUrl, '/audit?limit=1', { token: 'secret' })).json() as {
      count: number;
      has_more: boolean;
      limit: number;
    };
    expect(limited.count).toBe(1);
    expect(limited.limit).toBe(1);
    expect(limited.has_more).toBe(true);
  });

  it('列表查询默认分页并给出 has_more，避免把整表构造成响应', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await driveToReview(engine);

    const defaults = await (await call(baseUrl, '/audit', { token: 'secret' })).json() as {
      limit: number;
      has_more: boolean;
    };
    expect(defaults.limit).toBe(200);
    expect(defaults.has_more).toBe(false);

    const ascending = await (
      await call(baseUrl, '/audit?order=asc&limit=2', { token: 'secret' })
    ).json() as { items: Array<{ action: string }> };
    // 正序第一条是事件接收，倒序第一条是最新的策略/决策记录
    expect(ascending.items[0]?.action).toBe('event_processed');

    const descending = await (
      await call(baseUrl, '/audit?order=desc&limit=2', { token: 'secret' })
    ).json() as { items: Array<{ action: string }> };
    expect(descending.items[0]?.action).not.toBe('event_processed');

    // 超出上限的 limit 会被夹到最大值而不是原样透传
    const clamped = await (await call(baseUrl, '/audit?limit=999999', { token: 'secret' })).json() as {
      limit: number;
    };
    expect(clamped.limit).toBe(1_000);
  });

  it('GET /workflows 与 /exceptions 同样受分页上限约束', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await driveToReview(engine);

    const workflows = await (await call(baseUrl, '/workflows?limit=1', { token: 'secret' })).json() as {
      count: number;
      total: number;
      has_more: boolean;
      limit: number;
    };
    expect(workflows.count).toBe(1);
    expect(workflows.total).toBe(1);
    expect(workflows.has_more).toBe(false);
    expect(workflows.limit).toBe(1);

    await engine.handleEvent(emailSentEvent());
    const exceptions = await (await call(baseUrl, '/exceptions?limit=1', { token: 'secret' })).json() as {
      count: number;
      has_more: boolean;
    };
    expect(exceptions.count).toBeLessThanOrEqual(1);
    expect(exceptions.has_more).toBe(false);
  });

  it('异常队列可查询并标记处理结论', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    // 无 Workflow 的结果事件进入异常队列
    await engine.handleEvent(emailSentEvent());

    const open = await (await call(baseUrl, '/exceptions', { token: 'secret' })).json() as {
      items: Array<{ exception_id: string; reason: string }>;
      count: number;
    };
    expect(open.count).toBe(1);
    expect(open.items[0]?.reason).toBe('unmatched_event');

    const exceptionId = open.items[0]!.exception_id;
    const resolved = await call(baseUrl, `/exceptions/${exceptionId}/resolve`, {
      method: 'POST',
      token: 'secret',
      body: { resolution: '人工确认按当前事实处理' },
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ status: 'resolved', resolution: '人工确认按当前事实处理' });

    const after = await (await call(baseUrl, '/exceptions', { token: 'secret' })).json() as { count: number };
    expect(after.count).toBe(0);

    const discarded = await call(baseUrl, '/exceptions/exc_404/discard', {
      method: 'POST',
      token: 'secret',
      body: { resolution: 'x' },
    });
    expect(discarded.status).toBe(409);
  });

  it('Webhook 路径不受影响', async () => {
    const { baseUrl } = await startServer({ token: 'secret' });

    const posted = await call(baseUrl, '/webhooks/dealflow', {
      method: 'POST',
      token: 'secret',
      body: leadCreatedEvent(),
    });

    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({ status: 'processed' });
  });

  it('异常处理结论经 HTTP 写入审计（exception_id / actor / reason）', async () => {
    const { engine, audit, baseUrl } = await startServer({ token: 'secret' });
    await engine.handleEvent(emailSentEvent());

    const open = await (await call(baseUrl, '/exceptions', { token: 'secret' })).json() as {
      items: Array<{ exception_id: string }>;
    };
    const id = open.items[0]!.exception_id;

    await call(baseUrl, `/exceptions/${id}/resolve`, {
      method: 'POST',
      token: 'secret',
      body: { resolution: '已核对', reason: '历史导入数据', actor_id: 'user_42' },
    });

    const entry = audit.list().find((item) => item.action === 'exception_resolved');
    expect(entry).toMatchObject({
      exception_id: id,
      event_id: emailSentEvent().event_id,
      actor: { actor_type: 'user', actor_id: 'user_42' },
      reason: '历史导入数据',
      before_state: 'open',
      after_state: 'resolved',
    });
  });

  it('异常重放：HTTP 入口把事件交回正常路径并可重复调用', async () => {
    const { engine, baseUrl } = await startServer({ token: 'secret' });
    await engine.handleEvent(emailSentEvent());
    const open = await (await call(baseUrl, '/exceptions', { token: 'secret' })).json() as {
      items: Array<{ exception_id: string }>;
    };
    const id = open.items[0]!.exception_id;

    // 先补建 Workflow 并推到等待 email.sent 的状态
    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await engine.handleEvent(leadAssignedEvent());

    const first = await call(baseUrl, `/exceptions/${id}/replay`, {
      method: 'POST',
      token: 'secret',
      body: { resolution: '补投', actor_id: 'user_7' },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { event_status: string; exception: { status: string }; workflow: unknown };
    expect(firstBody.event_status).toBe('processed');
    expect(firstBody.exception.status).toBe('resolved');
    expect(firstBody.workflow).not.toBeNull();

    // 重复重放幂等：事件已生效，返回 duplicate，异常保持已处理
    const second = await call(baseUrl, `/exceptions/${id}/replay`, {
      method: 'POST',
      token: 'secret',
      body: { resolution: '补投', actor_id: 'user_7' },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ event_status: 'duplicate' });

    // 已丢弃的异常不可重放
    const secondId = (await (await call(baseUrl, '/exceptions', { token: 'secret' })).json() as {
      items: Array<{ exception_id: string }>;
    }).items[0];
    if (secondId !== undefined) {
      await call(baseUrl, `/exceptions/${secondId.exception_id}/discard`, {
        method: 'POST',
        token: 'secret',
        body: { resolution: '垃圾数据', actor_id: 'user_7' },
      });
      const refused = await call(baseUrl, `/exceptions/${secondId.exception_id}/replay`, {
        method: 'POST',
        token: 'secret',
        body: { resolution: '反悔', actor_id: 'user_7' },
      });
      expect(refused.status).toBe(409);
    }
  });

  it('Provider 对账经 HTTP 完成：确认未提交后用同一幂等 key 重试', async () => {
    const adapter = new InMemoryProviderAdapter({ provider: 'mailgun' });
    const { engine, audit, baseUrl } = await startServer({
      token: 'secret',
      executor: new ProviderAdapterExecutor([adapter]),
    });

    adapter.failNext(
      Object.assign(new Error('timeout'), {
        classification: 'transient' as const,
        code: 'TIMEOUT',
        submitted: 'unknown' as const,
      }),
    );
    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await engine.handleEvent(leadAssignedEvent());
    expect(engine.getWorkflow(WORKFLOW_ID)).toMatchObject({ status: 'failed', failure_submitted: 'unknown' });

    const response = await call(baseUrl, `/workflows/${WORKFLOW_ID}/reconcile`, {
      method: 'POST',
      token: 'secret',
      body: { actor_id: 'user_7' },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; reconcile: { outcome: string; provider_reference: string | null } };
    expect(body.status).toBe('waiting_result');
    expect(body.reconcile.outcome).toBe('not_submitted');
    expect(body.reconcile.provider_reference).toBeNull();

    const submitted = adapter.submitted();
    expect(submitted).toHaveLength(2);
    expect(submitted[0]?.execution_idempotency_key).toBe(submitted[1]?.execution_idempotency_key);
    expect(audit.list().some((entry) => entry.action === 'action_reconciled')).toBe(true);

    // 再次对账会被拒绝：实例已不在 failed
    const again = await call(baseUrl, `/workflows/${WORKFLOW_ID}/reconcile`, {
      method: 'POST',
      token: 'secret',
      body: { actor_id: 'user_7' },
    });
    expect(again.status).toBe(409);
  });

  it('对账结论为 indeterminate 时返回异常标识且保持 failed', async () => {
    const adapter = new InMemoryProviderAdapter({
      provider: 'mailgun',
      reconcile: () => ({ submitted: 'unknown', provider_reference: null }),
    });
    const { engine, baseUrl } = await startServer({
      token: 'secret',
      executor: new ProviderAdapterExecutor([adapter]),
    });

    adapter.failNext(
      Object.assign(new Error('timeout'), {
        classification: 'transient' as const,
        code: 'TIMEOUT',
        submitted: 'unknown' as const,
      }),
    );
    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await engine.handleEvent(leadAssignedEvent());

    const response = await call(baseUrl, `/workflows/${WORKFLOW_ID}/reconcile`, {
      method: 'POST',
      token: 'secret',
      body: { actor_id: 'user_7' },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; reconcile: { outcome: string; exception_id: string | null } };
    expect(body.status).toBe('failed');
    expect(body.reconcile.outcome).toBe('indeterminate');
    expect(body.reconcile.exception_id).toBeTruthy();

    const open = await (await call(baseUrl, '/exceptions', { token: 'secret' })).json() as {
      items: Array<{ exception_id: string; reason: string; event_id: string | null }>;
    };
    expect(open.items[0]).toMatchObject({ reason: 'processing_error', event_id: null });
  });
});

describe('控制面限流与来源识别', () => {
  it('超过额度返回 429 并带 Retry-After', async () => {
    const { baseUrl } = await startServer({ token: 'secret', controlPlaneRateLimit: 1 });

    expect((await call(baseUrl, '/workflows', { token: 'secret' })).status).toBe(200);

    const limited = await call(baseUrl, '/workflows', { token: 'secret' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await limited.json()).toEqual({ error: 'rate limited' });
  });

  it('限流排在鉴权之前：暴力猜 token 的请求同样消耗额度', async () => {
    const { baseUrl } = await startServer({ token: 'secret', controlPlaneRateLimit: 2 });

    expect((await call(baseUrl, '/workflows', { token: 'wrong' })).status).toBe(401);
    expect((await call(baseUrl, '/workflows', { token: 'wrong' })).status).toBe(401);
    expect((await call(baseUrl, '/workflows', { token: 'secret' })).status).toBe(429);
  });

  it('未匹配路由不消耗额度：不存在的路径仍然回落 404', async () => {
    const { baseUrl } = await startServer({ token: 'secret', controlPlaneRateLimit: 1 });

    expect((await call(baseUrl, '/not-a-route', { token: 'secret' })).status).toBe(404);
    expect((await call(baseUrl, '/workflows', { token: 'secret' })).status).toBe(200);
  });

  it('受信代理后按 X-Forwarded-For 区分来源，各自独立计数', async () => {
    const { baseUrl } = await startServer({
      token: 'secret',
      controlPlaneRateLimit: 1,
      trustProxyHeaders: true,
    });

    expect((await call(baseUrl, '/workflows', {
      token: 'secret',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })).status).toBe(200);
    expect((await call(baseUrl, '/workflows', {
      token: 'secret',
      headers: { 'x-forwarded-for': '198.51.100.9' },
    })).status).toBe(200);
  });

  it('默认不信任代理头：伪造 X-Forwarded-For 无法绕过限流', async () => {
    const { baseUrl } = await startServer({ token: 'secret', controlPlaneRateLimit: 1 });

    expect((await call(baseUrl, '/workflows', {
      token: 'secret',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })).status).toBe(200);
    expect((await call(baseUrl, '/workflows', {
      token: 'secret',
      headers: { 'x-forwarded-for': '198.51.100.9' },
    })).status).toBe(429);
  });
});

describe('销售读端点 /leads 与 /deals', () => {
  it('GET /leads 列出线索，支持 owner_id / status 过滤、分页与单条详情', async () => {
    const { baseUrl, engine } = await startServer({ token: 'secret' });
    await engine.handleEvent(leadCreatedEvent());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(
      leadCreatedEvent({
        event_id: 'evt_lead_2',
        idempotency_key: 'lead.created:crm:rec_1002',
        payload: {
          ...leadCreatedEvent().payload,
          lead_id: 'lead_2',
          source_channel: 'import',
          source_record_id: 'rec_1002',
          company_name: 'Beta',
          contact_id: null,
          initial_owner_id: 'user_9',
        },
      }),
    );

    const all = await (await call(baseUrl, '/leads', { token: 'secret' })).json() as {
      items: Array<{ lead_id: string }>;
      count: number;
      total: number;
      has_more: boolean;
      limit: number;
    };
    expect(all.total).toBe(2);
    expect(all.count).toBe(2);
    expect(all.has_more).toBe(false);
    expect(all.items.map((lead) => lead.lead_id).sort()).toEqual(['lead_1', 'lead_2']);

    const mine = await (await call(baseUrl, '/leads?owner_id=user_7', { token: 'secret' })).json() as {
      items: Array<{ lead_id: string }>;
      total: number;
    };
    expect(mine.items.map((lead) => lead.lead_id)).toEqual(['lead_1']);
    expect(mine.total).toBe(1);

    const assigned = await (await call(baseUrl, '/leads?status=assigned', { token: 'secret' })).json() as {
      items: Array<{ lead_id: string }>;
    };
    expect(assigned.items.map((lead) => lead.lead_id)).toEqual(['lead_1']);

    const paged = await (await call(baseUrl, '/leads?limit=1', { token: 'secret' })).json() as {
      items: Array<{ lead_id: string }>;
      count: number;
      total: number;
      has_more: boolean;
    };
    expect(paged).toMatchObject({ count: 1, total: 2, has_more: true });

    const detail = await call(baseUrl, '/leads/lead_1', { token: 'secret' });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      lead_id: 'lead_1',
      company_name: 'Acme',
      owner_id: 'user_7',
      status: 'assigned',
    });

    expect((await call(baseUrl, '/leads/lead_missing', { token: 'secret' })).status).toBe(404);
    expect((await call(baseUrl, '/leads')).status).toBe(401);
  });

  it('GET /deals 按 stage / owner_id / lead_id 过滤，并返回单条详情', async () => {
    const { baseUrl, engine } = await startServer({ token: 'secret' });
    await engine.handleEvent(leadCreatedEvent());
    await engine.handleEvent(dealCreatedEvent());
    await engine.handleEvent(
      dealCreatedEvent({
        event_id: 'evt_deal_2',
        idempotency_key: 'deal.created:deal_2',
        payload: {
          ...dealCreatedEvent().payload,
          deal_id: 'deal_2',
          owner_id: 'user_9',
        },
      }),
    );
    // Deal 只能从 qualification 建立，再按状态机推进到 discovery
    await engine.handleEvent(
      dealStageChangedEvent({
        event_id: 'evt_deal_2_discovery',
        idempotency_key: 'deal.stage_changed:deal_2:qualification:discovery',
        payload: { ...dealStageChangedEvent().payload, deal_id: 'deal_2', from_stage: 'qualification', to_stage: 'discovery' },
      }),
    );

    const all = await (await call(baseUrl, '/deals', { token: 'secret' })).json() as {
      items: Array<{ deal_id: string }>;
      total: number;
      has_more: boolean;
    };
    expect(all.total).toBe(2);
    expect(all.has_more).toBe(false);
    expect(all.items.map((deal) => deal.deal_id).sort()).toEqual(['deal_1', 'deal_2']);

    const byStage = await (await call(baseUrl, '/deals?stage=discovery', { token: 'secret' })).json() as {
      items: Array<{ deal_id: string }>;
      total: number;
    };
    expect(byStage.items.map((deal) => deal.deal_id)).toEqual(['deal_2']);
    expect(byStage.total).toBe(1);

    const byOwner = await (await call(baseUrl, '/deals?owner_id=user_7', { token: 'secret' })).json() as {
      items: Array<{ deal_id: string }>;
    };
    expect(byOwner.items.map((deal) => deal.deal_id)).toEqual(['deal_1']);

    const byLead = await (await call(baseUrl, '/deals?lead_id=lead_1', { token: 'secret' })).json() as {
      items: Array<{ deal_id: string }>;
      total: number;
    };
    expect(byLead.total).toBe(2);

    const detail = await call(baseUrl, '/deals/deal_1', { token: 'secret' });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      deal_id: 'deal_1',
      lead_id: 'lead_1',
      owner_id: 'user_7',
      stage: 'qualification',
      amount: 120000,
      currency: 'CNY',
    });

    expect((await call(baseUrl, '/deals/deal_missing', { token: 'secret' })).status).toBe(404);
    expect((await call(baseUrl, '/deals')).status).toBe(401);
  });
});
