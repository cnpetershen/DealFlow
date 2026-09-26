import type { ParsedEvent } from '../events/dictionary';
import type {
  AppendEventResult,
  AuditLogStore,
  AuditQuery,
  EventStore,
  ExceptionQueueStore,
  ExceptionStatus,
  ListOptions,
  MemoryStore,
  PendingActionStore,
  StateStore,
  StatusedListOptions,
  StoredEvent,
  WorkflowListOptions,
  WorkflowStateStore,
} from './interfaces';
import {
  EventNotAppendedError,
  ExceptionNotFoundError,
  WorkflowBusinessKeyConflictError,
} from './interfaces';
import { deepFreezeClone, describesSameFact, pendingOf } from './shared';
import type {
  AuditEntry,
  ExceptionRecord,
  MemoryEntry,
  NewAuditEntry,
  NewException,
  NewMemoryEntry,
  PendingActionRecord,
  WorkflowInstanceState,
} from './types';
import { workflowBusinessKey } from './types';

export class InMemoryEventStore implements EventStore {
  readonly #byIdempotencyKey = new Map<string, StoredEvent>();
  readonly #events: StoredEvent[] = [];

  append(event: ParsedEvent): AppendEventResult {
    const existing = this.#byIdempotencyKey.get(event.idempotency_key);

    if (existing !== undefined) {
      if (!describesSameFact(existing.event, event)) {
        return { status: 'conflict', existing };
      }

      return existing.processing_status === 'processed'
        ? { status: 'duplicate', stored: existing }
        : { status: 'retry', stored: existing };
    }

    const stored: StoredEvent = deepFreezeClone({
      sequence: this.#events.length + 1,
      event,
      processing_status: 'pending' as const,
    });

    this.#events.push(stored);
    this.#byIdempotencyKey.set(event.idempotency_key, stored);

    return { status: 'appended', stored };
  }

  markProcessed(idempotencyKey: string): StoredEvent {
    const existing = this.#byIdempotencyKey.get(idempotencyKey);

    if (existing === undefined) {
      throw new EventNotAppendedError(idempotencyKey);
    }

    if (existing.processing_status === 'processed') {
      return existing;
    }

    const updated: StoredEvent = deepFreezeClone({ ...existing, processing_status: 'processed' as const });
    this.#byIdempotencyKey.set(idempotencyKey, updated);
    this.#events[existing.sequence - 1] = updated;

    return updated;
  }

  getByIdempotencyKey(idempotencyKey: string): StoredEvent | undefined {
    return this.#byIdempotencyKey.get(idempotencyKey);
  }

  getByEventId(eventId: string): StoredEvent | undefined {
    return this.#events.find((stored) => stored.event.event_id === eventId);
  }

  list(): readonly StoredEvent[] {
    return [...this.#events];
  }

  listByLeadId(leadId: string, limit: number): readonly StoredEvent[] {
    const matched: StoredEvent[] = [];

    for (let index = this.#events.length - 1; index >= 0 && matched.length < limit; index -= 1) {
      const stored = this.#events[index]!;
      if (stored.event.payload.lead_id === leadId) {
        matched.push(stored);
      }
    }

    return matched;
  }
}

export class InMemoryAuditLog implements AuditLogStore {
  readonly #entries: AuditEntry[] = [];

  append(entry: NewAuditEntry): AuditEntry {
    const stored: AuditEntry = deepFreezeClone({
      ...entry,
      audit_id: `audit_${this.#entries.length + 1}`,
    });

    this.#entries.push(stored);

    return stored;
  }

  get(auditId: string): AuditEntry | undefined {
    return this.#entries.find((entry) => entry.audit_id === auditId);
  }

  list(): readonly AuditEntry[] {
    return [...this.#entries];
  }

  listByEventId(eventId: string): readonly AuditEntry[] {
    return this.query({ event_id: eventId, order: 'asc' });
  }

  listByActionId(actionId: string): readonly AuditEntry[] {
    return this.query({ action_id: actionId, order: 'asc' });
  }

  query(filter: AuditQuery): readonly AuditEntry[] {
    const matched = this.#entries.filter((entry) => matchesAuditQuery(entry, filter));
    const ordered = filter.order === 'asc' ? matched : [...matched].reverse();

    return filter.limit === undefined ? ordered : ordered.slice(0, filter.limit);
  }

  count(filter: AuditQuery): number {
    return this.#entries.filter((entry) => matchesAuditQuery(entry, filter)).length;
  }
}

/**
 * 审计查询条件判定。InMemory 与持久化实现共用，保证两端语义一致。
 * 注意 `limit` 由调用方单独处理，不属于「是否匹配」。
 */
export function matchesAuditQuery(entry: AuditEntry, filter: AuditQuery): boolean {
  if (filter.workflow_instance_id !== undefined && entry.subject.workflow_instance_id !== filter.workflow_instance_id) {
    return false;
  }
  if (filter.event_id !== undefined && entry.event_id !== filter.event_id) {
    return false;
  }
  if (filter.action_id !== undefined && entry.action_id !== filter.action_id) {
    return false;
  }
  if (filter.action !== undefined && entry.action !== filter.action) {
    return false;
  }
  if (filter.action_type !== undefined && entry.action_type !== filter.action_type) {
    return false;
  }
  if (filter.result !== undefined && entry.result !== filter.result) {
    return false;
  }
  if (filter.occurred_at_from !== undefined && Date.parse(entry.occurred_at) < Date.parse(filter.occurred_at_from)) {
    return false;
  }
  if (filter.occurred_at_to !== undefined && Date.parse(entry.occurred_at) > Date.parse(filter.occurred_at_to)) {
    return false;
  }
  return true;
}

export class InMemoryExceptionQueue implements ExceptionQueueStore {
  readonly #records = new Map<string, ExceptionRecord>();

  enqueue(input: NewException): ExceptionRecord {
    const record: ExceptionRecord = deepFreezeClone({
      ...input,
      exception_id: `exc_${this.#records.size + 1}`,
      status: 'open' as const,
      resolution: null,
      resolved_by: null,
      resolved_at: null,
    });

    this.#records.set(record.exception_id, record);

    return record;
  }

  get(exceptionId: string): ExceptionRecord | undefined {
    return this.#records.get(exceptionId);
  }

  list(options?: StatusedListOptions): readonly ExceptionRecord[] {
    const matched =
      options?.status === undefined ? [...this.#records.values()] : this.listByStatus(options.status);
    return applyPage(matched, options);
  }

  listOpen(options?: ListOptions): readonly ExceptionRecord[] {
    return this.list({ ...options, status: 'open' });
  }

  count(status?: ExceptionStatus): number {
    return status === undefined ? this.#records.size : this.listByStatus(status).length;
  }

  listByStatus(status: ExceptionStatus): readonly ExceptionRecord[] {
    return [...this.#records.values()].filter((record) => record.status === status);
  }

  resolve(exceptionId: string, resolution: string, actorId = 'system', resolvedAt?: string): ExceptionRecord {
    return this.#close(exceptionId, 'resolved', resolution, actorId, resolvedAt);
  }

  discard(exceptionId: string, resolution: string, actorId = 'system', resolvedAt?: string): ExceptionRecord {
    return this.#close(exceptionId, 'discarded', resolution, actorId, resolvedAt);
  }

  #close(
    exceptionId: string,
    status: 'resolved' | 'discarded',
    resolution: string,
    actorId: string,
    resolvedAt?: string,
  ): ExceptionRecord {
    const record = this.#records.get(exceptionId);

    if (record === undefined) {
      throw new ExceptionNotFoundError(exceptionId);
    }

    const updated: ExceptionRecord = deepFreezeClone({
      ...record,
      status,
      resolution,
      resolved_by: actorId,
      resolved_at: resolvedAt ?? new Date().toISOString(),
    });
    this.#records.set(exceptionId, updated);

    return updated;
  }
}

/**
 * 进程内 Memory：只追加，按主体检索。
 * 与持久化实现共享同一契约（见 `src/stores/memory-contract.ts`）。
 */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #entries: MemoryEntry[] = [];

  append(entry: NewMemoryEntry): MemoryEntry {
    const stored: MemoryEntry = deepFreezeClone({
      ...entry,
      memory_id: `mem_${this.#entries.length + 1}`,
    });

    this.#entries.push(stored);

    return stored;
  }

  list(subjectId: string): readonly MemoryEntry[] {
    return this.#entries.filter((entry) => entry.subject_id === subjectId);
  }

  listAll(): readonly MemoryEntry[] {
    return [...this.#entries];
  }
}

/** 进程内待审批动作存储。 */
export class InMemoryPendingActionStore implements PendingActionStore {
  readonly #records = new Map<string, PendingActionRecord>();

  put(record: PendingActionRecord): PendingActionRecord {
    const stored: PendingActionRecord = deepFreezeClone(record);
    this.#records.set(stored.action_id, stored);
    return stored;
  }

  get(actionId: string): PendingActionRecord | undefined {
    return this.#records.get(actionId);
  }

  getPending(workflowInstanceId: string): PendingActionRecord | undefined {
    return pendingOf(this.list(), workflowInstanceId);
  }

  list(): readonly PendingActionRecord[] {
    return [...this.#records.values()];
  }
}

/** 通用当前事实存储；id 的提取方式由构造参数决定，避免为每个实体重复实现。 */
export class InMemoryStateStore<T> implements StateStore<T> {
  protected readonly records = new Map<string, T>();

  constructor(private readonly idOf: (state: T) => string) {}

  get(id: string): T | undefined {
    return this.records.get(id);
  }

  save(state: T): T {
    const stored = deepFreezeClone(state);
    this.records.set(this.idOf(stored), stored);

    return stored;
  }

  list(): readonly T[] {
    return [...this.records.values()];
  }

  /**
   * 按 `lead_id` 过滤记录；实体类型没有 `lead_id` 字段时恒返回空数组。
   * 保持与 `list()` 相同的插入序，保证 `find` 语义在内存实现里不发生漂移。
   */
  listByLeadId(leadId: string): readonly T[] {
    return [...this.records.values()].filter(
      (state) => (state as { readonly lead_id?: unknown }).lead_id === leadId,
    );
  }
}

export class InMemoryWorkflowStateStore
  extends InMemoryStateStore<WorkflowInstanceState>
  implements WorkflowStateStore
{
  readonly #idByBusinessKey = new Map<string, string>();

  constructor() {
    super((state) => state.workflow_instance_id);
  }

  override save(state: WorkflowInstanceState): WorkflowInstanceState {
    const businessKey = workflowBusinessKey(state);
    const existingId = this.#idByBusinessKey.get(businessKey);

    if (existingId !== undefined && existingId !== state.workflow_instance_id) {
      throw new WorkflowBusinessKeyConflictError(
        businessKey,
        existingId,
        state.workflow_instance_id,
      );
    }

    this.#idByBusinessKey.set(businessKey, state.workflow_instance_id);

    return super.save(state);
  }

  override list(query?: WorkflowListOptions): readonly WorkflowInstanceState[] {
    const matched =
      query?.status === undefined ? super.list() : super.list().filter((state) => state.status === query.status);
    return applyPage(matched, query);
  }

  count(status?: string): number {
    if (status === undefined) {
      return this.records.size;
    }
    return this.countByStatus()[status] ?? 0;
  }

  countByStatus(): Readonly<Record<string, number>> {
    const counts = new Map<string, number>();
    for (const state of this.records.values()) {
      counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  findByBusinessKey(businessKey: string): WorkflowInstanceState | undefined {
    const instanceId = this.#idByBusinessKey.get(businessKey);

    return instanceId === undefined ? undefined : this.get(instanceId);
  }
}

/** 把 limit/offset 应用到已按稳定顺序排好的数组上。 */
function applyPage<T>(values: readonly T[], options?: { readonly limit?: number; readonly offset?: number }): readonly T[] {
  const offset = options?.offset ?? 0;
  if (offset === 0 && options?.limit === undefined) {
    return values;
  }
  const limit = options?.limit ?? values.length - offset;
  return values.slice(offset, offset + limit);
}
