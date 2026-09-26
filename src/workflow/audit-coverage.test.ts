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
  dealCreatedEvent,
  dealStageChangedEvent,
  emailSentEvent,
  leadAssignedEvent,
  leadCreatedEvent,
} from '../testing/fixtures';
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
  return { engine, audit, exceptions };
}

describe('WorkflowEngine Audit 覆盖（事件接收 / 冲突 / 异常写入）', () => {
  it('接收并处理事件时写入 event_processed 审计（含 lead.created 与 lead.assigned）', async () => {
    const { engine, audit } = createEngine();

    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await engine.handleEvent(leadAssignedEvent());

    expect(
      audit.listByEventId('evt_0001').some((e) => e.action === 'event_processed' && e.result === 'succeeded'),
    ).toBe(true);
    expect(
      audit.listByEventId('evt_0002').some((e) => e.action === 'event_processed' && e.result === 'succeeded'),
    ).toBe(true);
  });

  it('重复投递已处理事件时写入 event_processed(skipped) 审计', async () => {
    const { engine, audit } = createEngine();

    await engine.handleEvent(leadCreatedEvent());
    await engine.handleEvent(leadCreatedEvent());

    const duplicate = audit
      .listByEventId('evt_0001')
      .filter((e) => e.action === 'event_processed' && e.reason === 'duplicate');
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.result).toBe('skipped');
  });

  it('幂等冲突写入 event_conflicted 与 exception_enqueued 审计', async () => {
    const { engine, audit, exceptions } = createEngine();

    await engine.handleEvent(leadCreatedEvent());
    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, company_name: '另一家公司' } }),
    );

    expect(audit.list().some((e) => e.action === 'event_conflicted')).toBe(true);
    expect(
      audit.list().some((e) => e.action === 'exception_enqueued' && e.reason === 'idempotency_conflict'),
    ).toBe(true);
    expect(exceptions.listOpen()[0]?.reason).toBe('idempotency_conflict');
  });

  it('未匹配事件写入 exception_enqueued 审计且进异常队列', async () => {
    const { engine, audit, exceptions } = createEngine();

    await engine.handleEvent(emailSentEvent());

    expect(exceptions.listOpen()[0]?.reason).toBe('unmatched_event');
    expect(
      audit.list().some((e) => e.action === 'exception_enqueued' && e.reason === 'unmatched_event'),
    ).toBe(true);
  });

  it('冲突事实（stale_event）写入 exception_enqueued 审计', async () => {
    const { engine, audit, exceptions } = createEngine();

    await engine.handleEvent(leadCreatedEvent());
    await engine.handleEvent(dealCreatedEvent());
    await engine.handleEvent(
      dealStageChangedEvent({
        payload: { ...dealStageChangedEvent().payload, from_stage: 'discovery', to_stage: 'proposal' },
      }),
    );

    expect(exceptions.listOpen().some((e) => e.reason === 'stale_event')).toBe(true);
    expect(
      audit.list().some((e) => e.action === 'exception_enqueued' && e.reason === 'stale_event'),
    ).toBe(true);
  });
});
