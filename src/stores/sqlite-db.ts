import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/**
 * 通过 createRequire 加载 node:sqlite，避免打包器/Vitest 将 `node:` 内置模块
 * 错误解析为普通 npm 包（Vite 会把 `node:sqlite` 解析成 `sqlite` 并失败）。
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export type SqliteDb = InstanceType<typeof DatabaseSyncType>;

export interface OpenSqliteOptions {
  /** 数据库文件路径；`:memory:` 表示进程内内存库（不跨重启）。 */
  readonly path?: string;
  /** 获取写锁的忙等待超时（毫秒），多进程并发时避免立即 SQLITE_BUSY。 */
  readonly timeoutMs?: number;
}

/**
 * 共享 SQLite 连接：一个业务库打开一次，Event / Audit / Workflow / Exception / 实体
 * 各 Store 复用同一连接，跨表写入可用同一事务边界。
 *
 * node:sqlite 在 Node 22 为 Experimental；升级 Node 时需回归 `src/stores` 全部测试。
 */
export class SqliteDatabase {
  readonly db: SqliteDb;
  readonly #owned: boolean;

  constructor(options: OpenSqliteOptions = {}) {
    const path = options.path ?? ':memory:';
    this.db = new DatabaseSync(path, { timeout: options.timeoutMs ?? 5_000 });
    this.#owned = true;
    this.initSchema();
  }

  /** 包装已有连接的工厂保留给测试；close() 由调用方管理。 */
  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL,
        processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'processed')),
        claim_id TEXT,
        claim_expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_processing_status ON events (processing_status);

      CREATE TABLE IF NOT EXISTS audit_log (
        audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id TEXT NOT NULL UNIQUE,
        entry TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exceptions (
        exception_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        exception_id TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'discarded'))
      );
      CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions (status);

      CREATE TABLE IF NOT EXISTS workflows (
        workflow_instance_id TEXT PRIMARY KEY,
        business_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entity_states (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      );
    `);
  }

  close(): void {
    if (this.#owned && this.db.isOpen) {
      this.db.close();
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
  }
}

export function openSqlite(options: OpenSqliteOptions = {}): SqliteDatabase {
  return new SqliteDatabase(options);
}
