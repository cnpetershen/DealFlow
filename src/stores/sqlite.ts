import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type { ParsedEvent } from '../events/dictionary';
import type { AppendEventResult, EventStore, StoredEvent } from './interfaces';
import { EventNotAppendedError } from './interfaces';
import { deepFreezeClone, describesSameFact } from './shared';

/**
 * 通过 createRequire 加载 node:sqlite，避免打包器/Vitest 将 `node:` 内置模块
 * 错误解析为普通 npm 包（Vite 会把 `node:sqlite` 解析成 `sqlite` 并失败）。
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export interface SqliteEventStoreOptions {
  /** 数据库文件路径；`:memory:` 表示进程内内存库（不跨重启）。 */
  readonly path?: string;
  /** 获取写锁的忙等待超时（毫秒），多进程并发时避免立即 SQLITE_BUSY。 */
  readonly timeoutMs?: number;
}

interface EventRow {
  sequence: number;
  idempotency_key: string;
  event: string;
  processing_status: 'pending' | 'processed';
}

/**
 * 基于 node:sqlite 的持久化 EventStore。
 *
 * 保持与 InMemoryEventStore 完全一致的 append / markProcessed / 去重语义：
 * - `idempotency_key` PRIMARY KEY 唯一约束，append 天然防重复落库
 * - `sequence` AUTOINCREMENT 按接收顺序单调递增
 * - `markProcessed` 用条件 UPDATE，pending → processed 原子推进
 * - 事件 JSON 落盘，进程重启后可恢复；返回值统一 deepFreezeClone，保证不可变
 *
 * 不引入额外 npm 依赖，使用 Node 22 内置 `node:sqlite`。
 */
export class SqliteEventStore implements EventStore {
  readonly #db: InstanceType<typeof DatabaseSyncType>;

  constructor(options: SqliteEventStoreOptions = {}) {
    const path = options.path ?? ':memory:';
    this.#db = new DatabaseSync(path, { timeout: options.timeoutMs ?? 5_000 });
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL,
        processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'processed'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_processing_status ON events (processing_status);
    `);
  }

  append(event: ParsedEvent): AppendEventResult {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existingRow = this.#selectByKey(event.idempotency_key);

      if (existingRow !== undefined) {
        const existing = this.#toStoredEvent(existingRow);

        if (!describesSameFact(existing.event, event)) {
          this.#db.exec('ROLLBACK');
          return { status: 'conflict', existing };
        }

        this.#db.exec('COMMIT');
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

      this.#db.exec('COMMIT');
      return { status: 'appended', stored: this.#toStoredEvent(row) };
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec('ROLLBACK');
      }
      throw error;
    }
  }

  markProcessed(idempotencyKey: string): StoredEvent {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existingRow = this.#selectByKey(idempotencyKey);
      if (existingRow === undefined) {
        this.#db.exec('ROLLBACK');
        throw new EventNotAppendedError(idempotencyKey);
      }

      if (existingRow.processing_status === 'processed') {
        this.#db.exec('COMMIT');
        return this.#toStoredEvent(existingRow);
      }

      const update = this.#db.prepare(
        "UPDATE events SET processing_status = 'processed' WHERE idempotency_key = ? AND processing_status = 'pending'",
      );
      const result = update.run(idempotencyKey);

      if (result.changes !== 1n && result.changes !== 1) {
        throw new Error('Event markProcessed 未能原子更新 processing_status');
      }

      const updated = this.#selectByKey(idempotencyKey);
      if (updated === undefined) {
        throw new Error('Event markProcessed 后无法读取，数据库状态不一致');
      }

      this.#db.exec('COMMIT');
      return this.#toStoredEvent(updated);
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec('ROLLBACK');
      }
      throw error;
    }
  }

  getByIdempotencyKey(idempotencyKey: string): StoredEvent | undefined {
    const row = this.#selectByKey(idempotencyKey);
    return row === undefined ? undefined : this.#toStoredEvent(row);
  }

  list(): readonly StoredEvent[] {
    const rows = this.#db
      .prepare('SELECT sequence, idempotency_key, event, processing_status FROM events ORDER BY sequence')
      .all() as unknown as EventRow[];
    return rows.map((row) => this.#toStoredEvent(row));
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  #selectByKey(idempotencyKey: string): EventRow | undefined {
    const row = this.#db
      .prepare(
        'SELECT sequence, idempotency_key, event, processing_status FROM events WHERE idempotency_key = ?',
      )
      .get(idempotencyKey) as unknown as EventRow | undefined;
    return row;
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
