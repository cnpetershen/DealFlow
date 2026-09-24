import type { ParsedEvent } from '../events/dictionary';
import type {
  AuditEntry,
  ContactState,
  DealState,
  ExceptionRecord,
  LeadState,
  NewAuditEntry,
  NewException,
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
  list(): readonly StoredEvent[];
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
}

/** 异常队列：承载无法安全自动处理的输入，既不丢弃也不覆盖当前事实。 */
export interface ExceptionQueueStore {
  enqueue(input: NewException): ExceptionRecord;
  get(exceptionId: string): ExceptionRecord | undefined;
  list(): readonly ExceptionRecord[];
  listOpen(): readonly ExceptionRecord[];
  resolve(exceptionId: string, resolution: string): ExceptionRecord;
  discard(exceptionId: string, resolution: string): ExceptionRecord;
}

/** State 只存当前事实。 */
export interface StateStore<T> {
  get(id: string): T | undefined;
  save(state: T): T;
  list(): readonly T[];
}

export interface WorkflowStateStore extends StateStore<WorkflowInstanceState> {
  /** 按业务幂等 key 查找唯一实例，避免同一业务对象产生第二条并行流程。 */
  findByBusinessKey(businessKey: string): WorkflowInstanceState | undefined;
}

export class WorkflowBusinessKeyConflictError extends Error {
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

export class ExceptionNotFoundError extends Error {
  constructor(readonly exceptionId: string) {
    super(`异常记录不存在: ${exceptionId}`);
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
export type DealStateStore = StateStore<DealState>;
export type ContactStateStore = StateStore<ContactState>;