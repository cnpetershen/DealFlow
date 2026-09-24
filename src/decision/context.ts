import type { ParsedEvent } from '../events/dictionary';
import type {
  ContactState,
  DealState,
  LeadState,
  WorkflowInstanceState,
} from '../stores/types';
import type { ActionType } from './types';

/**
 * Decision 的输入快照，对应 docs/decision-policy.md「输入 Context」。
 *
 * Context 不是新的事实来源：当前事实以 State 为准，历史证据以事件与 Memory 为准。
 * 它只是把「做这一次判断所需的输入」聚合在一起，便于审计「基于什么事实提出了什么建议」。
 */

/** Memory 摘要：历史互动、偏好与有效上下文，随时可检索，但不作为当前事实的唯一来源。 */
export interface MemorySummary {
  interaction_count: number;
  last_interaction_at: string | null;
  /** 从历史互动中沉淀的客户偏好，例如「只在上午联系」。 */
  preferences: readonly string[];
}

export const TASK_STATUSES = ['open', 'overdue'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface PendingTask {
  task_id: string;
  task_type: string;
  assigned_to: string;
  due_at: string;
  status: TaskStatus;
}

/**
 * 已验证配置。动作参数只能来自 State 或这里，不能由模型猜测。
 * 字段为空表示缺少可信参数，Decider 必须放弃对应动作，而不是编造内容。
 */
export interface VerifiedConfig {
  first_touch_email_template_id: string | null;
  proposal_document_reference: string | null;
  default_meeting_duration_minutes: number;
}

export const PREVIOUS_ACTION_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'expired',
] as const;

export type PreviousActionStatus = (typeof PREVIOUS_ACTION_STATUSES)[number];

/** 相关 ProposedAction 的历史结论，用于体现「拒绝原因成为新的规划约束」。 */
export interface PreviousDecision {
  action_id: string;
  action_type: ActionType;
  status: PreviousActionStatus;
  plan_version: number;
  decided_by: string | null;
  reason: string | null;
  decided_at: string | null;
}

/** 适用的 Policy 版本、组织规则、时间窗口、权限与合规限制。 */
export interface PolicyContext {
  policy_version: string;
  /** 本次判断的时刻。显式传入而非读取时钟，保证判定可复现。 */
  evaluated_at: string;
  /** 允许自动执行的动作类型白名单。 */
  automation_whitelist: readonly ActionType[];
  /** 组织允许的动作类型边界；不在其中属于硬性 Reject。 */
  permitted_action_types: readonly ActionType[];
  /** 允许触发自动动作的操作者；由组织和操作者权限共同决定。 */
  permitted_actor_ids: readonly string[];
  /** 组织业务时区相对 UTC 的分钟偏移，用于判定发送窗口。 */
  business_timezone_offset_minutes: number;
  /** 允许外发沟通的小时区间，左闭右开，按业务时区计算。 */
  send_window: { readonly start_hour: number; readonly end_hour: number };
  max_auto_actions_per_day: number;
  auto_actions_today: number;
  /** 关键客户 Lead，其外部沟通必须人工审核。 */
  key_account_lead_ids: readonly string[];
  /** 达到该金额的 Deal 属于高价值，其外部沟通必须人工审核。 */
  high_value_deal_threshold: number;
}

/** 当前输入事件与已处理事件 key，用于保证动作不会被执行出第二次业务效果。 */
export interface IdempotencyContext {
  input_event_id: string;
  processed_idempotency_keys: readonly string[];
}

export interface DecisionContext {
  workflow_instance: WorkflowInstanceState;
  lead_state: LeadState | null;
  contact_state: ContactState | null;
  deal_state: DealState | null;
  verified_config: VerifiedConfig;
  recent_events: readonly ParsedEvent[];
  memory: MemorySummary;
  pending_tasks: readonly PendingTask[];
  policy_context: PolicyContext;
  previous_decisions: readonly PreviousDecision[];
  idempotency_context: IdempotencyContext;
  /**
   * State 与事件、Memory 或 CRM 数据之间的冲突说明。
   * 非空表示事实不可信，Policy 必须转人工审核，不得自动执行。
   */
  data_conflicts: readonly string[];
}