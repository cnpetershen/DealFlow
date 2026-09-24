/**
 * Policy 的输出契约，对应 docs/decision-policy.md「Policy：Auto 还是 Human Review」。
 *
 * Policy 对每一个 ProposedAction 独立判断：
 * - `auto`：满足自动化条件，可以交给 Executor 尝试执行
 * - `human_review`：必须先由授权人员批准
 * - `reject`：违反硬性规则，不进入执行
 *
 * `reject` 与人工拒绝不同：前者表示规则不允许，后者表示授权人员拒绝了一个原本可审查的建议。
 */

export const POLICY_DECISIONS = ['auto', 'human_review', 'reject'] as const;

export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/**
 * 硬性禁止项。命中即 Reject，不进入执行，也不进入人工审核。
 */
export const POLICY_REJECT_CODES = [
  /** 动作已过期，不得再执行。 */
  'action_expired',
  /** 同一执行幂等 key 已产生过业务效果，重复执行会造成第二次业务效果。 */
  'already_executed',
  /** 缺少执行幂等 key，无法保证不重复执行。 */
  'missing_idempotency_key',
  /** plan_version 与当前 WorkflowInstance 不一致，旧计划不得自动复用。 */
  'stale_plan_version',
  /** Lead 或 Deal 已进入终态，对应的自动动作被终态保护规则拒绝。 */
  'terminal_subject',
  /** 联系人已退订。 */
  'unsubscribed_contact',
  /** 动作类型超出组织允许的动作边界。 */
  'unauthorized_action',
] as const;

export type PolicyRejectCode = (typeof POLICY_REJECT_CODES)[number];

/**
 * 必须人工审核的原因，对应 docs/decision-policy.md「必须人工审核的情况」。
 */
export const POLICY_REVIEW_CODES = [
  /** 动作类型不在自动化白名单内，或 Decision 已标记需要审核。 */
  'not_automation_eligible',
  /** 对外沟通涉及新联系人、关键客户。 */
  'new_or_key_contact',
  /** 对外沟通涉及高价值 Deal。 */
  'high_value_deal',
  /** 涉及报价、折扣、合同、承诺、法律或财务条款。 */
  'commercial_terms',
  /** 动作会覆盖客户明确的联系偏好或合规限制。 */
  'contact_preference_override',
  /** State 与事件、Memory 或 CRM 数据冲突。 */
  'data_conflict',
  /** 结果、关联关系或语义不确定，参数来自模型猜测。 */
  'uncertain_basis',
  /** 动作会推进高风险 Deal 阶段或关闭销售机会。 */
  'high_risk_stage_advance',
  /** 自动化频率、发送窗口或重试次数达到阈值。 */
  'automation_limit_reached',
  /** Policy 版本变化导致旧 ProposedAction 不再可信。 */
  'stale_policy_version',
  /** 兜底：自动化条件未全部满足，按「不确定就转人工」处理。 */
  'auto_condition_not_met',
] as const;

export type PolicyReviewCode = (typeof POLICY_REVIEW_CODES)[number];

export type PolicyReasonCode = PolicyRejectCode | PolicyReviewCode;

/** 一条判定依据，写入 Audit Log 的 reason 字段。 */
export interface PolicyReason {
  readonly code: PolicyReasonCode;
  readonly detail: string;
}

/**
 * 可自动执行的条件，编号与 docs/decision-policy.md「可自动执行的条件」一一对应。
 * Policy 只有在全部条件满足时才输出 `auto`，并把这些条件记录进审计。
 */
export const AUTO_CONDITION_CODES = [
  'action_type_whitelisted',
  'context_integrity_ok',
  'plan_version_current',
  'risk_within_auto_limit',
  'communication_window_ok',
  'parameters_trusted',
  'execution_idempotent',
  'actor_permitted',
] as const;

export type AutoConditionCode = (typeof AUTO_CONDITION_CODES)[number];

interface PolicyOutcomeBase {
  readonly action_id: string;
  readonly policy_version: string;
  /** 本次判定时刻，取自 PolicyContext，保证结果可复现。 */
  readonly evaluated_at: string;
}

export interface AutoPolicyOutcome extends PolicyOutcomeBase {
  readonly decision: 'auto';
  /** 全部满足的可自动执行条件，用于审计「为什么可以自动执行」。 */
  readonly satisfied_conditions: readonly AutoConditionCode[];
}

export interface HumanReviewPolicyOutcome extends PolicyOutcomeBase {
  readonly decision: 'human_review';
  readonly reasons: readonly PolicyReason[];
}

export interface RejectPolicyOutcome extends PolicyOutcomeBase {
  readonly decision: 'reject';
  /** 首要拒绝原因，其余原因见 reasons。 */
  readonly code: PolicyRejectCode;
  readonly reasons: readonly PolicyReason[];
}

export type PolicyOutcome =
  | AutoPolicyOutcome
  | HumanReviewPolicyOutcome
  | RejectPolicyOutcome;