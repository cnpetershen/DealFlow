import type { StructuredLogger } from '../observability/logger';
import { allowsSimpleRetry } from '../executor/interfaces';
import type { WorkflowStateStore } from '../stores/interfaces';
import type { WorkflowInstanceState } from '../stores/types';
import type { WorkflowEngine } from '../workflow/engine';

/**
 * 失败实例自动重试调度器。
 *
 * `WorkflowInstance` 失败时会把分类、`submitted` 与建议重试时间持久化到 `failure_*` 字段，
 * 但在此之前**没有任何组件去读它们**：Executor 瞬时失败后 workflow 会停在 `failed`，
 * 只有人工调用控制面 retry 才恢复。生产环境需要这一环自动闭合。
 *
 * 重试计数与退避时间同样持久化在 `failure_retry_attempts` / `failure_next_attempt_at` 上：
 * 只存在进程内 Map 的话，每次重启计数归零，持续故障的外部系统会被每轮启动重打一次，
 * `max_attempts_per_workflow` 只在单次进程生命周期内有效。
 *
 * 判定规则（与 `docs/state-machine.md`「Workflow Resume 规则」第 8 条一致）：
 * - `permanent` 失败：不自动重试，等人工修正输入；
 * - `submitted === 'unknown'`：可能已被提供商接受，必须先对账，禁止简单重试；
 * - `failure_retry_after` 未到：按提供商建议的时间等待；
 * - 同一实例连续重试次数达到上限：停止自动重试并告警，避免无限循环打爆外部系统；
 * - 每次重试失败后按指数退避延长下次尝试时间。
 */
export interface RetrySchedulerOptions {
  readonly engine: WorkflowEngine;
  /** 重试计数与退避时间的持久化载体；必须与引擎写入的是同一份状态。 */
  readonly workflow_store: WorkflowStateStore;
  readonly logger?: StructuredLogger;
  /** 当前时间（epoch 毫秒）；显式注入以便测试。 */
  readonly now?: () => number;
  /** 扫描周期。 */
  readonly interval_ms?: number;
  /** 同一实例允许的连续自动重试次数上限。 */
  readonly max_attempts_per_workflow?: number;
  /** 退避上限。 */
  readonly max_backoff_ms?: number;
}

/** 单次扫描对某个实例的处理结论。 */
export type RetryOutcome =
  | 'retried'
  | 'skipped_permanent'
  | 'skipped_unknown_submit'
  | 'skipped_backoff'
  | 'exhausted'
  | 'failed';

export interface RetryAttempt {
  readonly workflow_instance_id: string;
  readonly outcome: RetryOutcome;
  readonly detail: string | null;
}

const DEFAULTS = {
  interval_ms: 30_000,
  max_attempts_per_workflow: 3,
  max_backoff_ms: 300_000,
} as const;

export class RetryScheduler {
  readonly #o: Required<Omit<RetrySchedulerOptions, 'logger' | 'workflow_store'>> & {
    readonly workflow_store: WorkflowStateStore;
    logger?: StructuredLogger;
  };
  /** 已就「达到上限」告警过的实例，避免每轮扫描重复刷告警。 */
  readonly #exhaustedWarned = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(options: RetrySchedulerOptions) {
    this.#o = {
      now: options.now ?? (() => Date.now()),
      interval_ms: options.interval_ms ?? DEFAULTS.interval_ms,
      max_attempts_per_workflow: options.max_attempts_per_workflow ?? DEFAULTS.max_attempts_per_workflow,
      max_backoff_ms: options.max_backoff_ms ?? DEFAULTS.max_backoff_ms,
      engine: options.engine,
      workflow_store: options.workflow_store,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    };
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  /** 幂等启动；定时器 unref，不会阻止进程退出。 */
  start(): void {
    if (this.#timer !== null) {
      return;
    }

    const timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#o.logger?.log('error', 'dealflow.retry.tick_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#o.interval_ms);

    timer.unref();
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** 扫描一轮；返回每个被检查实例的结论，便于测试与手动触发。 */
  async runOnce(): Promise<readonly RetryAttempt[]> {
    if (this.#ticking) {
      return [];
    }
    this.#ticking = true;

    try {
      const results: RetryAttempt[] = [];
      const workflows = this.#o.engine.listWorkflows();
      const failed = workflows.filter((workflow) => workflow.status === 'failed');
      const failedIds = new Set(failed.map((workflow) => workflow.workflow_instance_id));

      // 已离开 failed 的实例清零持久化的退避状态，下次失败从头计数；
      // 否则历史累积会让 `max_attempts_per_workflow` 永久卡住自动重试。
      for (const workflow of workflows) {
        if (workflow.status !== 'failed' && workflow.failure_retry_attempts !== 0) {
          this.#writeAttempts(workflow.workflow_instance_id, 0, null);
        }
      }
      for (const id of [...this.#exhaustedWarned]) {
        if (!failedIds.has(id)) {
          this.#exhaustedWarned.delete(id);
        }
      }

      for (const workflow of failed) {
        const attempt = await this.#attemptRetry(workflow);
        results.push(attempt);
      }

      if (results.length > 0) {
        this.#o.logger?.log('info', 'dealflow.retry.tick', {
          checked: results.length,
          retried: results.filter((result) => result.outcome === 'retried').length,
          failed: results.filter((result) => result.outcome === 'failed').length,
          skipped: results.filter((result) => result.outcome.startsWith('skipped')).length,
          exhausted: results.filter((result) => result.outcome === 'exhausted').length,
        });
      }

      return results;
    } finally {
      this.#ticking = false;
    }
  }

  async #attemptRetry(workflow: WorkflowInstanceState): Promise<RetryAttempt> {
    const id = workflow.workflow_instance_id;
    const now = this.#o.now();
    const attempts = workflow.failure_retry_attempts;

    if (
      !allowsSimpleRetry({
        classification: workflow.failure_classification ?? 'permanent',
        submitted: workflow.failure_submitted ?? false,
      })
    ) {
      const outcome: RetryOutcome =
        workflow.failure_classification === 'permanent' ? 'skipped_permanent' : 'skipped_unknown_submit';
      return { workflow_instance_id: id, outcome, detail: workflow.failure_classification };
    }

    if (attempts >= this.#o.max_attempts_per_workflow) {
      if (!this.#exhaustedWarned.has(id)) {
        this.#exhaustedWarned.add(id);
        this.#o.logger?.log('warn', 'dealflow.retry.exhausted', {
          workflow_instance_id: id,
          attempts,
        });
      }
      return { workflow_instance_id: id, outcome: 'exhausted', detail: `已自动重试 ${attempts} 次` };
    }

    const notBefore = Math.max(
      workflow.failure_next_attempt_at === null ? 0 : safeParse(workflow.failure_next_attempt_at),
      workflow.failure_retry_after === null ? 0 : safeParse(workflow.failure_retry_after),
    );

    if (now < notBefore) {
      return { workflow_instance_id: id, outcome: 'skipped_backoff', detail: new Date(notBefore).toISOString() };
    }

    try {
      // 注意：`retry()` 正常返回**不等于**重试成功 —— 它会重新规划并再次派发，
      // 若派发又失败，返回的实例仍是 failed（失败分类已持久化）。
      // 因此必须检查返回状态，否则会把连续失败当成成功、退避与上限全部失效。
      const retried = await this.#o.engine.retry(id);

      if (retried.status === 'failed') {
        return this.#recordFailure(id, attempts, now, null);
      }

      this.#writeAttempts(id, 0, null);
      this.#exhaustedWarned.delete(id);
      this.#o.logger?.log('info', 'dealflow.retry.succeeded', { workflow_instance_id: id });
      return { workflow_instance_id: id, outcome: 'retried', detail: null };
    } catch (error) {
      return this.#recordFailure(id, attempts, now, error);
    }
  }

  /** 记录一次失败的自动重试：累加计数并按指数退避安排下次尝试时间（两者都持久化）。 */
  #recordFailure(id: string, attempts: number, now: number, error: unknown): RetryAttempt {
    const nextAttempts = attempts + 1;
    const nextAttemptAt = now + Math.min(this.#o.interval_ms * 2 ** (nextAttempts - 1), this.#o.max_backoff_ms);
    this.#writeAttempts(id, nextAttempts, nextAttemptAt);
    const detail = error === null ? '执行仍然失败' : error instanceof Error ? error.message : String(error);
    this.#o.logger?.log('warn', 'dealflow.retry.failed', {
      workflow_instance_id: id,
      attempt: nextAttempts,
      error: detail,
    });
    return { workflow_instance_id: id, outcome: 'failed', detail };
  }

  #writeAttempts(id: string, attempts: number, nextAttemptAtMs: number | null): void {
    const workflow = this.#o.workflow_store.get(id);
    if (workflow === undefined) {
      return;
    }
    this.#o.workflow_store.save({
      ...workflow,
      failure_retry_attempts: attempts,
      failure_next_attempt_at:
        nextAttemptAtMs === null ? null : new Date(nextAttemptAtMs).toISOString(),
      updated_at: new Date(this.#o.now()).toISOString(),
    });
  }
}

function safeParse(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}
