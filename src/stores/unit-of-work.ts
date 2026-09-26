/**
 * 业务事务边界（Unit of Work）。
 *
 * 一次 Workflow 处理会写入多个 Store：Event 处理状态、Workflow State、Entity State、
 * Audit Log 与异常队列。若每个写入各自提交，中途失败会留下「部分提交」的事实
 * （例如 Lead 已推进但 Workflow 未推进，或审计与状态不一致）。
 *
 * UnitOfWork 把一次处理中的**同步**写入批次包进单一事务：全部提交或整体回滚。
 *
 * 约束：`fn` 必须是同步的。外部副作用（Executor 调用）不进事务，
 * 由引擎在事务之间执行，避免长事务持有 SQLite 写锁。
 */
export interface UnitOfWork {
  run<T>(fn: () => T): T;
}

/** 无事务实现：用于 InMemory Store 与未配置事务的环境。 */
export const noopUnitOfWork: UnitOfWork = {
  run<T>(fn: () => T): T {
    return fn();
  },
};
