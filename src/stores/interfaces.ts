import type { ActionType } from '../decision/types';
import type { ParsedEvent } from '../events/dictionary';
import { BusinessError } from '../errors';
import type {
  AuditAction,
  AuditEntry,
  AuditResult,
  ContactState,
  DealState,
  ExceptionRecord,
  LeadState,
  MemoryEntry,
  NewAuditEntry,
  NewException,
  NewMemoryEntry,
  PendingActionRecord,
  WorkflowInstanceState,
} from './types';

/**
 * 事件的落库状态。
 * - `pending`：已落库但尚未处理成功，重复投递需要重试处理
 * - `processed`：已处理成功，重复投递不得产生第二次业务效果
 */
export type EventProcessingStatus = 'pending' | 'processed';

/** 已落库的不可变事件，信封本身不再改变，仅落库状态可推进。 */
export interface StoredEvent {
  /** 接收顺序，从 1 开始单调递增，作为处理游标。 */
  readonly sequence: number;
  readonly event: ParsedEvent;
  readonly processing_status: EventProcessingStatus;
}

/**
 * 事件投递结果。
 * - `appended`：新事实，需要处理
 * - `retry`：同一事实已落库但未处理成功，需用同一 key 重试
 * - `duplicate`：同一事实已处理成功，不重复执行
 * - `conflict`：同一 idempotency_key 携带不同事实，拒绝覆盖
 */
export type AppendEventResult =
  | { readonly status: 'appended'; readonly stored: StoredEvent }
  | { readonly status: 'retry'; readonly stored: StoredEvent }
  | { readonly status: 'duplicate'; readonly stored: StoredEvent }
  | { readonly status: 'conflict'; readonly existing: StoredEvent };

/** Event 只追加，不可修改。 */
export interface EventStore {
  /** 按 idempotency_key 去重并登记事件；同一 key 的不同事实会被拒绝。 */
  append(event: ParsedEvent): AppendEventResult;
  /** 标记处理成功，此后同一事件的重复投递返回 duplicate。 */
  markProcessed(idempotencyKey: string): StoredEvent;
  getByIdempotencyKey(idempotencyKey: string): StoredEvent | undefined;
  /**
   * 按 `event_id` 精确取回单条事件。
   *
   * 重试路径要按 `last_processed_event_id` 找回「最近一次处理的事件」；
   * 走 `list().find()` 等于每次重试都全表扫一遍事件日志，且历史只增不减。
   * 持久化实现必须走索引（见 `sqlite-db.ts` 中的表达式索引）。
   */
  getByEventId(eventId: string): StoredEvent | undefined;
  list(): readonly StoredEvent[];
  /**
   * 按 Lead 查询该主体的事件，**按 sequence 倒序取最近 limit 条**。
   *
   * 引擎每处理一个事件都要构造 Decision Context，必须只读取与当前主体相关的事件：
   * 对整个事件日志做 `list()` 会让处理耗时随事件总量线性增长（实测 20k 事件时单事件 1.4s）。
   * 持久化实现必须走索引（见 `sqlite-db.ts` 中的表达式索引）。
   */
  listByLeadId(leadId: string, limit: number): readonly StoredEvent[];
}

/**
 * 可选的跨进程处理租约：防止多个 worker 同时处理同一 pending 事件。
 * 基本 EventStore 不要求实现；支持持久化/多进程的实现应提供。
 */
export interface ClaimableEventStore extends EventStore {
  /** 尝试获取处理租约；已 processed、不存在或租约被他人持有且未过期时返回 false。 */
  tryClaim(idempotencyKey: string, claimId: string, nowMs: number, leaseMs: number): boolean;
  /** 释放自己的租约；他人的租约不受影响。 */
  releaseClaim(idempotencyKey: string, claimId: string): void;
}

export function isClaimableEventStore(store: EventStore): store is ClaimableEventStore {
  return (
    typeof (store as Partial<ClaimableEventStore>).tryClaim === 'function' &&
    typeof (store as Partial<ClaimableEventStore>).releaseClaim === 'function'
  );
}

/** Audit Log 只追加，不可修改。 */
export interface AuditLogStore {
  append(entry: NewAuditEntry): AuditEntry;
  get(auditId: string): AuditEntry | undefined;
  list(): readonly AuditEntry[];
  /** 查询某个事件引发的完整处理链路。 */
  listByEventId(eventId: string): readonly AuditEntry[];
  /** 查询某个 ProposedAction 的审批与执行链路。 */
  listByActionId(actionId: string): readonly AuditEntry[];
  /**
   * 按条件查询审计记录，**默认按写入顺序倒序**（最近的在前）。
   *
   * 审计日志只增不减，任何「读全表再内存过滤」的调用都会随运行时间线性变慢
   * （`auto_actions_today` 计数、按实例追溯审批链路、控制面查询都属于此类）。
   */
  query(filter: AuditQuery): readonly AuditEntry[];
  /** 统计符合条件的记录条数；持久化实现应使用 COUNT 而不物化记录本体。 */
  count(filter: AuditQuery): number;
}

export interface AuditQuery {
  readonly workflow_instance_id?: string;
  readonly event_id?: string;
  readonly action_id?: string;
  readonly action?: AuditAction;
  readonly action_type?: ActionType;
  readonly result?: AuditResult;
  /** 只返回 occurred_at >= 该时间的记录（ISO-8601 带时区）。 */
  readonly occurred_at_from?: string;
  /** 只返回 occurred_at <= 该时间的记录（ISO-8601 带时区）。 */
  readonly occurred_at_to?: string;
  /** 最近 N 条；不传表示不限制。 */
  readonly limit?: number;
  /**
   * 返回顺序。`desc`（默认）按写入顺序倒序，适合「最近发生了什么」的运维查询；
   * `asc` 按写入顺序正序，适合「一条链路的完整先后」追溯。
   */
  readonly order?: 'asc' | 'desc';
}

/** 异常队列：承载无法安全自动处理的输入，既不丢弃也不覆盖当前事实。 */
export type ExceptionStatus = ExceptionRecord['status'];

/**
 * 分页选项：把 limit/offset 下推给存储层。
 *
 * 控制面列表接口若先 `list()` 全表再内存截断，每次翻页都要物化全部记录并逐条 JSON.parse；
 * 记录数随运行时间增长，这会让 `/workflows`、`/exceptions` 越跑越慢。
 */
export interface ListOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/** 按状态过滤的列表选项；状态是 exceptions 表的真实列（有索引）。 */
export interface StatusedListOptions extends ListOptions {
  readonly status?: ExceptionStatus;
}

export interface ExceptionQueueStore {
  enqueue(input: NewException): ExceptionRecord;
  get(exceptionId: string): ExceptionRecord | undefined;
  list(options?: StatusedListOptions): readonly ExceptionRecord[];
  listOpen(options?: ListOptions): readonly ExceptionRecord[];
  /** 记录条数；持久化实现用 COUNT(*)，不物化记录本体。 */
  count(status?: ExceptionStatus): number;
  /**
   * 标记异常已处理（人工给出结论）。
   * 处理结论必须能回答「谁、何时、为什么」，因此会一并记录 `resolved_by` / `resolved_at`；
   * 调用方（引擎控制面入口）负责同时追加 Audit Log。
   */
  resolve(exceptionId: string, resolution: string, actorId?: string, resolvedAt?: string): ExceptionRecord;
  /** 标记异常已丢弃：明确判定该输入不应产生任何业务效果。 */
  discard(exceptionId: string, resolution: string, actorId?: string, resolvedAt?: string): ExceptionRecord;
}

/** State 只存当前事实。 */
export interface StateStore<T> {
  get(id: string): T | undefined;
  save(state: T): T;
  list(): readonly T[];
}

/**
 * Memory：历史互动、摘要与偏好。只追加、可检索，供 Decision Context 使用。
 * 它记录的是「发生过什么」，因此不提供修改与删除。
 */
export interface MemoryStore {
  append(entry: NewMemoryEntry): MemoryEntry;
  /** 某个主体（通常是 Lead）的全部记忆，按写入顺序返回。 */
  list(subjectId: string): readonly MemoryEntry[];
  listAll(): readonly MemoryEntry[];
}

/**
 * 待审批动作存储：让 Human Review 在进程重启后仍然可审批。
 * 保存动作快照而非仅保存 action_id，避免重启后依赖内存中的动作表。
 */
export interface PendingActionStore {
  put(record: PendingActionRecord): PendingActionRecord;
  get(actionId: string): PendingActionRecord | undefined;
  /** 该 Workflow 当前处于 pending 的动作；没有则返回 undefined。 */
  getPending(workflowInstanceId: string): PendingActionRecord | undefined;
  list(): readonly PendingActionRecord[];
}

/** 按状态分页列 Workflow 实例的查询条件。 */
export interface WorkflowListOptions extends ListOptions {
  readonly status?: string;
}

export interface WorkflowStateStore extends StateStore<WorkflowInstanceState> {
  /** 按业务幂等 key 查找唯一实例，避免同一业务对象产生第二条并行流程。 */
  findByBusinessKey(businessKey: string): WorkflowInstanceState | undefined;
  /**
   * 分页列表（默认按 workflow_instance_id 升序，翻页顺序稳定）。
   * `status` / `limit` / `offset` 下推到存储层，避免「全表物化再内存截断」。
   */
  list(query?: WorkflowListOptions): readonly WorkflowInstanceState[];
  /** 记录条数（可按状态过滤）；持久化实现用 COUNT(*)。 */
  count(status?: string): number;
  /** 按状态分组计数，供 `/metrics` 抓取时不再物化每个实例的完整 JSON。 */
  countByStatus(): Readonly<Record<string, number>>;
}

export class WorkflowBusinessKeyConflictError extends BusinessError {
  constructor(
    readonly businessKey: string,
    readonly existingInstanceId: string,
    readonly conflictingInstanceId: string,
  ) {
    super(
      `业务 key ${businessKey} 已由实例 ${existingInstanceId} 占用，拒绝创建第二条流程 ${conflictingInstanceId}`,
    );
    this.name = 'WorkflowBusinessKeyConflictError';
  }
}

export class ExceptionNotFoundError extends BusinessError {
  constructor(readonly exceptionId: string) {
    super(`异常记录不存在: ${exceptionId}`, 404);
    this.name = 'ExceptionNotFoundError';
  }
}

export class EventNotAppendedError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`idempotency_key 未登记，无法标记处理结果: ${idempotencyKey}`);
    this.name = 'EventNotAppendedError';
  }
}

export type LeadStateStore = StateStore<LeadState>;

/**
 * Deal 必须能按 `lead_id` 反查。
 *
 * `#context` 每处理一个事件都要读一次本线索的成交阶段：全表 `list()` 再内存 `find()`
 * 会让单事件耗时随 Deal 总量线性增长。持久化实现配合
 * `idx_entity_state_lead` 表达式索引走索引查找。
 */
export interface DealStateStore extends StateStore<DealState> {
  listByLeadId(leadId: string): readonly DealState[];
}

export type ContactStateStore = StateStore<ContactState>;