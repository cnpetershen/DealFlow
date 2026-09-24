import type { ProposedAction } from '../decision/types';

export type ExecutionResult =
  | { readonly status: 'accepted'; readonly action_id: string; readonly execution_idempotency_key: string }
  | { readonly status: 'duplicate'; readonly action_id: string; readonly execution_idempotency_key: string };

/** 执行失败分类：transient 可重试，permanent 需人工介入。 */
export type ErrorClassification = 'transient' | 'permanent';

export interface Executor {
  execute(action: ProposedAction): Promise<ExecutionResult>;
}

/**
 * 在 Executor 错误边界统一分类：
 * - 显式 classification 原样保留
 * - code === 'TIMEOUT' 默认 transient
 * - 其余未分类错误默认 permanent（保守策略，避免盲目重试未知失败）
 */
export function classifyExecutionError(
  error: unknown,
): Error & { classification: ErrorClassification } {
  if (error instanceof Error) {
    const existing = (error as Partial<{ classification: ErrorClassification }>).classification;
    if (existing === 'transient' || existing === 'permanent') {
      return error as Error & { classification: ErrorClassification };
    }

    const code = (error as Partial<{ code: string }>).code;
    const classification: ErrorClassification = code === 'TIMEOUT' ? 'transient' : 'permanent';
    Object.assign(error, { classification });
    return error as Error & { classification: ErrorClassification };
  }

  const wrapped = new Error(String(error));
  Object.assign(wrapped, { classification: 'permanent' as const });
  return wrapped as Error & { classification: ErrorClassification };
}

export class ExecutionError extends Error {
  constructor(
    readonly actionId: string,
    message: string,
    readonly classification: ErrorClassification = 'permanent',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}
