import type { DecisionContext } from '../decision/context';
import type { ProposedAction } from '../decision/types';
import type { PolicyOutcome } from './types';

/**
 * Policy 组件接口：对每一个 ProposedAction 独立判断风险与权限。
 *
 * Policy 只输出结论，不执行动作。结论必须写入只追加 Audit Log。
 */
export interface PolicyEvaluator {
  evaluate(action: ProposedAction, context: DecisionContext): PolicyOutcome;
}