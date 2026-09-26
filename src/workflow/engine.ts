import { randomUUID } from 'node:crypto';

import type {
  DecisionContext,
  MemorySummary,
  PendingTask,
  PolicyContext,
  PreviousDecision,
  VerifiedConfig,
} from '../decision/context';
import type { Decider } from '../decision/interfaces';
import { BusinessError } from '../errors';
import type { ActionType, ProposedAction } from '../decision/types';
import {
  isFactOnlyEvent,
  parseEvent,
  type EventType,
  type ParsedEvent,
  type ParsedEventOf,
} from '../events/dictionary';
import {
  classifyExecutionError,
  isReconcilableExecutor,
  type ErrorClassification,
  type ExecutionReceipt,
  type Executor,
  type ReconciledSubmission,
} from '../executor/interfaces';
import type { PolicyEvaluator } from '../policy/interfaces';
import type { PolicyOutcome } from '../policy/types';
import { isWorkflowTerminal, type WorkflowStatus } from '../state-machine/states';
import {
  validateDealTransition,
  validateLeadTransition,
  validateWorkflowTransition,
  type WorkflowTrigger,
} from '../state-machine/transitions';
import type {
  AuditLogStore,
  ContactStateStore,
  DealStateStore,
  EventStore,
  ExceptionQueueStore,
  LeadStateStore,
  MemoryStore,
  PendingActionStore,
  WorkflowListOptions,
  WorkflowStateStore,
} from '../stores/interfaces';
import { isClaimableEventStore } from '../stores/interfaces';
import { InMemoryMemoryStore, InMemoryPendingActionStore } from '../stores/in-memory';
import { deepFreezeClone } from '../stores/shared';
import type {
  ContactState,
  DealState,
  ExceptionRecord,
  ExceptionReason,
  MemoryEntry,
  NewAuditEntry,
  PendingActionRecord,
  WorkflowInstanceState,
} from '../stores/types';
import { workflowBusinessKey } from '../stores/types';
import type { UnitOfWork } from '../stores/unit-of-work';
import { expectedEventsFor } from './expected-events';
import { summarizeMemory } from './memory-summary';
import { derivePendingTasks } from './pending-tasks';

/**
 * 未能在等待窗口内拿到处理租约（多半是上一次进程崩溃留下的孤儿租约）。
 * 单独成类是为了让启动恢复能把它识别为「稍后重试」而不是「处理失败」：
 * 把它当失败会让进程在崩溃重启后直接退出，直到租约过期才起得来。
 */
export class ClaimTimeoutError extends Error {
  constructor(readonly idempotency_key: string) {
    super(`获取事件处理租约超时: ${idempotency_key}`);
    this.name = 'ClaimTimeoutError';
  }
}

export function isClaimTimeoutError(error: unknown): error is ClaimTimeoutError {
  return error instanceof ClaimTimeoutError;
}

export interface WorkflowEngineOptions {
  readonly event_store: EventStore;
  readonly audit_log: AuditLogStore;
  readonly exception_queue: ExceptionQueueStore;
  readonly lead_store: LeadStateStore;
  readonly contact_store: ContactStateStore;
  readonly deal_store: DealStateStore;
  readonly workflow_store: WorkflowStateStore;
  readonly executor: Executor;
  readonly decider: Decider;
  readonly policy: PolicyEvaluator;
  readonly workflow_type?: string;
  readonly now?: () => string;
  readonly verified_config?: VerifiedConfig;
  readonly policy_context?: (workflow: WorkflowInstanceState, now: string) => PolicyContext;
  /**
   * Memory：历史互动与偏好。不提供时使用进程内实现（仍会写入，只是不跨重启）。
   * 替代早先的 `memory` 回调——那个回调在装配时从未被注入，导致 Context.memory 永远是空摘要。
   */
  readonly memory_store?: MemoryStore;
  /**
   * 待审批动作存储。不提供时使用进程内实现；
   * 生产装配必须提供持久化实现，否则重启后 Human Review 无法继续审批。
   */
  readonly pending_action_store?: PendingActionStore;
  /** 显式覆盖待办任务推导；不提供时按事件与审计推导。 */
  readonly pending_tasks?: (workflow: WorkflowInstanceState) => readonly PendingTask[];
  readonly contact_defaults?: (contactId: string) => ContactState;
  /**
   * 业务事务边界。提供后，一次处理的同步写入（Entity State / Workflow State /
   * Audit Log / 异常队列 / Event 处理状态）合并为单一事务，避免部分提交。
   * 不提供时退化为逐个写入各自提交（InMemory 场景）。
   */
  readonly unit_of_work?: UnitOfWork;
}

export type HandleEventResult =
  | { status: 'processed' | 'duplicate' | 'unmatched' | 'failed'; workflow: WorkflowInstanceState | null }
  | { status: 'conflict' };

/** 正常投递争用处理租约的等待窗口。 */
const CLAIM_WAIT_MS = 5_000;
/** 启动恢复争用处理租约的等待窗口：孤儿租约等不来，越快让位给延迟重投越好。 */
export const RECOVERY_CLAIM_WAIT_MS = 100;

export interface HandleEventOptions {
  /** 争用处理租约的等待窗口（毫秒）；缺省 5_000。 */
  readonly claim_wait_ms?: number;
}

/** Provider 对账结论，对应 `WorkflowEngine.reconcile` 的三条分支。 */
export interface ReconcileResult {
  readonly outcome: 'submitted' | 'not_submitted' | 'indeterminate';
  readonly workflow: WorkflowInstanceState;
  /** 对账确认已提交时提供商返回的回执标识。 */
  readonly provider_reference: string | null;
  /** 结论为 indeterminate 时写入的异常记录标识。 */
  readonly exception_id?: string;
}

/**
 * 人工审核结论（approve / reject 共用）。
 *
 * `stale_action_replanned` 为 true 表示审核时动作已经失效：引擎没有执行它，
 * 而是作废该动作并基于当前事实重新规划，实例因此离开 needs_review。
 */
export interface ReviewOutcome {
  readonly workflow: WorkflowInstanceState;
  readonly stale_action_replanned: boolean;
}

/** 人工处理异常时的结论与操作者。 */
export interface ExceptionDecision {
  readonly resolution: string;
  readonly reason?: string;
  readonly actor_id?: string;
}

export interface ExceptionReplayResult {
  readonly exception: ExceptionRecord;
  /** 重放后事件在正常路径上的处理结果。 */
  readonly event_status: HandleEventResult['status'];
  readonly workflow_id: string | null;
}

/**
 * 每个动作类型对应的外部结果事件；动作派发成功后据此等待结果。
 * 与 docs/decision-policy.md「输出 ProposedAction」中的结果确认方式一一对应。
 */
const RESULT_EVENTS: Readonly<Record<ActionType, readonly EventType[]>> = {
  send_email: ['email.sent'],
  schedule_meeting: ['meeting.scheduled'],
  create_task: ['task.overdue'],
  send_proposal: ['proposal.sent'],
  advance_deal_stage: ['deal.stage_changed'],
};

/** 需要写入 Memory 的互动事件：外部结果事件表示与客户之间真实发生过互动。 */
const INTERACTION_EVENTS: readonly EventType[] = [
  'email.sent',
  'email.replied',
  'meeting.scheduled',
  'proposal.sent',
  'deal.stage_changed',
  'task.overdue',
];

/**
 * Decision Context 中 `recent_events` 的窗口大小（按主体取最近 N 条）。
 *
 * 只取本主体的事件是让处理耗时与事件总量解耦的关键（见 `EventStore.listByLeadId`）。
 * 取 500 条是保守上限：单个 Lead 的完整生命周期（分配、N 轮邮件、会议、阶段变更）
 * 通常在数十条量级；超过该窗口意味着这条 Lead 的互动量已达异常规模，
 * 此时「事件是否已发生」的判定仍以窗口内事实为准，Decider 的具体规则不受影响。
 */
const RECENT_EVENT_LIMIT = 500;

/**
 * #facts 判定事实不可安全合并时抛出，携带写入异常队列的原因。
 * 与状态机拒绝不同：这表示「事件与当前 State 冲突或违反迁移规则」，而非处理崩溃。
 */
class FactsRejectedError extends BusinessError {
  constructor(
    readonly reason: ExceptionReason,
    message: string,
  ) {
    super(message);
    this.name = 'FactsRejectedError';
  }
}

/**
 * 控制面要操作的实例不存在。
 * 单列一个子类是为了让 HTTP 层回 404 而不是 409：「资源不存在」与「资源状态冲突」
 * 对客户端是两件事，混在一起会让重试与缓存逻辑写错。
 */
export class WorkflowNotFoundError extends BusinessError {
  constructor(readonly workflowInstanceId: string) {
    super(`Workflow 不存在: ${workflowInstanceId}`, 404);
    this.name = 'WorkflowNotFoundError';
  }
}

/**
 * 从事件联合类型中读取 `lead_id` 用于把事件关联到 Workflow 主体。
 * 所有事件类型都携带 `lead_id`（`task.overdue` 可为空），因此可在联合上直接读取，
 * 结果为 `string | null`，无需 `Record<string, any>`。
 */
function leadIdOfEvent(e: ParsedEvent): string | null {
  return e.payload.lead_id;
}

/**
 * 读取事件中的 `workflow_instance_id`（仅部分结果事件携带），用于结果匹配。
 */
function workflowInstanceIdOfEvent(e: ParsedEvent): string | null {
  switch (e.type) {
    case 'email.sent':
    case 'task.overdue':
      return e.payload.workflow_instance_id;
    default:
      return null;
  }
}

/**
 * 读取结果事件的提供商回执标识，用于审计追溯与对账。
 * 只有提供商 webhook 驱动的结果事件（Result Event 契约）携带该字段。
 */
function providerReferenceOfEvent(e: ParsedEvent | null): string | null {
  if (e === null) {
    return null;
  }
  switch (e.type) {
    case 'email.sent':
    case 'email.replied':
    case 'meeting.scheduled':
    case 'proposal.sent':
      return e.payload.provider_reference;
    default:
      return null;
  }
}

export class WorkflowEngine {
  readonly #o: WorkflowEngineOptions;
  readonly #type: string;
  readonly #now: () => string;
  readonly #memory: MemoryStore;
  readonly #pendingActions: PendingActionStore;
  readonly #failureClassifications = new Map<string, ErrorClassification>();
  /** 同一 idempotency_key 的在途 handleEvent 合并为一次处理，避免并发重复业务效果。 */
  readonly #inFlight = new Map<string, Promise<HandleEventResult>>();
  /** 同一 workflow 的在途 retry 合并为一次执行。 */
  readonly #retryInFlight = new Map<string, Promise<WorkflowInstanceState>>();
  /** 同一实例的在途对账合并为一次执行：对账是外部调用，不能并发重复发起。 */
  readonly #reconcileInFlight = new Map<string, Promise<ReconcileResult>>();

  constructor(options: WorkflowEngineOptions) {
    this.#o = options;
    this.#type = options.workflow_type ?? 'lead_follow_up';
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#memory = options.memory_store ?? new InMemoryMemoryStore();
    this.#pendingActions = options.pending_action_store ?? new InMemoryPendingActionStore();
  }

  /** 控制面只读查询：全部 Workflow 实例。 */
  listWorkflows(query?: WorkflowListOptions): readonly WorkflowInstanceState[] {
    return this.#o.workflow_store.list(query);
  }

  /** 控制面只读查询：实例条数（可按状态过滤）；下推 COUNT，不物化实例本体。 */
  countWorkflows(status?: string): number {
    return this.#o.workflow_store.count(status);
  }

  /** 控制面只读查询：单个实例。 */
  getWorkflow(id: string): WorkflowInstanceState | undefined {
    return this.#o.workflow_store.get(id);
  }

  /** 控制面只读查询：该实例当前待审批的动作，供人工审核界面取 action_id。 */
  pendingAction(id: string): ProposedAction | null {
    return this.#pendingActions.getPending(id)?.action ?? null;
  }

  async handleEvent(input: ParsedEvent, options: HandleEventOptions = {}): Promise<HandleEventResult> {
    const key = input.idempotency_key;
    const inflight = this.#inFlight.get(key);
    if (inflight) {
      return inflight;
    }
    const run = this.#handleEventOnce(input, options).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, run);
    return run;
  }

  async #handleEventOnce(input: ParsedEvent, options: HandleEventOptions): Promise<HandleEventResult> {
    const stored = this.#o.event_store.append(input);

    if (stored.status === 'conflict') {
      return this.#transaction((): HandleEventResult => {
        const workflow = this.#workflow(input);
        this.#audit(input, workflow ?? null, 'event_conflicted', null, 'idempotency_conflict', 'failed');
        this.#enqueueException('idempotency_conflict', input, workflow ?? null);
        return { status: 'conflict' };
      });
    }

    if (stored.status === 'duplicate') {
      return this.#transaction((): HandleEventResult => {
        const workflow = this.#workflow(input);
        this.#audit(input, workflow ?? null, 'event_processed', null, 'duplicate', 'skipped');
        return { status: 'duplicate', workflow: workflow ?? null };
      });
    }

    return this.#withClaim(input, () => this.#runEvent(input, false), options.claim_wait_ms);
  }

  /**
   * 跨进程处理租约：同一 idempotency_key 仅一个 worker 处理中；
   * 等待期间若他人完成，则返回 duplicate，避免双写业务效果。
   *
   * `claimWaitMs` 是**争用等待窗口**，不是租约本身：正常投递等 5 秒（多半是另一个 worker
   * 正在处理同一条），而启动恢复走 `claim_wait_ms` 很小的路径——恢复时拿到的多半是
   * 上一次进程崩溃留下的孤儿租约，等满窗口只会白白拖慢重启。
   */
  async #withClaim(
    e: ParsedEvent,
    run: () => Promise<HandleEventResult>,
    claimWaitMs?: number,
  ): Promise<HandleEventResult> {
    const store = this.#o.event_store;
    if (!isClaimableEventStore(store)) {
      return run();
    }
    const claimId = randomUUID();
    const deadline = Date.now() + (claimWaitMs ?? CLAIM_WAIT_MS);
    while (Date.now() < deadline) {
      if (store.tryClaim(e.idempotency_key, claimId, Date.now(), 30_000)) {
        try {
          return await run();
        } finally {
          store.releaseClaim(e.idempotency_key, claimId);
        }
      }
      const current = store.getByIdempotencyKey(e.idempotency_key);
      if (current?.processing_status === 'processed') {
        return this.#transaction(() => {
          const workflow = this.#workflow(e);
          this.#audit(e, workflow ?? null, 'event_processed', null, 'duplicate', 'skipped');
          return { status: 'duplicate', workflow: workflow ?? null };
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new ClaimTimeoutError(e.idempotency_key);
  }

  /**
   * 崩溃恢复：按 sequence 顺序用 EventStore 中的全部事件重建内存 State / Audit / Exception。
   * 仅应在空 State Store 上调用；已处理事件重新应用事实，pending 事件完整处理并 markProcessed。
   *
   * 恢复期间不调用外部 Executor（replay = true）：外部副作用（发邮件、建会议等）无法幂等重放，
   * 重放只会「按确定性 Decision + Policy 重建已派发状态（waiting_result）」并写入 action_dispatched 审计，
   * 而不会再次触发外部提供商。见 docs/state-machine.md「Workflow Resume 规则」第 11 条。
   */
  async recoverFromEventLog(options: HandleEventOptions = {}): Promise<readonly HandleEventResult[]> {
    const results: HandleEventResult[] = [];
    for (const { event } of this.#o.event_store.list()) {
      try {
        results.push(await this.#replay(event, options));
      } catch (error) {
        // 租约被上一次进程占着：跳过而不是让整个恢复失败，事件保持 pending，
        // 由启动恢复的延迟重投在租约过期后接手。
        if (isClaimTimeoutError(error)) {
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  async #replay(input: ParsedEvent, options: HandleEventOptions): Promise<HandleEventResult> {
    const stored = this.#o.event_store.getByIdempotencyKey(input.idempotency_key);
    // 已 processed 的事件：崩溃恢复仍需重建 State，无需再争用处理租约。
    if (stored?.processing_status === 'processed') {
      return this.#runEvent(input, true);
    }
    return this.#withClaim(input, () => this.#runEvent(input, true), options.claim_wait_ms);
  }

  /**
   * 处理一个事件。`#process` 内部已负责在成功后推进 Event 处理状态，
   * 因此这里不再单独 markProcessed，避免「状态已写但处理状态未写」的部分提交。
   */
  async #runEvent(e: ParsedEvent, replay: boolean): Promise<HandleEventResult> {
    try {
      const outcome = await this.#process(e, replay);
      if (outcome.failed) {
        return { status: 'failed', workflow: outcome.workflow };
      }
      if (outcome.workflow) {
        return { status: 'processed', workflow: outcome.workflow };
      }
      // 事实类事件在尚无 Workflow 时也被接收为事实（例如先登记联系人、先建立 Deal），
      // 此时返回 processed 而不是 unmatched：它不是「无人认领的事件」，而是已落库的当前事实。
      return isFactOnlyEvent(e.type)
        ? { status: 'processed', workflow: null }
        : { status: 'unmatched', workflow: null };
    } catch (error) {
      const workflow = this.#transaction(() => {
        const current = this.#workflow(e);
        if (current?.status === 'running') {
          this.#save(this.#transition(current, 'processing_error', undefined, msg(error)));
        }
        this.#enqueueException(
          error instanceof FactsRejectedError ? error.reason : 'processing_error',
          e,
          current ?? null,
        );
        return current ?? null;
      });
      return { status: 'failed', workflow };
    }
  }

  async retry(id: string): Promise<WorkflowInstanceState> {
    const inflight = this.#retryInFlight.get(id);
    if (inflight) {
      return inflight;
    }
    const run = this.#retryOnce(id).finally(() => {
      this.#retryInFlight.delete(id);
    });
    this.#retryInFlight.set(id, run);
    return run;
  }

  async #retryOnce(id: string): Promise<WorkflowInstanceState> {
    const w = this.#require(id);
    if (w.status !== 'failed') {
      throw new BusinessError('Workflow 当前不可重试');
    }
    const classification = w.failure_classification ?? this.#failureClassifications.get(id) ?? null;
    if (classification === 'permanent') {
      throw new BusinessError('永久性失败不允许自动重试');
    }
    if (w.failure_submitted === 'unknown') {
      throw new BusinessError('提交状态未知，需先对账后才能自动重试');
    }
    const entry = w.last_processed_event_id === null
      ? undefined
      : this.#o.event_store.getByEventId(w.last_processed_event_id);
    if (!entry) {
      throw new BusinessError('Workflow 没有可重试事件');
    }
    const planned = this.#transaction(() => this.#planSync(this.#save(this.#transition(w, 'retry')), entry.event));
    if (planned.action === null) {
      this.#transaction(() => {
        this.#o.event_store.markProcessed(entry.event.idempotency_key);
      });
      return planned.workflow;
    }
    return this.#dispatchAction(planned.action, planned.workflow, entry.event, false);
  }

  async approve(id: string, actionId: string, actorId: string): Promise<ReviewOutcome> {
    const outcome = await this.#review(id, actionId, actorId, true, null);
    this.#settleAwaitingApproval(outcome.workflow, actorId);
    return outcome;
  }

  async reject(id: string, actionId: string, actorId: string, reason: string): Promise<ReviewOutcome> {
    const outcome = await this.#review(id, actionId, actorId, false, reason);
    this.#settleAwaitingApproval(outcome.workflow, actorId);
    return outcome;
  }

  /**
   * 人工重新规划：作废当前待审动作并按当前事实重算下一步。
   *
   * 与「拒绝」的区别是不写 `previous_decisions`——重新规划只是丢掉过时的计划，
   * 不等于人工否决这个动作类型，否则重新规划一次就等于永久拉黑一次。
   */
  async replan(id: string, actorId: string): Promise<WorkflowInstanceState> {
    const w = this.#require(id);
    if (w.status !== 'needs_review') {
      throw new BusinessError(`只有待审核实例可以重新规划，当前状态 ${w.status}`);
    }

    const action = this.#pendingActions.getPending(id)?.action ?? null;
    const next = await this.#staleActionReplan(w, action, actorId, 'replan_requested', `人工触发重新规划（${actorId}）`);
    this.#settleAwaitingApproval(next, actorId);
    return next;
  }

  cancel(id: string, actorId = 'system'): WorkflowInstanceState {
    const next = this.#transaction(() =>
      this.#transitionWithAudit(this.#require(id), 'cancel_requested', undefined, `cancelled by ${actorId}`, actorId),
    );
    this.#settleAwaitingApproval(next, actorId);
    return next;
  }

  /**
   * Provider 对账：处理 `failure_submitted === 'unknown'` 的失败实例。
   *
   * 这类失败（超时/连接中断）无法判断提供商是否已经接受了动作，因此**禁止简单 retry**：
   * 先问提供商，再按结论分支（对应 docs/domain.md「Executor Error Contract」第 5 条）：
   *
   * - `submitted === true`：提供商侧确实有这次提交 → 恢复为「已派发、等待结果」，等结果事件确认；
   * - `submitted === false`：确认未提交 → 用**原 execution_idempotency_key** 重新派发（幂等，安全）；
   * - `'unknown'` 或对账请求本身失败 → 保持 `failed`，写入异常队列转人工，绝不猜测后重试。
   *
   * 对账本身也必须是幂等的：只有 `failed` 且 `failure_submitted === 'unknown'` 的实例可对账，
   * 同实例并发对账合并为一次执行。
   */
  reconcile(id: string, actorId = 'system'): Promise<ReconcileResult> {
    const inflight = this.#reconcileInFlight.get(id);
    if (inflight) {
      return inflight;
    }
    const run = this.#reconcileOnce(id, actorId).finally(() => {
      this.#reconcileInFlight.delete(id);
    });
    this.#reconcileInFlight.set(id, run);
    return run;
  }

  async #reconcileOnce(id: string, actorId: string): Promise<ReconcileResult> {
    const w = this.#require(id);
    if (w.status !== 'failed') {
      throw new BusinessError('Workflow 当前无需对账');
    }
    if (w.failure_submitted !== 'unknown') {
      throw new BusinessError('该失败的提交状态已确定，无需对账');
    }

    const executor = this.#o.executor;
    if (!isReconcilableExecutor(executor)) {
      throw new BusinessError('Executor 不支持对账，无法确认提交状态');
    }

    const action = this.#failedActionOf(id);
    if (action === null) {
      throw new BusinessError('没有可对账的动作快照，无法确认提交状态');
    }

    let reconciliation: ReconciledSubmission;
    try {
      reconciliation = await executor.reconcile(action);
    } catch (error) {
      return this.#transaction(() => this.#indeterminateReconcile(w, action, actorId, `对账请求失败：${msg(error)}`));
    }

    if (reconciliation.submitted === true) {
      const receipt: ExecutionReceipt = {
        provider: reconciliation.provider,
        provider_reference: reconciliation.provider_reference,
        correlation_id: null,
      };
      const workflow = this.#transaction(() => {
        const running = this.#save(this.#transition(w, 'retry'));
        const dispatched = this.#save({
          ...this.#transition(running, 'action_dispatched'),
          current_step: action.action_type,
          awaiting_event_types: RESULT_EVENTS[action.action_type],
          failure_classification: null,
          failure_submitted: null,
          failure_retry_after: null,
        });
        this.#markActionDecided(action, null, actorId);
        this.#audit(null, dispatched, 'action_reconciled', action, 'submitted: 提供商确认已接受该动作', 'succeeded', receipt, {
          actor_id: actorId,
        });
        return dispatched;
      });

      return { outcome: 'submitted', workflow, provider_reference: reconciliation.provider_reference };
    }

    if (reconciliation.submitted === false) {
      if (action.plan_version !== w.plan_version) {
        throw new BusinessError('动作已过期，需先重新规划后再对账');
      }
      const running = this.#transaction(() => {
        const next = this.#save(this.#transition(w, 'retry'));
        this.#audit(null, next, 'action_reconciled', action, 'not_submitted: 确认未提交，使用同一执行幂等 key 重试', 'succeeded', null, {
          actor_id: actorId,
        });
        return next;
      });

      const workflow = await this.#dispatchAction(action, running, null, false);
      return { outcome: 'not_submitted', workflow, provider_reference: null };
    }

    return this.#transaction(() => this.#indeterminateReconcile(w, action, actorId, '对账返回 unknown：提供商侧无法判定'));
  }

  /** 对账无法得出结论：保持 failed，写入异常队列转人工，并留下审计。 */
  #indeterminateReconcile(
    w: WorkflowInstanceState,
    action: ProposedAction,
    actorId: string,
    detail: string,
  ): ReconcileResult {
    this.#audit(null, w, 'action_reconciled', action, `indeterminate: ${detail}`, 'failed', null, { actor_id: actorId });
    const record = this.#enqueueException('processing_error', null, w, detail);
    return { outcome: 'indeterminate', workflow: w, provider_reference: null, exception_id: record.exception_id };
  }

  /**
   * 取回最近一次失败动作的完整快照。
   * 审计提供 `action_id`（重启后仍在），待审批动作存储提供完整动作（含执行幂等 key），
   * 两者都是持久化事实，因此重启后对账依然可用。
   */
  #failedActionOf(workflowInstanceId: string): ProposedAction | null {
    const failed = this.#o.audit_log.query({
      workflow_instance_id: workflowInstanceId,
      action: 'action_failed',
      order: 'desc',
      limit: 1,
    })[0];

    if (failed?.action_id == null) {
      return null;
    }

    return this.#pendingActions.get(failed.action_id)?.action ?? null;
  }

  /** 人工标记异常已处理；结论与处理人一并落库，并追加只追加审计。 */
  resolveException(exceptionId: string, input: ExceptionDecision): ExceptionRecord {
    return this.#closeException(exceptionId, 'resolved', 'exception_resolved', input);
  }

  /** 人工标记异常已丢弃：明确判定该输入不产生任何业务效果。 */
  discardException(exceptionId: string, input: ExceptionDecision): ExceptionRecord {
    return this.#closeException(exceptionId, 'discarded', 'exception_discarded', input);
  }

  #closeException(
    exceptionId: string,
    status: 'resolved' | 'discarded',
    action: 'exception_resolved' | 'exception_discarded',
    input: ExceptionDecision,
  ): ExceptionRecord {
    const record = this.#requireException(exceptionId);
    const actorId = input.actor_id ?? 'control_plane';

    return this.#transaction(() => {
      const updated = status === 'resolved'
        ? this.#o.exception_queue.resolve(exceptionId, input.resolution, actorId, this.#now())
        : this.#o.exception_queue.discard(exceptionId, input.resolution, actorId, this.#now());

      this.#auditException(action, updated, actorId, input.reason ?? input.resolution, 'succeeded', record.status);
      return updated;
    });
  }

  /**
   * 异常重放：把异常队列里保存的原始事件副本重新交给正常 Workflow 路径处理。
   *
   * 设计要点（对应 docs/domain.md「异常队列」与「Workflow Resume 规则」）：
   * - 原始 Event 不可变：重放使用的是异常记录里的信封副本，事件本身没有被修改；
   * - 走正常路径：直接调用 `handleEvent`，因此去重、幂等、状态机校验、审计与 HTTP 入口完全同源；
   * - 不产生重复业务效果：事件存储按 `idempotency_key` 去重，已生效的事件只会返回 `duplicate`；
   * - 可审计：每次重放都追加 `exception_replayed` 审计，并记录结论与操作者。
   *
   * 已 `discarded` 的异常不允许重放：丢弃表示明确判定该输入不应产生业务效果。
   */
  async replayException(exceptionId: string, input: ExceptionDecision): Promise<ExceptionReplayResult> {
    const record = this.#requireException(exceptionId);
    if (record.status === 'discarded') {
      throw new BusinessError('异常已丢弃，不可重放');
    }
    if (record.event === null) {
      throw new BusinessError('该异常没有关联事件，无法重放');
    }

    const actorId = input.actor_id ?? 'control_plane';
    // 重新校验信封：副本可能来自旧版本或损坏的存储，脏数据不得进入流程。
    const event = parseEvent(record.event);
    const result = await this.handleEvent(event);

    if (result.status === 'conflict') {
      this.#transaction(() => {
        this.#auditException('exception_replayed', record, actorId, 'idempotency_key 冲突，重放被拒', 'failed');
      });
      throw new BusinessError('重放被拒：同一 idempotency_key 已存在不同事实');
    }

    const applied = result.status === 'processed' || result.status === 'duplicate';

    const settled = this.#transaction(() => {
      const exception = applied
        ? this.#o.exception_queue.resolve(exceptionId, input.resolution, actorId, this.#now())
        : record;

      this.#auditException(
        'exception_replayed',
        exception,
        actorId,
        input.reason ?? `${input.resolution}（事件处理结果：${result.status}）`,
        applied ? (result.status === 'processed' ? 'succeeded' : 'skipped') : 'failed',
      );
      return exception;
    });

    return {
      exception: settled,
      event_status: result.status,
      workflow_id: result.workflow?.workflow_instance_id ?? null,
    };
  }

  #requireException(exceptionId: string): ExceptionRecord {
    const record = this.#o.exception_queue.get(exceptionId);
    if (record === undefined) {
      throw new BusinessError(`异常记录不存在: ${exceptionId}`);
    }
    return record;
  }

  /**
   * 异常处理结论的审计。
   *
   * 结论本身（`resolution` / `resolved_by` / `resolved_at`）保存在异常记录上，
   * 审计通过 `exception_id` 与它关联，并记录「谁、何时、基于什么原因做了什么决定」。
   */
  #auditException(
    action: 'exception_resolved' | 'exception_discarded' | 'exception_replayed',
    record: ExceptionRecord,
    actorId: string,
    reason: string,
    result: NewAuditEntry['result'],
    beforeState?: ExceptionRecord['status'],
  ): void {
    this.#o.audit_log.append({
      occurred_at: this.#now(),
      actor: { actor_type: 'user', actor_id: actorId },
      action,
      subject: record.subject ?? {
        subject_type: 'exception',
        subject_id: record.exception_id,
        workflow_instance_id: null,
      },
      event_id: record.event_id,
      action_id: null,
      action_type: null,
      before_state: beforeState ?? record.status,
      after_state: record.status,
      reason,
      policy_version: null,
      plan_version: null,
      source: 'control_plane',
      result,
      provider_reference: null,
      provider_receipt: null,
      exception_id: record.exception_id,
    });
  }

  /**
   * 实例离开 `needs_review` 后，等待审批期间入队的 `awaiting_approval` 异常已无人需要处理：
   * 审批、拒绝、重新规划或取消本身就是对那段事实的人工判断，留着 open 只会让异常队列
   * 堆满已完成事项。仍停在 `needs_review` 的实例不动——此时异常还描述着真实待办。
   */
  #settleAwaitingApproval(w: WorkflowInstanceState, actor: string): void {
    if (w.status === 'needs_review') {
      return;
    }
    const open = this.#o.exception_queue.listOpen().filter(
      (record) => record.reason === 'awaiting_approval'
        && record.subject?.workflow_instance_id === w.workflow_instance_id,
    );
    if (open.length === 0) {
      return;
    }
    this.#transaction(() => {
      for (const record of open) {
        const before = record.status;
        const settled = this.#o.exception_queue.resolve(
          record.exception_id,
          '审批已离开 needs_review：等待期间到达的事实已并入规划输入',
          actor,
          this.#now(),
        );
        this.#auditException(
          'exception_resolved',
          settled,
          actor,
          '等待人工审批期间入队的事件已随审批一并处理',
          'succeeded',
          before,
        );
      }
    });
  }

  async #process(e: ParsedEvent, replay: boolean): Promise<{ workflow: WorkflowInstanceState | null; failed: boolean }> {
    if (e.type === 'lead.created') {
      const workflow = this.#transaction(() => {
        const w = this.#create(e);
        this.#audit(e, w, 'event_processed', null, null, 'succeeded');
        this.#o.event_store.markProcessed(e.idempotency_key);
        return w;
      });
      return { workflow, failed: false };
    }

    const prepared = this.#transaction(() => this.#mergeAndPlan(e));
    if (prepared === null) {
      return { workflow: null, failed: false };
    }
    if (prepared.failed === true) {
      return { workflow: prepared.workflow, failed: true };
    }
    if (prepared.action === null) {
      return { workflow: prepared.workflow, failed: false };
    }
    return { workflow: await this.#dispatchAction(prepared.action, prepared.workflow, e, replay), failed: false };
  }

  /**
   * 事务阶段一：事实合并 + 状态推进 + 审计 + Decision/Policy 结论。
   *
   * 需要外部副作用的动作不在本事务内执行，而是作为 `action` 返回，
   * 由 `#dispatch` 在事务之外调用 Executor 后再开事务提交结果。
   * 返回 null 表示事件不匹配任何 Workflow（已写入异常队列并完成处理登记）。
   */
  #mergeAndPlan(
    e: ParsedEvent,
  ): { workflow: WorkflowInstanceState; action: ProposedAction | null; failed?: boolean } | null {
    const w = this.#workflow(e);
    const factOnly = isFactOnlyEvent(e.type);
    /**
     * 事实类事件是否可以触发重新规划。
     *
     * - `running` / `replanning`：此刻没有任何动作在途，事实到来就应该重新规划；
     * - 推导等待（`current_step === 'await_event'`）且事件命中等待集合：等待被满足，可以重新规划；
     * - 派发动作后的等待集合只包含该动作的结果事件，事实类事件不会命中它，
     *   因此在动作在途、以及等待人工审核期间，不会重复规划、重复派发。
     *
     * 「推导等待 + 事实合并后 Decider 输入发生变化」这条额外唤醒规则在下方 `#mergeAndPlan`
     * 内判断，因为它必须比较合并前后的真实 State（例如联系人邮箱是分配之后才登记的）。
     */
    const factOnlyReplans =
      factOnly &&
      w !== undefined &&
      (w.status === 'running' ||
        w.status === 'replanning' ||
        (w.status === 'waiting_result' && w.current_step === 'await_event' && this.#matches(w, e)));

    if (!w) {
      if (factOnly) {
        // 尚无 Workflow 也先保留事实：Contact / Deal 是独立于流程的主体。
        this.#facts(e);
        this.#o.event_store.markProcessed(e.idempotency_key);
        return null;
      }
      // 没有任何 Workflow 认领：事实尚未被消费，因此**不标记 processed**。
      // 事件保持 pending，人工补建 Workflow 后可以通过异常重放把它接进正常路径。
      this.#unmatched(e);
      return null;
    }

    if (isWorkflowTerminal(w.status)) {
      if (factOnly) {
        this.#facts(e);
        return this.#commitFactOnly(w, e);
      }
      /**
       * 终态实例不恢复流程（docs/state-machine.md「Workflow Resume 规则」第 9 条），
       * 但事件确实发生在该主体上：它不是「无人认领」，不能记 `unmatched_event`，
       * 也不能让事件永远停在 `pending`——重放只会走到同一条分支得到同样结论。
       * 这里按事实落库并按 `processed` 消费事件，用 `workflow_ended` 进异常队列交人工
       * 判断是否需要新建后续流程；Workflow 自身保持终态不变。事实本身非法时仍由
       * `#facts` 抛错走 catch，原因保持 `invalid_transition` / `stale_event`。
       */
      this.#facts(e);
      const merged = this.#commitFactOnly(w, e);
      this.#enqueueException('workflow_ended', e, merged.workflow, undefined, 'pending');
      return merged;
    }

    if (w.status === 'waiting_result' && !this.#matches(w, e) && !factOnly) {
      this.#unmatched(e, w);
      return null;
    }

    /**
     * 等待人工审核期间到达的外部事件（非事实类）。
     *
     * `needs_review` 没有可用的迁移触发器，因此不能推进流程；但「事件已经发生」是事实，
     * 不该因为审核没走完就整笔回滚丢掉。这里在**独立事务**中合并可安全合并的事实，
     * 并把事件按 `processed` 消费掉（事实已落库、审计可查），再用 `awaiting_approval`
     * 写进异常队列等人工判断：既不静默覆盖、也不静默丢弃，也不把「等审批」误报成处理失败。
     * 真正非法的事实冲突由 `#facts` 抛错，走上面 catch 返回 failed，原因保持 stale_event。
     */
    if (w.status === 'needs_review' && !factOnly) {
      this.#facts(e);
      const merged = this.#save({ ...w, last_processed_event_id: e.event_id, updated_at: this.#now() });
      this.#audit(e, merged, 'event_processed', null, null, 'succeeded');
      this.#enqueueException('awaiting_approval', e, merged, undefined, 'pending');
      this.#o.event_store.markProcessed(e.idempotency_key);
      return { workflow: merged, action: null, failed: false };
    }

    if (factOnly) {
      const before = this.#decisionFacts(w);
      this.#facts(e);

      /**
       * 派生等待（没有任何动作在途，只是按 State 推导出的集合休眠）时，
       * 事实合并若真的改变了 Decider 的输入就必须重新规划：否则流程会一直等一个
       * 永远不会来的事件——典型是「分配时还没有邮箱，之后才登记 contact.recorded」，
       * 系统会空等一封从未派发的 email.sent。
       * 动作在途（current_step = 动作类型）与 waiting for 人工审核都不在此列，
       * 因此不会重复派发、也不会绕过审批。
       */
      const waking =
        factOnlyReplans || (this.#awaitingDerivedEvents(w) && before !== this.#decisionFacts(w));
      if (!waking) {
        return this.#commitFactOnly(w, e);
      }
    } else {
      this.#facts(e);
    }

    let current: WorkflowInstanceState = {
      ...w,
      last_processed_event_id: e.event_id,
      updated_at: this.#now(),
    };
    if (current.status === 'failed') {
      current = this.#transition(current, 'retry');
    } else if (w.status === 'waiting_result') {
      current = this.#transition(current, 'result_event_matched');
    }
    current = this.#save(current);
    this.#audit(e, current, 'event_processed', null, null, 'succeeded');
    this.#rememberInteraction(e, current);

    const planned = this.#planSync(current, e);
    if (planned.action === null) {
      // 没有需要外部副作用的动作：处理在此事务内完成。
      this.#o.event_store.markProcessed(e.idempotency_key);
    }
    return planned;
  }

  /**
   * 派生等待：流程按当前 State 推导出的等待集合休眠，没有任何动作在途。
   * 与之相对的是「动作已派发、只等该动作的结果事件」（current_step = 动作类型），
   * 后者期间到达的事实不能触发规划，否则会重复派发或绕过审批。
   */
  #awaitingDerivedEvents(w: WorkflowInstanceState): boolean {
    return w.status === 'waiting_result' && w.current_step === 'await_event';
  }

  /**
   * Decision 关心的事实摘要，用于判断一次事实合并是否真的改变了规划输入。
   * 只取 Decider / Policy 读取的字段：其余变化（如 full_name）不值得让 plan_version 抖动。
   */
  #decisionFacts(w: WorkflowInstanceState): string {
    const lead = this.#o.lead_store.get(w.subject_id) ?? null;
    const contact = lead?.contact_id === null || lead?.contact_id === undefined
      ? null
      : this.#o.contact_store.get(lead.contact_id) ?? null;
    const deal = this.#o.deal_store.listByLeadId(w.subject_id)[0] ?? null;

    return JSON.stringify({
      lead: lead === null ? null : { status: lead.status, owner_id: lead.owner_id, contact_id: lead.contact_id },
      contact:
        contact === null
          ? null
          : {
              email: contact.email,
              contactability: contact.contactability,
              contact_preference: contact.contact_preference,
              is_new_contact: contact.is_new_contact,
            },
      deal: deal === null ? null : { stage: deal.stage, amount: deal.amount },
    });
  }

  /** 只合并事实的事件处理收尾：登记处理结果、写审计，不改变 Workflow 状态。 */
  #commitFactOnly(
    w: WorkflowInstanceState,
    e: ParsedEvent,
  ): { workflow: WorkflowInstanceState; action: null } {
    const merged = this.#save({
      ...w,
      last_processed_event_id: e.event_id,
      updated_at: this.#now(),
    });
    this.#audit(e, merged, 'event_processed', null, null, 'succeeded');
    this.#o.event_store.markProcessed(e.idempotency_key);
    return { workflow: merged, action: null };
  }

  #create(e: ParsedEventOf<'lead.created'>): WorkflowInstanceState {
    const p = e.payload;
    if (!this.#o.lead_store.get(p.lead_id)) {
      this.#o.lead_store.save({
        lead_id: p.lead_id,
        source_channel: p.source_channel,
        source_record_id: p.source_record_id,
        company_name: p.company_name,
        contact_id: p.contact_id,
        owner_id: p.initial_owner_id,
        status: 'new',
        created_at: e.occurred_at,
        updated_at: e.occurred_at,
      });
      if (p.contact_id && this.#o.contact_defaults) {
        this.#o.contact_store.save(this.#o.contact_defaults(p.contact_id));
      }
    }
    const key = workflowBusinessKey({ workflow_type: this.#type, subject_type: 'lead', subject_id: p.lead_id });
    const existing = this.#o.workflow_store.findByBusinessKey(key);
    if (existing) {
      return existing;
    }
    const pending: WorkflowInstanceState = {
      workflow_instance_id: `wf_${this.#type}_${p.lead_id}`,
      workflow_type: this.#type,
      subject_type: 'lead',
      subject_id: p.lead_id,
      status: 'pending',
      current_step: 'assignment',
      awaiting_event_types: [],
      plan_version: 1,
      last_processed_event_id: e.event_id,
      failure_classification: null,
      failure_submitted: null,
      failure_retry_after: null,
      failure_retry_attempts: 0,
      failure_next_attempt_at: null,
      previous_decisions: [],
      created_at: e.occurred_at,
      updated_at: this.#now(),
    };
    return this.#save(this.#transition(pending, 'started'));
  }

  /** 把事件合并为当前事实；冲突或违反迁移规则时抛 FactsRejectedError。 */
  #facts(e: ParsedEvent): void {
    switch (e.type) {
      case 'lead.assigned':
      case 'email.sent':
      case 'email.replied':
      case 'meeting.scheduled': {
        const lead = this.#o.lead_store.get(e.payload.lead_id);
        if (!lead) {
          throw new BusinessError('Lead 不存在');
        }
        const t = validateLeadTransition(lead.status, e.type);
        if (!t.allowed) {
          throw new FactsRejectedError('invalid_transition', t.detail);
        }
        this.#o.lead_store.save({
          ...lead,
          owner_id: e.type === 'lead.assigned' ? e.payload.owner_id : lead.owner_id,
          status: t.to[0]!,
          updated_at: e.occurred_at,
        });
        return;
      }
      case 'task.overdue': {
        if (e.payload.lead_id === null) {
          throw new BusinessError('Lead 不存在');
        }
        const lead = this.#o.lead_store.get(e.payload.lead_id);
        if (!lead) {
          throw new BusinessError('Lead 不存在');
        }
        const t = validateLeadTransition(lead.status, e.type);
        if (!t.allowed) {
          throw new FactsRejectedError('invalid_transition', t.detail);
        }
        this.#o.lead_store.save({ ...lead, status: t.to[0]!, updated_at: e.occurred_at });
        return;
      }
      case 'contact.recorded': {
        const p = e.payload;
        const existing = this.#o.contact_store.get(p.contact_id);
        this.#o.contact_store.save({
          contact_id: p.contact_id,
          full_name: p.full_name,
          email: p.email,
          organization_id: p.organization_id,
          contact_preference: p.contact_preference,
          contactability: p.contactability,
          is_new_contact: p.is_new_contact,
          updated_at: e.occurred_at,
        });
        // 回填 Lead → Contact 关联：Lead 由 lead.created 建立时可能只有 contact_id，
        // 也可能完全没有；这里只在缺失时补齐，不覆盖已有事实。
        if (p.lead_id !== null) {
          const lead = this.#o.lead_store.get(p.lead_id);
          if (lead && lead.contact_id === null) {
            this.#o.lead_store.save({ ...lead, contact_id: p.contact_id, updated_at: e.occurred_at });
          }
        }
        if (existing === undefined || existing.email !== p.email || existing.contact_preference !== p.contact_preference) {
          this.#memory.append({
            subject_type: 'contact',
            subject_id: p.contact_id,
            kind: 'preference',
            content: `contact_preference:${p.contact_preference}`,
            occurred_at: e.occurred_at,
            source: e.source,
          });
        }
        return;
      }
      case 'deal.created': {
        const p = e.payload;
        if (this.#o.deal_store.get(p.deal_id)) {
          return;
        }
        const t = validateDealTransition(null, e.type, p.initial_stage);
        if (!t.allowed) {
          throw new FactsRejectedError('invalid_transition', t.detail);
        }
        this.#o.deal_store.save({
          deal_id: p.deal_id,
          lead_id: p.lead_id,
          contact_id: p.contact_id,
          owner_id: p.owner_id,
          stage: p.initial_stage,
          amount: p.amount,
          currency: p.currency,
          expected_close_at: p.expected_close_at,
          outcome: null,
          created_at: e.occurred_at,
          updated_at: e.occurred_at,
        });
        return;
      }
      case 'proposal.sent': {
        const deal = this.#o.deal_store.get(e.payload.deal_id);
        if (!deal) {
          throw new BusinessError('Deal 不存在');
        }
        const t = validateDealTransition(deal.stage, e.type, 'proposal');
        if (!t.allowed) {
          throw new FactsRejectedError('invalid_transition', t.detail);
        }
        this.#o.deal_store.save({ ...deal, stage: 'proposal', updated_at: e.occurred_at });
        return;
      }
      case 'deal.stage_changed': {
        const p = e.payload;
        const deal = this.#o.deal_store.get(p.deal_id);
        if (!deal) {
          throw new BusinessError('Deal 不存在');
        }
        if (deal.stage !== p.from_stage) {
          throw new FactsRejectedError('stale_event', 'Deal 当前阶段与事件冲突');
        }
        const t = validateDealTransition(deal.stage, e.type, p.to_stage);
        if (!t.allowed) {
          throw new FactsRejectedError('invalid_transition', t.detail);
        }
        this.#o.deal_store.save({
          ...deal,
          stage: p.to_stage,
          outcome: p.to_stage === 'won' || p.to_stage === 'lost' ? (p.reason ?? deal.outcome) : deal.outcome,
          updated_at: e.occurred_at,
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * 事务阶段一（同步）：重算 plan_version、评估 Decision 与 Policy，并写出对应审计。
   *
   * 遇需要外部副作用的动作时**不执行**，而是作为 `action` 返回给调用方，
   * 由 `#dispatch` 在事务外调用 Executor。其余结论（Reject / Human Review / 结束）
   * 在本事务内直接落库。Decider 当前至多产出一个动作，因此最多返回一个待派发动作。
   */
  #planSync(
    w: WorkflowInstanceState,
    e: ParsedEvent | null,
  ): { workflow: WorkflowInstanceState; action: ProposedAction | null } {
    const base = w.status === 'running' || w.status === 'replanning' ? w : this.#transition(w, 'result_event_matched');
    const current = this.#save({ ...base, plan_version: base.plan_version + 1, updated_at: this.#now() });
    const ctx = this.#context(current, e?.occurred_at ?? this.#now(), e);
    const actions = this.#o.decider.decide(ctx);

    if (!actions.length) {
      return { workflow: this.#enterWaitOrFinish(current, ctx), action: null };
    }

    let result = current;
    for (const action of actions) {
      this.#pendingActions.put({
        action_id: action.action_id,
        workflow_instance_id: action.workflow_instance_id,
        status: 'pending',
        decision: null,
        decided_by: null,
        decided_at: null,
        proposed_at: this.#now(),
        action: deepFreezeClone(action),
      });
      this.#audit(e, result, 'decision_proposed', action, action.reason, 'pending');

      const outcome = this.#o.policy.evaluate(action, ctx);
      this.#audit(
        e,
        result,
        outcome.decision === 'reject' ? 'policy_rejected' : 'policy_evaluated',
        action,
        reason(outcome),
        outcome.decision === 'auto' ? 'succeeded' : outcome.decision === 'reject' ? 'failed' : 'pending',
      );

      if (outcome.decision === 'reject') {
        // Policy 拒绝也是「已决」：记录停在 pending 会让控制面显示一个永远批不掉的待审动作，
        // 而它和人工拒绝的区别由 decision='policy_rejected' + 审计 action='policy_rejected' 表达。
        this.#markActionDecided(action, 'policy_rejected', 'policy');
        continue;
      }
      if (outcome.decision === 'human_review') {
        result = this.#save(
          result.status === 'replanning'
            ? this.#transition(result, 'replan_completed', 'needs_review')
            : this.#transition(result, 'approval_required'),
        );
        continue;
      }
      return { workflow: result, action };
    }

    // 全部动作都被 Policy 拒绝、或都转为人工审核后没有可派发动作：
    // 仍然要落到明确状态，不能停在 running/replanning 这种「假装还能继续」的状态上。
    if (result.status === 'running' || result.status === 'replanning') {
      return { workflow: this.#enterWaitOrFinish(result, ctx), action: null };
    }
    return { workflow: result, action: null };
  }

  /**
   * 无动作可提时的落点：按当前 State 推导等待事件集合，进入休眠等待；
   * 只有主体已进入终态、确实没有后续事件时才结束 Workflow。
   *
   * 这条规则修正了「Decider 沉默即结束流程」的行为：`meeting.scheduled`、
   * `deal.stage_changed` 等结果事件到达后，Lead 往往还没有终态，
   * 此时结束流程会让后续的 Deal 生命周期再也没有机会被处理。
   */
  #enterWaitOrFinish(current: WorkflowInstanceState, ctx: DecisionContext): WorkflowInstanceState {
    const expected = expectedEventsFor({
      workflow_status: current.status,
      lead: ctx.lead_state,
      deal: ctx.deal_state,
      recent_events: ctx.recent_events,
    });

    if (expected.length === 0) {
      const finished = this.#transitionWithAudit(current, 'workflow_finished', undefined, '无后续事件且主体已终态');
      return finished;
    }

    const waiting = current.status === 'replanning'
      ? this.#transitionWithAudit(current, 'replan_completed', 'waiting_result', '无可执行动作，进入等待')
      : this.#transitionWithAudit(current, 'awaiting_events', undefined, '无可执行动作，进入等待');

    return this.#save({
      ...waiting,
      current_step: 'await_event',
      awaiting_event_types: expected,
    });
  }

  /**
   * 统一的动作派发：自动执行（Policy auto）与人工批准（approve）共用同一套
   * 错误分类、审计与失败状态处理，保证两条路径的 Audit 链路与 failure_* 持久化一致。
   *
   * `replay === true`（崩溃恢复）时不调用外部 Executor，只重建「已派发」状态，
   * 避免重放导致重复外部副作用。
   */
  async #dispatchAction(
    action: ProposedAction,
    current: WorkflowInstanceState,
    e: ParsedEvent | null,
    replay: boolean,
  ): Promise<WorkflowInstanceState> {
    const running = current.status === 'replanning'
      ? this.#transition(current, 'replan_completed', 'running')
      : current;

    let failure: unknown = null;
    let receipt: ExecutionReceipt | null = null;
    if (!replay) {
      // 外部副作用在事务之外执行：不持有 SQLite 写锁，超时也不会阻塞其它写入。
      try {
        const outcome = await this.#o.executor.execute(action);
        // 只取回执三要素：ExecutionResult 还带着 status / action_id 等执行元数据，
        // 它们不属于「提供商回执」，混进审计会让回执字段失去确定含义。
        receipt = {
          provider: outcome.provider,
          provider_reference: outcome.provider_reference,
          correlation_id: outcome.correlation_id,
        };
      } catch (error) {
        failure = error;
      }
    }

    // 结果落库在单一事务内完成（Workflow State + Audit + Event 处理状态）。
    return this.#transaction(() => this.#persistDispatch(action, running, e, failure, receipt));
  }

  /** 事务阶段二（同步）：提交一次派发的结果，成功或失败都整体提交。 */
  #persistDispatch(
    action: ProposedAction,
    running: WorkflowInstanceState,
    e: ParsedEvent | null,
    failure: unknown,
    receipt: ExecutionReceipt | null,
  ): WorkflowInstanceState {
    const result = failure === null
      ? this.#persistDispatchSuccess(action, running, e, receipt)
      : this.#persistDispatchFailure(action, running, e, failure);

    if (e !== null) {
      this.#o.event_store.markProcessed(e.idempotency_key);
    }
    return result;
  }

  #persistDispatchSuccess(
    action: ProposedAction,
    running: WorkflowInstanceState,
    e: ParsedEvent | null,
    receipt: ExecutionReceipt | null,
  ): WorkflowInstanceState {
    this.#failureClassifications.delete(running.workflow_instance_id);
    // 动作已交给 Executor，待审批记录随即作废：避免重启后又被审批一次。
    this.#markActionDecided(action, null, null);
    const dispatched = this.#save({
      ...this.#transition(running, 'action_dispatched'),
      current_step: action.action_type,
      awaiting_event_types: RESULT_EVENTS[action.action_type],
      failure_classification: null,
      failure_submitted: null,
      failure_retry_after: null,
    });
    // 回执必须落到审计：它是「本地 action」与「提供商侧副作用」唯一能对账的凭据。
    this.#audit(e, dispatched, 'action_dispatched', action, null, 'succeeded', receipt);
    return dispatched;
  }

  /** 把待审批记录置为已决；不存在（如自动执行路径）时忽略。 */
  #markActionDecided(
    action: ProposedAction,
    decision: 'approved' | 'rejected' | 'policy_rejected' | null,
    actor: string | null,
  ): void {
    const record = this.#pendingActions.get(action.action_id);
    if (record === undefined || record.status === 'decided') {
      return;
    }
    this.#pendingActions.put({
      ...record,
      status: 'decided',
      decision,
      decided_by: actor,
      decided_at: this.#now(),
    });
  }

  #persistDispatchFailure(
    action: ProposedAction,
    running: WorkflowInstanceState,
    e: ParsedEvent | null,
    error: unknown,
  ): WorkflowInstanceState {
    const classified = classifyExecutionError(error);
    this.#failureClassifications.set(running.workflow_instance_id, classified.classification);
    this.#audit(e, running, 'action_failed', action, `${classified.classification}: ${classified.message}`, 'failed');
    return this.#save({
      ...this.#transition(running, 'processing_error', undefined, msg(error)),
      failure_classification: classified.classification,
      failure_submitted: classified.submitted,
      failure_retry_after: classified.retry_after,
    });
  }

  async #review(
    id: string,
    actionId: string,
    actor: string,
    approved: boolean,
    why: string | null,
  ): Promise<ReviewOutcome> {
    const w = this.#require(id);
    const record = this.#pendingActions.get(actionId);
    const action = record?.action ?? null;
    if (!action || record?.status !== 'pending' || action.workflow_instance_id !== id || w.status !== 'needs_review') {
      throw new BusinessError('审核动作不可用');
    }

    /**
     * 对应 docs/decision-policy.md「Approved」第 2 条：
     * 批准前必须重新读取当前 State，确认动作未过期、未被新事件取代、plan_version 仍有效。
     * 否则人工可能批准一个已经失效的动作（例如 Deal 已 won、联系人已退订、动作已过期），
     * 而审批入口是控制面开放的，不能假设审核人一定看得到最新事实。
     *
     * 失效不能靠抛错来处理：那会让实例永远停在 needs_review，除了 cancel 没有别的推进手段。
     * 正确出口是作废该动作并按当前事实重新规划，把决定权交回 Decider。
     */
    if (approved) {
      const outcome = this.#o.policy.evaluate(action, this.#context(w, this.#now()));
      if (outcome.decision === 'reject') {
        return {
          workflow: await this.#staleActionReplan(w, action, actor, 'action_stale', reason(outcome)),
          stale_action_replanned: true,
        };
      }
    }

    const next = this.#transaction(() => {
      this.#pendingActions.put({
        ...record,
        status: 'decided',
        decision: approved ? 'approved' : 'rejected',
        decided_by: actor,
        decided_at: this.#now(),
      });
      this.#audit(null, w, approved ? 'action_approved' : 'action_rejected', action, why ?? actor, approved ? 'succeeded' : 'skipped');

      /**
       * 拒绝结论写进 State 而不是进程内存：已拒动作是新的规划约束，
       * 只存内存会在重启后立刻失效，同一动作会被 Decider 原样重新提出，等于人工白拒一次。
       *
       * `basis_event_id` 锚定约束的有效期：同一条事件还在处理位上时阻断重提（防止拒绝后立刻拉锯），
       * 新事件进入后解封，但 Decider 会强制该动作 `requires_approval`，不会绕过这次人工拒绝自动执行。
       */
      const rejection: PreviousDecision | null = approved
        ? null
        : {
            action_id: action.action_id,
            action_type: action.action_type,
            status: 'rejected',
            plan_version: action.plan_version,
            decided_by: actor,
            reason: why,
            decided_at: this.#now(),
            basis_event_id: w.last_processed_event_id,
          };

      const base = this.#transition(w, approved ? 'approval_granted' : 'approval_rejected');
      return this.#save({
        ...base,
        plan_version: w.plan_version + 1,
        previous_decisions:
          rejection === null ? (base.previous_decisions ?? []) : [...(base.previous_decisions ?? []), rejection],
      });
    });

    if (!approved) {
      const planned = this.#transaction(() => this.#planSync(next, null));
      if (planned.action === null) {
        return { workflow: planned.workflow, stale_action_replanned: false };
      }
      return {
        workflow: await this.#dispatchAction(planned.action, planned.workflow, null, false),
        stale_action_replanned: false,
      };
    }

    return { workflow: await this.#dispatchAction(action, next, null, false), stale_action_replanned: false };
  }

  /**
   * 待审动作失效（被新事实取代 / 人工要求重来）时的统一出口：
   * 作废该动作，再基于当前 State 重新规划，让实例离开 needs_review。
   *
   * 作废不写拒绝结论（decision=null）：被取代只是「计划过时了」，不是否决这个动作类型，
   * 写进 previous_decisions 会让 Decider 永久避开它，重新规划反而比审批死锁更糟。
   * 「策略拒发」由 Policy 的 policy_rejected 结论表达，人工拒绝才写 previous_decisions。
   */
  async #staleActionReplan(
    w: WorkflowInstanceState,
    action: ProposedAction | null,
    actor: string,
    auditAction: 'action_stale' | 'replan_requested',
    reasonText: string,
  ): Promise<WorkflowInstanceState> {
    const planned = this.#transaction(() => {
      if (action !== null) {
        this.#markActionDecided(action, null, actor);
      }
      this.#audit(null, w, auditAction, action, reasonText, 'skipped');
      // 外部副作用必须留在事务之外，因此这里只把规划做完，派发放到事务提交后。
      return this.#planSync(this.#save(this.#transition(w, 'stale_action')), null);
    });

    if (planned.action === null) {
      return planned.workflow;
    }
    return this.#dispatchAction(planned.action, planned.workflow, null, false);
  }

  /**
   * 判定时刻 `evaluated_at` 来自触发事件的事实时间 `occurred_at`，而不是服务器本地时钟：
   * 事件驱动路径必须可复现，同一事件在任何时刻处理都得到同一结论。
   * 只有控制面操作（approve/reject/cancel 等没有事件的操作）才回退到注入时钟。
   */
  #context(w: WorkflowInstanceState, evaluatedAt: string, current: ParsedEvent | null = null): DecisionContext {
    const lead = this.#o.lead_store.get(w.subject_id) ?? null;
    const defaults: VerifiedConfig = {
      first_touch_email_template_id: 'tpl_first_touch',
      proposal_document_reference: null,
      default_meeting_duration_minutes: 30,
    };
    const policy = this.#o.policy_context?.(w, evaluatedAt) ?? ({
      policy_version: 'policy_v1',
      evaluated_at: evaluatedAt,
      automation_whitelist: ['send_email', 'create_task'],
      permitted_action_types: [
        'send_email',
        'schedule_meeting',
        'create_task',
        'send_proposal',
        'advance_deal_stage',
      ],
      permitted_actor_ids: lead?.owner_id ? [lead.owner_id] : [],
      business_timezone_offset_minutes: 480,
      send_window: { start_hour: 9, end_hour: 18 },
      max_auto_actions_per_day: 100,
      auto_actions_today: 0,
      key_account_lead_ids: [],
      high_value_deal_threshold: 500000,
    } satisfies PolicyContext);

    return {
      workflow_instance: w,
      lead_state: lead,
      contact_state: lead?.contact_id ? this.#o.contact_store.get(lead.contact_id) ?? null : null,
      deal_state: this.#o.deal_store.listByLeadId(w.subject_id)[0] ?? null,
      verified_config: this.#o.verified_config ?? defaults,
      recent_events: this.#recentEvents(w, current),
      memory: summarizeMemory(this.#memoryEntries(w)),
      pending_tasks: this.#o.pending_tasks?.(w) ?? derivePendingTasks({
        events: this.#recentEvents(w, current),
        audit_entries: this.#o.audit_log.query({
          workflow_instance_id: w.workflow_instance_id,
          action: 'action_dispatched',
          action_type: 'create_task',
        }),
        workflow_instance_id: w.workflow_instance_id,
        lead_id: lead?.lead_id ?? null,
      }),
      policy_context: policy,
      previous_decisions: w.previous_decisions ?? [],
      idempotency_context: { input_event_id: w.last_processed_event_id ?? '', processed_idempotency_keys: [] },
      data_conflicts: [],
    };
  }

  /**
   * 本主体最近的不可变事件（Decision Context 的事实窗口）。
   *
   * 只包含**已确认的事实**：`processed` 的事件才真正被合并进 State。
   * 仍是 `pending` 的事件（处理失败或还没被任何 Workflow 认领）不是「已经发生过的业务事实」，
   * 把它当成已发生会同时造成两个后果：Decider 误判「邮件已经发过」而不再提出首次跟进，
   * 以及推导等待集合把该事件剔除，使它即便被人工重放也无法再匹配。
   *
   * 例外是**本次正在处理的事件**：它此刻仍是 `pending`，但它是这次判断的输入事实之一，必须可见。
   *
   * 只查询当前 Lead（`EventStore.listByLeadId` 走索引），不读取整个事件日志。
   */
  #recentEvents(w: WorkflowInstanceState, current: ParsedEvent | null = null): readonly ParsedEvent[] {
    if (w.subject_type !== 'lead') {
      return current === null ? [] : [current];
    }

    const processed = this.#o.event_store
      .listByLeadId(w.subject_id, RECENT_EVENT_LIMIT)
      .filter((stored) => stored.processing_status === 'processed');

    if (current === null || processed.some((stored) => stored.event.event_id === current.event_id)) {
      return processed.map((stored) => stored.event);
    }

    return [current, ...processed.map((stored) => stored.event)];
  }

  /**
   * 与当前 Workflow 相关的 Memory 记录：主体的互动（按 Lead）与联系人的偏好（按 Contact）。
   * Memory 是历史证据，不能反过来变成当前事实，因此只读不写。
   */
  #memoryEntries(w: WorkflowInstanceState): readonly MemoryEntry[] {
    const leadId = w.subject_type === 'lead' ? w.subject_id : null;
    const lead = leadId === null ? undefined : this.#o.lead_store.get(leadId);
    const contactId = lead?.contact_id ?? null;

    return [
      ...this.#memory.list(w.subject_id),
      ...(contactId === null ? [] : this.#memory.list(contactId)),
    ];
  }

  /** 结果类事件表示与客户之间真实发生过互动，写入 Memory 作为历史证据。 */
  #rememberInteraction(e: ParsedEvent, w: WorkflowInstanceState): void {
    if (!INTERACTION_EVENTS.includes(e.type)) {
      return;
    }

    this.#memory.append({
      subject_type: w.subject_type,
      subject_id: w.subject_id,
      kind: 'interaction',
      content: e.type,
      occurred_at: e.occurred_at,
      source: e.source,
    });
  }

  #workflow(e: ParsedEvent): WorkflowInstanceState | undefined {
    const id = leadIdOfEvent(e);
    if (!id) {
      return undefined;
    }
    return this.#o.workflow_store.findByBusinessKey(
      workflowBusinessKey({ workflow_type: this.#type, subject_type: 'lead', subject_id: id }),
    );
  }

  /** 结果事件必须匹配等待条件、实例与主体；payload 缺失 lead_id 时以 workflow_instance_id 绑定主体。 */
  #matches(w: WorkflowInstanceState, e: ParsedEvent): boolean {
    if (!w.awaiting_event_types.includes(e.type)) {
      return false;
    }
    const instanceId = workflowInstanceIdOfEvent(e);
    if (instanceId && instanceId !== w.workflow_instance_id) {
      return false;
    }
    const leadId = leadIdOfEvent(e);
    return leadId != null ? leadId === w.subject_id : Boolean(instanceId);
  }

  #require(id: string): WorkflowInstanceState {
    const w = this.#o.workflow_store.get(id);
    if (!w) {
      throw new WorkflowNotFoundError(id);
    }
    return w;
  }

  #save<T extends WorkflowInstanceState>(s: T): T {
    return this.#o.workflow_store.save(deepFreezeClone(s)) as T;
  }

  /**
   * 事务边界：一次处理中的多个 Store 写入要么全部提交，要么整体回滚。
   * 未注入 `unit_of_work` 时直接执行（InMemory 场景无需事务）。回调必须是同步的。
   */
  #transaction<T>(fn: () => T): T {
    const unitOfWork = this.#o.unit_of_work;
    return unitOfWork === undefined ? fn() : unitOfWork.run(fn);
  }

  #transition(w: WorkflowInstanceState, tr: WorkflowTrigger, target?: WorkflowStatus, why?: string): WorkflowInstanceState {
    const r = validateWorkflowTransition(w.status, tr);
    if (!r.allowed) {
      throw new FactsRejectedError('invalid_transition', why ?? r.detail);
    }
    const status = target ?? r.to[0]!;
    if (!r.to.includes(status)) {
      throw new BusinessError('非法 Workflow 状态');
    }
    return {
      ...w,
      status,
      updated_at: this.#now(),
      awaiting_event_types: status === 'waiting_result' ? w.awaiting_event_types : [],
    };
  }

  /**
   * 带审计的状态迁移。
   *
   * docs/state-machine.md「Workflow Resume 规则」第 10 条要求「状态迁移必须追加 Audit Log」，
   * 而工作流自身的状态变化（进入等待、结束、重规划）此前没有对应审计记录。
   */
  #transitionWithAudit(
    w: WorkflowInstanceState,
    tr: WorkflowTrigger,
    target: WorkflowStatus | undefined,
    why: string,
    actorId?: string,
  ): WorkflowInstanceState {
    const before = w.status;
    const next = this.#save(this.#transition(w, tr, target, why));

    this.#o.audit_log.append({
      occurred_at: this.#now(),
      actor: actorId === undefined ? { actor_type: 'system', actor_id: 'workflow_engine' } : { actor_type: 'user', actor_id: actorId },
      action: 'state_transitioned',
      subject: this.#subject(next),
      event_id: w.last_processed_event_id,
      action_id: null,
      action_type: null,
      before_state: before,
      after_state: next.status,
      reason: why,
      policy_version: null,
      plan_version: next.plan_version,
      source: 'workflow_engine',
      result: 'succeeded',
      provider_reference: null,
      provider_receipt: null,
      exception_id: null,
    });

    return next;
  }

  #unmatched(e: ParsedEvent, w?: WorkflowInstanceState): void {
    this.#enqueueException('unmatched_event', e, w ?? null);
  }

  /**
   * 统一异常写入：异常队列是降级安全网，因此先入队保证失败可被记录；
   * 随后尽力追加一条 `exception_enqueued` 审计（docs/domain.md「异常记录本身也必须追加一条 AuditEntry」）。
   * 当审计存储不可用（如磁盘满）时，不阻断异常入队，异常仍可被人工处理。
   *
   * 同一 (event_id, reason) 已有未关闭异常时直接返回既有记录，不重复入队也不重复审计：
   * 事件保持 pending，重复投递会原样再走到这里，`processing_error` / `idempotency_conflict` /
   * `invalid_transition` 与 `unmatched_event` 一样会被同一条事件按同一原因刷满队列。
   * 没有关联事件（e 为 null）时无从比对，保持每次都入队。
   *
   * `auditResult` 表达该异常的严重度：真正没处理成功用 `failed`（默认）；
   * `awaiting_approval` 这类「事件已正常消费、只是流程在等人」的入队记 `pending`，
   * 否则监控会把每次等待审批都当成一次处理失败。
   */
  #enqueueException(
    reason: ExceptionReason,
    e: ParsedEvent | null,
    subject: WorkflowInstanceState | null,
    detail?: string,
    auditResult: NewAuditEntry['result'] = 'failed',
  ): ExceptionRecord {
    if (e !== null) {
      const duplicate = this.#o.exception_queue
        .listOpen()
        .find((record) => record.event_id === e.event_id && record.reason === reason);
      if (duplicate !== undefined) {
        return duplicate;
      }
    }

    const record = this.#o.exception_queue.enqueue({
      occurred_at: this.#now(),
      reason,
      event_id: e?.event_id ?? null,
      event: e,
      subject: subject ? this.#subject(subject) : null,
    });
    try {
      this.#audit(e, subject, 'exception_enqueued', null, detail ?? reason, auditResult, null, {
        exception_id: record.exception_id,
      });
    } catch {
      // 审计不可用时不阻断异常入队。
    }
    return record;
  }

  #subject(w: WorkflowInstanceState): { subject_type: string; subject_id: string; workflow_instance_id: string } {
    return { subject_type: w.subject_type, subject_id: w.subject_id, workflow_instance_id: w.workflow_instance_id };
  }

  /**
   * 统一审计写入。
   *
   * `receipt` 是本次**执行**拿到的提供商回执快照，单独放在 `provider_receipt` 字段；
   * 顶层 `provider_reference` 仍遵循 docs/domain.md「Audit 契约」：结果事件携带回执时，
   * 该事件下的全部审计记录共享同一值。事件没有回执时（例如 `lead.assigned` 触发的首次外发、
   * 或控制面审批），才用执行回执的标识补齐，保证「动作打到了哪个提供商」始终可追溯。
   */
  #audit(
    e: ParsedEvent | null,
    w: WorkflowInstanceState | null,
    action: NewAuditEntry['action'],
    a: ProposedAction | null,
    why: string | null,
    result: NewAuditEntry['result'],
    receipt: ExecutionReceipt | null = null,
    extra: { actor_id?: string; exception_id?: string | null; event_id?: string | null } = {},
  ): void {
    this.#o.audit_log.append({
      occurred_at: this.#now(),
      actor: { actor_type: extra.actor_id === undefined ? 'system' : 'user', actor_id: extra.actor_id ?? 'workflow_engine' },
      action,
      subject: w ? this.#subject(w) : { subject_type: 'event', subject_id: e?.event_id ?? 'unknown', workflow_instance_id: null },
      event_id: e?.event_id ?? extra.event_id ?? null,
      action_id: a?.action_id ?? null,
      action_type: a?.action_type ?? null,
      before_state: null,
      after_state: w?.status ?? null,
      reason: why,
      policy_version: a?.policy_version ?? null,
      plan_version: a?.plan_version ?? w?.plan_version ?? null,
      source: e?.source ?? 'workflow_engine',
      result,
      provider_reference: providerReferenceOfEvent(e) ?? receipt?.provider_reference ?? null,
      provider_receipt: receipt,
      exception_id: extra.exception_id ?? null,
    });
  }
}

function reason(o: PolicyOutcome): string {
  return o.decision === 'auto'
    ? o.satisfied_conditions.join(',')
    : o.reasons.map((x) => `${x.code}: ${x.detail}`).join('; ');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
