import type { SqliteDatabase } from './sqlite-db';
import type { UnitOfWork } from './unit-of-work';

/**
 * 基于共享 SQLite 连接的事务边界。
 *
 * 所有 SQLite Store 复用同一个连接，因此事务内的嵌套 Store 写入会自动并入外层事务
 * （见 `SqliteDatabase.transaction` 对 `isTransaction` 的处理），无需改造 Store 接口。
 *
 * 注意：`run` 内是同步执行，因此不会跨 await 持有事务。文档化的取舍是：
 * 外部副作用不参与事务，由引擎在事务之间调用，再用第二个事务提交其结果。
 */
export class SqliteUnitOfWork implements UnitOfWork {
  readonly #sqlite: SqliteDatabase;

  constructor(sqlite: SqliteDatabase) {
    this.#sqlite = sqlite;
  }

  run<T>(fn: () => T): T {
    return this.#sqlite.transaction(fn);
  }
}
