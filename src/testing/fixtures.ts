import type { DecisionContext, PolicyContext } from '../decision/context';
import type { ProposedAction } from '../decision/types';
import type { EventType, ParsedEventOf } from '../events/dictionary';
import type {
  ContactState,
  DealState,
  LeadState,
  NewAuditEntry,
  NewException,
  WorkflowInstanceState,
} from '../stores/types';

/**
 * payload 允许传入任意形状，便于构造非法或冲突的 payload 场景；
 * 覆盖后的对象不再保证是合法事件，因此各构造函数末尾集中断言一次。
 */
type EventOverrides<T extends EventType> = Partial<Omit<ParsedEventOf<T>, 'payload'>> & {
  payload?: Record<string, unknown>;
};

export function leadCreatedEvent(
  overrides: EventOverrides<'lead.created'> = {},
): ParsedEventOf<'lead.created'> {
  return {
    event_id: 'evt_0001',
    type: 'lead.created',
    version: 1,
    occurred_at: '2026-09-24T10:00:00+08:00',
    idempotency_key: 'lead.created:crm:rec_1001',
    payload: {
      lead_id: 'lead_1',
      source_channel: 'web_form',
      source_record_id: 'rec_1001',
      company_name: 'Acme',
      contact_id: null,
      initial_owner_id: null,
    },
    source: 'crm',
    ...overrides,
  } as ParsedEventOf<'lead.created'>;
}

export function leadAssignedEvent(
  overrides: EventOverrides<'lead.assigned'> = {},
): ParsedEventOf<'lead.assigned'> {
  return {
    event_id: 'evt_0002',
    type: 'lead.assigned',
    version: 1,
    occurred_at: '2026-09-24T11:00:00+08:00',
    idempotency_key: 'lead.assigned:lead_1:user_7:1',
    payload: {
      lead_id: 'lead_1',
      owner_id: 'user_7',
      previous_owner_id: null,
      assignment_reason: 'rule:territory',
    },
    source: 'assignment_engine',
    ...overrides,
  } as ParsedEventOf<'lead.assigned'>;
}

export function auditEntryInput(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    occurred_at: '2026-09-24T10:00:01+08:00',
    actor: { actor_type: 'system', actor_id: 'event_processor' },
    action: 'event_processed',
    subject: { subject_type: 'lead', subject_id: 'lead_1', workflow_instance_id: 'wf_1' },
    event_id: 'evt_0001',
    action_id: null,
    before_state: null,
    after_state: 'new',
    reason: null,
    policy_version: null,
    plan_version: 1,
    source: 'crm',
    result: 'succeeded',
    provider_reference: null,
    ...overrides,
  };
}

export function exceptionInput(overrides: Partial<NewException> = {}): NewException {
  return {
    occurred_at: '2026-09-24T10:00:02+08:00',
    reason: 'idempotency_conflict',
    event_id: 'evt_0002',
    event: leadAssignedEvent(),
    subject: { subject_type: 'lead', subject_id: 'lead_1', workflow_instance_id: null },
    ...overrides,
  };
}

export function leadState(overrides: Partial<LeadState> = {}): LeadState {
  return {
    lead_id: 'lead_1',
    source_channel: 'web_form',
    source_record_id: 'rec_1001',
    company_name: 'Acme',
    contact_id: null,
    owner_id: null,
    status: 'new',
    created_at: '2026-09-24T10:00:00+08:00',
    updated_at: '2026-09-24T10:00:00+08:00',
    ...overrides,
  };
}

export function dealState(overrides: Partial<DealState> = {}): DealState {
  return {
    deal_id: 'deal_1',
    lead_id: 'lead_1',
    contact_id: null,
    owner_id: 'user_7',
    stage: 'qualification',
    amount: 120000,
    currency: 'CNY',
    expected_close_at: null,
    outcome: null,
    created_at: '2026-09-24T10:00:00+08:00',
    updated_at: '2026-09-24T10:00:00+08:00',
    ...overrides,
  };
}

export function dealCreatedEvent(
  overrides: EventOverrides<'deal.created'> = {},
): ParsedEventOf<'deal.created'> {
  return {
    event_id: 'evt_0006',
    type: 'deal.created',
    version: 1,
    occurred_at: '2026-09-24T14:00:00+08:00',
    idempotency_key: 'deal.created:deal_1',
    payload: {
      deal_id: 'deal_1',
      lead_id: 'lead_1',
      contact_id: null,
      owner_id: 'user_7',
      initial_stage: 'qualification',
      amount: 120000,
      currency: 'CNY',
      expected_close_at: null,
    },
    source: 'crm',
    ...overrides,
  } as ParsedEventOf<'deal.created'>;
}

export function dealStageChangedEvent(
  overrides: EventOverrides<'deal.stage_changed'> = {},
): ParsedEventOf<'deal.stage_changed'> {
  return {
    event_id: 'evt_0007',
    type: 'deal.stage_changed',
    version: 1,
    occurred_at: '2026-09-24T16:00:00+08:00',
    idempotency_key: 'deal.stage_changed:deal_1:qualification:discovery',
    payload: {
      deal_id: 'deal_1',
      lead_id: 'lead_1',
      from_stage: 'qualification',
      to_stage: 'discovery',
      reason: null,
    },
    source: 'crm',
    ...overrides,
  } as ParsedEventOf<'deal.stage_changed'>;
}

export function workflowState(
  overrides: Partial<WorkflowInstanceState> = {},
): WorkflowInstanceState {
  return {
    workflow_instance_id: 'wf_1',
    workflow_type: 'lead_follow_up',
    subject_type: 'lead',
    subject_id: 'lead_1',
    status: 'pending',
    current_step: 'assignment',
    awaiting_event_types: [],
    plan_version: 1,
    last_processed_event_id: null,
    failure_classification: null,
    failure_submitted: null,
    failure_retry_after: null,
    created_at: '2026-09-24T10:00:00+08:00',
    updated_at: '2026-09-24T10:00:00+08:00',
    ...overrides,
  };
}

export function emailSentEvent(
  overrides: EventOverrides<'email.sent'> = {},
): ParsedEventOf<'email.sent'> {
  return {
    event_id: 'evt_0003',
    type: 'email.sent',
    version: 1,
    occurred_at: '2026-09-24T10:30:00+08:00',
    idempotency_key: 'email.sent:msg_1',
    payload: {
      message_id: 'msg_1',
      lead_id: 'lead_1',
      contact_id: 'contact_1',
      sender_id: 'user_7',
      recipient_email: 'buyer@acme.example',
      template_id: 'tpl_first_touch',
      workflow_instance_id: 'wf_lead_follow_up_lead_1',
      sent_at: '2026-09-24T10:30:00+08:00',
    },
    source: 'email_connector',
    ...overrides,
  } as ParsedEventOf<'email.sent'>;
}

export function emailRepliedEvent(
  overrides: EventOverrides<'email.replied'> = {},
): ParsedEventOf<'email.replied'> {
  return {
    event_id: 'evt_0004',
    type: 'email.replied',
    version: 1,
    occurred_at: '2026-09-24T12:00:00+08:00',
    idempotency_key: 'email.replied:reply_1',
    payload: {
      message_id: 'msg_1',
      reply_id: 'reply_1',
      lead_id: 'lead_1',
      contact_id: 'contact_1',
      reply_at: '2026-09-24T12:00:00+08:00',
      sentiment: 'positive',
      intent: 'ask_pricing',
      body_reference: 'raw_msg_reply_1',
    },
    source: 'email_connector',
    ...overrides,
  } as ParsedEventOf<'email.replied'>;
}

export function proposalSentEvent(
  overrides: EventOverrides<'proposal.sent'> = {},
): ParsedEventOf<'proposal.sent'> {
  return {
    event_id: 'evt_0005',
    type: 'proposal.sent',
    version: 1,
    occurred_at: '2026-09-24T15:00:00+08:00',
    idempotency_key: 'proposal.sent:prop_1',
    payload: {
      proposal_id: 'prop_1',
      deal_id: 'deal_1',
      lead_id: 'lead_1',
      contact_id: 'contact_1',
      sender_id: 'user_7',
      amount: 120000,
      currency: 'CNY',
      document_reference: 'doc_rev_1',
      sent_at: '2026-09-24T15:00:00+08:00',
    },
    source: 'crm',
    ...overrides,
  } as ParsedEventOf<'proposal.sent'>;
}

export function contactState(overrides: Partial<ContactState> = {}): ContactState {
  return {
    contact_id: 'contact_1',
    full_name: 'Zhang San',
    email: 'buyer@acme.example',
    organization_id: 'org_acme',
    contact_preference: 'auto_allowed',
    contactability: 'reachable',
    is_new_contact: false,
    updated_at: '2026-09-24T10:00:00+08:00',
    ...overrides,
  };
}

export function policyContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    policy_version: 'policy_v1',
    evaluated_at: '2026-09-24T10:05:00+08:00',
    automation_whitelist: ['send_email', 'create_task'],
    permitted_action_types: [
      'send_email',
      'schedule_meeting',
      'create_task',
      'send_proposal',
      'advance_deal_stage',
    ],
    permitted_actor_ids: ['user_7'],
    business_timezone_offset_minutes: 480,
    send_window: { start_hour: 9, end_hour: 18 },
    max_auto_actions_per_day: 5,
    auto_actions_today: 0,
    key_account_lead_ids: [],
    high_value_deal_threshold: 500000,
    ...overrides,
  };
}

/**
 * 默认 Context 是一个「可决策」的快照：Workflow 运行中、Lead 已分配且有负责人、
 * 联系人可自动联系、已验证配置齐备。测试通过 overrides 制造各种边界。
 */
export function decisionContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    workflow_instance: workflowState({ status: 'running', current_step: 'first_follow_up' }),
    lead_state: leadState({ status: 'assigned', owner_id: 'user_7', contact_id: 'contact_1' }),
    contact_state: contactState(),
    deal_state: null,
    verified_config: {
      first_touch_email_template_id: 'tpl_first_touch',
      proposal_document_reference: null,
      default_meeting_duration_minutes: 30,
    },
    recent_events: [],
    memory: { interaction_count: 0, last_interaction_at: null, preferences: [] },
    pending_tasks: [],
    policy_context: policyContext(),
    previous_decisions: [],
    idempotency_context: { input_event_id: 'evt_0002', processed_idempotency_keys: [] },
    data_conflicts: [],
    ...overrides,
  };
}

/** parameters 允许传入任意形状，便于构造非法或跨类型的参数场景。 */
type ActionOverrides = Partial<Omit<ProposedAction, 'parameters'>> & {
  parameters?: Record<string, unknown>;
};

export function proposedAction(overrides: ActionOverrides = {}): ProposedAction {
  return {
    action_id: 'action_1',
    action_type: 'send_email',
    subject_type: 'lead',
    subject_id: 'lead_1',
    workflow_instance_id: 'wf_1',
    lead_id: 'lead_1',
    contact_id: 'contact_1',
    deal_id: null,
    parameters: {
      template_id: 'tpl_first_touch',
      recipient_email: 'buyer@acme.example',
      subject: null,
    },
    reason: 'Lead 已分配且尚无首次跟进邮件',
    expected_outcome: '客户收到首次跟进邮件',
    risk_level: 'low',
    policy_version: 'policy_v1',
    plan_version: 1,
    requires_approval: false,
    expires_at: '2026-09-26T10:05:00+08:00',
    parameter_source: 'verified_config',
    execution_idempotency_key: 'exec:lead_1:send_email:1:action_1',
    ...overrides,
  } as ProposedAction;
}