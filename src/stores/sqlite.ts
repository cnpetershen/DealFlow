import type { ParsedEvent } from '../events/dictionary';
import type { AppendEventResult, ClaimableEventStore, EventStore, StoredEvent } from './interfaces';
import { EventNotAppendedError } from './interfaces';
import { deepFreezeClone, describesSameFact } from './shared';
import { SqliteDatabase, openSqlite, type OpenSqliteOptions } from './sqlite-db';

export interface SqliteEventStoreOptions extends OpenSqliteOptions {
  /** 复用已打开的共享连接（与其它 Sqlite Store 共用同一库文件时传入）。 */
  readonly sqlite?: SqliteDatabase;
}

interface EventRow {
  sequence: number | bigint;
  idempotency_key: string;
  event: string;
  processing_status: 'pending' | 'processed';
}

/**
 * 基于 node:sqlite 的持久化 EventStore。
 *
 * 与 InMemoryEventStore 语义一致：
 * - `idempotency_key` PRIMARY KEY 唯一约束
 * - `markProcessed` 条件 UPDATE 原子推进
 * - 附带跨进程处理租约（ClaimableEventStore），防止双 worker 重复处理同一 pending 事件
 */
export class SqliteEventStore implements ClaimableEventStore {
  readonly #sqlite: SqliteDatabase;
  readonly #ownsSqlite: boolean;

  constructor(options: SqliteEventStoreOptions = {}) {
    if (options.sqlite) {
      this.#sqlite = options.sqlite;
      this.#ownsSqlite = false;
      this.#sqlite.initSchema();
    } else {
      this.#sqlite = openSqlite(options);
      this.#ownsSqlite = true;
    }
  }

  get sqlite(): SqliteDatabase {
    return this.#sqlite;
  }

  append(event: ParsedEvent): AppendEventResult {
    return this.#sqlite.transaction((): AppendEventResult => {
      const existingRow = this.#selectByKey(event.idempotency_key);

      if (existingRow !== undefined) {
        const existing = this.#toStoredEvent(existingRow);

        if (!describesSameFact(existing.event, event)) {
          return { status: 'conflict', existing };
        }

        return existing.processing_status === 'processed'
          ? { status: 'duplicate', stored: existing }
          : { status: 'retry', stored: existing };
      }

      const insert = this.#db.prepare(
        'INSERT INTO events (idempotency_key, event, processing_status) VALUES (?, ?, ?)',
      );
      insert.run(event.idempotency_key, JSON.stringify(event), 'pending');

      const row = this.#selectByKey(event.idempotency_key);
      if (row === undefined) {
        throw new Error('Event append 后无法读取，数据库状态不一致');
      }

      return { status: 'appended', stored: this.#toStoredEvent(row) };
    });
  }

  markProcessed(idempotencyKey: string): StoredEvent {
    return this.#sqlite.transaction(() => {
      const existingRow = this.#selectByKey(idempotencyKey);
      if (existingRow === undefined) {
        throw new EventNotAppendedError(idempotencyKey);
      }

      if (existingRow.processing_status === 'processed') {
        this.#clearClaim(idempotencyKey);
        return this.#toStoredEvent(existingRow);
      }

      const update = this.#db.prepare(
        "UPDATE events SET processing_status = 'processed', claim_id = NULL, claim_expires_at = NULL WHERE idempotency_key = ? AND processing_status = 'pending'",
      );
      const result = update.run(idempotencyKey);

      if (result.changes !== 1n && result.changes !== 1) {
        throw new Error('Event markProcessed 未能原子更新 processing_status');
      }

      const updated = this.#selectByKey(idempotencyKey);
      if (updated === undefined) {
        throw new Error('Event markProcessed 后无法读取，数据库状态不一致');
      }

      return this.#toStoredEvent(updated);
    });
  }

  getByIdempotencyKey(idempotencyKey: string): StoredEvent | undefined {
    const row = this.#selectByKey(idempotencyKey);
    return row === undefined ? undefined : this.#toStoredEvent(row);
  }

  /**
   * 走 `idx_events_event_id` 表达式索引：重试路径按事件 id 取回单条，
   * 而不是把整本事件日志读进内存再 `find`（事件只增不减，退化是必然的）。
   */
  getByEventId(eventId: string): StoredEvent | undefined {
    const row = this.#db
      .prepare(
        `SELECT sequence, idempotency_key, event, processing_status
         FROM events
         WHERE json_extract(event, '$.event_id') = ?
         ORDER BY sequence
         LIMIT 1`,
      )
      .get(eventId) as EventRow | undefined;
    return row === undefined ? undefined : this.#toStoredEvent(row);
  }

  list(): readonly StoredEvent[] {
    const rows = this.#db
      .prepare(
        'SELECT sequence, idempotency_key, event, processing_status FROM events ORDER BY sequence',
      )
      .all() as unknown as EventRow[];
    return rows.map((row) => this.#toStoredEvent(row));
  }

  /**
   * 走 `idx_events_lead` 表达式索引，只读取该 Lead 的最近 limit 条事件。
   * 见 `EventStore.listByLeadId` 的说明：这是避免处理耗时随事件总量线性增长的关键。
   */
  listByLeadId(leadId: string, limit: number): readonly StoredEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT sequence, idempotency_key, event, processing_status
         FROM events
         WHERE json_extract(event, '$.payload.lead_id') = ?
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(leadId, limit) as unknown as EventRow[];
    return rows.map((row) => this.#toStoredEvent(row));
  }

  tryClaim(idempotencyKey: string, claimId: string, nowMs: number, leaseMs: number): boolean {
    return this.#sqlite.transaction(() => {
      const row = this.#selectByKey(idempotencyKey);
      if (row === undefined) {
        return false;
      }
      if (row.processing_status === 'processed') {
        return false;
      }

      const result = this.#db.prepare(
        `UPDATE events
         SET claim_id = ?, claim_expires_at = ?
         WHERE idempotency_key = ?
           AND processing_status = 'pending'
           AND (claim_id IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
      ).run(claimId, nowMs + leaseMs, idempotencyKey, nowMs);

      return result.changes === 1n || result.changes === 1;
    });
  }

  releaseClaim(idempotencyKey: string, claimId: string): void {
    this.#sqlite.transaction(() => {
      this.#db
        .prepare(
          'UPDATE events SET claim_id = NULL, claim_expires_at = NULL WHERE idempotency_key = ? AND claim_id = ?',
        )
        .run(idempotencyKey, claimId);
    });
  }

  close(): void {
    if (this.#ownsSqlite) {
      this.#sqlite.close();
    }
  }

  get #db() {
    return this.#sqlite.db;
  }

  #clearClaim(idempotencyKey: string): void {
    this.#db
      .prepare('UPDATE events SET claim_id = NULL, claim_expires_at = NULL WHERE idempotency_key = ?')
      .run(idempotencyKey);
  }

  #selectByKey(idempotencyKey: string): EventRow | undefined {
    return this.#db
      .prepare(
        'SELECT sequence, idempotency_key, event, processing_status FROM events WHERE idempotency_key = ?',
      )
      .get(idempotencyKey) as unknown as EventRow | undefined;
  }

  #toStoredEvent(row: EventRow): StoredEvent {
    const event = JSON.parse(row.event) as ParsedEvent;
    return deepFreezeClone({
      sequence: Number(row.sequence),
      event,
      processing_status: row.processing_status,
    });
  }
}

