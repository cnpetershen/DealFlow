import type { AuditLogStore, ExceptionQueueStore, WorkflowStateStore } from '../stores/interfaces';

/**
 * 运行时观测快照：计数器 + 从 State/Audit/Exception 派生出的当前事实（gauges）。
 * 计数器单调递增；gauge 每次快照时实时读取。
 */
export interface RuntimeSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly workflows_by_status: Readonly<Record<string, number>>;
  readonly open_exceptions: number;
  readonly total_exceptions: number;
  readonly audit_entries: number;
}

export interface RuntimeMetricsStores {
  readonly workflow_store: WorkflowStateStore;
  readonly exception_queue: ExceptionQueueStore;
  readonly audit_log: AuditLogStore;
}

/**
 * 进程内运行时观测：记录事件接收结果，并按需派生 State 快照。
 * 无外部依赖，接口化 Store 保证可替换为持久化实现。
 */
export class RuntimeMetrics {
  readonly #counters = new Map<string, number>();
  readonly #stores: RuntimeMetricsStores;

  constructor(stores: RuntimeMetricsStores) {
    this.#stores = stores;
  }

  /** 记录一次事件接收结果。status 为 HandleEventResult.status，非法事件记为 'invalid'。 */
  recordEvent(status: string): void {
    this.#increment('events.total');
    this.#increment(`events.${status}`);
  }

  /** 记录一次控制面调用。与 events.* 分开计数，避免污染事件接收指标。 */
  recordAction(name: string): void {
    this.#increment('control_plane.total');
    this.#increment(`control_plane.${name}`);
  }

  #increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  counters(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.#counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  /**
   * 实时派生当前事实。
   *
   * 这里刻意**不**物化任何一张表：`/metrics` 按抓取频率调用，逐条 JSON.parse 全表
   * 会让耗时随数据量线性增长。计数一律下推成 `COUNT(*)` / `GROUP BY`。
   */
  snapshot(): RuntimeSnapshot {
    return {
      counters: this.counters(),
      workflows_by_status: this.#stores.workflow_store.countByStatus(),
      open_exceptions: this.#stores.exception_queue.count('open'),
      total_exceptions: this.#stores.exception_queue.count(),
      audit_entries: this.#stores.audit_log.count({}),
    };
  }
}
