import type { ActionType, ProposedAction } from '../decision/types';

/**
 * 提供商回执：外部提供商接受动作后返回的对账标识。
 * 对应 docs/domain.md「Executor Error Contract」与 docs/events.md「Result Event 契约」。
 */
export interface ProviderReceipt {
  readonly provider: string;
  /** 提供商侧唯一回执标识（如邮件 message-id），用于对账与审计追溯。 */
  readonly provider_reference: string;
  /** 提供商关联 id，可与本地 action_id / execution_idempotency_key 对账。 */
  readonly correlation_id: string | null;
}

/**
 * 提交动作的结果：
 * - `accepted`：提供商首次接受
 * - `duplicate`：同一执行幂等 key 已提交过，不产生第二次副作用
 */
export type SubmitOutcome =
  | { readonly status: 'accepted'; readonly receipt: ProviderReceipt }
  | { readonly status: 'duplicate'; readonly receipt: ProviderReceipt };

/**
 * 对账结果：用于 `submitted === 'unknown'`（超时/网络中断）时确认动作是否真的落到了提供商侧。
 *
 * `submitted` 三态的含义：
 * - `true`：提供商侧确实有这次提交 → 按「已派发、等待结果」恢复流程；
 * - `false`：提供商侧没有这次提交 → 可以用**同一个执行幂等 key** 安全重试；
 * - `'unknown'`：提供商有记录但无法确认效果（例如返回了记录却没有回执标识），
 *   或对账请求本身失败 → 保持失败并转人工，绝不允许猜测后重试。
 */
export interface ProviderReconciliation {
  readonly submitted: boolean | 'unknown';
  /** 已提交时提供提供商侧回执标识；未提交时为 null。 */
  readonly provider_reference: string | null;
}

/**
 * Provider Adapter：一个「真实」外部提供商连接器必须实现的端口。
 *
 * 与领域 Executor 的差异：Executor 是引擎侧的「执行动作」端口，Provider Adapter 是
 * 面向具体提供商（邮件、日历、文档等）的提交 + 对账端口。一个 Provider Adapter 只处理
 * 自己声明支持的动作类型，并返回可对账的 provider_reference。
 *
 * 契约：
 * - `submit` 成功返回回执；失败抛可分类的 `ExecutionError`（含 classification / submitted）。
 * - `submit` 对同一 execution_idempotency_key 必须幂等：重复提交返回 `duplicate`，不产生第二次副作用。
 * - `reconcile` 用于判断一次不确定的提交是否真的被提供商接受（`submitted === 'unknown'` 的恢复路径）。
 */
export interface ProviderAdapter {
  readonly provider: string;
  readonly action_types: readonly ActionType[];
  submit(action: ProposedAction): Promise<SubmitOutcome>;
  reconcile(action: ProposedAction): Promise<ProviderReconciliation>;
}
