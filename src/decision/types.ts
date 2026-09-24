import { z } from 'zod';

import { DEAL_STAGES } from '../state-machine/states';

/**
 * Decision 的输出契约，对应 docs/decision-policy.md「输出 ProposedAction」。
 *
 * ProposedAction 只表示「建议做什么」，不代表动作已经发生。
 * 只有 Policy 给出 Auto 结论、或授权人员 Approved 之后，Executor 才可以尝试执行。
 */

export const ACTION_TYPES = [
  'send_email',
  'schedule_meeting',
  'create_task',
  'send_proposal',
  'advance_deal_stage',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * 动作参数的来源。
 * 对应 docs/decision-policy.md 可自动执行条件第 6 条：参数必须来自可信 State 或已验证配置，
 * 不允许来自模型猜测，否则只能转人工。
 */
export const PARAMETER_SOURCES = ['state', 'verified_config', 'model_inference'] as const;

export type ParameterSource = (typeof PARAMETER_SOURCES)[number];

/**
 * 动作类型的固有属性，是 Decision 与 Policy 共用的唯一来源。
 * - `external_communication`：是否是对外沟通，受联系偏好、发送窗口与频率约束
 * - `commercial`：是否涉及报价、条款等商业内容，必须人工审核
 */
export interface ActionMetadata {
  readonly risk_level: RiskLevel;
  /** 未执行动作的默认有效期，超过后不得再执行。 */
  readonly default_ttl_hours: number;
  readonly external_communication: boolean;
  readonly commercial: boolean;
}

export const ACTION_METADATA = {
  send_email: {
    risk_level: 'low',
    default_ttl_hours: 48,
    external_communication: true,
    commercial: false,
  },
  schedule_meeting: {
    risk_level: 'medium',
    default_ttl_hours: 72,
    external_communication: true,
    commercial: false,
  },
  create_task: {
    risk_level: 'low',
    default_ttl_hours: 168,
    external_communication: false,
    commercial: false,
  },
  send_proposal: {
    risk_level: 'high',
    default_ttl_hours: 48,
    external_communication: true,
    commercial: true,
  },
  advance_deal_stage: {
    risk_level: 'medium',
    default_ttl_hours: 168,
    external_communication: false,
    commercial: false,
  },
} as const satisfies Record<ActionType, ActionMetadata>;

const identifier = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });

/** 动作自身的参数，按 action_type 区分。 */
export const sendEmailParameters = z.object({
  template_id: identifier,
  recipient_email: z.string().email(),
  subject: identifier.nullable(),
});

export const scheduleMeetingParameters = z.object({
  agenda: identifier,
  duration_minutes: z.number().int().positive(),
  /** 可接受的最早开始时间；具体时段由 Executor 与日历连接器协商确定。 */
  earliest_start_at: timestamp,
});

export const createTaskParameters = z.object({
  task_type: identifier,
  assigned_to: identifier,
  due_at: timestamp,
  note: identifier,
});

export const sendProposalParameters = z.object({
  document_reference: identifier,
  amount: z.number().nonnegative().nullable(),
  currency: identifier.nullable(),
});

export const advanceDealStageParameters = z.object({
  to_stage: z.enum(DEAL_STAGES),
});

const proposedActionBase = z.object({
  action_id: identifier,
  action_type: z.enum(ACTION_TYPES),
  subject_type: identifier,
  subject_id: identifier,
  workflow_instance_id: identifier,
  lead_id: identifier.nullable(),
  contact_id: identifier.nullable(),
  deal_id: identifier.nullable(),
  reason: identifier,
  expected_outcome: identifier,
  risk_level: z.enum(RISK_LEVELS),
  /** 提出该动作时所依据的 Policy 版本；与当前版本不一致时不再可信。 */
  policy_version: identifier,
  plan_version: z.number().int().min(1),
  /** Decision 自己给出的审核建议，最终以 Policy 结论为准。 */
  requires_approval: z.boolean(),
  expires_at: timestamp,
  parameter_source: z.enum(PARAMETER_SOURCES),
  /** 执行幂等 key，保证同一动作不会被执行出第二次业务效果。 */
  execution_idempotency_key: identifier,
});

export const proposedActionSchema = z.discriminatedUnion('action_type', [
  proposedActionBase.extend({
    action_type: z.literal('send_email'),
    parameters: sendEmailParameters,
  }),
  proposedActionBase.extend({
    action_type: z.literal('schedule_meeting'),
    parameters: scheduleMeetingParameters,
  }),
  proposedActionBase.extend({
    action_type: z.literal('create_task'),
    parameters: createTaskParameters,
  }),
  proposedActionBase.extend({
    action_type: z.literal('send_proposal'),
    parameters: sendProposalParameters,
  }),
  proposedActionBase.extend({
    action_type: z.literal('advance_deal_stage'),
    parameters: advanceDealStageParameters,
  }),
]);

export type ProposedAction = z.infer<typeof proposedActionSchema>;

/**
 * Decision 产出的草稿：`action_id` 与执行幂等 key 由 Decider 统一生成，
 * 因此规则本身只需要给出业务内容。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ProposedActionDraft = DistributiveOmit<
  ProposedAction,
  'action_id' | 'execution_idempotency_key'
>;

export function parseProposedAction(input: unknown): ProposedAction {
  return proposedActionSchema.parse(input);
}

export function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}