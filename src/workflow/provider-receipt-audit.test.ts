import { describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import { ProviderAdapterExecutor } from '../provider/executor';
import { InMemoryProviderAdapter } from '../provider/in-memory';
import type { ProviderReconciliation, ProviderAdapter } from '../provider/types';
import {
  InMemoryAuditLog,
  InMemoryEventStore,
  InMemoryExceptionQueue,
  InMemoryMemoryStore,
  InMemoryPendingActionStore,
  InMemoryStateStore,
  InMemoryWorkflowStateStore,
} from '../stores/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import {
  contactState,
  emailRepliedEvent,
  emailSentEvent,
  leadAssignedEvent,
  leadCreatedEvent,
} from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';

/** 回执完整的假适配器：验证 provider / provider_reference / correlation_id 一路不丢。 */
function receiptAdapter(): ProviderAdapter {
  let counter = 0;
  const receipts = new Map<string, { provider_reference: string; correlation_id: string | null }>();

  return {
    provider: 'mailgun',
    action_types: ['send_email', 'schedule_meeting', 'create_task', 'send_proposal', 'advance_deal_stage'],
    async submit(action) {
      const existing = receipts.get(action.execution_idempotency_key);
      if (existing !== undefined) {
        return {
          status: 'duplicate',
          receipt: { provider: 'mailgun', ...existing },
        };
      }
      counter += 1;
      const receipt = {
        provider_reference: `mailgun:msg-${counter}`,
        correlation_id: `corr-${counter}`,
      };
      receipts.set(action.execution_idempotency_key, receipt);
      return { status: 'accepted', receipt: { provider: 'mailgun', ...receipt } };
    },
    async reconcile(action): Promise<ProviderReconciliation> {
      const receipt = receipts.get(action.execution_idempotency_key);
      return receipt === undefined
        ? { submitted: false, provider_reference: null }
        : { submitted: true, provider_reference: receipt.provider_reference };
    },
  };
}

function buildStack(adapter: ProviderAdapter = receiptAdapter()) {
  const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
  const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();

  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    memory_store: new InMemoryMemoryStore(),
    pending_action_store: new InMemoryPendingActionStore(),
    executor: new ProviderAdapterExecutor([adapter]),
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => contactState(),
  });

  return { engine, audit, workflows };
}

const leadWithContact = () =>
  leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } });

describe('Provider 回执的端到端保留', () => {
  it('ProviderAdapter.submit → Executor → action_dispatched 审计，回执三要素完整', async () => {
    const { engine, audit } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());

    const dispatched = audit.list().find((entry) => entry.action === 'action_dispatched');
    expect(dispatched?.provider_receipt).toEqual({
      provider: 'mailgun',
      provider_reference: 'mailgun:msg-1',
      correlation_id: 'corr-1',
    });
    // 触发事件本身不带回执，因此用本次执行回执补齐顶层标识，便于按回执检索
    expect(dispatched?.provider_reference).toBe('mailgun:msg-1');
    expect(dispatched?.action_id).toBe('action_1');
    expect(dispatched?.action_type).toBe('send_email');
    expect(dispatched?.subject.workflow_instance_id).toBe(WORKFLOW_ID);
  });

  it('Executor 结果保留回执字段（accepted 与 duplicate 都保留）', async () => {
    const executor = new ProviderAdapterExecutor([receiptAdapter()]);
    const action = {
      action_id: 'action_1',
      action_type: 'send_email' as const,
      subject_type: 'lead',
      subject_id: 'lead_1',
      workflow_instance_id: WORKFLOW_ID,
      lead_id: 'lead_1',
      contact_id: 'contact_1',
      deal_id: null,
      parameters: { template_id: 'tpl_first_touch', recipient_email: 'buyer@acme.example', subject: null },
      reason: 'r',
      expected_outcome: 'o',
      risk_level: 'low' as const,
      policy_version: 'policy_v1',
      plan_version: 1,
      requires_approval: false,
      expires_at: '2026-09-30T00:00:00+08:00',
      parameter_source: 'verified_config' as const,
      execution_idempotency_key: 'exec:lead_1:send_email:1',
    };

    const first = await executor.execute(action);
    const second = await executor.execute(action);

    expect(first).toMatchObject({
      status: 'accepted',
      provider: 'mailgun',
      provider_reference: 'mailgun:msg-1',
      correlation_id: 'corr-1',
    });
    expect(second).toMatchObject({
      status: 'duplicate',
      provider: 'mailgun',
      provider_reference: 'mailgun:msg-1',
    });
  });

  it('结果事件自带回执时，事件审计链路保持同一 provider_reference；执行回执另存快照', async () => {
    const { engine, audit } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    // 邮件已发出的回执（与动作派发的 provider_receipt 是同一标识）
    await engine.handleEvent(
      emailSentEvent({ payload: { ...emailSentEvent().payload, provider_reference: 'mailgun:msg-1' } }),
    );
    const reply = emailRepliedEvent({
      payload: { ...emailRepliedEvent().payload, provider_reference: 'sendgrid:event-789' },
    });
    await engine.handleEvent(reply);

    // 回复事件触发的决策/策略审计都带事件自己的回执（docs/domain.md「Audit 契约」）
    const eventEntries = audit.listByEventId(reply.event_id);
    expect(eventEntries.length).toBeGreaterThan(0);
    expect(eventEntries.every((entry) => entry.provider_reference === 'sendgrid:event-789')).toBe(true);

    // 安排会议需要人工审核，批准后才会真正派发
    const actionId = engine.pendingAction(WORKFLOW_ID)?.action_id ?? '';
    await engine.approve(WORKFLOW_ID, actionId, 'user_7');

    const dispatched = audit.list().filter((entry) => entry.action === 'action_dispatched').at(-1);
    // 批准是控制面操作（没有触发事件），因此顶层标识用本次执行回执补齐
    expect(dispatched?.event_id).toBeNull();
    expect(dispatched?.provider_reference).toBe('mailgun:msg-2');
    expect(dispatched?.provider_receipt).toMatchObject({
      provider: 'mailgun',
      provider_reference: 'mailgun:msg-2',
      correlation_id: 'corr-2',
    });
  });

  it('按 action_id 能追回回执与结果事件，形成可追溯链路', async () => {
    const { engine, audit } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(
      emailSentEvent({ payload: { ...emailSentEvent().payload, provider_reference: 'mailgun:msg-1' } }),
    );

    const chain = audit.listByActionId('action_1').map((entry) => entry.action);
    expect(chain).toEqual(['decision_proposed', 'policy_evaluated', 'action_dispatched']);

    const dispatched = audit.listByActionId('action_1').find((entry) => entry.action === 'action_dispatched');
    expect(dispatched?.provider_receipt?.provider_reference).toBe('mailgun:msg-1');
    // 结果事件（email.sent）能通过 event_id 与动作对上
    const result = audit.listByEventId(emailSentEvent().event_id).find((entry) => entry.action === 'event_processed');
    expect(result?.provider_reference).toBe('mailgun:msg-1');
  });

  it('进程内 Executor 没有外部回执时记录空回执而不是伪造', async () => {
    const adapter = new InMemoryProviderAdapter({ provider: 'local-dev' });
    const { engine, audit } = buildStack(adapter);

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());

    const dispatched = audit.list().find((entry) => entry.action === 'action_dispatched');
    expect(dispatched?.provider_receipt).toMatchObject({ provider: 'local-dev' });
    expect(dispatched?.provider_receipt?.provider_reference).toBeTruthy();
  });
});
