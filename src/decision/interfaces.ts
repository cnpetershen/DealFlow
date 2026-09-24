import type { DecisionContext } from './context';
import type { ProposedAction } from './types';

/**
 * Decision 组件接口：只提出建议，不执行动作。
 *
 * 返回空数组表示「当前事实下没有安全动作」。调用方应按 docs/decision-policy.md
 * 处理为 `waiting_result`、`needs_review` 或结束 Workflow，而不是无限循环规划。
 */
export interface Decider {
  decide(context: DecisionContext): readonly ProposedAction[];
}