import type { PreviousDecision } from '../decision/context';
import type { ActionType, ProposedAction } from '../decision/types';
import type { ExecutionReceipt } from '../executor/interfaces';
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
  | 'action_reconciled'
  | 'event_conflicted'
  | 'exception_enqueued'
  | 'exception_resolved'
  | 'exception_discarded'
  | 'exception_replayed';

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
  /**
   * 关联 ProposedAction 的动作类型。
   * 单独保存是因为重启后内存中的 action 快照会丢失，审计仍需能回答「派发了什么动作」，
   * 也用于「逾期任务是否已被补救」这类派生判断。
   */
  action_type: ActionType | null;
  before_state: string | null;
  after_state: string | null;
  reason: string | null;
  policy_version: string | null;
  plan_version: number | null;
  source: string;
  result: AuditResult;
  /**
   * 关联事件或动作的提供商回执标识（如邮件服务 message-id），便于对账与排障；无则为 null。
   * 结果事件携带时，该事件下的全部审计记录都写入同一值（见 docs/domain.md「Audit 契约」）。
   */
  provider_reference: string | null;
  /**
   * 本次**执行**拿到的提供商回执快照（`action_dispatched` / `action_reconciled` 写入）。
   *
   * 与顶层 `provider_reference` 的区别：后者跟随「关联事件」以保证同一事件的审计链路可追溯，
   * 前者是「这一个动作提交后提供商返回了什么」的事实记录。
   * 把两者分开，才能同时回答「这个事件引发的审计都有哪些」和「这个动作到底打到了哪个提供商」。
   */
  provider_receipt: ExecutionReceipt | null;
  /**
   * 关联的异常记录标识。
   * 异常的处理结论本身也是审计事实，用它把 `exception_resolved` / `exception_discarded` /
   * `exception_replayed` 与具体的异常记录关联起来。
   */
  exception_id: string | null;
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

/**
 * 异常记录携带事件完整信封副本，原始事件本身保持不可变。
 *
 * `event_id` / `event` 可为 null：异常也可能由控制面操作产生（例如对账返回 unknown），
 * 那种情况没有触发事件，此时以 `subject` 与关联审计的 `action_id` 定位。
 */
export interface ExceptionRecord {
  exception_id: string;
  occurred_at: string;
  reason: ExceptionReason;
  event_id: string | null;
  event: unknown | null;
  subject: AuditSubject | null;
  status: ExceptionStatus;
  resolution: string | null;
  /** 处理人标识（控制面操作者）；未处理时为 null。 */
  resolved_by: string | null;
  /** 处理时间；未处理时为 null。 */
  resolved_at: string | null;
}

/** exception_id、status、resolution、resolved_by、resolved_at 由异常队列生成，不由调用方提供。 */
export type NewException = Omit<
  ExceptionRecord,
  'exception_id' | 'status' | 'resolution' | 'resolved_by' | 'resolved_at'
>;

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
  /**
   * 最近一次 Executor 失败分类。与 `failure_submitted` 一起持久化到 Workflow，
   * 使重启后仍能判断是否允许自动 retry（transient 可重试，permanent 不可）。
   */
  failure_classification: 'transient' | 'permanent' | null;
  /**
   * 最近一次失败时动作是否可能已被外部接受：
   * false = 确认未提交可安全重试；'unknown' = 需 provider 对账，禁止简单 retry。
   */
  failure_submitted: boolean | 'unknown' | null;
  /** 失败建议的最早可重试时间（ISO-8601），无则为 null。 */
  failure_retry_after: string | null;
  /**
   * 自动重试已尝试的次数。持久化在 Workflow 上而不是调度器内存里：
   * 否则每次重启计数清零，持续故障的外部系统会每轮启动都被重打一次，
   * `max_attempts_per_workflow` 形同虚设。
   */
  failure_retry_attempts: number;
  /** 下一次允许自动重试的时间（ISO-8601，指数退避结果）；null 表示没有退避限制。 */
  failure_next_attempt_at: string | null;
  /**
   * 人工已做出的历史决策（目前只有拒绝）。
   *
   * 它是**当前事实**而非历史记录：已拒动作是新的规划约束，Decider 必须能看到它才不会再提。
   * 因此必须随 State 持久化 —— 只存内存会让进程重启后被拒的动作立刻被重新提出。
   * 旧的持久化行没有该字段，读取时一律 `?? []` 兜底。
   */
  previous_decisions: readonly PreviousDecision[];
  created_at: string;
  updated_at: string;
}

export type WorkflowBusinessKey = Pick<
  WorkflowInstanceState,
  'workflow_type' | 'subject_type' | 'subject_id'
>;/**
 * 把业务 key 序列化为可安全用作 Map 键的字符串。
 * 使用 JSON 数组而非字符串拼接，避免字段值包含分隔符时产生歧义。
 */
export function workflowBusinessKey(subject: WorkflowBusinessKey): string {
  return JSON.stringify([subject.workflow_type, subject.subject_type, subject.subject_id]);
}

/**
 * Memory 记录类型，对应 docs/domain.md「边界与数据归属」：历史互动、摘要与偏好。
 * Memory 只追加、可检索，用于 Decision Context，不作为当前事实的唯一来源。
 */
export const MEMORY_KINDS = ['interaction', 'preference', 'summary'] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  memory_id: string;
  subject_type: string;
  subject_id: string;
  kind: MemoryKind;
  content: string;
  occurred_at: string;
  source: string | null;
}

/** memory_id 由 Memory Store 生成，不由调用方提供。 */
export type NewMemoryEntry = Omit<MemoryEntry, 'memory_id'>;

/**
 * 待审批动作的持久化记录。
 *
 * Decision 提出的 ProposedAction 在进入 Human Review 后必须能在进程重启后继续审批，
 * 因此这里保存动作快照与审批结论；已决记录保留用于追溯，不参与「当前待审批」查询。
 */
export const PENDING_ACTION_STATUSES = ['pending', 'decided'] as const;

export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

export interface PendingActionRecord {
  action_id: string;
  workflow_instance_id: string;
  status: PendingActionStatus;
  decision: 'approved' | 'rejected' | null;
  decided_by: string | null;
  decided_at: string | null;
  proposed_at: string;
  /** 动作快照；批准后直接交给 Executor，不再重新推断。 */
  action: ProposedAction;
}