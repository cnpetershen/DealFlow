import type { ParsedEvent } from '../events/dictionary';
import type {
  AppendEventResult,
  AuditLogStore,
  EventStore,
  ExceptionQueueStore,
  StateStore,
  StoredEvent,
  WorkflowStateStore,
} from './interfaces';
import {
  EventNotAppendedError,
  ExceptionNotFoundError,
  WorkflowBusinessKeyConflictError,
} from './interfaces';
import { deepFreezeClone, describesSameFact } from './shared';
import type {
  AuditEntry,
  ExceptionRecord,
  NewAuditEntry,
  NewException,
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

  list(): readonly StoredEvent[] {
    return [...this.#events];
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
    return this.#entries.filter((entry) => entry.event_id === eventId);
  }

  listByActionId(actionId: string): readonly AuditEntry[] {
    return this.#entries.filter((entry) => entry.action_id === actionId);
  }
}

export class InMemoryExceptionQueue implements ExceptionQueueStore {
  readonly #records = new Map<string, ExceptionRecord>();

  enqueue(input: NewException): ExceptionRecord {
    const record: ExceptionRecord = deepFreezeClone({
      ...input,
      exception_id: `exc_${this.#records.size + 1}`,
      status: 'open' as const,
      resolution: null,
    });

    this.#records.set(record.exception_id, record);

    return record;
  }

  get(exceptionId: string): ExceptionRecord | undefined {
    return this.#records.get(exceptionId);
  }

  list(): readonly ExceptionRecord[] {
    return [...this.#records.values()];
  }

  listOpen(): readonly ExceptionRecord[] {
    return this.list().filter((record) => record.status === 'open');
  }

  resolve(exceptionId: string, resolution: string): ExceptionRecord {
    return this.#close(exceptionId, 'resolved', resolution);
  }

  discard(exceptionId: string, resolution: string): ExceptionRecord {
    return this.#close(exceptionId, 'discarded', resolution);
  }

  #close(
    exceptionId: string,
    status: 'resolved' | 'discarded',
    resolution: string,
  ): ExceptionRecord {
    const record = this.#records.get(exceptionId);

    if (record === undefined) {
      throw new ExceptionNotFoundError(exceptionId);
    }

    const updated: ExceptionRecord = deepFreezeClone({ ...record, status, resolution });
    this.#records.set(exceptionId, updated);

    return updated;
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

  findByBusinessKey(businessKey: string): WorkflowInstanceState | undefined {
    const instanceId = this.#idByBusinessKey.get(businessKey);

    return instanceId === undefined ? undefined : this.get(instanceId);
  }
}