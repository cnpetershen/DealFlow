import type { ProposedAction } from '../decision/types';

/**
 * 执行回执：一次成功派发从外部提供商拿到的对账标识。
 *
 * 只有回执能让「本地 action」与「提供商侧副作用」对上账，因此它必须一路保留到审计：
 * `ProviderAdapter.submit` → `ProviderAdapterExecutor` → `ExecutionResult` → `action_dispatched` AuditEntry。
 * 对应 docs/domain.md「Executor Error Contract」与 docs/events.md「Result Event 契约」。
 */
export interface ExecutionReceipt {
  readonly provider: string | null;
  /** 提供商侧唯一回执标识（如邮件 message-id）。 */
  readonly provider_reference: string | null;
  /** 提供商关联 id，可与本地 action_id / execution_idempotency_key 对账。 */
  readonly correlation_id: string | null;
}

/** 未产生外部回执时的空回执（例如进程内 Executor）。 */
export const NO_RECEIPT: ExecutionReceipt = {
  provider: null,
  provider_reference: null,
  correlation_id: null,
};

export type ExecutionResult =
  | ({ readonly status: 'accepted'; readonly action_id: string; readonly execution_idempotency_key: string } & ExecutionReceipt)
  | ({ readonly status: 'duplicate'; readonly action_id: string; readonly execution_idempotency_key: string } & ExecutionReceipt);

/** 执行失败分类：transient 可重试，permanent 需人工介入。 */
export type ErrorClassification = 'transient' | 'permanent';

/**
 * 动作是否可能已被外部提供商接受：
 * - `false`：确认未提交，可安全重试
 * - `true`：已提交（通常伴随成功或结果事件）
 * - `'unknown'`：超时/网络中断等无法判定，禁止简单 retry，必须先 provider 对账
 */
export type SubmitState = boolean | 'unknown';

export interface ExecutionErrorDetails {
  readonly code?: string | null;
  readonly provider?: string | null;
  readonly provider_reference?: string | null;
  readonly retry_after?: string | null;
  readonly submitted?: SubmitState;
}

export interface ClassifiedExecutionError extends Error {
  readonly classification: ErrorClassification;
  readonly code: string | null;
  readonly provider: string | null;
  readonly provider_reference: string | null;
  readonly retry_after: string | null;
  readonly submitted: SubmitState;
}

export interface Executor {
  execute(action: ProposedAction): Promise<ExecutionResult>;
}

/** 一次对账的结论。`submitted` 为 `'unknown'` 表示提供商侧也无法判定。 */
export interface ReconciledSubmission {
  readonly submitted: boolean | 'unknown';
  /** 作出结论的提供商标识，便于把对账结果写进审计回执。 */
  readonly provider: string | null;
  readonly provider_reference: string | null;
}

/**
 * 支持对账的执行器（可选能力）。
 *
 * `failure_submitted === 'unknown'`（超时/网络中断）时禁止简单 retry，必须先问提供商
 * 「这次提交到底有没有落到你那边」。真实提供商适配器应实现该能力；
 * 进程内 Executor 可以不实现，引擎会在对账请求上明确报错而不是猜一个结论。
 * 与 `EventStore` / `ClaimableEventStore` 同一模式：基础端口保持最小，能力按需探测。
 */
export interface ReconcilableExecutor extends Executor {
  reconcile(action: ProposedAction): Promise<ReconciledSubmission>;
}

export function isReconcilableExecutor(executor: Executor): executor is ReconcilableExecutor {
  return typeof (executor as Partial<ReconcilableExecutor>).reconcile === 'function';
}

/** 规范化后的执行错误字段；调用方可安全读取 classification / submitted 等。 */
export type NormalizedExecutionError = Error & {
  classification: ErrorClassification;
  code: string | null;
  provider: string | null;
  provider_reference: string | null;
  retry_after: string | null;
  submitted: SubmitState;
};

/**
 * 在 Executor 错误边界统一分类：
 * - 显式 classification 原样保留
 * - code === 'TIMEOUT' 默认 transient，submitted 默认 'unknown'（可能已提交）
 * - 其余未分类错误默认 permanent（保守策略）
 * - submitted 未显式提供时：permanent → false；transient → false；TIMEOUT → 'unknown'
 */
export function classifyExecutionError(error: unknown): NormalizedExecutionError {
  if (error instanceof Error) {
    const existing = (error as Partial<{ classification: ErrorClassification }>).classification;
    const code = (error as Partial<{ code?: string | null }>).code ?? null;
    const explicitSubmitted = (error as Partial<{ submitted?: SubmitState }>).submitted;

    const classification: ErrorClassification =
      existing === 'transient' || existing === 'permanent'
        ? existing
        : code === 'TIMEOUT'
          ? 'transient'
          : 'permanent';

    const submitted: SubmitState =
      explicitSubmitted === false || explicitSubmitted === true || explicitSubmitted === 'unknown'
        ? explicitSubmitted
        : classification === 'permanent'
          ? false
          : code === 'TIMEOUT'
            ? 'unknown'
            : false;

    const normalized = error as NormalizedExecutionError;
    normalized.classification = classification;
    normalized.submitted = submitted;
    normalized.code = code;
    normalized.provider =
      (error as Partial<{ provider?: string | null }>).provider ?? null;
    normalized.provider_reference =
      (error as Partial<{ provider_reference?: string | null }>).provider_reference ?? null;
    normalized.retry_after =
      (error as Partial<{ retry_after?: string | null }>).retry_after ?? null;
    return normalized;
  }

  const wrapped = new Error(String(error));
  Object.assign(wrapped, {
    classification: 'permanent' as const,
    submitted: false as const,
    code: null,
    provider: null,
    provider_reference: null,
    retry_after: null,
  });
  return wrapped as NormalizedExecutionError;
}

/** 是否允许自动 retry：permanent 拒绝；submitted === 'unknown' 需对账后才能简单重试。 */
export function allowsSimpleRetry(error: {
  readonly classification: ErrorClassification;
  readonly submitted: SubmitState;
}): boolean {
  if (error.classification === 'permanent') return false;
  return error.submitted !== 'unknown';
}

export class ExecutionError extends Error {
  readonly classification: ErrorClassification;
  readonly code: string | null;
  readonly provider: string | null;
  readonly provider_reference: string | null;
  readonly retry_after: string | null;
  readonly submitted: SubmitState;

  constructor(
    readonly actionId: string,
    message: string,
    classification: ErrorClassification = 'permanent',
    details: ExecutionErrorDetails = {},
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExecutionError';
    this.classification = classification;
    this.code = details.code ?? null;
    this.provider = details.provider ?? null;
    this.provider_reference = details.provider_reference ?? null;
    this.retry_after = details.retry_after ?? null;
    this.submitted = details.submitted ?? false;
  }
}
