import { describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import {
  InMemoryAuditLog,
  InMemoryEventStore,
  InMemoryExceptionQueue,
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
import { WorkflowEngine } from './engine';

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';

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
  return { engine, workflows, audit, executor };
}

/** 推进到 needs_review（会议动作需要人工审核），返回该待审核动作的 action_id。 */
async function driveToReview(engine: WorkflowEngine, audit: InMemoryAuditLog): Promise<string> {
  await engine.handleEvent(
    leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
  );
  await engine.handleEvent(leadAssignedEvent());
  await engine.handleEvent(emailSentEvent());
  await engine.handleEvent(emailRepliedEvent());

  const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
  return proposed[proposed.length - 1]?.action_id ?? '';
}

describe('WorkflowEngine 批准执行失败（dispatchAction 统一路径）', () => {
  it('transient 失败：批准后进入 failed，持久化分类，retry 被允许', async () => {
    const { engine, workflows, audit, executor } = createEngine();
    const actionId = await driveToReview(engine, audit);

    executor.failNext(Object.assign(new Error('provider unavailable'), { classification: 'transient' as const }));
    const result = await engine.approve(WORKFLOW_ID, actionId, 'user_7');

    expect(result).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: false,
    });
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('failed');
    expect(audit.listByActionId(actionId).map((e) => e.action)).toContain('action_failed');
    expect(audit.listByActionId(actionId).map((e) => e.action)).not.toContain('action_dispatched');
    expect(audit.listByActionId(actionId).find((e) => e.action === 'action_failed')?.reason).toMatch(
      /^transient:/,
    );

    // transient 且 submitted=false 允许自动重试。
    await expect(engine.retry(WORKFLOW_ID)).resolves.toBeDefined();
    expect(executor.attempts()).toHaveLength(2);
  });

  it('permanent 失败：批准后进入 failed，retry 被拒绝', async () => {
    const { engine, workflows, audit, executor } = createEngine();
    const actionId = await driveToReview(engine, audit);

    executor.failNext(Object.assign(new Error('invalid recipient'), { classification: 'permanent' as const }));
    const result = await engine.approve(WORKFLOW_ID, actionId, 'user_7');

    expect(result).toMatchObject({
      status: 'failed',
      failure_classification: 'permanent',
      failure_submitted: false,
    });
    expect(audit.listByActionId(actionId).find((e) => e.action === 'action_failed')?.reason).toMatch(
      /^permanent:/,
    );
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('failed');

    await expect(engine.retry(WORKFLOW_ID)).rejects.toThrow('永久性失败不允许自动重试');
    expect(executor.attempts()).toHaveLength(2);
  });

  it('timeout：批准后按 transient 记录但 submitted=unknown，禁止简单 retry', async () => {
    const { engine, workflows, audit, executor } = createEngine();
    const actionId = await driveToReview(engine, audit);

    executor.failNext(Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' }));
    const result = await engine.approve(WORKFLOW_ID, actionId, 'user_7');

    expect(result).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: 'unknown',
    });
    expect(workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: 'unknown',
    });

    await expect(engine.retry(WORKFLOW_ID)).rejects.toThrow('提交状态未知');
    expect(executor.attempts()).toHaveLength(2);
  });

  it('显式 submitted=unknown：批准后禁止简单 retry，即使 transient', async () => {
    const { engine, workflows, audit, executor } = createEngine();
    const actionId = await driveToReview(engine, audit);

    executor.failNext(
      Object.assign(new Error('socket hang up'), {
        classification: 'transient' as const,
        submitted: 'unknown' as const,
      }),
    );
    const result = await engine.approve(WORKFLOW_ID, actionId, 'user_7');

    expect(result).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: 'unknown',
    });
    expect(workflows.get(WORKFLOW_ID)?.status).toBe('failed');

    await expect(engine.retry(WORKFLOW_ID)).rejects.toThrow('提交状态未知');
    expect(executor.attempts()).toHaveLength(2);
  });
});
