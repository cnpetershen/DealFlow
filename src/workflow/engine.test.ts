import { describe, expect, it } from 'vitest';

import type { DecisionContext } from '../decision/context';
import type { Decider } from '../decision/interfaces';
import { InMemoryExecutor } from '../executor/in-memory';
import { leadAssignedEvent, leadCreatedEvent, emailSentEvent, emailRepliedEvent, dealCreatedEvent, dealStageChangedEvent, dealState, contactState, contactRecordedEvent, proposedAction, taskOverdueEvent, meetingScheduledEvent } from '../testing/fixtures';
import { InMemoryAuditLog, InMemoryEventStore, InMemoryExceptionQueue, InMemoryPendingActionStore, InMemoryStateStore, InMemoryWorkflowStateStore } from '../stores/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import { WorkflowEngine, type WorkflowEngineOptions } from './engine';

function createEngine(makeDecider?: () => Decider, overrides: Partial<WorkflowEngineOptions> = {}) {
  const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
  const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const pendingActions = new InMemoryPendingActionStore();
  const executor = new InMemoryExecutor();
  const newEngine = (decider: Decider) =>
    new WorkflowEngine({
      event_store: events,
      audit_log: audit,
      exception_queue: exceptions,
      lead_store: leads,
      contact_store: contacts,
      deal_store: deals,
      workflow_store: workflows,
      pending_action_store: pendingActions,
      executor,
      decider,
      policy: new RuleBasedPolicyEvaluator(),
      contact_defaults: () => contactState(),
      ...overrides,
    });
  const engine = newEngine(
    makeDecider
      ? makeDecider()
      : new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
  );
  return { engine, newEngine, leads, contacts, deals, workflows, events, audit, exceptions, pendingActions, executor };
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

  it('TIMEOUT 未显式 submitted 时按 transient 记录，但提交状态未知，拒绝简单自动重试', async () => {
    const { engine, workflows, executor } = createEngine();
    executor.failNext(Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' }));
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: 'unknown',
    });
    await expect(engine.retry('wf_lead_follow_up_lead_1')).rejects.toThrow('提交状态未知');
    expect(executor.attempts()).toHaveLength(1);
  });

  it('显式 submitted=false 的 transient 失败允许自动重试', async () => {
    const { engine, workflows, executor } = createEngine();
    executor.failNext(
      Object.assign(new Error('provider unavailable'), {
        classification: 'transient' as const,
        submitted: false as const,
      }),
    );
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: false,
    });
    await engine.retry('wf_lead_follow_up_lead_1');
    expect(executor.attempts()).toHaveLength(2);
    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'waiting_result',
      failure_classification: null,
      failure_submitted: null,
    });
  });

  it('已取消的 Workflow 属于终态：后续事件按事实接收并交人工判断，不恢复流程', async () => {
    const { engine, workflows, exceptions, events, audit, leads } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    engine.cancel('wf_lead_follow_up_lead_1', 'user_7');
    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed').length;
    const replied = emailRepliedEvent();

    const result = await engine.handleEvent(replied);

    // 事件确实落在该主体上，只是实例已结束：按 processed 接收，不能报「无人认领」，
    // 也不能让它永远停在 pending（重放只会得到同样结论）。
    expect(result.status).toBe('processed');
    expect(result).toMatchObject({
      status: 'processed',
      workflow: { workflow_instance_id: 'wf_lead_follow_up_lead_1' },
    });
    expect(events.getByEventId(replied.event_id)?.processing_status).toBe('processed');
    // 终态保持：不恢复流程，也不提出任何新动作；事实本身照常合并
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('cancelled');
    expect(audit.list().filter((entry) => entry.action === 'decision_proposed')).toHaveLength(proposed);
    expect(leads.get('lead_1')?.status).toBe('engaged');
    // 事实已落库，但需要人工判断是否需要新建后续流程
    expect(exceptions.listOpen()).toHaveLength(1);
    expect(exceptions.listOpen()[0]).toMatchObject({ reason: 'workflow_ended', status: 'open' });
    expect(
      audit.list().some(
        (entry) => entry.action === 'exception_enqueued' && entry.reason === 'workflow_ended' && entry.result === 'pending',
      ),
    ).toBe(true);
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

  it('人工审核期间到达的合法事件按 processed 接收，异常原因标记为 awaiting_approval', async () => {
    const { engine, workflows, exceptions, audit, leads } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const late = meetingScheduledEvent({
      event_id: 'evt_late_1',
      idempotency_key: 'meeting.scheduled:mtg_late',
      payload: { ...meetingScheduledEvent().payload, meeting_id: 'mtg_late' },
    });
    const result = await engine.handleEvent(late);

    // 事实已合并、事件已消费：卡住的只是流程，不是事件本身
    expect(result.status).toBe('processed');
    expect(leads.get('lead_1')?.status).toBe('qualified');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');
    expect(exceptions.listOpen()[0]).toMatchObject({ reason: 'awaiting_approval', status: 'open' });
    expect(
      audit.list().some(
        (entry) => entry.action === 'event_processed' && entry.event_id === late.event_id && entry.result === 'succeeded',
      ),
    ).toBe(true);
    expect(
      audit.list().find(
        (entry) => entry.action === 'exception_enqueued' && entry.event_id === late.event_id,
      ),
    ).toMatchObject({ reason: 'awaiting_approval', result: 'pending' });
  });

  it('审核期间事实校验不通过的迟到事件仍判失败，原因保持 invalid_transition', async () => {
    const { engine, workflows, exceptions } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');

    // Lead 已 engaged：engaged + email.sent 不是合法事实迁移，必须原样拒绝
    const late = emailSentEvent({
      event_id: 'evt_late_1',
      idempotency_key: 'email.sent:msg_late',
      occurred_at: '2026-09-24T13:00:00+08:00',
      payload: { ...emailSentEvent().payload, message_id: 'msg_late' },
    });
    const result = await engine.handleEvent(late);

    expect(result.status).toBe('failed');
    expect(exceptions.listOpen()[0]).toMatchObject({ reason: 'invalid_transition', status: 'open' });
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');
  });

  it('实例离开 needs_review 后自动关闭等待审批期间入队的异常', async () => {
    const { engine, exceptions, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    await engine.handleEvent(meetingScheduledEvent({
      event_id: 'evt_late_1',
      idempotency_key: 'meeting.scheduled:mtg_late',
      payload: { ...meetingScheduledEvent().payload, meeting_id: 'mtg_late' },
    }));

    const waiting = exceptions.listOpen().filter((record) => record.reason === 'awaiting_approval');
    expect(waiting).toHaveLength(1);

    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
    const actionId = proposed[proposed.length - 1]?.action_id ?? '';
    const { workflow } = await engine.approve('wf_lead_follow_up_lead_1', actionId, 'user_7');

    expect(workflow.status).not.toBe('needs_review');
    expect(exceptions.listOpen().filter((record) => record.reason === 'awaiting_approval')).toHaveLength(0);
    expect(exceptions.get(waiting[0]!.exception_id)).toMatchObject({ status: 'resolved', resolved_by: 'user_7' });
    expect(
      audit.list().some((entry) => entry.action === 'exception_resolved' && entry.result === 'succeeded'),
    ).toBe(true);
  });

  it('拒绝待审动作同样关闭等待审批期间入队的异常', async () => {
    const { engine, exceptions, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    await engine.handleEvent(meetingScheduledEvent({
      event_id: 'evt_late_1',
      idempotency_key: 'meeting.scheduled:mtg_late',
      payload: { ...meetingScheduledEvent().payload, meeting_id: 'mtg_late' },
    }));

    const waiting = exceptions.listOpen().filter((record) => record.reason === 'awaiting_approval');
    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
    const actionId = proposed[proposed.length - 1]?.action_id ?? '';
    const { workflow } = await engine.reject('wf_lead_follow_up_lead_1', actionId, 'user_7', '客户暂不需要会议');

    expect(workflow.status).not.toBe('needs_review');
    expect(exceptions.get(waiting[0]!.exception_id)).toMatchObject({ status: 'resolved', resolved_by: 'user_7' });
  });

  it('审核期间真正非法的事实迁移仍判失败，原因保持 stale_event', async () => {
    const { engine, workflows, exceptions, deals } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');
    await engine.handleEvent(dealCreatedEvent());

    const conflicting = dealStageChangedEvent({
      payload: { ...dealStageChangedEvent().payload, from_stage: 'discovery', to_stage: 'proposal' },
    });
    const result = await engine.handleEvent(conflicting);

    expect(result.status).toBe('failed');
    expect(exceptions.listOpen().some((record) => record.reason === 'stale_event')).toBe(true);
    expect(deals.get('deal_1')?.stage).toBe('qualification');
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');
  });

  it('approve 执行待审核动作后进入等待外部结果', async () => {
    const { engine, workflows, executor, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
    const actionId = proposed[proposed.length - 1]?.action_id ?? '';
    const { workflow } = await engine.approve('wf_lead_follow_up_lead_1', actionId, 'user_7');

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
    const { workflow } = await engine.reject('wf_lead_follow_up_lead_1', actionId, 'user_7', '客户暂不需要会议');

    // 被拒动作类型成为新的规划约束后没有任何安全替代动作：
    // 按 docs/decision-policy.md「Rejected」第 6 条进入 waiting_result 等待后续事件，而不是直接结束流程。
    expect(workflow).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['meeting.scheduled', 'task.overdue'] });
    expect(audit.list().some((entry) => entry.action === 'action_rejected')).toBe(true);
    expect(executor.attempts()).toHaveLength(1);
  });

  it('人工拒绝后：同一上下文不重复提出，新事实到达时重新提出且必须再次审批', async () => {
    const { engine, workflows, executor, audit, pendingActions } = createEngine(undefined, {
      // 联系人偏好人工联系：首次跟进邮件每次都要人工审核，便于观察 Decider 的约束与解锁
      contact_defaults: () => contactState({ contact_preference: 'human_only' }),
    });
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('needs_review');
    expect(executor.attempts()).toHaveLength(0);

    const firstActionId = audit.list().filter((entry) => entry.action === 'decision_proposed').at(-1)?.action_id ?? '';
    await engine.reject('wf_lead_follow_up_lead_1', firstActionId, 'user_7', '客户在休假，先不要发信');

    const afterReject = workflows.get('wf_lead_follow_up_lead_1')!;
    expect(afterReject.status).toBe('waiting_result');
    expect(afterReject.previous_decisions).toEqual([
      expect.objectContaining({
        action_type: 'send_email',
        status: 'rejected',
        reason: '客户在休假，先不要发信',
        basis_event_id: afterReject.last_processed_event_id,
      }),
    ]);
    // 同一上下文下约束依然有效：不重复提出同一动作，也不会因为重新规划而自动发出邮件
    expect(pendingActions.getPending('wf_lead_follow_up_lead_1')).toBeUndefined();
    expect(executor.attempts()).toHaveLength(0);

    // 新事实（CRM 里建立了 Deal）：约束解除，但上一次人工拒绝不允许再次自动执行
    await engine.handleEvent(
      dealCreatedEvent({
        occurred_at: new Date().toISOString(),
        payload: { ...dealCreatedEvent().payload, deal_id: 'deal_1' },
      }),
    );

    const woken = workflows.get('wf_lead_follow_up_lead_1')!;
    expect(woken.status).toBe('needs_review');
    expect(pendingActions.getPending('wf_lead_follow_up_lead_1')?.action).toMatchObject({
      action_type: 'send_email',
      requires_approval: true,
    });
    expect(executor.attempts()).toHaveLength(0);

    const secondActionId = pendingActions.getPending('wf_lead_follow_up_lead_1')?.action.action_id ?? '';
    const { workflow } = await engine.approve('wf_lead_follow_up_lead_1', secondActionId, 'user_7');

    expect(workflow.status).toBe('waiting_result');
    expect(executor.attempts()).toHaveLength(1);
  });

  it('终态实例收到非法事实时仍按事实校验失败，不被终态分支静默吞掉', async () => {
    const { engine, workflows, exceptions } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(dealCreatedEvent());
    engine.cancel('wf_lead_follow_up_lead_1', 'user_7');

    const conflicting = dealStageChangedEvent({
      payload: { ...dealStageChangedEvent().payload, from_stage: 'discovery', to_stage: 'proposal' },
    });
    const result = await engine.handleEvent(conflicting);

    expect(result.status).toBe('failed');
    expect(exceptions.listOpen()[0]).toMatchObject({ reason: 'stale_event', status: 'open' });
    // 失败不改变终态：已结束的流程不会因为一条非法事件被拉回来
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('cancelled');
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
    // Lead 尚未发生有效互动：Workflow 按当前 Lead 事实等待可推进的事件，而不是终结或转人工
    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['deal.stage_changed', 'proposal.sent', 'lead.assigned', 'task.overdue'],
    });
  });
});

describe('拒绝结论持久化', () => {
  it('拒绝结论写入 State，重建引擎后仍作为规划约束', async () => {
    const inner = new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() });
    const contexts: DecisionContext[] = [];
    const decider: Decider = {
      decide: (ctx) => {
        contexts.push(ctx);
        return inner.decide(ctx);
      },
    };
    const { engine, newEngine, workflows, audit } = createEngine(() => decider);

    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());

    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
    const actionId = proposed[proposed.length - 1]?.action_id ?? '';
    await engine.reject('wf_lead_follow_up_lead_1', actionId, 'user_7', '客户暂不需要此类跟进');

    const rejected = workflows.get('wf_lead_follow_up_lead_1')?.previous_decisions ?? [];
    expect(rejected).toEqual([
      expect.objectContaining({
        action_id: actionId,
        status: 'rejected',
        decided_by: 'user_7',
        reason: '客户暂不需要此类跟进',
      }),
    ]);

    // 重启后引擎内部的 Map 一律丢弃，约束只能来自持久化的 State。
    contexts.length = 0;
    const restarted = newEngine(decider);
    await restarted.handleEvent(taskOverdueEvent());

    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts[contexts.length - 1]?.previous_decisions).toEqual(rejected);
  });
});

describe('异常队列去重', () => {
  it('同一事件的同一原因不重复入队也不重复审计', async () => {
    const { engine, exceptions, audit } = createEngine();

    await engine.handleEvent(leadCreatedEvent());
    const conflicting = leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, company_name: '另一家公司' },
    });

    expect((await engine.handleEvent(conflicting)).status).toBe('conflict');
    expect((await engine.handleEvent(conflicting)).status).toBe('conflict');

    expect(exceptions.listOpen().filter((record) => record.reason === 'idempotency_conflict')).toHaveLength(1);
    expect(audit.list().filter((entry) => entry.action === 'exception_enqueued')).toHaveLength(1);
  });

  it('异常被人工处理后，同一事件可以再次入队', async () => {
    const { engine, exceptions } = createEngine();

    await engine.handleEvent(leadCreatedEvent());
    const conflicting = leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, company_name: '另一家公司' },
    });
    await engine.handleEvent(conflicting);
    await engine.handleEvent(conflicting);

    const open = exceptions.listOpen()[0];
    expect(open).toBeDefined();
    exceptions.resolve(open!.exception_id, '已人工确认', 'user_7');
    await engine.handleEvent(conflicting);

    expect(exceptions.listOpen().filter((record) => record.reason === 'idempotency_conflict')).toHaveLength(1);
    expect(exceptions.list().filter((record) => record.reason === 'idempotency_conflict')).toHaveLength(2);
  });
});

describe('cancel 的状态迁移审计', () => {
  it('写入迁移前后的状态与操作者', async () => {
    const { engine, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());

    engine.cancel('wf_lead_follow_up_lead_1', 'user_7');

    const entry = audit
      .list()
      .find((item) => item.action === 'state_transitioned' && item.after_state === 'cancelled');
    expect(entry).toBeDefined();
    expect(entry?.before_state).toBe('waiting_result');
    expect(entry?.reason).toBe('cancelled by user_7');
    expect(entry?.actor).toEqual({ actor_type: 'user', actor_id: 'user_7' });
  });
});

describe('Policy 拒绝后的待审批记录', () => {
  /** 走到「Decider 提出 send_email → Policy 因退订硬性拒绝」这一步。 */
  async function driveToPolicyReject() {
    const stack = createEngine();
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(
      contactRecordedEvent({
        payload: { ...contactRecordedEvent().payload, contactability: 'unsubscribed' },
      }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());
    return stack;
  }

  it('Policy 拒绝后不留下「可被审批」的待审记录', async () => {
    const { engine, workflows, audit } = await driveToPolicyReject();

    expect(audit.list().some((entry) => entry.action === 'policy_rejected')).toBe(true);
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).not.toBe('needs_review');
    // 控制面「当前待审批动作」必须为空：幽灵动作会让审核界面显示一个永远批不掉的条目。
    expect(engine.pendingAction('wf_lead_follow_up_lead_1')).toBeNull();
  });

  it('待审记录被记为 policy_rejected，而不是停留在 pending', async () => {
    const { pendingActions, audit } = await driveToPolicyReject();

    const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
    const actionId = proposed[proposed.length - 1]?.action_id ?? '';
    expect(actionId).not.toBe('');

    const record = pendingActions.get(actionId);
    expect(record).toMatchObject({ status: 'decided', decision: 'policy_rejected', decided_by: 'policy' });
    expect(record?.decided_at).not.toBeNull();
  });

  it('Policy 拒绝不写入人工拒绝约束，后续事实仍能触发重新规划', async () => {
    const { engine, workflows } = await driveToPolicyReject();
    const id = 'wf_lead_follow_up_lead_1';

    // 人工拒绝才进 previous_decisions；Policy 拒绝是每次规划时重新判定的动态结论，
    // 写成永久约束会让「退订后重新订阅」的联系人永远收不到跟进。
    expect(workflows.get(id)?.previous_decisions ?? []).toEqual([]);
    const planBefore = workflows.get(id)?.plan_version ?? 0;

    await engine.handleEvent(emailSentEvent());

    expect(workflows.get(id)?.plan_version ?? 0).toBeGreaterThan(planBefore);
    expect(workflows.get(id)?.previous_decisions ?? []).toEqual([]);
    expect(engine.pendingAction(id)).toBeNull();
  });
});

describe('事实事件唤醒派生等待中的流程', () => {
  const WF = 'wf_lead_follow_up_lead_1';

  /**
   * 生产环境的 contact_defaults 不带邮箱（docs/events.md：邮箱必须由 contact.recorded 声明），
   * 因此这里也要还原「分配时还没有邮箱」的真实前提。
   */
  function createLateContactEngine() {
    return createEngine(undefined, {
      contact_defaults: (contactId) =>
        contactState({
          contact_id: contactId,
          full_name: null,
          email: null,
          contact_preference: 'auto_allowed',
          contactability: 'reachable',
          is_new_contact: true,
        }),
    });
  }

  async function assignWithoutContactEmail() {
    const stack = createLateContactEngine();
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());
    return stack;
  }

  it('分配后再登记联系人邮箱，也能提出首封跟进邮件', async () => {
    const { engine, workflows } = await assignWithoutContactEmail();

    expect(workflows.get(WF)).toMatchObject({ status: 'waiting_result', current_step: 'await_event' });
    expect(engine.pendingAction(WF)).toBeNull();

    await engine.handleEvent(
      contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, is_new_contact: true } }),
    );

    expect(workflows.get(WF)?.status).toBe('needs_review');
    expect(engine.pendingAction(WF)).toMatchObject({ action_type: 'send_email' });
  });

  it('非新联系人的邮箱晚到时直接自动派发，不经过人工审批', async () => {
    const { engine, workflows, executor } = await assignWithoutContactEmail();

    await engine.handleEvent(
      contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, is_new_contact: false } }),
    );

    expect(workflows.get(WF)).toMatchObject({
      status: 'waiting_result',
      current_step: 'send_email',
      awaiting_event_types: ['email.sent'],
    });
    expect(executor.attempts()).toHaveLength(1);
    expect(engine.pendingAction(WF)).toBeNull();
  });

  it('动作在途期间到达的联系人事实只合并，不重复派发', async () => {
    const { engine, workflows, executor } = createLateContactEngine();
    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await engine.handleEvent(
      contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, is_new_contact: false } }),
    );
    await engine.handleEvent(leadAssignedEvent());
    expect(executor.attempts()).toHaveLength(1);
    const planBefore = workflows.get(WF)?.plan_version ?? 0;

    await engine.handleEvent(
      contactRecordedEvent({
        event_id: 'evt_0010b',
        idempotency_key: 'contact.recorded:crm:contact_1:2',
        payload: {
          ...contactRecordedEvent().payload,
          is_new_contact: false,
          email: 'changed@acme.example',
        },
      }),
    );

    expect(executor.attempts()).toHaveLength(1);
    expect(workflows.get(WF)?.plan_version).toBe(planBefore);
    expect(workflows.get(WF)).toMatchObject({ status: 'waiting_result', current_step: 'send_email' });
  });

  it('没有实质变化的联系人事实不重新规划，plan_version 保持不变', async () => {
    const { engine, workflows } = await assignWithoutContactEmail();
    const planBefore = workflows.get(WF)?.plan_version ?? 0;

    await engine.handleEvent(
      contactRecordedEvent({
        event_id: 'evt_0010c',
        idempotency_key: 'contact.recorded:crm:contact_1:2',
        payload: {
          ...contactRecordedEvent().payload,
          full_name: 'Chen',
          email: null,
          contactability: 'reachable',
          contact_preference: 'auto_allowed',
          is_new_contact: true,
        },
      }),
    );

    expect(workflows.get(WF)?.plan_version).toBe(planBefore);
    expect(workflows.get(WF)).toMatchObject({ status: 'waiting_result', current_step: 'await_event' });
    expect(engine.pendingAction(WF)).toBeNull();
  });

  it('重复投递同一联系人事实只判重，不重新规划', async () => {
    const { engine, workflows } = await assignWithoutContactEmail();
    await engine.handleEvent(contactRecordedEvent());
    const planAfter = workflows.get(WF)?.plan_version ?? 0;

    const repeated = await engine.handleEvent(contactRecordedEvent());

    expect(repeated.status).toBe('duplicate');
    expect(workflows.get(WF)?.plan_version).toBe(planAfter);
  });
});

describe('失效动作的重新规划', () => {
  const WF = 'wf_lead_follow_up_lead_1';

  /** 推到 needs_review：等待人工审核「安排会议」。 */
  async function driveToReview(engine: WorkflowEngine) {
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    await engine.handleEvent(emailSentEvent());
    await engine.handleEvent(emailRepliedEvent());
    return engine.pendingAction(WF)?.action_id ?? '';
  }

  it('批准前事实已让动作失效：作废旧动作并重新规划，而不是抛错', async () => {
    const { engine, workflows, audit, pendingActions, executor } = createEngine();
    const actionId = await driveToReview(engine);
    expect(workflows.get(WF)?.status).toBe('needs_review');

    // 审核期间联系人退订：Policy 判定「安排会议」已失效
    await engine.handleEvent(
      contactRecordedEvent({ payload: { ...contactRecordedEvent().payload, contactability: 'unsubscribed' } }),
    );

    const outcome = await engine.approve(WF, actionId, 'user_7');

    expect(outcome.stale_action_replanned).toBe(true);
    expect(outcome.workflow.status).not.toBe('needs_review');
    expect(engine.pendingAction(WF)).toBeNull();
    expect(pendingActions.get(actionId)).toMatchObject({ status: 'decided', decision: null, decided_by: 'user_7' });
    expect(audit.list().some((entry) => entry.action === 'action_stale' && entry.action_id === actionId)).toBe(true);
    expect(audit.list().some((entry) => entry.action === 'action_approved')).toBe(false);
    // 失效动作没有被执行：仍然只有分配后那一次派发
    expect(executor.attempts()).toHaveLength(1);
  });

  it('批准未失效的动作照常执行，stale_action_replanned 为 false', async () => {
    const { engine, audit, executor } = createEngine();
    const actionId = await driveToReview(engine);

    const outcome = await engine.approve(WF, actionId, 'user_7');

    expect(outcome.stale_action_replanned).toBe(false);
    expect(outcome.workflow).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['meeting.scheduled'] });
    expect(executor.attempts()).toHaveLength(2);
    expect(audit.list().some((entry) => entry.action === 'action_stale')).toBe(false);
  });

  it('replan 作废当前待审动作并按当前事实提出新动作', async () => {
    const { engine, workflows, audit, pendingActions } = createEngine();
    const actionId = await driveToReview(engine);
    const planBefore = workflows.get(WF)?.plan_version ?? 0;

    const workflow = await engine.replan(WF, 'user_7');

    expect(workflow.status).toBe('needs_review');
    expect(workflow.plan_version).toBeGreaterThan(planBefore);
    expect(engine.pendingAction(WF)?.action_id).not.toBe(actionId);
    expect(pendingActions.get(actionId)).toMatchObject({ status: 'decided', decision: null, decided_by: 'user_7' });
    expect(audit.list().some((entry) => entry.action === 'replan_requested' && entry.action_id === actionId)).toBe(
      true,
    );
    // 人工重新规划不等于拒绝：没有 previous_decisions，同一动作类型可以被重新提出
    expect(workflow.previous_decisions ?? []).toEqual([]);
  });

  it('非待审实例不能重新规划', async () => {
    const { engine } = createEngine();
    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));

    await expect(engine.replan(WF, 'user_7')).rejects.toThrow('只有待审核实例可以重新规划');
  });

  it('已取消的实例不能重新规划', async () => {
    const stack = createEngine();
    const actionId = await driveToReview(stack.engine);
    stack.engine.cancel(WF, 'user_7');

    await expect(stack.engine.replan(WF, 'user_7')).rejects.toThrow('只有待审核实例可以重新规划');
    expect(stack.pendingActions.get(actionId)?.status).toBe('pending');
  });
});
