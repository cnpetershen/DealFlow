import type { EventType } from '../events/dictionary';
import type { DealStage, LeadStatus, WorkflowStatus } from '../state-machine/states';

/** 审计动作类型，对应 docs/domain.md「AuditEntry 字段定义」。 */
export type AuditAction =
  | 'event_processed'
  | 'state_transitioned'
  | 'decision_proposed'
  | 'policy_evaluated'
  | 'policy_rejected'
  | 'action_approved'
  | 'action_rejected'
  | 'action_dispatched'
  | 'action_failed'
  | 'event_conflicted';

export type AuditActorType = 'system' | 'user' | 'connector';

export interface AuditActor {
  actor_type: AuditActorType;
  actor_id: string;
}

export interface AuditSubject {
  subject_type: string;
  subject_id: string;
  workflow_instance_id: string | null;
}

export type AuditResult = 'succeeded' | 'failed' | 'skipped' | 'pending';

/**
 * 审计记录，只追加、不参与状态计算。
 * `event_id` 与 `action_id` 至少一个不为空。
 */
export interface AuditEntry {
  audit_id: string;
  occurred_at: string;
  actor: AuditActor;
  action: AuditAction;
  subject: AuditSubject;
  event_id: string | null;
  action_id: string | null;
  before_state: string | null;
  after_state: string | null;
  reason: string | null;
  policy_version: string | null;
  plan_version: number | null;
  source: string;
  result: AuditResult;
  /** 外部提供商回执标识（如邮件服务 message-id），便于对账与排障；无则为 null。 */
  provider_reference: string | null;
}

/** audit_id 由 Audit Log 生成，不由调用方提供。 */
export type NewAuditEntry = Omit<AuditEntry, 'audit_id'>;

/** 异常队列写入原因，对应 docs/domain.md「异常队列」。 */
export type ExceptionReason =
  | 'idempotency_conflict'
  | 'unmatched_event'
  | 'stale_event'
  | 'invalid_transition'
  | 'processing_error';

export type ExceptionStatus = 'open' | 'resolved' | 'discarded';

/** 异常记录携带事件完整信封副本，原始事件本身保持不可变。 */
export interface ExceptionRecord {
  exception_id: string;
  occurred_at: string;
  reason: ExceptionReason;
  event_id: string;
  event: unknown;
  subject: AuditSubject | null;
  status: ExceptionStatus;
  resolution: string | null;
}

/** exception_id、status、resolution 由异常队列生成，不由调用方提供。 */
export type NewException = Omit<ExceptionRecord, 'exception_id' | 'status' | 'resolution'>;

export interface LeadState {
  lead_id: string;
  source_channel: string;
  source_record_id: string;
  company_name: string | null;
  contact_id: string | null;
  owner_id: string | null;
  status: LeadStatus;
  created_at: string;
  updated_at: string;
}

export interface DealState {
  deal_id: string;
  lead_id: string;
  contact_id: string | null;
  owner_id: string | null;
  stage: DealStage;
  amount: number | null;
  currency: string | null;
  expected_close_at: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

/** 联系偏好：是否允许系统自动外发沟通。 */
export const CONTACT_PREFERENCES = ['auto_allowed', 'human_only'] as const;

export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];

/** 可联系状态；`unsubscribed` 表示联系人已明确退订。 */
export const CONTACTABILITIES = ['reachable', 'unsubscribed'] as const;

export type Contactability = (typeof CONTACTABILITIES)[number];

/**
 * Contact 当前事实，对应 docs/domain.md「Contact」。
 * 只保存当前有效值；历史互动进入事件流与 Memory。
 */
export interface ContactState {
  contact_id: string;
  full_name: string | null;
  email: string | null;
  organization_id: string | null;
  contact_preference: ContactPreference;
  contactability: Contactability;
  /** 尚无历史互动的新联系人，外发沟通需要更严格审核。 */
  is_new_contact: boolean;
  updated_at: string;
}

/**
 * workflow_instance_id 是技术标识，不替代业务幂等 key。
 * 业务 key 由 `(workflow_type, subject_type, subject_id)` 唯一确定。
 */
export interface WorkflowInstanceState {
  workflow_instance_id: string;
  workflow_type: string;
  subject_type: string;
  subject_id: string;
  status: WorkflowStatus;
  /** 当前节点或等待节点。 */
  current_step: string | null;
  /** 期望接收的结果事件条件；MVP 以事件类型表达，非等待状态为空数组。 */
  awaiting_event_types: readonly EventType[];
  plan_version: number;
  /** 最近一次处理的事件标识。 */
  last_processed_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export type WorkflowBusinessKey = Pick<
  WorkflowInstanceState,
  'workflow_type' | 'subject_type' | 'subject_id'
>;

/**
 * 把业务 key 序列化为可安全用作 Map 键的字符串。
 * 使用 JSON 数组而非字符串拼接，避免字段值包含分隔符时产生歧义。
 */
export function workflowBusinessKey(subject: WorkflowBusinessKey): string {
  return JSON.stringify([subject.workflow_type, subject.subject_type, subject.subject_id]);
}