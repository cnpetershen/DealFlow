import type { ActionType, ProposedAction } from '../decision/types';
import {
  classifyExecutionError,
  type ExecutionResult,
  type ReconcilableExecutor,
  type ReconciledSubmission,
} from '../executor/interfaces';
import type { ProviderAdapter } from './types';

/**
 * 把一组 Provider Adapter 组合成引擎的 Executor 端口：
 * 按动作类型路由到声明的适配器，`submit` 的回执原样透传给引擎（回执是唯一能让
 * 「本地动作」与「提供商副作用」对上账的东西，不能在这里丢掉）。
 * 失败仍以分类后的 `ExecutionError` 抛回给引擎的 dispatchAction 统一处理。
 *
 * 同时实现 `ReconcilableExecutor`：`submitted === 'unknown'` 时引擎通过它向提供商对账。
 */
export class ProviderAdapterExecutor implements ReconcilableExecutor {
  readonly #byType = new Map<ActionType, ProviderAdapter>();

  constructor(adapters: readonly ProviderAdapter[]) {
    for (const adapter of adapters) {
      for (const actionType of adapter.action_types) {
        this.#byType.set(actionType, adapter);
      }
    }
  }

  async execute(action: ProposedAction): Promise<ExecutionResult> {
    const adapter = this.#adapterFor(action);
    const outcome = await adapter.submit(action);

    return {
      status: outcome.status,
      action_id: action.action_id,
      execution_idempotency_key: action.execution_idempotency_key,
      provider: outcome.receipt.provider,
      provider_reference: outcome.receipt.provider_reference,
      correlation_id: outcome.receipt.correlation_id,
    };
  }

  /** 对账落到声明支持该动作类型的同一个适配器上。 */
  async reconcile(action: ProposedAction): Promise<ReconciledSubmission> {
    const adapter = this.#adapterFor(action);
    const reconciliation = await adapter.reconcile(action);

    return {
      submitted: reconciliation.submitted,
      provider: adapter.provider,
      provider_reference: reconciliation.provider_reference,
    };
  }

  #adapterFor(action: ProposedAction): ProviderAdapter {
    const adapter = this.#byType.get(action.action_type);
    if (adapter === undefined) {
      throw classifyExecutionError(
        Object.assign(new Error(`无 Provider Adapter 支持动作类型 ${action.action_type}`), {
          classification: 'permanent' as const,
        }),
      );
    }
    return adapter;
  }
}
