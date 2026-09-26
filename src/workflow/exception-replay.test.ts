import { describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
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
import { InMemoryExecutor } from '../executor/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import {
  contactState,
  emailSentEvent,
  leadAssignedEvent,
  leadCreatedEvent,
  taskOverdueEvent,
} from '../testing/fixtures';
import { WorkflowEngine } from './engine';

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';

function buildStack() {
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
    memory_store: new InMemoryMemoryStore(),
    pending_action_store: new InMemoryPendingActionStore(),
    executor,
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => contactState(),
  });

  return { engine, events, audit, exceptions, workflows, executor };
}

/** 制造一条 unmatched_event 异常：无 Workflow 时投递结果事件。 */
async function seedUnmatchedException(stack: ReturnType<typeof buildStack>): Promise<string> {
  await stack.engine.handleEvent(emailSentEvent());
  return stack.exceptions.listOpen()[0]!.exception_id;
}

describe('异常审计 · resolve / discard', () => {
  it('resolve 写入结论、处理人、时间与只追加审计', async () => {
    const stack = buildStack();
    const exceptionId = await seedUnmatchedException(stack);

    const record = stack.engine.resolveException(exceptionId, {
      resolution: '人工确认按当前事实处理',
      reason: '该事件属于历史数据导入',
      actor_id: 'user_7',
    });

    expect(record).toMatchObject({
      status: 'resolved',
      resolution: '人工确认按当前事实处理',
      resolved_by: 'user_7',
    });
    expect(record.resolved_at).toBeTruthy();
    expect(stack.exceptions.listOpen()).toHaveLength(0);

    const audit = stack.audit.list().find((entry) => entry.action === 'exception_resolved');
    expect(audit).toMatchObject({
      exception_id: exceptionId,
      event_id: emailSentEvent().event_id,
      actor: { actor_type: 'user', actor_id: 'user_7' },
      reason: '该事件属于历史数据导入',
      result: 'succeeded',
      before_state: 'open',
      after_state: 'resolved',
      source: 'control_plane',
    });
    expect(audit?.occurred_at).toBeTruthy();
  });

  it('discard 记录结论并写明前后状态', async () => {
    const stack = buildStack();
    const exceptionId = await seedUnmatchedException(stack);

    const record = stack.engine.discardException(exceptionId, {
      resolution: '重复投递，无需处理',
      actor_id: 'user_9',
    });

    expect(record).toMatchObject({
      status: 'discarded',
      resolution: '重复投递，无需处理',
      resolved_by: 'user_9',
    });

    const audit = stack.audit.list().find((entry) => entry.action === 'exception_discarded');
    expect(audit).toMatchObject({
      exception_id: exceptionId,
      after_state: 'discarded',
      // 未提供独立 reason 时，处理结论本身就是做出该决定的原因
      reason: '重复投递，无需处理',
      result: 'succeeded',
    });
  });

  it('不存在的异常报错且不写审计', async () => {
    const stack = buildStack();
    const before = stack.audit.list().length;

    expect(() => stack.engine.resolveException('exc_404', { resolution: 'x' })).toThrow('异常记录不存在');
    expect(stack.audit.list()).toHaveLength(before);
  });

  it('每次处理都追加一条审计，审计不可修改', async () => {
    const stack = buildStack();
    const exceptionId = await seedUnmatchedException(stack);

    stack.engine.resolveException(exceptionId, { resolution: '第一次结论', actor_id: 'user_1' });
    const second = stack.engine.resolveException(exceptionId, { resolution: '第二次结论', actor_id: 'user_2' });

    const audits = stack.audit.list().filter((entry) => entry.action === 'exception_resolved');
    expect(audits).toHaveLength(2);
    expect(second.resolved_by).toBe('user_2');
    // 审计保留第一次的结论，不被覆盖
    expect(audits[0]?.reason).toBe('第一次结论');
  });
});

describe('异常重放 · 正常 Workflow 路径', () => {
  it('重放未匹配的事件：事件按正常路径处理，异常被结论化', async () => {
    const stack = buildStack();
    const exceptionId = await seedUnmatchedException(stack);

    // 先建立 Workflow 并推到等待 email.sent 的状态
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());
    expect(stack.workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });

    const result = await stack.engine.replayException(exceptionId, {
      resolution: '补投历史事件',
      actor_id: 'user_7',
    });

    expect(result.event_status).toBe('processed');
    expect(result.workflow_id).toBe(WORKFLOW_ID);
    expect(result.exception).toMatchObject({ status: 'resolved', resolved_by: 'user_7' });
    // 走的是正常路径：Workflow 从等待 email.sent 恢复为等待回复
    expect(stack.workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.replied', 'task.overdue'],
    });

    const audit = stack.audit.list().find((entry) => entry.action === 'exception_replayed');
    expect(audit).toMatchObject({
      exception_id: exceptionId,
      result: 'succeeded',
      actor: { actor_type: 'user', actor_id: 'user_7' },
    });
  });

  it('重复重放是幂等的：事件已生效则返回 duplicate，不产生第二次业务效果', async () => {
    const stack = buildStack();
    const exceptionId = await seedUnmatchedException(stack);
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());

    const first = await stack.engine.replayException(exceptionId, { resolution: '补投', actor_id: 'user_7' });
    const attemptsAfterFirst = stack.executor.attempts().length;
    const second = await stack.engine.replayException(exceptionId, { resolution: '再补一次', actor_id: 'user_7' });

    expect(first.event_status).toBe('processed');
    expect(second.event_status).toBe('duplicate');
    // 重复重放没有触发新的外部副作用
    expect(stack.executor.attempts()).toHaveLength(attemptsAfterFirst);

    const audits = stack.audit.list().filter((entry) => entry.action === 'exception_replayed');
    expect(audits.map((entry) => entry.result)).toEqual(['succeeded', 'skipped']);
  });

  it('已丢弃的异常不允许重放', async () => {
    const stack = buildStack();
    const exceptionId = await seedUnmatchedException(stack);
    stack.engine.discardException(exceptionId, { resolution: '垃圾数据', actor_id: 'user_7' });

    await expect(
      stack.engine.replayException(exceptionId, { resolution: '反悔了', actor_id: 'user_7' }),
    ).rejects.toThrow('异常已丢弃，不可重放');
    expect(stack.audit.list().some((entry) => entry.action === 'exception_replayed')).toBe(false);
  });

  it('控制面产生的无事件异常无法重放', async () => {
    const stack = buildStack();
    // 手工构造一条没有事件副本的异常（对账 unknown 就是这种形态）
    const record = stack.exceptions.enqueue({
      occurred_at: '2026-09-24T10:00:00+08:00',
      reason: 'processing_error',
      event_id: null,
      event: null,
      subject: { subject_type: 'lead', subject_id: 'lead_1', workflow_instance_id: WORKFLOW_ID },
    });

    await expect(
      stack.engine.replayException(record.exception_id, { resolution: 'x', actor_id: 'user_7' }),
    ).rejects.toThrow('没有关联事件，无法重放');
  });

  it('重新规划后重放：事件在正常路径上仍会被状态机拒绝时保持 open 并留审计', async () => {
    const stack = buildStack();
    // 未分配的 Lead 收到 email.sent：违反 Lead 迁移规则
    await stack.engine.handleEvent(leadCreatedEvent());
    await stack.engine.handleEvent(emailSentEvent({ idempotency_key: 'email.sent:blocked' }));
    const open = stack.exceptions.listOpen();
    expect(open[0]?.reason).toBe('invalid_transition');

    // 未修复前置条件直接重放：仍然失败，异常保持 open（人工可继续处理或丢弃）
    const result = await stack.engine.replayException(open[0]!.exception_id, {
      resolution: '尝试重放',
      actor_id: 'user_7',
    });

    expect(result.event_status).toBe('failed');
    expect(result.exception.status).toBe('open');
    const audit = stack.audit.list().find((entry) => entry.action === 'exception_replayed');
    expect(audit?.result).toBe('failed');
  });

  it('修复前置条件后重放成功，且不产生重复业务效果', async () => {
    const stack = buildStack();
    await stack.engine.handleEvent(leadCreatedEvent());
    await stack.engine.handleEvent(emailSentEvent({ idempotency_key: 'email.sent:late' }));
    const exceptionId = stack.exceptions.listOpen()[0]!.exception_id;

    // 修复：先分配负责人，Lead 状态允许接收 email.sent
    await stack.engine.handleEvent(leadAssignedEvent());
    const before = stack.executor.attempts().length;

    const result = await stack.engine.replayException(exceptionId, {
      resolution: '前置条件已修复，重放',
      actor_id: 'user_7',
    });

    expect(result.event_status).toBe('processed');
    expect(result.exception.status).toBe('resolved');
    // 重放的是同一个事件副本：不产生新的外部副作用
    expect(stack.executor.attempts()).toHaveLength(before);
  });
});

describe('异常审计 · 入队与重放的可追踪性', () => {
  it('入队审计与处理审计通过 exception_id 关联', async () => {
    const stack = buildStack();
    const exceptionId = await seedUnmatchedException(stack);
    stack.engine.resolveException(exceptionId, { resolution: '已处理', actor_id: 'user_7' });

    const related = stack.audit.list().filter((entry) => entry.exception_id === exceptionId);
    expect(related.map((entry) => entry.action)).toEqual(['exception_enqueued', 'exception_resolved']);
    // 入队审计同样带 event_id，能与原始事件对上
    expect(related[0]?.event_id).toBe(emailSentEvent().event_id);
    expect(related.every((entry) => entry.occurred_at.length > 0)).toBe(true);
  });

  it('task.overdue 的异常处理不影响原有 Workflow 事实', async () => {
    const stack = buildStack();
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());
    await stack.engine.handleEvent(emailSentEvent());
    // 等待 email.replied / task.overdue，此处故意投递不匹配的 workflow 归属
    await stack.engine.handleEvent(
      taskOverdueEvent({ payload: { ...taskOverdueEvent().payload, workflow_instance_id: 'wf_other' } }),
    );

    const open = stack.exceptions.listOpen();
    expect(open).toHaveLength(1);
    const lead = stack.workflows.get(WORKFLOW_ID);
    const resolved = stack.engine.resolveException(open[0]!.exception_id, {
      resolution: '归属错误，转人工跟进',
      actor_id: 'user_7',
    });

    expect(resolved.status).toBe('resolved');
    // 处理异常不会改动 Workflow 现状
    expect(stack.workflows.get(WORKFLOW_ID)).toEqual(lead);
  });
});
