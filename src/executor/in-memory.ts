import type { ProposedAction } from '../decision/types';
import { classifyExecutionError, type ExecutionResult, type Executor } from './interfaces';

export interface InMemoryExecutorOptions {
  readonly execute?: (action: ProposedAction) => Promise<void> | void;
}

export class InMemoryExecutor implements Executor {
  readonly #execute: (action: ProposedAction) => Promise<void>;
  readonly #completed = new Set<string>();
  readonly #attempted: ProposedAction[] = [];
  #failure: Error | null = null;

  constructor(options: InMemoryExecutorOptions = {}) {
    this.#execute = async (action) => options.execute?.(action);
  }

  async execute(action: ProposedAction): Promise<ExecutionResult> {
    if (this.#completed.has(action.execution_idempotency_key)) {
      return { status: 'duplicate', action_id: action.action_id, execution_idempotency_key: action.execution_idempotency_key };
    }

    this.#attempted.push(structuredClone(action));
    if (this.#failure !== null) {
      const failure = this.#failure;
      this.#failure = null;
      throw classifyExecutionError(failure);
    }

    await this.#execute(action);
    this.#completed.add(action.execution_idempotency_key);
    return { status: 'accepted', action_id: action.action_id, execution_idempotency_key: action.execution_idempotency_key };
  }

  failNext(error: Error): void {
    this.#failure = error;
  }

  attempts(): readonly ProposedAction[] {
    return this.#attempted.map((action) => structuredClone(action));
  }
}
