import { describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
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
  contactRecordedEvent,
  contactState,
  dealCreatedEvent,
  dealStageChangedEvent,
  dealState,
  emailRepliedEvent,
  emailSentEvent,
  fixedNow,
  leadAssignedEvent,
  leadCreatedEvent,
  meetingScheduledEvent,
  taskOverdueEvent,
} from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';

function buildStack(options: { contactEmail?: string | null } = {}) {
  const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
  const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const memory = new InMemoryMemoryStore();
  const pendingActions = new InMemoryPendingActionStore();
  const executor = new InMemoryExecutor();

  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    memory_store: memory,
    pending_action_store: pendingActions,
    executor,
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    // 控制面操作的判定时刻固定，避免测试随真实运行时间漂移
    now: fixedNow,
    // 与 bootstrap 一致：未知联系人默认「新联系人 + 无邮箱 + 仅人工联系」
    contact_defaults: (contactId) =>
      options.contactEmail === undefined
        ? contactState({ contact_id: contactId, email: null, contact_preference: 'human_only', is_new_contact: true })
        : contactState({ contact_id: contactId, email: options.contactEmail }),
  });

  return { engine, leads, contacts, deals, workflows, events, audit, exceptions, memory, pendingActions, executor };
}

const leadWithContact = () =>
  leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } });

describe('contact.recorded：打通联系人事实', () => {
  it('默认联系人没有邮箱时不会编造外发动作', async () => {
    const { engine, workflows, executor } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());

    expect(executor.attempts()).toHaveLength(0);
    expect(workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent', 'email.replied', 'task.overdue'],
    });
  });

  it('contact.recorded 提供邮箱后可自动发出首次跟进邮件', async () => {
    const { engine, workflows, contacts, executor } = buildStack();

    await engine.handleEvent(leadWithContact());
    const recorded = await engine.handleEvent(contactRecordedEvent());
    expect(recorded.status).toBe('processed');

    await engine.handleEvent(leadAssignedEvent());

    expect(contacts.get('contact_1')?.email).toBe('buyer@acme.example');
    expect(executor.attempts()).toHaveLength(1);
    expect(executor.attempts()[0]?.action_type).toBe('send_email');
    expect(workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });
  });

  it('尚无 Workflow 时也把 Contact 事实落库，而不是丢进异常队列', async () => {
    const { engine, contacts, exceptions, workflows } = buildStack();

    const result = await engine.handleEvent(contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, lead_id: null } }));

    expect(result.status).toBe('processed');
    expect(contacts.get('contact_1')?.email).toBe('buyer@acme.example');
    expect(exceptions.listOpen()).toHaveLength(0);
    expect(workflows.list()).toHaveLength(0);
  });

  it('联系人偏好写入 Memory', async () => {
    const { engine, memory } = buildStack();

    await engine.handleEvent(contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, lead_id: null } }));

    expect(memory.list('contact_1')).toEqual([
      expect.objectContaining({ kind: 'preference', content: 'contact_preference:auto_allowed' }),
    ]);
  });
});

describe('事实类事件不会因等待条件被丢弃', () => {
  it('等待 email.sent 期间到达的 deal.created 仍然建立 Deal', async () => {
    const { engine, deals, workflows, exceptions } = buildStack({ contactEmail: 'buyer@acme.example' });

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    expect(workflows.get(WORKFLOW_ID)).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['email.sent'] });

    const result = await engine.handleEvent(dealCreatedEvent());

    expect(result.status).toBe('processed');
    expect(deals.get('deal_1')).toMatchObject({ deal_id: 'deal_1', stage: 'qualification' });
    // 不消费等待条件：动作结果事件仍在等待中
    expect(workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });
    expect(exceptions.listOpen()).toHaveLength(0);
  });

  it('等待 email.sent 期间的事实合并不会重复派发已在途的动作', async () => {
    const { engine, executor } = buildStack({ contactEmail: 'buyer@acme.example' });

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(dealCreatedEvent());
    await engine.handleEvent(dealCreatedEvent({ idempotency_key: 'deal.created:other' }));

    expect(executor.attempts()).toHaveLength(1);
    expect(executor.attempts()[0]?.action_type).toBe('send_email');
  });

  it('已结束实例仍保留后续 Deal 事实', async () => {
    const { engine, workflows, deals } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(dealCreatedEvent({ payload: { ...dealCreatedEvent().payload, deal_id: 'deal_a' } }));
    engine.cancel(WORKFLOW_ID, 'user_7');
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('cancelled');

    const result = await engine.handleEvent(
      dealCreatedEvent({ idempotency_key: 'deal.created:deal_b', payload: { ...dealCreatedEvent().payload, deal_id: 'deal_b' } }),
    );

    expect(result.status).toBe('processed');
    expect(deals.get('deal_b')).toMatchObject({ stage: 'qualification' });
  });

  it('人工审核期间的外部结果事件会落库，同时进入异常队列等待人工判断', async () => {
    const { engine, deals, workflows, exceptions } = buildStack({ contactEmail: 'buyer@acme.example' });

    // 走到「安排会议需要人工审核」
    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('needs_review');

    // 审核期间建立 Deal（事实类事件，只合并事实）
    await engine.handleEvent(dealCreatedEvent({ payload: { ...dealCreatedEvent().payload, deal_id: 'deal_a' } }));
    expect(deals.get('deal_a')).toBeDefined();

    // 审核期间到达的外部结果事件：既不丢事实，也不擅自推进 Workflow
    const result = await engine.handleEvent(
      dealStageChangedEvent({
        payload: { deal_id: 'deal_a', lead_id: 'lead_1', from_stage: 'qualification', to_stage: 'discovery', changed_by: 'user_7', reason: null },
      }),
    );

    expect(deals.get('deal_a')?.stage).toBe('discovery');
    expect(result.status).toBe('processed');
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('needs_review');
    expect(exceptions.listOpen().some((record) => record.reason === 'awaiting_approval')).toBe(true);
  });
});

describe('无动作时进入等待而不是结束流程', () => {
  it('meeting.scheduled 之后继续等待 Deal 建立，而不是直接完成', async () => {
    const { engine, workflows } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const actionId = engine.pendingAction(WORKFLOW_ID)?.action_id ?? '';
    await engine.approve(WORKFLOW_ID, actionId, 'user_7');
    await engine.handleEvent(meetingScheduledEvent());

    // Lead 已 qualified 且尚无 Deal：等待 deal.created，而不是终结整个流程
    expect(workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      current_step: 'await_event',
      awaiting_event_types: ['deal.created', 'proposal.sent', 'task.overdue'],
    });
  });

  it('Deal 建立后重新规划并提出阶段推进入工审核', async () => {
    const { engine, workflows, audit } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    await engine.approve(WORKFLOW_ID, engine.pendingAction(WORKFLOW_ID)?.action_id ?? '', 'user_7');
    await engine.handleEvent(meetingScheduledEvent());

    // 命中推导等待集合的 deal.created 会重新规划
    await engine.handleEvent(dealCreatedEvent());

    expect(workflows.get(WORKFLOW_ID)?.status).toBe('needs_review');
    expect(engine.pendingAction(WORKFLOW_ID)?.action_type).toBe('advance_deal_stage');
    expect(audit.list().some((entry) => entry.action === 'decision_proposed' && entry.action_type === 'advance_deal_stage')).toBe(true);
  });

  it('主体终态后无后续事件才结束流程', async () => {
    const { engine, workflows, deals } = buildStack({ contactEmail: 'buyer@acme.example' });

    // 走完 Lead 侧互动：邮件 → 回复 → 会议（人工批准）
    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    await engine.approve(WORKFLOW_ID, engine.pendingAction(WORKFLOW_ID)?.action_id ?? '', 'user_7');
    await engine.handleEvent(meetingScheduledEvent());

    // Deal 建立并推进到成交
    await engine.handleEvent(dealCreatedEvent());
    await engine.approve(WORKFLOW_ID, engine.pendingAction(WORKFLOW_ID)?.action_id ?? '', 'user_7');
    await engine.handleEvent(
      dealStageChangedEvent({
        payload: { deal_id: 'deal_1', lead_id: 'lead_1', from_stage: 'qualification', to_stage: 'discovery', changed_by: 'user_7', reason: null },
      }),
    );
    await engine.handleEvent(
      dealStageChangedEvent({
        idempotency_key: 'deal.stage_changed:deal_1:discovery:proposal',
        payload: { deal_id: 'deal_1', lead_id: 'lead_1', from_stage: 'discovery', to_stage: 'proposal', changed_by: 'user_7', reason: null },
      }),
    );
    await engine.handleEvent(
      dealStageChangedEvent({
        idempotency_key: 'deal.stage_changed:deal_1:proposal:negotiation',
        payload: { deal_id: 'deal_1', lead_id: 'lead_1', from_stage: 'proposal', to_stage: 'negotiation', changed_by: 'user_7', reason: null },
      }),
    );
    await engine.handleEvent(
      dealStageChangedEvent({
        idempotency_key: 'deal.stage_changed:deal_1:negotiation:won',
        payload: { deal_id: 'deal_1', lead_id: 'lead_1', from_stage: 'negotiation', to_stage: 'won', changed_by: 'user_7', reason: '签约完成' },
      }),
    );

    expect(deals.get('deal_1')).toMatchObject({ stage: 'won', outcome: '签约完成' });
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('completed');
  });

  it('状态迁移写入只追加审计', async () => {
    const { engine, audit } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());

    const transition = audit
      .list()
      .find((entry) => entry.action === 'state_transitioned' && entry.after_state === 'waiting_result');
    expect(transition).toBeDefined();
    expect(transition?.before_state).toBe('running');
  });
});

describe('task.overdue 补救分支', () => {
  it('逾期任务触发补救任务建议，并且只提出一次', async () => {
    const { engine, executor, audit } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(taskOverdueEvent());

    const remedies = executor.attempts().filter((action) => action.action_type === 'create_task');
    expect(remedies).toHaveLength(1);
    expect(remedies[0]?.parameters).toMatchObject({ task_type: 'overdue_remedy', assigned_to: 'user_7' });

    // 已派发补救后再规划，不再重复提出同一任务
    await engine.handleEvent(
      dealCreatedEvent({ payload: { ...dealCreatedEvent().payload, amount: 1000 } }),
    );
    expect(executor.attempts().filter((action) => action.action_type === 'create_task')).toHaveLength(1);
    expect(audit.list().some((entry) => entry.action === 'action_dispatched' && entry.action_type === 'create_task')).toBe(true);
  });
});

describe('重启后 Human Review 仍可审批', () => {
  it('待审批动作持久化在 Store 中，新引擎实例可以继续审批', async () => {
    const stack = buildStack();

    await stack.engine.handleEvent(leadWithContact());
    await stack.engine.handleEvent(leadAssignedEvent());
    await stack.engine.handleEvent(emailSentEvent());
    await stack.engine.handleEvent(emailRepliedEvent());

    const actionId = stack.engine.pendingAction(WORKFLOW_ID)?.action_id ?? '';
    expect(actionId).not.toBe('');

    // 模拟进程重启：只保留 Store，换一个引擎实例
    const rebooted = new WorkflowEngine({
      event_store: stack.events,
      audit_log: stack.audit,
      exception_queue: stack.exceptions,
      lead_store: stack.leads,
      contact_store: stack.contacts,
      deal_store: stack.deals,
      workflow_store: stack.workflows,
      memory_store: stack.memory,
      pending_action_store: stack.pendingActions,
      executor: stack.executor,
      decider: new RuleBasedDecider({ createActionId: (() => { let n = 100; return () => `action_${++n}`; })() }),
      policy: new RuleBasedPolicyEvaluator(),
      now: fixedNow,
    });

    const { workflow } = await rebooted.approve(WORKFLOW_ID, actionId, 'user_7');

    expect(workflow).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['meeting.scheduled'] });
  });
});

describe('审批前复核动作有效性', () => {
  it('主体已进入终态时不执行陈旧动作：作废并按新事实重新规划', async () => {
    const { engine, workflows, audit } = buildStack({ contactEmail: 'buyer@acme.example' });

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    const scheduleMeeting = engine.pendingAction(WORKFLOW_ID)?.action_id ?? '';
    await engine.approve(WORKFLOW_ID, scheduleMeeting, 'user_7');
    await engine.handleEvent(meetingScheduledEvent());

    // Lead 已 qualified、Deal 已建立：Decider 提出阶段推进，等待人工审核
    await engine.handleEvent(dealCreatedEvent());
    const advance = engine.pendingAction(WORKFLOW_ID)?.action_id ?? '';
    expect(advance).not.toBe('');

    // 审核期间 Deal 被外部直接推进到 won（事实先落库）
    await engine.handleEvent(
      dealStageChangedEvent({
        payload: { deal_id: 'deal_1', lead_id: 'lead_1', from_stage: 'qualification', to_stage: 'won', changed_by: 'user_7', reason: '客户确认采购' },
      }),
    );

    // 此时批准「推进到 discovery」已经失效：Deal 是终态，动作作废并重新规划，不再卡在 needs_review
    const outcome = await engine.approve(WORKFLOW_ID, advance, 'user_7');

    expect(outcome.stale_action_replanned).toBe(true);
    expect(outcome.workflow.status).toBe('completed');
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('completed');
    expect(audit.list().some((entry) => entry.action === 'action_stale' && entry.action_id === advance)).toBe(true);
    expect(audit.list().some((entry) => entry.action === 'action_approved' && entry.action_id === advance)).toBe(false);
  });
});

describe('Memory 记录', () => {
  it('结果事件写入互动记忆，可供 Context 检索', async () => {
    const { engine, memory } = buildStack();

    await engine.handleEvent(leadWithContact());
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const interactions = memory.list('lead_1').filter((entry) => entry.kind === 'interaction');
    expect(interactions.map((entry) => entry.content)).toEqual(['email.sent', 'email.replied']);
    expect(interactions[0]?.occurred_at).toBe(emailSentEvent().occurred_at);
  });
});
