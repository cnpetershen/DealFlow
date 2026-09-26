import type {
  AuditLogStore,
  AuditQuery,
  ExceptionQueueStore,
  ExceptionStatus,
  ListOptions,
  MemoryStore,
  PendingActionStore,
  StateStore,
  StatusedListOptions,
  WorkflowListOptions,
  WorkflowStateStore,
} from './interfaces';
import { ExceptionNotFoundError, WorkflowBusinessKeyConflictError } from './interfaces';
import { deepFreezeClone, pendingOf } from './shared';
import { SqliteDatabase, openSqlite, type OpenSqliteOptions } from './sqlite-db';
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
 * 把审计查询条件翻译成 SQL WHERE。
 * 条件表达式必须与 `sqlite-db.ts` 中的表达式索引逐字一致，否则 SQLite 无法使用索引。
 *
 * 时间条件统一换算成 **epoch 秒** 再比较：审计记录里的 `occurred_at` 可能是 `Z`，
 * 也可能是 `+08:00` 这类带偏移的写法，直接做字符串比较在跨时区格式下是错的
 * （`strftime('%s', ...)` 能正确解析两种写法，见 `sqlite-db.ts` 的索引定义）。
 */
function buildAuditWhere(filter: AuditQuery): { where: string; params: readonly (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const push = (expression: string, value: string | number | undefined): void => {
    if (value === undefined) {
      return;
    }
    conditions.push(`${expression} = ?`);
    params.push(value);
  };

  push("json_extract(entry, '$.subject.workflow_instance_id')", filter.workflow_instance_id);
  push("json_extract(entry, '$.event_id')", filter.event_id);
  push("json_extract(entry, '$.action_id')", filter.action_id);
  push("json_extract(entry, '$.action')", filter.action);
  push("json_extract(entry, '$.action_type')", filter.action_type);
  push("json_extract(entry, '$.result')", filter.result);

  for (const [key, operator] of [['occurred_at_from', '>='], ['occurred_at_to', '<=']] as const) {
    const value = filter[key];
    if (value === undefined) {
      continue;
    }
    conditions.push(
      `CAST(strftime('%s', json_extract(entry, '$.occurred_at')) AS INTEGER) ${operator} ?`,
    );
    params.push(Math.floor(Date.parse(value) / 1_000));
  }

  return {
    where: conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`,
    params,
  };
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
    return this.query({ event_id: eventId, order: 'asc' });
  }

  listByActionId(actionId: string): readonly AuditEntry[] {
    return this.query({ action_id: actionId, order: 'asc' });
  }

  /**
   * 动态拼接 WHERE 并走表达式索引（见 `sqlite-db.ts`）。
   * 默认按写入顺序倒序返回，便于「最近发生了什么」的运维查询。
   */
  query(filter: AuditQuery): readonly AuditEntry[] {
    const { where, params } = buildAuditWhere(filter);
    const direction = filter.order === 'asc' ? 'ASC' : 'DESC';
    const limit = filter.limit === undefined ? '' : ' LIMIT ?';
    const rows = this.#sqlite.db
      .prepare(`SELECT entry FROM audit_log${where} ORDER BY audit_seq ${direction}${limit}`)
      .all(...(filter.limit === undefined ? params : [...params, filter.limit])) as unknown as Array<{ entry: string }>;
    return rows.map((row) => JSON.parse(row.entry) as AuditEntry);
  }

  count(filter: AuditQuery): number {
    const { where, params } = buildAuditWhere(filter);
    const row = this.#sqlite.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log${where}`)
      .get(...params) as { n: number | bigint };
    return Number(row.n);
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

/** 持久化异常队列：记录只追加；resolve/discard 仅更新 status/resolution 与处理人信息。 */
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
        resolved_by: null,
        resolved_at: null,
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

  list(options?: StatusedListOptions): readonly ExceptionRecord[] {
    const where = options?.status === undefined ? '' : ' WHERE status = ?';
    const params: Array<string | number | null> = options?.status === undefined ? [] : [options.status];
    const page = pageClause(options, params);
    const rows = this.#sqlite.db
      .prepare(`SELECT record FROM exceptions${where} ORDER BY exception_seq${page}`)
      .all(...params) as unknown as Array<{ record: string }>;
    return rows.map((row) => this.#parse(row.record));
  }

  listOpen(options?: ListOptions): readonly ExceptionRecord[] {
    return this.list({ ...options, status: 'open' });
  }

  count(status?: ExceptionStatus): number {
    const where = status === undefined ? '' : ' WHERE status = ?';
    const params: Array<string | number | null> = status === undefined ? [] : [status];
    const row = this.#sqlite.db
      .prepare(`SELECT COUNT(*) AS n FROM exceptions${where}`)
      .get(...params) as { n: number | bigint };
    return Number(row.n);
  }

  resolve(exceptionId: string, resolution: string, actorId = 'system', resolvedAt?: string): ExceptionRecord {
    return this.#close(exceptionId, 'resolved', resolution, actorId, resolvedAt);
  }

  discard(exceptionId: string, resolution: string, actorId = 'system', resolvedAt?: string): ExceptionRecord {
    return this.#close(exceptionId, 'discarded', resolution, actorId, resolvedAt);
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
    actorId: string,
    resolvedAt?: string,
  ): ExceptionRecord {
    return this.#sqlite.transaction(() => {
      const row = this.#sqlite.db
        .prepare('SELECT record FROM exceptions WHERE exception_id = ?')
        .get(exceptionId) as { record: string } | undefined;
      if (row === undefined) {
        throw new ExceptionNotFoundError(exceptionId);
      }
      const record = this.#parse(row.record);
      const updated: ExceptionRecord = deepFreezeClone({
        ...record,
        status,
        resolution,
        resolved_by: actorId,
        resolved_at: resolvedAt ?? new Date().toISOString(),
      });
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

  list(query?: WorkflowListOptions): readonly WorkflowInstanceState[] {
    const where = query?.status === undefined ? '' : " WHERE json_extract(state, '$.status') = ?";
    const params: Array<string | number | null> = query?.status === undefined ? [] : [query.status];
    const page = pageClause(query, params);
    const rows = this.#sqlite.db
      .prepare(`SELECT state FROM workflows${where} ORDER BY workflow_instance_id${page}`)
      .all(...params) as unknown as Array<{ state: string }>;
    return rows.map((row) => JSON.parse(row.state) as WorkflowInstanceState);
  }

  count(status?: string): number {
    const where = status === undefined ? '' : " WHERE json_extract(state, '$.status') = ?";
    const params: Array<string | number | null> = status === undefined ? [] : [status];
    const row = this.#sqlite.db
      .prepare(`SELECT COUNT(*) AS n FROM workflows${where}`)
      .get(...params) as { n: number | bigint };
    return Number(row.n);
  }

  countByStatus(): Readonly<Record<string, number>> {
    const rows = this.#sqlite.db
      .prepare(
        `SELECT json_extract(state, '$.status') AS status, COUNT(*) AS n
         FROM workflows GROUP BY json_extract(state, '$.status') ORDER BY status`,
      )
      .all() as unknown as Array<{ status: string; n: number | bigint }>;
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
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

  /**
   * 走 `idx_entity_state_lead` 表达式索引，避免为取一条线索的成交阶段
   * 而把整张 `entity_states` 拉进内存再过滤（引擎每处理一个事件都会调一次）。
   */
  listByLeadId(leadId: string): readonly T[] {
    const rows = this.#sqlite.db
      .prepare(
        `SELECT state FROM entity_states
         WHERE entity_type = ? AND json_extract(state, '$.lead_id') = ?
         ORDER BY entity_id`,
      )
      .all(this.#entityType, leadId) as unknown as Array<{ state: string }>;
    return rows.map((row) => JSON.parse(row.state) as T);
  }

  /** 供聚合 Store（Memory / 待审批动作）复用同一连接做索引查询。 */
  get sqlite(): SqliteDatabase {
    return this.#sqlite;
  }

  close(): void {
    if (this.#owned) {
      this.#sqlite.close();
    }
  }
}

/**
 * 持久化 Memory：复用 entity_states 表，按 entity_type = 'memory' 隔离。
 * 只追加（memory_id 每次新生成），因此没有 update/delete 语义。
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly #store: SqliteStateStore<MemoryEntry>;
  readonly #sqlite: SqliteDatabase;
  readonly #owned: boolean;

  constructor(options: SqliteStoreOptions = {}) {
    this.#store = new SqliteStateStore<MemoryEntry>('memory', (entry) => entry.memory_id, options);
    this.#sqlite = this.#store.sqlite;
    this.#owned = options.sqlite === undefined;
  }

  append(entry: NewMemoryEntry): MemoryEntry {
    const memoryId = this.#nextId(entry.subject_id);
    return this.#store.save(deepFreezeClone({ ...entry, memory_id: memoryId }));
  }

  /** 走 `idx_entity_state_subject`，只读该主体的记忆，而不是全表 list 后过滤。 */
  list(subjectId: string): readonly MemoryEntry[] {
    const rows = this.#sqlite.db
      .prepare(
        `SELECT state FROM entity_states
         WHERE entity_type = 'memory' AND json_extract(state, '$.subject_id') = ?
         ORDER BY entity_id`,
      )
      .all(subjectId) as unknown as Array<{ state: string }>;
    return rows.map((row) => JSON.parse(row.state) as MemoryEntry);
  }

  listAll(): readonly MemoryEntry[] {
    return this.#store.list();
  }

  close(): void {
    if (this.#owned) {
      this.#store.close();
    }
  }

  /** 生成同库唯一的 memory_id；顺序与写入顺序一致，便于断言。 */
  #nextId(subjectId: string): string {
    const prefix = `mem_${subjectId}_`;
    const existing = new Set(this.list(subjectId).map((entry) => entry.memory_id));
    let index = existing.size + 1;

    while (existing.has(`${prefix}${index}`)) {
      index += 1;
    }

    return `${prefix}${index}`;
  }
}

/**
 * 持久化待审批动作：复用 entity_states 表，按 entity_type = 'pending_action' 隔离。
 * 保存动作快照，使 Human Review 在进程重启后依然可审批。
 */
export class SqlitePendingActionStore implements PendingActionStore {
  readonly #store: SqliteStateStore<PendingActionRecord>;
  readonly #sqlite: SqliteDatabase;
  readonly #owned: boolean;

  constructor(options: SqliteStoreOptions = {}) {
    this.#store = new SqliteStateStore<PendingActionRecord>(
      'pending_action',
      (record) => record.action_id,
      options,
    );
    this.#sqlite = this.#store.sqlite;
    this.#owned = options.sqlite === undefined;
  }

  put(record: PendingActionRecord): PendingActionRecord {
    return this.#store.save(record);
  }

  get(actionId: string): PendingActionRecord | undefined {
    return this.#store.get(actionId);
  }

  /** 走 `idx_entity_state_workflow`，只取该实例当前待审批的那一条。 */
  getPending(workflowInstanceId: string): PendingActionRecord | undefined {
    const row = this.#sqlite.db
      .prepare(
        `SELECT state FROM entity_states
         WHERE entity_type = 'pending_action'
           AND json_extract(state, '$.workflow_instance_id') = ?
           AND json_extract(state, '$.status') = 'pending'
         ORDER BY entity_id DESC
         LIMIT 1`,
      )
      .get(workflowInstanceId) as { state: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.state) as PendingActionRecord);
  }

  list(): readonly PendingActionRecord[] {
    return this.#store.list();
  }

  close(): void {
    if (this.#owned) {
      this.#store.close();
    }
  }
}

/**
 * 把 limit/offset 下推成 SQL 片段，并把值追加到绑定参数末尾。
 * WHERE 条件的参数在前、分页参数在后，顺序与 SQL 中出现的位置一致。
 */
function pageClause(
  options: { readonly limit?: number; readonly offset?: number } | undefined,
  params: Array<string | number | null>,
): string {
  if (options?.limit !== undefined) {
    params.push(Math.max(0, Math.trunc(options.limit)));
  }
  if (options?.offset !== undefined) {
    params.push(Math.max(0, Math.trunc(options.offset)));
  }
  if (options?.limit !== undefined) {
    return options.offset !== undefined ? ' LIMIT ? OFFSET ?' : ' LIMIT ?';
  }
  return options?.offset !== undefined ? ' LIMIT -1 OFFSET ?' : '';
}