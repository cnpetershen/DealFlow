import type { ProposedAction } from '../decision/types';
import { classifyExecutionError, NO_RECEIPT, type ExecutionResult, type Executor } from './interfaces';

export interface InMemoryExecutorOptions {
  readonly execute?: (action: ProposedAction) => Promise<void> | void;
}

export class InMemoryExecutor implements Executor {
  readonly #execute: (action: ProposedAction) => Promise<void>;
  readonly #completed = new Set<string>();
  readonly #attempted: ProposedAction[] = [];
  #failure: Error | null = null;
  #persistentFailure: Error | null = null;

  constructor(options: InMemoryExecutorOptions = {}) {
    this.#execute = async (action) => options?.execute?.(action);
  }

  async execute(action: ProposedAction): Promise<ExecutionResult> {
    if (this.#completed.has(action.execution_idempotency_key)) {
      return {
        status: 'duplicate',
        action_id: action.action_id,
        execution_idempotency_key: action.execution_idempotency_key,
        ...NO_RECEIPT,
      };
    }

    this.#attempted.push(structuredClone(action));

    const failure = this.#persistentFailure ?? this.#failure;
    if (failure !== null) {
      this.#failure = null;
      throw classifyExecutionError(failure);
    }

    await this.#execute(action);
    this.#completed.add(action.execution_idempotency_key);
    return {
      status: 'accepted',
      action_id: action.action_id,
      execution_idempotency_key: action.execution_idempotency_key,
      ...NO_RECEIPT,
    };
  }

  /** 下一次 execute 失败一次。 */
  failNext(error: Error): void {
    this.#failure = error;
  }

  /** 之后所有 execute 都失败，直到 `clearFailure()`；用于模拟持续不可用的提供商。 */
  failAlways(error: Error): void {
    this.#persistentFailure = error;
  }

  clearFailure(): void {
    this.#persistentFailure = null;
    this.#failure = null;
  }

  attempts(): readonly ProposedAction[] {
    return this.#attempted.map((action) => structuredClone(action));
  }
}
