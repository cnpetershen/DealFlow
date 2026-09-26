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
import { contactState, emailRepliedEvent, emailSentEvent, leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import { RetryScheduler } from './retry-scheduler';

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
  return { engine, executor, workflows };
}

/** 让实例进入 failed：Executor 注入一次分类失败。 */
async function driveToFailure(
  stack: ReturnType<typeof buildStack>,
  failure: { classification?: 'transient' | 'permanent'; submitted?: boolean | 'unknown'; code?: string },
): Promise<void> {
  stack.executor.failNext(
    Object.assign(new Error('provider failure'), failure) as Error & { classification?: string },
  );
  await stack.engine.handleEvent(
    leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
  );
  await stack.engine.handleEvent(leadAssignedEvent());
}

function scheduler(
  stack: ReturnType<typeof buildStack>,
  options: { now_ms?: number; interval_ms?: number; max_attempts?: number } = {},
): { scheduler: RetryScheduler; advance: (ms: number) => void } {
  let clock = options.now_ms ?? Date.parse('2026-09-24T10:00:00+08:00');
  const instance = new RetryScheduler({
    engine: stack.engine,
    workflow_store: stack.workflows,
    now: () => clock,
    interval_ms: options.interval_ms ?? 1_000,
    max_attempts_per_workflow: options.max_attempts ?? 3,
    max_backoff_ms: 60_000,
  });
  return { scheduler: instance, advance: (ms) => { clock += ms; } };
}

describe('RetryScheduler', () => {
  it('transient 失败会被自动重试并恢复流程', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { classification: 'transient', submitted: false });
    expect(stack.workflows.get(WORKFLOW_ID)?.status).toBe('failed');

    const { scheduler: instance } = scheduler(stack);
    const results = await instance.runOnce();

    expect(results).toEqual([{ workflow_instance_id: WORKFLOW_ID, outcome: 'retried', detail: null }]);
    expect(stack.workflows.get(WORKFLOW_ID)?.status).toBe('waiting_result');
    expect(stack.executor.attempts()).toHaveLength(2);
  });

  it('permanent 失败不自动重试', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { classification: 'permanent' });

    const { scheduler: instance } = scheduler(stack);
    const results = await instance.runOnce();

    expect(results).toEqual([
      { workflow_instance_id: WORKFLOW_ID, outcome: 'skipped_permanent', detail: 'permanent' },
    ]);
    expect(stack.workflows.get(WORKFLOW_ID)?.status).toBe('failed');
    expect(stack.executor.attempts()).toHaveLength(1);
  });

  it('submitted === unknown 时不自动重试（必须先对账）', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { code: 'TIMEOUT' });

    const { scheduler: instance } = scheduler(stack);
    const results = await instance.runOnce();

    expect(results[0]?.outcome).toBe('skipped_unknown_submit');
    expect(stack.executor.attempts()).toHaveLength(1);
  });

  it('重试失败后按退避等待，不会每个周期都打一次外部调用', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { classification: 'transient', submitted: false });
    // 提供商持续不可用
    stack.executor.failAlways(Object.assign(new Error('still down'), { classification: 'transient' as const, submitted: false }));

    const { scheduler: instance, advance } = scheduler(stack, { interval_ms: 1_000 });

    expect((await instance.runOnce())[0]?.outcome).toBe('failed');
    // 退避 1s，尚未到时间
    expect((await instance.runOnce())[0]?.outcome).toBe('skipped_backoff');

    advance(1_000);
    expect((await instance.runOnce())[0]?.outcome).toBe('failed');
    expect(stack.executor.attempts()).toHaveLength(3);
  });

  it('连续失败达到上限后停止自动重试并告警一次', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { classification: 'transient', submitted: false });
    stack.executor.failAlways(Object.assign(new Error('down'), { classification: 'transient' as const, submitted: false }));

    const { scheduler: instance, advance } = scheduler(stack, { interval_ms: 1_000, max_attempts: 2 });

    expect((await instance.runOnce())[0]?.outcome).toBe('failed');
    advance(1_000);
    expect((await instance.runOnce())[0]?.outcome).toBe('failed');
    advance(600_000);
    expect((await instance.runOnce())[0]?.outcome).toBe('exhausted');
    expect((await instance.runOnce())[0]?.outcome).toBe('exhausted');
    // 1 次原始 + 2 次自动重试
    expect(stack.executor.attempts()).toHaveLength(3);
  });

  it('尊重 failure_retry_after 指定的时间', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { classification: 'transient', submitted: false });
    const retryAfter = '2026-09-24T10:05:00+08:00';
    stack.workflows.save({ ...stack.workflows.get(WORKFLOW_ID)!, failure_retry_after: retryAfter });

    const { scheduler: instance, advance } = scheduler(stack);

    const early = await instance.runOnce();
    expect(early[0]?.outcome).toBe('skipped_backoff');
    expect(early[0]?.detail).toBe(new Date(Date.parse(retryAfter)).toISOString());

    advance(5 * 60_000);
    expect((await instance.runOnce())[0]?.outcome).toBe('retried');
  });

  it('实例恢复后清空退避计数，再次失败时立即重试而不是继续等退避', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { classification: 'transient', submitted: false });
    stack.executor.failAlways(Object.assign(new Error('down'), { classification: 'transient' as const, submitted: false }));

    const { scheduler: instance, advance } = scheduler(stack, { interval_ms: 1_000 });
    expect((await instance.runOnce())[0]?.outcome).toBe('failed');

    // 提供商恢复，重试成功
    stack.executor.clearFailure();
    advance(1_000);
    expect((await instance.runOnce())[0]?.outcome).toBe('retried');
    expect(stack.workflows.get(WORKFLOW_ID)?.status).toBe('waiting_result');

    // 再次失败：退避计数已被清空，无需等待即可重试
    stack.executor.failAlways(Object.assign(new Error('down again'), { classification: 'transient' as const, submitted: false }));
    await stack.engine.handleEvent(
      emailSentEvent({ payload: { ...emailSentEvent().payload, workflow_instance_id: WORKFLOW_ID } }),
    );
    await stack.engine.handleEvent(emailRepliedEvent());
    const actionId = stack.engine.pendingAction(WORKFLOW_ID)?.action_id ?? '';
    await expect(stack.engine.approve(WORKFLOW_ID, actionId, 'user_7')).resolves.toBeDefined();
    expect(stack.workflows.get(WORKFLOW_ID)?.status).toBe('failed');

    expect((await instance.runOnce())[0]?.outcome).toBe('retried');
  });

  it('没有失败实例时不做任何事', async () => {
    const stack = buildStack();
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );

    const { scheduler: instance } = scheduler(stack);
    expect(await instance.runOnce()).toEqual([]);
  });

  it('重试计数持久化：新建调度器（模拟重启）后上限仍然生效', async () => {
    const stack = buildStack();
    await driveToFailure(stack, { classification: 'transient', submitted: false });
    stack.executor.failAlways(
      Object.assign(new Error('down'), { classification: 'transient' as const, submitted: false }),
    );

    const first = scheduler(stack, { interval_ms: 1_000, max_attempts: 1 });
    expect((await first.scheduler.runOnce())[0]?.outcome).toBe('failed');
    expect(stack.workflows.get(WORKFLOW_ID)?.failure_retry_attempts).toBe(1);

    // 进程重启：调度器的内存状态全没了，计数必须来自 WorkflowStateStore
    const second = scheduler(stack, { interval_ms: 1_000, max_attempts: 1 });
    expect((await second.scheduler.runOnce())[0]?.outcome).toBe('exhausted');
    // 持续故障的外部系统不会因为每次重启都被重新打一次
    expect(stack.executor.attempts()).toHaveLength(2);
    expect(stack.workflows.get(WORKFLOW_ID)?.failure_retry_attempts).toBe(1);
  });

  it('start / stop 幂等，stop 后不再有定时器', () => {
    const stack = buildStack();
    const { scheduler: instance } = scheduler(stack);

    expect(instance.running).toBe(false);
    instance.start();
    instance.start();
    expect(instance.running).toBe(true);
    instance.stop();
    instance.stop();
    expect(instance.running).toBe(false);
  });
});
