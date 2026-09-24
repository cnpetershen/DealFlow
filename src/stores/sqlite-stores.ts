import type {
  AuditLogStore,
  ExceptionQueueStore,
  StateStore,
  WorkflowStateStore,
} from './interfaces';
import { ExceptionNotFoundError, WorkflowBusinessKeyConflictError } from './interfaces';
import { deepFreezeClone } from './shared';
import { SqliteDatabase, openSqlite, type OpenSqliteOptions } from './sqlite-db';
import type {
  AuditEntry,
  ExceptionRecord,
  NewAuditEntry,
  NewException,
  WorkflowInstanceState,
} from './types';
import { workflowBusinessKey } from './types';

export interface SqliteStoreOptions extends OpenSqliteOptions {
  /** 复用已打开的共享连接（与 EventStore 共用同一库文件时传入）。 */
  readonly sqlite?: SqliteDatabase;
}

function resolveSqlite(options: SqliteStoreOptions): { sqlite: SqliteDatabase; owned: boolean } {
  if (options.sqlite) {
    options.sqlite.initSchema();
    return { sqlite: options.sqlite, owned: false };
  }
  return { sqlite: openSqlite(options), owned: true };
}

/**
 * 只追加的持久化 Audit Log：无 update/delete API，写入后不可变。
 * audit_id 使用自增序号，保证同库唯一。
 */
export class SqliteAuditLog implements AuditLogStore {
  readonly #sqlite: SqliteDatabase;
  readonly #owned: boolean;

  constructor(options: SqliteStoreOptions = {}) {
    const resolved = resolveSqlite(options);
    this.#sqlite = resolved.sqlite;
    this.#owned = resolved.owned;
  }

  append(entry: NewAuditEntry): AuditEntry {
    return this.#sqlite.transaction(() => {
      const next = this.#nextId();
      const auditId = `audit_${next}`;
      const stored: AuditEntry = deepFreezeClone({ ...entry, audit_id: auditId });
      this.#sqlite.db
        .prepare('INSERT INTO audit_log (audit_id, entry) VALUES (?, ?)')
        .run(auditId, JSON.stringify(stored));
      return stored;
    });
  }

  get(auditId: string): AuditEntry | undefined {
    const row = this.#sqlite.db
      .prepare('SELECT entry FROM audit_log WHERE audit_id = ?')
      .get(auditId) as { entry: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.entry) as AuditEntry);
  }

  list(): readonly AuditEntry[] {
    const rows = this.#sqlite.db
      .prepare('SELECT entry FROM audit_log ORDER BY audit_seq')
      .all() as unknown as Array<{ entry: string }>;
    return rows.map((row) => JSON.parse(row.entry) as AuditEntry);
  }

  listByEventId(eventId: string): readonly AuditEntry[] {
    return this.list().filter((entry) => entry.event_id === eventId);
  }

  listByActionId(actionId: string): readonly AuditEntry[] {
    return this.list().filter((entry) => entry.action_id === actionId);
  }

  close(): void {
    if (this.#owned) {
      this.#sqlite.close();
    }
  }

  #nextId(): number {
    const row = this.#sqlite.db.prepare(
      'SELECT COALESCE(MAX(audit_seq), 0) + 1 AS next FROM audit_log',
    ).get() as { next: number | bigint };
    return Number(row.next);
  }
}

/** 持久化异常队列：记录只追加；resolve/discard 仅更新 status/resolution。 */
export class SqliteExceptionQueue implements ExceptionQueueStore {
  readonly #sqlite: SqliteDatabase;
  readonly #owned: boolean;

  constructor(options: SqliteStoreOptions = {}) {
    const resolved = resolveSqlite(options);
    this.#sqlite = resolved.sqlite;
    this.#owned = resolved.owned;
  }

  enqueue(input: NewException): ExceptionRecord {
    return this.#sqlite.transaction(() => {
      const next = this.#nextId();
      const record: ExceptionRecord = deepFreezeClone({
        ...input,
        exception_id: `exc_${next}`,
        status: 'open' as const,
        resolution: null,
      });
      this.#sqlite.db
        .prepare('INSERT INTO exceptions (exception_id, record, status) VALUES (?, ?, ?)')
        .run(record.exception_id, JSON.stringify(record), record.status);
      return record;
    });
  }

  get(exceptionId: string): ExceptionRecord | undefined {
    const row = this.#sqlite.db
      .prepare('SELECT record FROM exceptions WHERE exception_id = ?')
      .get(exceptionId) as { record: string } | undefined;
    return row === undefined ? undefined : this.#parse(row.record);
  }

  list(): readonly ExceptionRecord[] {
    const rows = this.#sqlite.db
      .prepare('SELECT record FROM exceptions ORDER BY exception_seq')
      .all() as unknown as Array<{ record: string }>;
    return rows.map((row) => this.#parse(row.record));
  }

  listOpen(): readonly ExceptionRecord[] {
    const rows = this.#sqlite.db
      .prepare(
        "SELECT record FROM exceptions WHERE status = 'open' ORDER BY exception_seq",
      )
      .all() as unknown as Array<{ record: string }>;
    return rows.map((row) => this.#parse(row.record));
  }

  resolve(exceptionId: string, resolution: string): ExceptionRecord {
    return this.#close(exceptionId, 'resolved', resolution);
  }

  discard(exceptionId: string, resolution: string): ExceptionRecord {
    return this.#close(exceptionId, 'discarded', resolution);
  }

  close(): void {
    if (this.#owned) {
      this.#sqlite.close();
    }
  }

  #close(
    exceptionId: string,
    status: 'resolved' | 'discarded',
    resolution: string,
  ): ExceptionRecord {
    return this.#sqlite.transaction(() => {
      const row = this.#sqlite.db
        .prepare('SELECT record FROM exceptions WHERE exception_id = ?')
        .get(exceptionId) as { record: string } | undefined;
      if (row === undefined) {
        throw new ExceptionNotFoundError(exceptionId);
      }
      const record = this.#parse(row.record);
      const updated: ExceptionRecord = deepFreezeClone({ ...record, status, resolution });
      this.#sqlite.db
        .prepare('UPDATE exceptions SET record = ?, status = ? WHERE exception_id = ?')
        .run(JSON.stringify(updated), status, exceptionId);
      return updated;
    });
  }

  #parse(json: string): ExceptionRecord {
    return JSON.parse(json) as ExceptionRecord;
  }

  #nextId(): number {
    const row = this.#sqlite.db.prepare(
      'SELECT COALESCE(MAX(exception_seq), 0) + 1 AS next FROM exceptions',
    ).get() as { next: number | bigint };
    return Number(row.next);
  }
}

/** 持久化 Workflow 状态：business_key UNIQUE 保证同一业务对象仅一条流程。 */
export class SqliteWorkflowStateStore implements WorkflowStateStore {
  readonly #sqlite: SqliteDatabase;
  readonly #owned: boolean;

  constructor(options: SqliteStoreOptions = {}) {
    const resolved = resolveSqlite(options);
    this.#sqlite = resolved.sqlite;
    this.#owned = resolved.owned;
  }

  get(id: string): WorkflowInstanceState | undefined {
    const row = this.#sqlite.db
      .prepare('SELECT state FROM workflows WHERE workflow_instance_id = ?')
      .get(id) as { state: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.state) as WorkflowInstanceState);
  }

  save(state: WorkflowInstanceState): WorkflowInstanceState {
    return this.#sqlite.transaction(() => {
      const businessKey = workflowBusinessKey(state);
      const byKey = this.#sqlite.db
        .prepare('SELECT workflow_instance_id FROM workflows WHERE business_key = ?')
        .get(businessKey) as { workflow_instance_id: string } | undefined;

      if (byKey !== undefined && byKey.workflow_instance_id !== state.workflow_instance_id) {
        throw new WorkflowBusinessKeyConflictError(
          businessKey,
          byKey.workflow_instance_id,
          state.workflow_instance_id,
        );
      }

      const stored = deepFreezeClone(state);
      this.#sqlite.db
        .prepare(
          `INSERT INTO workflows (workflow_instance_id, business_key, state)
           VALUES (?, ?, ?)
           ON CONFLICT(workflow_instance_id) DO UPDATE SET state = excluded.state, business_key = excluded.business_key`,
        )
        .run(stored.workflow_instance_id, businessKey, JSON.stringify(stored));
      return stored;
    });
  }

  list(): readonly WorkflowInstanceState[] {
    const rows = this.#sqlite.db
      .prepare('SELECT state FROM workflows ORDER BY workflow_instance_id')
      .all() as unknown as Array<{ state: string }>;
    return rows.map((row) => JSON.parse(row.state) as WorkflowInstanceState);
  }

  findByBusinessKey(businessKey: string): WorkflowInstanceState | undefined {
    const row = this.#sqlite.db
      .prepare('SELECT state FROM workflows WHERE business_key = ?')
      .get(businessKey) as { state: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.state) as WorkflowInstanceState);
  }

  close(): void {
    if (this.#owned) {
      this.#sqlite.close();
    }
  }
}

/** 通用实体当前事实存储：按 entity_type 隔离，id 由构造参数提取。 */
export class SqliteStateStore<T> implements StateStore<T> {
  readonly #sqlite: SqliteDatabase;
  readonly #owned: boolean;
  readonly #entityType: string;
  readonly #idOf: (state: T) => string;

  constructor(
    entityType: string,
    idOf: (state: T) => string,
    options: SqliteStoreOptions = {},
  ) {
    const resolved = resolveSqlite(options);
    this.#sqlite = resolved.sqlite;
    this.#owned = resolved.owned;
    this.#entityType = entityType;
    this.#idOf = idOf;
  }

  get(id: string): T | undefined {
    const row = this.#sqlite.db
      .prepare('SELECT state FROM entity_states WHERE entity_type = ? AND entity_id = ?')
      .get(this.#entityType, id) as { state: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.state) as T);
  }

  save(state: T): T {
    const stored = deepFreezeClone(state);
    this.#sqlite.transaction(() => {
      this.#sqlite.db
        .prepare(
          `INSERT INTO entity_states (entity_type, entity_id, state)
           VALUES (?, ?, ?)
           ON CONFLICT(entity_type, entity_id) DO UPDATE SET state = excluded.state`,
        )
        .run(this.#entityType, this.#idOf(stored), JSON.stringify(stored));
    });
    return stored;
  }

  list(): readonly T[] {
    const rows = this.#sqlite.db
      .prepare(
        'SELECT state FROM entity_states WHERE entity_type = ? ORDER BY entity_id',
      )
      .all(this.#entityType) as unknown as Array<{ state: string }>;
    return rows.map((row) => JSON.parse(row.state) as T);
  }

  close(): void {
    if (this.#owned) {
      this.#sqlite.close();
    }
  }
}
