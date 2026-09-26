import { describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import { ProviderAdapterExecutor } from '../provider/executor';
import { InMemoryProviderAdapter } from '../provider/in-memory';
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
import { contactState, leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { WorkflowEngine, type WorkflowEngineOptions } from './engine';

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';

/** 提交超时错误：transient + submitted=unknown，正是需要对账的场景。 */
function timeoutError(): Error {
  return Object.assign(new Error('provider timeout'), {
    classification: 'transient' as const,
    code: 'TIMEOUT',
    submitted: 'unknown' as const,
  });
}

function buildStack(options: { executor?: WorkflowEngineOptions['executor'] } = {}) {
  const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
  const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const pendingActions = new InMemoryPendingActionStore();
  const adapter = new InMemoryProviderAdapter({ provider: 'mailgun' });
  const executor = options.executor ?? new ProviderAdapterExecutor([adapter]);

  const createEngine = (actionIdSeed: number): WorkflowEngine =>
    new WorkflowEngine({
      event_store: events,
      audit_log: audit,
      exception_queue: exceptions,
      lead_store: leads,
      contact_store: contacts,
      deal_store: deals,
      workflow_store: workflows,
      memory_store: new InMemoryMemoryStore(),
      pending_action_store: pendingActions,
      executor,
      decider: new RuleBasedDecider({
        createActionId: (() => { let n = actionIdSeed; return () => `action_${++n}`; })(),
      }),
      policy: new RuleBasedPolicyEvaluator(),
      contact_defaults: () => contactState(),
    });

  return { engine: createEngine(0), createEngine, adapter, executor, workflows, events, audit, exceptions, pendingActions };
}

/** 走到「首次外发提交超时」：unknown submission 的失败实例。 */
async function driveToUnknownSubmission(stack: ReturnType<typeof buildStack>): Promise<void> {
  stack.adapter.failNext(timeoutError(), { record_receipt: false });
  await stack.engine.handleEvent(
    leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
  );
  await stack.engine.handleEvent(leadAssignedEvent());
}

describe('Provider 对账 · submitted', () => {
  it('对账确认已提交时恢复为等待结果，并记录回执审计', async () => {
    const stack = buildStack();
    // 提供商已接受、回执在响应途中丢失：副作用已发生，调用方只看到超时
    stack.adapter.failNext(timeoutError(), { record_receipt: true });
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());

    expect(stack.workflows.get(WORKFLOW_ID)).toMatchObject({ status: 'failed', failure_submitted: 'unknown' });

    const result = await stack.engine.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('submitted');
    expect(result.provider_reference).toBeTruthy();
    expect(result.workflow).toMatchObject({
      status: 'waiting_result',
      current_step: 'send_email',
      awaiting_event_types: ['email.sent'],
      failure_classification: null,
      failure_submitted: null,
    });

    const reconciled = stack.audit.list().find((entry) => entry.action === 'action_reconciled');
    expect(reconciled).toMatchObject({ action_type: 'send_email', result: 'succeeded' });
    expect(reconciled?.provider_receipt).toMatchObject({ provider: 'mailgun' });
    expect(reconciled?.actor).toEqual({ actor_type: 'user', actor_id: 'user_7' });
    // 对账不会再次调用 Executor：副作用已经发生过，不能再打一次
    expect(stack.adapter.submitted()).toHaveLength(1);
  });

  it('已恢复的实例再次对账会被拒绝（幂等）', async () => {
    const stack = buildStack();
    stack.adapter.failNext(timeoutError(), { record_receipt: true });
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());

    await stack.engine.reconcile(WORKFLOW_ID, 'user_7');
    await expect(stack.engine.reconcile(WORKFLOW_ID, 'user_7')).rejects.toThrow('无需对账');
    expect(stack.adapter.reconcileCalls()).toBe(1);
  });
});

describe('Provider 对账 · not_submitted', () => {
  it('确认未提交时用原执行幂等 key 安全重试', async () => {
    const stack = buildStack();
    await driveToUnknownSubmission(stack);
    const firstKey = stack.adapter.submitted()[0]?.execution_idempotency_key;

    const result = await stack.engine.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('not_submitted');
    expect(result.workflow.status).toBe('waiting_result');

    // 关键：重试复用同一个执行幂等 key，不会产生第二次业务效果
    const submitted = stack.adapter.submitted();
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.execution_idempotency_key).toBe(firstKey);
    expect(new Set(submitted.map((action) => action.execution_idempotency_key)).size).toBe(1);

    const reconciled = stack.audit.list().find((entry) => entry.action === 'action_reconciled');
    expect(reconciled?.reason).toContain('not_submitted');
    // 第一次提交失败（action_failed），对账后重试成功（action_dispatched）
    expect(stack.audit.list().filter((entry) => entry.action === 'action_failed')).toHaveLength(1);
    expect(stack.audit.list().filter((entry) => entry.action === 'action_dispatched')).toHaveLength(1);
  });

  it('安全重试仍失败时回到 failed，且 key 不变', async () => {
    const stack = buildStack();
    await driveToUnknownSubmission(stack);
    const firstKey = stack.adapter.submitted()[0]?.execution_idempotency_key;
    stack.adapter.failNext(
      Object.assign(new Error('still down'), { classification: 'transient' as const, submitted: false }),
    );

    const result = await stack.engine.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('not_submitted');
    expect(result.workflow).toMatchObject({ status: 'failed', failure_submitted: false });
    const submitted = stack.adapter.submitted();
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.execution_idempotency_key).toBe(firstKey);
  });

  it('动作 plan_version 已过期时拒绝用旧动作重试', async () => {
    const stack = buildStack();
    await driveToUnknownSubmission(stack);
    const workflow = stack.workflows.get(WORKFLOW_ID)!;
    stack.workflows.save({ ...workflow, plan_version: workflow.plan_version + 5 });

    await expect(stack.engine.reconcile(WORKFLOW_ID, 'user_7')).rejects.toThrow('动作已过期');
  });
});

describe('Provider 对账 · indeterminate', () => {
  it('对账返回 unknown 时保持 failed 并写入异常队列', async () => {
    const unknownAdapter = new InMemoryProviderAdapter({
      provider: 'mailgun',
      reconcile: () => ({ submitted: 'unknown', provider_reference: null }),
    });
    const stack = buildStack({ executor: new ProviderAdapterExecutor([unknownAdapter]) });
    unknownAdapter.failNext(timeoutError(), { record_receipt: false });
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());

    const result = await stack.engine.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('indeterminate');
    expect(result.exception_id).toBeDefined();
    expect(result.workflow.status).toBe('failed');

    const open = stack.exceptions.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: 'processing_error', event_id: null, status: 'open' });

    expect(stack.audit.list().find((entry) => entry.action === 'action_reconciled')).toMatchObject({ result: 'failed' });
    expect(stack.audit.list().some((entry) => entry.action === 'exception_enqueued')).toBe(true);
    // 未确认的提交绝不能被重试
    expect(unknownAdapter.submitted()).toHaveLength(1);
  });

  it('对账请求本身失败时同样保持 failed 并写异常', async () => {
    const stack = buildStack();
    await driveToUnknownSubmission(stack);
    stack.adapter.failReconcileNext(Object.assign(new Error('reconcile endpoint down'), { code: 'ECONNREFUSED' }));

    const result = await stack.engine.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('indeterminate');
    expect(stack.workflows.get(WORKFLOW_ID)?.status).toBe('failed');
    expect(stack.exceptions.listOpen()).toHaveLength(1);
    expect(stack.adapter.submitted()).toHaveLength(1);
  });
});

describe('Provider 对账 · 前置条件与幂等', () => {
  it('未被标记为 unknown 的失败不允许对账', async () => {
    const stack = buildStack();
    stack.adapter.failNext(
      Object.assign(new Error('provider unreachable'), { classification: 'transient' as const, submitted: false }),
    );
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());

    expect(stack.workflows.get(WORKFLOW_ID)?.failure_submitted).toBe(false);
    await expect(stack.engine.reconcile(WORKFLOW_ID, 'user_7')).rejects.toThrow('提交状态已确定');
    expect(stack.adapter.reconcileCalls()).toBe(0);
  });

  it('非 failed 状态的实例不允许对账', async () => {
    const stack = buildStack();
    await stack.engine.handleEvent(leadCreatedEvent());

    await expect(stack.engine.reconcile(WORKFLOW_ID, 'user_7')).rejects.toThrow('无需对账');
  });

  it('不存在的实例报错', async () => {
    const stack = buildStack();

    await expect(stack.engine.reconcile('wf_missing', 'user_7')).rejects.toThrow('Workflow 不存在');
  });

  it('Executor 不支持对账时明确报错，而不是猜一个结论', async () => {
    const stack = buildStack({ executor: new InMemoryExecutor() });
    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await stack.engine.handleEvent(leadAssignedEvent());

    // InMemoryExecutor 无法注入失败，先手工制造 unknown 状态
    const workflow = stack.workflows.get(WORKFLOW_ID)!;
    stack.workflows.save({ ...workflow, status: 'failed', failure_submitted: 'unknown' });

    await expect(stack.engine.reconcile(WORKFLOW_ID, 'user_7')).rejects.toThrow('Executor 不支持对账');
  });

  it('并发对账合并为一次外部调用', async () => {
    const stack = buildStack();
    await driveToUnknownSubmission(stack);

    const [first, second] = await Promise.all([
      stack.engine.reconcile(WORKFLOW_ID, 'user_7'),
      stack.engine.reconcile(WORKFLOW_ID, 'user_8'),
    ]);

    expect(stack.adapter.reconcileCalls()).toBe(1);
    expect(first).toBe(second);
  });

  it('重启后仍可对账：失败动作快照来自持久化事实而不是进程内存', async () => {
    const stack = buildStack();
    await driveToUnknownSubmission(stack);

    // 模拟重启：用同一批 Store 新建引擎，内存中的动作表与失败分类全部丢失
    const restarted = stack.createEngine(100);
    const result = await restarted.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('not_submitted');
    expect(result.workflow.status).toBe('waiting_result');
  });
});
