import { describe, expect, it } from 'vitest';

import { InMemoryExecutor } from '../executor/in-memory';
import { leadAssignedEvent, leadCreatedEvent, emailSentEvent, emailRepliedEvent, dealCreatedEvent, dealStageChangedEvent, dealState, contactState, proposedAction } from '../testing/fixtures';
import { InMemoryAuditLog, InMemoryEventStore, InMemoryExceptionQueue, InMemoryStateStore, InMemoryWorkflowStateStore } from '../stores/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import { WorkflowEngine } from './engine';

function createEngine() {
  const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
  const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const executor = new InMemoryExecutor();
  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    executor,
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => contactState(),
  });
  return { engine, leads, deals, workflows, events, audit, exceptions, executor };
}

describe('WorkflowEngine', () => {
  it('处理 lead.created 并幂等创建 Lead 与 Workflow', async () => {
    const { engine, leads, workflows } = createEngine();

    await engine.handleEvent(leadCreatedEvent());
    await engine.handleEvent(leadCreatedEvent());

    expect(leads.get('lead_1')).toMatchObject({ lead_id: 'lead_1', status: 'new' });
    expect(workflows.list()).toHaveLength(1);
    expect(workflows.list()[0]).toMatchObject({ status: 'running', plan_version: 1 });
  });

  it('收到 lead.assigned 后提出并自动发起邮件，但保持等待外部结果', async () => {
    const { engine, leads, workflows, executor, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    expect(leads.get('lead_1')).toMatchObject({ status: 'assigned', owner_id: 'user_7' });
    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['email.sent'] });
    expect(executor.attempts()).toHaveLength(1);
    expect(audit.list().map((entry) => entry.action)).toEqual(expect.arrayContaining(['decision_proposed', 'policy_evaluated', 'action_dispatched']));
  });

  it('只在匹配的 email.sent 到达后恢复规划，重复回执不产生第二次效果', async () => {
    const { engine, workflows, leads, executor } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailSentEvent());
    expect(leads.get('lead_1')?.status).toBe('assigned');
    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['email.replied', 'task.overdue'] });
    expect(executor.attempts()).toHaveLength(1);
  });

  it('处理 email.replied 后更新 Lead 并生成需要审核的会议动作', async () => {
    const { engine, workflows, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({ status: 'needs_review', awaiting_event_types: [] });
    expect(audit.list().some((entry) => entry.action === 'policy_evaluated' && entry.result === 'pending')).toBe(true);
  });

  it('未知结果事件不创建 Workflow，而是进入异常队列', async () => {
    const { engine, exceptions, workflows } = createEngine();
    await engine.handleEvent(emailSentEvent());

    expect(workflows.list()).toHaveLength(0);
    expect(exceptions.listOpen()).toHaveLength(1);
    expect(exceptions.listOpen()[0]?.reason).toBe('unmatched_event');
  });

  it('执行失败后保留 failed 状态，使用原事件重试不会重复创建事实', async () => {
    const { engine, workflows, executor } = createEngine();
    executor.failNext(Object.assign(new Error('temporary failure'), { classification: 'transient' as const }));
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('failed');
    await engine.retry('wf_lead_follow_up_lead_1');
    expect(executor.attempts()).toHaveLength(2);
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
  });

  it('transient 失败允许自动重试', async () => {
    const { engine, workflows, executor, audit } = createEngine();
    executor.failNext(Object.assign(new Error('provider unavailable'), { classification: 'transient' as const }));
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('failed');
    expect(audit.list().some((entry) => entry.action === 'action_failed' && entry.reason?.startsWith('transient:'))).toBe(true);

    await engine.retry('wf_lead_follow_up_lead_1');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
    expect(executor.attempts()).toHaveLength(2);
  });

  it('permanent 失败进入 failed 但拒绝自动重试', async () => {
    const { engine, workflows, executor, audit } = createEngine();
    executor.failNext(Object.assign(new Error('invalid recipient'), { classification: 'permanent' as const }));
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('failed');
    expect(audit.list().some((entry) => entry.action === 'action_failed' && entry.reason?.startsWith('permanent:'))).toBe(true);

    await expect(engine.retry('wf_lead_follow_up_lead_1')).rejects.toThrow('永久性失败不允许自动重试');
    expect(executor.attempts()).toHaveLength(1);
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('failed');
  });

  it('TIMEOUT 未显式分类时按 transient 处理并允许重试', async () => {
    const { engine, workflows, executor } = createEngine();
    executor.failNext(Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' }));
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('failed');
    await engine.retry('wf_lead_follow_up_lead_1');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
    expect(executor.attempts()).toHaveLength(2);
  });

  it('已取消的 Workflow 属于终态：后续结果事件只进入异常队列，不恢复流程', async () => {
    const { engine, workflows, exceptions } = createEngine();
    await engine.handleEvent(leadCreatedEvent());
    engine.cancel('wf_lead_follow_up_lead_1', 'user_7');

    const result = await engine.handleEvent(emailSentEvent());

    expect(result.status).toBe('unmatched');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('cancelled');
    expect(exceptions.listOpen()).toHaveLength(1);
    expect(exceptions.listOpen()[0]?.reason).toBe('unmatched_event');
  });

  it('workflow_instance_id 指向其他实例的结果事件不满足等待条件', async () => {
    const { engine, workflows, exceptions } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    const stray = emailSentEvent({
      payload: { ...emailSentEvent().payload, workflow_instance_id: 'wf_other' },
    });
    await engine.handleEvent(stray);

    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });
    expect(exceptions.listOpen()[0]?.reason).toBe('unmatched_event');
  });

  it('同一幂等键携带不同内容时判定为冲突，写入异常队列且不改变 Workflow', async () => {
    const { engine, workflows, exceptions } = createEngine();
    await engine.handleEvent(leadCreatedEvent());

    const conflicting = leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, company_name: '另一家公司' },
    });
    const result = await engine.handleEvent(conflicting);

    expect(result.status).toBe('conflict');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('running');
    expect(exceptions.listOpen()).toHaveLength(1);
    expect(exceptions.listOpen()[0]?.reason).toBe('idempotency_conflict');
  });

  it('人工审核期间到达的迟到事件不擅自恢复流程，而是进入异常队列', async () => {
    const { engine, workflows, exceptions } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const late = emailSentEvent({
      event_id: 'evt_late_1',
      idempotency_key: 'email.sent:msg_late',
      occurred_at: '2026-09-24T13:00:00+08:00',
      payload: { ...emailSentEvent().payload, message_id: 'msg_late' },
    });
    const result = await engine.handleEvent(late);

    expect(result.status).toBe('failed');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');
    expect(exceptions.listOpen()[0]?.reason).toBe('invalid_transition');
  });

  it('approve 执行待审核动作后进入等待外部结果', async () => {
    const { engine, workflows, executor, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
    const actionId = proposed[proposed.length - 1]?.action_id ?? '';
    const workflow = await engine.approve('wf_lead_follow_up_lead_1', actionId, 'user_7');

    expect(workflow).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['meeting.scheduled'] });
    expect(executor.attempts()).toHaveLength(2);
    expect(audit.list().some((entry) => entry.action === 'action_approved')).toBe(true);
  });

  it('reject 将被拒动作类型登记为约束，重新规划后不再提出同一动作', async () => {
    const { engine, workflows, executor, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
    const actionId = proposed[proposed.length - 1]?.action_id ?? '';
    const workflow = await engine.reject('wf_lead_follow_up_lead_1', actionId, 'user_7', '客户暂不需要会议');

    expect(workflow.status).toBe('completed');
    expect(audit.list().some((entry) => entry.action === 'action_rejected')).toBe(true);
    expect(executor.attempts()).toHaveLength(1);
  });

  it('事件的 from_stage 与 Deal 当前阶段冲突时判定为 stale_event，不推进流程', async () => {
    const { engine, workflows, exceptions } = createEngine();
    await engine.handleEvent(leadCreatedEvent());
    await engine.handleEvent(dealCreatedEvent());

    const conflicting = dealStageChangedEvent({
      payload: { ...dealStageChangedEvent().payload, from_stage: 'discovery', to_stage: 'proposal' },
    });
    await engine.handleEvent(conflicting);

    expect(exceptions.listOpen()[0]?.reason).toBe('stale_event');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');
  });
});
