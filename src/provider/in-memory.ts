import type { ActionType, ProposedAction } from '../decision/types';
import { classifyExecutionError } from '../executor/interfaces';
import type { ProviderAdapter, ProviderReceipt, ProviderReconciliation, SubmitOutcome } from './types';

export interface InMemoryProviderAdapterOptions {
  readonly provider?: string;
  /** 默认支持全部动作类型。 */
  readonly action_types?: readonly ActionType[];
  /** 注入自定义提交行为；返回即视为接受。 */
  readonly submit?: (action: ProposedAction) => Promise<void> | void;
  /** 注入自定义对账行为；不提供时按已记录的回执判断。 */
  readonly reconcile?: (action: ProposedAction) => Promise<ProviderReconciliation> | ProviderReconciliation;
}

/**
 * 参考实现：内存版 Provider Adapter，行为契约与真实适配器一致。
 *
 * 测试注入点：
 * - `failNext(error, { record_receipt })`：提交失败；`record_receipt` 模拟
 *   「提供商已接受、回执在响应途中丢失」这一 `submitted === 'unknown'` 的关键场景；
 * - `failReconcileNext(error)`：对账请求本身失败；
 * - `submitted()` / `reconcileCalls()`：断言副作用次数与对账调用次数。
 */
export class InMemoryProviderAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly action_types: readonly ActionType[];

  readonly #receipts = new Map<string, ProviderReceipt>();
  readonly #submitted: ProposedAction[] = [];
  readonly #submit: (action: ProposedAction) => Promise<void>;
  readonly #reconcile: (action: ProposedAction) => Promise<ProviderReconciliation>;
  #failure: Error | null = null;
  #failureRecordsReceipt = false;
  #reconcileFailure: Error | null = null;
  #reconcileCalls = 0;

  constructor(options: InMemoryProviderAdapterOptions = {}) {
    this.provider = options.provider ?? 'in-memory';
    this.action_types = options.action_types ?? (['send_email', 'schedule_meeting', 'create_task', 'send_proposal', 'advance_deal_stage'] as const);
    this.#submit = async (action) => options.submit?.(action);
    this.#reconcile = async (action) => options.reconcile?.(action) ?? this.#reconcileFromReceipts(action);
  }

  async submit(action: ProposedAction): Promise<SubmitOutcome> {
    const existing = this.#receipts.get(action.execution_idempotency_key);
    if (existing !== undefined) {
      return { status: 'duplicate', receipt: existing };
    }

    this.#submitted.push(structuredClone(action));

    if (this.#failure !== null) {
      const failure = this.#failure;
      const recordsReceipt = this.#failureRecordsReceipt;
      this.#failure = null;
      this.#failureRecordsReceipt = false;

      // 模拟「提供商已接受、但回执在响应途中丢失」：副作用已发生，调用方只看到超时。
      if (recordsReceipt) {
        this.#receipts.set(action.execution_idempotency_key, this.#receiptFor(action));
      }
      throw classifyExecutionError(failure);
    }

    await this.#submit(action);

    const receipt = this.#receiptFor(action);
    this.#receipts.set(action.execution_idempotency_key, receipt);
    return { status: 'accepted', receipt };
  }

  async reconcile(action: ProposedAction): Promise<ProviderReconciliation> {
    this.#reconcileCalls += 1;

    if (this.#reconcileFailure !== null) {
      const failure = this.#reconcileFailure;
      this.#reconcileFailure = null;
      throw failure;
    }

    return this.#reconcile(action);
  }

  /** 下一次 submit 失败一次；`record_receipt` 为真时同时记录回执（模拟响应丢失）。 */
  failNext(error: Error, options: { record_receipt?: boolean } = {}): void {
    this.#failure = error;
    this.#failureRecordsReceipt = options.record_receipt === true;
  }

  /** 下一次 reconcile 抛错（对账请求本身失败）。 */
  failReconcileNext(error: Error): void {
    this.#reconcileFailure = error;
  }

  submitted(): readonly ProposedAction[] {
    return this.#submitted.map((action) => structuredClone(action));
  }

  reconcileCalls(): number {
    return this.#reconcileCalls;
  }

  #reconcileFromReceipts(action: ProposedAction): ProviderReconciliation {
    const receipt = this.#receipts.get(action.execution_idempotency_key);
    return receipt === undefined
      ? { submitted: false, provider_reference: null }
      : { submitted: true, provider_reference: receipt.provider_reference };
  }

  #receiptFor(action: ProposedAction): ProviderReceipt {
    return {
      provider: this.provider,
      provider_reference: `${this.provider}:${action.execution_idempotency_key}`,
      correlation_id: null,
    };
  }
}
