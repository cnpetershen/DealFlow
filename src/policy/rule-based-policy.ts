import type { DecisionContext } from '../decision/context';
import { ACTION_METADATA, type ProposedAction } from '../decision/types';
import { isDealTerminal, isLeadTerminal, isWorkflowTerminal } from '../state-machine/states';
import type { PolicyEvaluator } from './interfaces';
import {
  AUTO_CONDITION_CODES,
  type AutoConditionCode,
  type PolicyOutcome,
  type PolicyReason,
  type PolicyRejectCode,
  type PolicyReviewCode,
} from './types';

/**
 * 确定性规则版 Policy，对应 docs/decision-policy.md「Policy：Auto 还是 Human Review」。
 *
 * 判定顺序固定为 Reject → Human Review → Auto：
 * 1. 硬性禁止项命中即 `reject`，不进入执行也不进入人工审核；
 * 2. 逐条检查「可自动执行的条件」，任一条件不满足即 `human_review`，并记录未满足的条件；
 * 3. 全部条件满足才输出 `auto`，同时记录已满足的条件。
 *
 * Policy 只输出结论，不执行动作；结论必须写入只追加 Audit Log。
 */

/** 自动化条件下的风险上限；高于该等级的动作一律转人工。 */
const AUTO_RISK_LEVELS = ['low', 'medium'] as const;

/** 推进到这些阶段会关闭销售机会或进入条款谈判，必须人工审核。 */
const HIGH_RISK_STAGE_ADVANCE_TARGETS = ['negotiation', 'won', 'lost'] as const;

export class RuleBasedPolicyEvaluator implements PolicyEvaluator {
  evaluate(action: ProposedAction, context: DecisionContext): PolicyOutcome {
    const base = {
      action_id: action.action_id,
      policy_version: action.policy_version,
      evaluated_at: context.policy_context.evaluated_at,
    };

    const rejected = collectRejectReasons(action, context);

    if (rejected.length > 0) {
      return {
        ...base,
        decision: 'reject',
        code: rejected[0]!.code as PolicyRejectCode,
        reasons: rejected,
      };
    }

    const unmet = AUTO_CONDITION_CODES.filter((code) => !satisfiesAutoCondition(code, action, context));
    const reviewReasons = collectReviewReasons(action, context, unmet);

    if (reviewReasons.length > 0) {
      return { ...base, decision: 'human_review', reasons: reviewReasons };
    }

    return { ...base, decision: 'auto', satisfied_conditions: [...AUTO_CONDITION_CODES] };
  }
}

/**
 * 已由专门审核规则给出原因的自动执行条件。
 * 其余未满足的条件（风险上限、操作者权限）由兜底原因统一表达。
 * `plan_version_current` 未满足时已在硬性 Reject 阶段被拒绝，不会走到这里。
 */
const AUTO_CONDITIONS_WITH_DEDICATED_REASONS: readonly AutoConditionCode[] = [
  'action_type_whitelisted',
  'context_integrity_ok',
  'plan_version_current',
  'communication_window_ok',
  'parameters_trusted',
];

/**
 * 硬性禁止项，按「动作自身是否已失效」→「业务规则是否允许」的顺序检查，
 * 首个命中的原因即 `PolicyOutcome.code`，全部命中原因都会写入审计。
 */
function collectRejectReasons(action: ProposedAction, context: DecisionContext): readonly PolicyReason[] {
  const reasons: PolicyReason[] = [];
  const { policy_context: policy, contact_state: contact, lead_state: lead, deal_state: deal } = context;

  if (action.execution_idempotency_key.length === 0) {
    reasons.push({ code: 'missing_idempotency_key', detail: '动作缺少执行幂等 key，无法保证不重复执行' });
  } else if (context.idempotency_context.processed_idempotency_keys.includes(action.execution_idempotency_key)) {
    reasons.push({
      code: 'already_executed',
      detail: `执行幂等 key ${action.execution_idempotency_key} 已产生过业务效果，拒绝重复执行`,
    });
  }

  if (Date.parse(action.expires_at) <= Date.parse(policy.evaluated_at)) {
    reasons.push({
      code: 'action_expired',
      detail: `动作有效期至 ${action.expires_at}，判定时刻 ${policy.evaluated_at} 已过期`,
    });
  }

  if (action.plan_version !== context.workflow_instance.plan_version) {
    reasons.push({
      code: 'stale_plan_version',
      detail: `动作 plan_version=${action.plan_version} 与当前实例 plan_version=${context.workflow_instance.plan_version} 不一致`,
    });
  }

  if (lead !== null && isLeadTerminal(lead.status)) {
    reasons.push({ code: 'terminal_subject', detail: `Lead ${lead.lead_id} 已进入终态 ${lead.status}` });
  }

  if (deal !== null && isDealTerminal(deal.stage)) {
    reasons.push({
      code: 'terminal_subject',
      detail: `Deal ${deal.deal_id} 已进入终态 ${deal.stage}，不再接受自动动作`,
    });
  }

  if (isWorkflowTerminal(context.workflow_instance.status)) {
    reasons.push({
      code: 'terminal_subject',
      detail: `Workflow ${context.workflow_instance.workflow_instance_id} 已进入终态 ${context.workflow_instance.status}`,
    });
  }

  if (contact !== null && contact.contactability === 'unsubscribed') {
    reasons.push({ code: 'unsubscribed_contact', detail: `联系人 ${contact.contact_id} 已退订，禁止外发沟通` });
  }

  if (!policy.permitted_action_types.includes(action.action_type)) {
    reasons.push({
      code: 'unauthorized_action',
      detail: `动作类型 ${action.action_type} 超出组织允许的动作边界`,
    });
  }

  return reasons;
}

function satisfiesAutoCondition(
  code: AutoConditionCode,
  action: ProposedAction,
  context: DecisionContext,
): boolean {
  const { policy_context: policy } = context;

  switch (code) {
    case 'action_type_whitelisted':
      return policy.automation_whitelist.includes(action.action_type);
    case 'context_integrity_ok':
      return context.data_conflicts.length === 0 && hasConsistentReferences(action, context);
    case 'plan_version_current':
      return action.plan_version === context.workflow_instance.plan_version;
    case 'risk_within_auto_limit':
      return (
        (AUTO_RISK_LEVELS as readonly string[]).includes(action.risk_level) &&
        !ACTION_METADATA[action.action_type].commercial &&
        highRiskStageAdvanceTarget(action) === null
      );
    case 'communication_window_ok':
      return communicationConstraints(context, ACTION_METADATA[action.action_type].external_communication).length === 0;
    case 'parameters_trusted':
      return action.parameter_source !== 'model_inference';
    case 'execution_idempotent':
      return action.execution_idempotency_key.length > 0;
    case 'actor_permitted':
      return isActorPermitted(action, context);
  }
}

/** 动作的关联关系必须与当前 State 一致，否则事实不可信。 */
function hasConsistentReferences(action: ProposedAction, context: DecisionContext): boolean {
  const { workflow_instance: workflow, lead_state: lead, deal_state: deal } = context;

  if (action.workflow_instance_id !== workflow.workflow_instance_id) {
    return false;
  }

  if (action.subject_id !== workflow.subject_id) {
    return false;
  }

  if (workflow.subject_type === 'lead' && lead !== null && lead.lead_id !== workflow.subject_id) {
    return false;
  }

  return deal === null || lead === null || deal.lead_id === lead.lead_id;
}

function collectReviewReasons(
  action: ProposedAction,
  context: DecisionContext,
  unmet: readonly AutoConditionCode[],
): readonly PolicyReason[] {
  const reasons: PolicyReason[] = [];
  const { policy_context: policy, contact_state: contact, lead_state: lead, deal_state: deal } = context;
  const external = ACTION_METADATA[action.action_type].external_communication;

  if (unmet.includes('action_type_whitelisted') || action.requires_approval) {
    reasons.push({
      code: 'not_automation_eligible',
      detail: action.requires_approval
        ? 'Decision 标记该动作需要人工审核'
        : `动作类型 ${action.action_type} 不在自动化白名单内`,
    });
  }

  if (external && contact !== null && (contact.is_new_contact || isKeyAccount(lead?.lead_id ?? null, policy.key_account_lead_ids))) {
    reasons.push({
      code: 'new_or_key_contact',
      detail: contact.is_new_contact
        ? `联系人 ${contact.contact_id} 为新联系人，外发沟通必须先审核`
        : `Lead ${lead?.lead_id ?? ''} 属于关键客户，外发沟通必须先审核`,
    });
  }

  if (
    external &&
    deal !== null &&
    lead !== null &&
    deal.lead_id === lead.lead_id &&
    deal.amount !== null &&
    deal.amount >= policy.high_value_deal_threshold
  ) {
    reasons.push({
      code: 'high_value_deal',
      detail: `Deal ${deal.deal_id} 金额 ${deal.amount} 达到高价值阈值 ${policy.high_value_deal_threshold}`,
    });
  }

  if (ACTION_METADATA[action.action_type].commercial) {
    reasons.push({
      code: 'commercial_terms',
      detail: `动作类型 ${action.action_type} 涉及报价、折扣、合同或承诺条款`,
    });
  }

  if (external && contact !== null && contact.contact_preference === 'human_only') {
    reasons.push({
      code: 'contact_preference_override',
      detail: `联系人 ${contact.contact_id} 的联系偏好要求人工联系，自动外发会覆盖该偏好`,
    });
  }

  if (context.data_conflicts.length > 0) {
    reasons.push({ code: 'data_conflict', detail: context.data_conflicts.join('；') });
  } else if (unmet.includes('context_integrity_ok')) {
    reasons.push({
      code: 'data_conflict',
      detail: '动作关联关系与当前 State 不一致，事实不可信',
    });
  }

  if (unmet.includes('parameters_trusted')) {
    reasons.push({
      code: 'uncertain_basis',
      detail: '动作参数来自模型推断而非可信 State 或已验证配置，需要人工确认',
    });
  }

  const riskyTarget = highRiskStageAdvanceTarget(action);

  if (riskyTarget !== null) {
    reasons.push({
      code: 'high_risk_stage_advance',
      detail: `动作会将 Deal 推进到 ${riskyTarget}，属于高风险阶段变更`,
    });
  }

  if (unmet.includes('communication_window_ok')) {
    reasons.push({
      code: 'automation_limit_reached',
      detail:
        communicationConstraints(context, external).join('；') || '自动化频率或发送窗口约束未满足',
    });
  }

  if (action.policy_version !== policy.policy_version) {
    reasons.push({
      code: 'stale_policy_version',
      detail: `动作基于 Policy 版本 ${action.policy_version}，当前有效版本为 ${policy.policy_version}`,
    });
  }

  const unclassified = unmet.filter(
    (code) => !AUTO_CONDITIONS_WITH_DEDICATED_REASONS.includes(code),
  );

  if (unclassified.length > 0) {
    reasons.push({
      code: 'auto_condition_not_met',
      detail: `未满足的可自动执行条件: ${unclassified.join(', ')}`,
    });
  }

  return reasons;
}

function isActorPermitted(action: ProposedAction, context: DecisionContext): boolean {
  const actorId = context.lead_state?.owner_id ?? context.deal_state?.owner_id ?? null;

  return actorId !== null && context.policy_context.permitted_actor_ids.includes(actorId);
}

function isKeyAccount(leadId: string | null, keyAccountLeadIds: readonly string[]): boolean {
  return leadId !== null && keyAccountLeadIds.includes(leadId);
}

/** 返回动作会推进到的高风险阶段；不是高风险阶段推进时返回 null。 */
function highRiskStageAdvanceTarget(action: ProposedAction): string | null {
  if (action.action_type !== 'advance_deal_stage') {
    return null;
  }

  const toStage: string = action.parameters.to_stage;

  return (HIGH_RISK_STAGE_ADVANCE_TARGETS as readonly string[]).includes(toStage) ? toStage : null;
}

/**
 * 按业务时区判定是否处于允许发送窗口内，避免依赖服务器本地时区。
 *
 * `start_hour >= end_hour` 是**跨零点窗口**（例如夜间静默 22:00-07:00，以及 `start === end`
 * 的全天窗口），按「≥ 起点 或 < 终点」判定；否则按普通的「≥ 起点 且 < 终点」判定。
 * 少了跨零点分支时起点永远大于终点、条件恒为假，夜间的静默窗口会被判成
 * 「永远不在窗口内」，所有对外沟通一律被转人工。
 */
function isWithinSendWindow(context: DecisionContext): boolean {
  const { evaluated_at: evaluatedAt, business_timezone_offset_minutes: offsetMinutes, send_window: window } =
    context.policy_context;

  const localHour = new Date(Date.parse(evaluatedAt) + offsetMinutes * 60_000).getUTCHours();

  if (window.start_hour < window.end_hour) {
    return localHour >= window.start_hour && localHour < window.end_hour;
  }

  return localHour >= window.start_hour || localHour < window.end_hour;
}

/**
 * 被违反的自动化频率与发送窗口约束。
 * 发送窗口只约束对外沟通，频率上限约束全部自动动作。
 */
function communicationConstraints(context: DecisionContext, external: boolean): readonly string[] {
  const policy = context.policy_context;
  const violated: string[] = [];

  if (external && !isWithinSendWindow(context)) {
    violated.push(
      `判定时刻 ${policy.evaluated_at} 不在允许发送窗口 ${policy.send_window.start_hour}:00-${policy.send_window.end_hour}:00 内`,
    );
  }

  if (policy.auto_actions_today >= policy.max_auto_actions_per_day) {
    violated.push(`当日自动动作已达上限 ${policy.max_auto_actions_per_day} 次`);
  }

  return violated;
}