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
    // WAL：读不挡写、写不挡读。
    // 回滚日志模式下，`npm run backup` 这类读事务会把服务进程的写事务挡到 busy_timeout
    // 之后抛 SQLITE_BUSY，反之亦然——运维侧看到的就是「数据库冻住了」。
    // :memory: 没有文件，journal_mode 本来就只能是 memory，改它没有意义。
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
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

      /*
       * 表达式索引：把 JSON 里被查询的字段提升为可索引的表达式。
       *
       * 引擎每处理一个事件都要构造 Decision Context（读本主体的事件、数当日自动动作数、
       * 查待办任务补救记录），如果每次都 SELECT 全表再在内存里过滤，处理耗时就会随
       * 事件/审计总量线性增长。这些索引让上述查询走 SEARCH ... USING INDEX 而不是全表扫描，
       * 且无需新增列或数据迁移。
       */
      CREATE INDEX IF NOT EXISTS idx_events_lead
        ON events (json_extract(event, '$.payload.lead_id'), sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_event
        ON audit_log (json_extract(entry, '$.event_id'), audit_seq DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action_id
        ON audit_log (json_extract(entry, '$.action_id'), audit_seq DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_workflow
        ON audit_log (json_extract(entry, '$.subject.workflow_instance_id'), audit_seq DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action_window
        ON audit_log (
          json_extract(entry, '$.action'),
          json_extract(entry, '$.result'),
          CAST(strftime('%s', json_extract(entry, '$.occurred_at')) AS INTEGER)
        );
      CREATE INDEX IF NOT EXISTS idx_audit_dispatched
        ON audit_log (
          json_extract(entry, '$.action'),
          json_extract(entry, '$.action_type'),
          json_extract(entry, '$.subject.workflow_instance_id')
        );
      CREATE INDEX IF NOT EXISTS idx_entity_state_subject
        ON entity_states (entity_type, json_extract(state, '$.subject_id'));
      CREATE INDEX IF NOT EXISTS idx_entity_state_workflow
        ON entity_states (entity_type, json_extract(state, '$.workflow_instance_id'));
      /*
       * Deal 按线索反查、失败实例按最近事件重试，都是「按 JSON 字段取单条」的点查，
       * 没有索引就会退化成整表/整本日志扫描——而这两条都在每事件热路径或重试热路径上。
       */
      CREATE INDEX IF NOT EXISTS idx_entity_state_lead
        ON entity_states (entity_type, json_extract(state, '$.lead_id'));
      CREATE INDEX IF NOT EXISTS idx_events_event_id
        ON events (json_extract(event, '$.event_id'));
    `);
    this.refreshQueryStats();
  }

  /**
   * 让查询规划器拿到索引选择性统计。
   *
   * 没有 `sqlite_stat1` 时 SQLite 只能按固定比例估算，判定「先用主键按
   * `entity_type` 切分再逐行算 JSON」比直接用 `idx_entity_state_lead` 更便宜，
   * 于是 `#context` 的 Deal 反查退化成扫全部 Deal 再算 JSON——
   * 正是这条热路径每处理一个事件都要走一次。
   *
   * `PRAGMA optimize` 只在表从未被分析过或数据量显著变化时才真的执行 ANALYZE，
   * 常态下是空操作（实测 9000 行首跑 1ms、之后 0ms），因此适合放在每次打开连接时。
   * 失败不致命：最多退回保守的查询计划，不影响可用性。
   */
  refreshQueryStats(): void {
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      // 只读连接 / 锁竞争下放弃统计刷新，不阻断启动。
    }
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
