import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import {
  emailRepliedEvent,
  emailSentEvent,
  leadAssignedEvent,
  leadCreatedEvent,
} from '../testing/fixtures';
import {
  InMemoryAuditLog,
  InMemoryExceptionQueue,
  InMemoryStateStore,
  InMemoryWorkflowStateStore,
} from './in-memory';
import type { AuditLogStore, EventStore } from './interfaces';
import { SqliteEventStore } from './sqlite';
import type { ContactState, DealState, LeadState } from './types';
import { WorkflowEngine } from '../workflow/engine';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dealflow-recovery-'));
}

interface Stack {
  engine: WorkflowEngine;
  eventStore: EventStore;
  audit: InMemoryAuditLog;
  exceptions: InMemoryExceptionQueue;
  executor: InMemoryExecutor;
  workflows: InMemoryWorkflowStateStore;
  leads: InMemoryStateStore<LeadState>;
  close: () => void;
}

function createStack(options: { eventStore?: EventStore; executor?: InMemoryExecutor } = {}): Stack {
  const leads = new InMemoryStateStore<LeadState>((s) => s.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((s) => s.contact_id);
  const deals = new InMemoryStateStore<DealState>((s) => s.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const eventStore = options.eventStore ?? new SqliteEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const executor = options.executor ?? new InMemoryExecutor();
  const engine = new WorkflowEngine({
    event_store: eventStore,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    executor,
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => ({
      contact_id: 'contact_1',
      full_name: 'Zhang San',
      email: 'buyer@acme.example',
      organization_id: 'org_acme',
      contact_preference: 'auto_allowed' as const,
      contactability: 'reachable' as const,
      is_new_contact: false,
      updated_at: '2026-09-24T10:00:00+08:00',
    }),
  });
  return {
    engine,
    eventStore,
    audit,
    exceptions,
    executor,
    workflows,
    leads,
    close: () => {
      if (eventStore instanceof SqliteEventStore) eventStore.close();
    },
  };
}

/** 共享外部 EventStore 时，stack.close 不再关闭 store，由测试方负责。 */
function createStackWithSharedStore(eventStore: EventStore): Omit<Stack, 'close'> & { close: () => void } {
  const stack = createStack({ eventStore });
  return { ...stack, close: () => {} };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function track(stack: Stack): Stack {
  cleanups.push(stack.close);
  return stack;
}

describe('Crash Recovery', () => {
  it('事件已持久化但 Workflow 尚未处理：重启后可继续处理', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'events.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const firstStore = new SqliteEventStore({ path: dbPath });
    firstStore.append(leadCreatedEvent());
    firstStore.append(leadCreatedEvent({ event_id: 'evt_0010', idempotency_key: 'lead.created:crm:rec_1002', payload: { ...leadCreatedEvent().payload, lead_id: 'lead_2', source_record_id: 'rec_1002' } }));
    firstStore.close();

    const secondStore = track(createStack({ eventStore: new SqliteEventStore({ path: dbPath }) }));
    expect(secondStore.eventStore.list().every((e) => e.processing_status === 'pending')).toBe(true);

    const results = await secondStore.engine.recoverFromEventLog();

    expect(results.map((r) => r.status)).toEqual(['processed', 'processed']);
    expect(secondStore.eventStore.list().every((e) => e.processing_status === 'processed')).toBe(true);
    expect(secondStore.leads.get('lead_1')?.status).toBe('new');
    expect(secondStore.leads.get('lead_2')?.status).toBe('new');
    expect(secondStore.workflows.list().length).toBe(2);
  });

  it('Executor 已接受 Action 但 Result 未到达：重启重放后保持 waiting_result', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'events.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const liveStore = new SqliteEventStore({ path: dbPath });
    const live = track(createStack({ eventStore: liveStore }));
    await live.engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await live.engine.handleEvent(leadAssignedEvent());
    expect(live.workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
    expect(live.executor.attempts()).toHaveLength(1);
    live.close();

    const rebootStore = new SqliteEventStore({ path: dbPath });
    const rebooted = track(createStack({ eventStore: rebootStore }));
    expect(rebooted.workflows.list()).toHaveLength(0);

    await rebooted.engine.recoverFromEventLog();

    expect(rebooted.workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });
    // 崩溃恢复不盲目调用外部 Executor：状态重建为「已派发等待结果」，但不再发起第二次外部副作用。
    expect(rebooted.executor.attempts()).toHaveLength(0);
    expect(rebooted.audit.list().some((e) => e.action === 'action_dispatched')).toBe(true);
  });

  it('Audit 写入异常时不 markProcessed，事件保持 pending 可重试', async () => {
    const stack = track(createStack());
    let failAudit = true;
    const throwingAudit: AuditLogStore = {
      append(entry) {
        if (failAudit) throw new Error('audit disk full');
        return stack.audit.append(entry);
      },
      get: (id) => stack.audit.get(id),
      list: () => stack.audit.list(),
      listByEventId: (id) => stack.audit.listByEventId(id),
      listByActionId: (id) => stack.audit.listByActionId(id),
      query: (filter) => stack.audit.query(filter),
      count: (filter) => stack.audit.count(filter),
    };

    const leads = new InMemoryStateStore<LeadState>((s) => s.lead_id);
    const contacts = new InMemoryStateStore<ContactState>((s) => s.contact_id);
    const deals = new InMemoryStateStore<DealState>((s) => s.deal_id);
    const workflows = new InMemoryWorkflowStateStore();
    const engine = new WorkflowEngine({
      event_store: stack.eventStore,
      audit_log: throwingAudit,
      exception_queue: stack.exceptions,
      lead_store: leads,
      contact_store: contacts,
      deal_store: deals,
      workflow_store: workflows,
      executor: stack.executor,
      decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
      policy: new RuleBasedPolicyEvaluator(),
      contact_defaults: () => ({
        contact_id: 'contact_1',
        full_name: 'Zhang San',
        email: 'buyer@acme.example',
        organization_id: 'org_acme',
        contact_preference: 'auto_allowed' as const,
        contactability: 'reachable' as const,
        is_new_contact: false,
        updated_at: '2026-09-24T10:00:00+08:00',
      }),
    });

    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    const result = await engine.handleEvent(leadAssignedEvent());

    expect(result.status).toBe('failed');
    expect(stack.eventStore.getByIdempotencyKey('lead.assigned:lead_1:user_7:1')?.processing_status).toBe('pending');
    expect(stack.exceptions.listOpen().some((e) => e.reason === 'processing_error')).toBe(true);

    failAudit = false;
    const retry = await engine.handleEvent(leadAssignedEvent());

    expect(retry.status).toBe('processed');
    expect(stack.eventStore.getByIdempotencyKey('lead.assigned:lead_1:user_7:1')?.processing_status).toBe('processed');
  });
});

describe('Concurrent Processing', () => {
  it('two requests + same idempotency_key：最多一次业务效果', async () => {
    const stack = track(createStack());
    let executes = 0;
    const counting = new InMemoryExecutor({
      execute: async () => {
        executes += 1;
      },
    });
    const leads = new InMemoryStateStore<LeadState>((s) => s.lead_id);
    const contacts = new InMemoryStateStore<ContactState>((s) => s.contact_id);
    const deals = new InMemoryStateStore<DealState>((s) => s.deal_id);
    const workflows = new InMemoryWorkflowStateStore();
    const engine = new WorkflowEngine({
      event_store: stack.eventStore,
      audit_log: stack.audit,
      exception_queue: stack.exceptions,
      lead_store: leads,
      contact_store: contacts,
      deal_store: deals,
      workflow_store: workflows,
      executor: counting,
      decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
      policy: new RuleBasedPolicyEvaluator(),
      contact_defaults: () => ({
        contact_id: 'contact_1',
        full_name: 'Zhang San',
        email: 'buyer@acme.example',
        organization_id: 'org_acme',
        contact_preference: 'auto_allowed' as const,
        contactability: 'reachable' as const,
        is_new_contact: false,
        updated_at: '2026-09-24T10:00:00+08:00',
      }),
    });

    const [a, b] = await Promise.all([
      engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } })),
      engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } })),
    ]);

    expect(workflows.list()).toHaveLength(1);
    expect(stack.eventStore.list()).toHaveLength(1);
    expect(a.status).toBe('processed');
    expect(b.status).toBe('processed');
    expect('workflow' in a && 'workflow' in b && a.workflow).toBe('workflow' in b ? b.workflow : null);

    await Promise.all([
      engine.handleEvent(leadAssignedEvent()),
      engine.handleEvent(leadAssignedEvent()),
    ]);

    expect(executes).toBe(1);
    expect(stack.eventStore.list()).toHaveLength(2);
  });

  it('two workers + same workflow：状态不被错误覆盖', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'events.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const sharedStore = new SqliteEventStore({ path: dbPath });
    cleanups.push(() => sharedStore.close());

    const workerA = createStackWithSharedStore(sharedStore);
    const workerB = createStackWithSharedStore(sharedStore);
    cleanups.push(workerA.close, workerB.close);

    await workerA.engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    const second = await workerB.engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));

    expect(second.status).toBe('duplicate');
    expect(sharedStore.list()).toHaveLength(1);
    expect(workerA.workflows.list()).toHaveLength(1);

    await workerA.engine.handleEvent(leadAssignedEvent());
    const assignOnB = await workerB.engine.handleEvent(leadAssignedEvent());

    expect(assignOnB.status).toBe('duplicate');
    expect(sharedStore.list()).toHaveLength(2);
    expect(workerB.workflows.list()).toHaveLength(0);
    expect(workerA.workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
  });

  it('concurrent retry：同一 Action 不会产生重复业务效果', async () => {
    const stack = track(createStack());
    let executes = 0;
    const flaky = new InMemoryExecutor({
      execute: async () => {
        executes += 1;
        if (executes === 1) throw Object.assign(new Error('boom'), { classification: 'transient' as const });
      },
    });
    const leads = new InMemoryStateStore<LeadState>((s) => s.lead_id);
    const contacts = new InMemoryStateStore<ContactState>((s) => s.contact_id);
    const deals = new InMemoryStateStore<DealState>((s) => s.deal_id);
    const workflows = new InMemoryWorkflowStateStore();
    const engine = new WorkflowEngine({
      event_store: stack.eventStore,
      audit_log: stack.audit,
      exception_queue: stack.exceptions,
      lead_store: leads,
      contact_store: contacts,
      deal_store: deals,
      workflow_store: workflows,
      executor: flaky,
      decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
      policy: new RuleBasedPolicyEvaluator(),
      contact_defaults: () => ({
        contact_id: 'contact_1',
        full_name: 'Zhang San',
        email: 'buyer@acme.example',
        organization_id: 'org_acme',
        contact_preference: 'auto_allowed' as const,
        contactability: 'reachable' as const,
        is_new_contact: false,
        updated_at: '2026-09-24T10:00:00+08:00',
      }),
    });

    await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await engine.handleEvent(leadAssignedEvent());
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('failed');

    const outcomes = await Promise.allSettled([
      engine.retry('wf_lead_follow_up_lead_1'),
      engine.retry('wf_lead_follow_up_lead_1'),
    ]);

    // 同一 workflow 的并发 retry 合并为一次执行，两个调用方共享同一结果。
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    expect(executes).toBe(2);
    expect(workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
  });
});

describe('Event Anomalies', () => {
  it('duplicate event：第二次投递不产生第二次业务效果', async () => {
    const stack = track(createStack());
    await stack.engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await stack.engine.handleEvent(leadAssignedEvent());

    const dup = await stack.engine.handleEvent(leadAssignedEvent());

    expect(dup.status).toBe('duplicate');
    expect(stack.executor.attempts()).toHaveLength(1);
    expect(stack.workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
  });

  it('conflicting event：同 key 不同事实进异常队列且不覆盖', async () => {
    const stack = track(createStack());
    await stack.engine.handleEvent(leadCreatedEvent());

    const conflict = await stack.engine.handleEvent(
      leadCreatedEvent({ event_id: 'evt_other', payload: { ...leadCreatedEvent().payload, company_name: 'Evil' } }),
    );

    expect(conflict.status).toBe('conflict');
    expect(stack.exceptions.listOpen().some((e) => e.reason === 'idempotency_conflict')).toBe(true);
    expect(stack.leads.get('lead_1')?.company_name).toBe('Acme');
    expect(stack.eventStore.list()).toHaveLength(1);
  });

  it('late event：waiting_result 时不匹配的结果事件不推进流程', async () => {
    const stack = track(createStack());
    await stack.engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await stack.engine.handleEvent(leadAssignedEvent());

    const late = emailRepliedEvent({
      payload: { ...emailRepliedEvent().payload, lead_id: 'lead_unknown' },
    });
    const result = await stack.engine.handleEvent(late);

    expect(result.status).toBe('unmatched');
    expect(stack.exceptions.listOpen().some((e) => e.reason === 'unmatched_event')).toBe(true);
    expect(stack.workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
  });

  it('out-of-order event：结果事件先于动作派发到达时拒绝推进并进异常队列', async () => {
    const stack = track(createStack());
    await stack.engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));

    const early = emailSentEvent();
    const result = await stack.engine.handleEvent(early);

    expect(result.status).toBe('failed');
    expect(stack.exceptions.listOpen().some((e) => e.reason === 'invalid_transition')).toBe(true);
    expect(stack.workflows.get('wf_lead_follow_up_lead_1')?.status).toBe('failed');
    expect(stack.eventStore.getByIdempotencyKey(early.idempotency_key)?.processing_status).toBe('pending');
  });

  it('pending 事件重启后 recover 与直接 handle 行为一致', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'events.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const store = new SqliteEventStore({ path: dbPath });
    store.append(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    store.close();

    const stack = track(createStack({ eventStore: new SqliteEventStore({ path: dbPath }) }));
    await stack.engine.recoverFromEventLog();

    expect(stack.workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({ status: 'running' });
    expect(stack.eventStore.getByIdempotencyKey('lead.created:crm:rec_1001')?.processing_status).toBe('processed');

    const again = await stack.engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    expect(again.status).toBe('duplicate');
    expect(stack.workflows.list()).toHaveLength(1);
  });
});
