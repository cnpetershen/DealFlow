import { describe, expect, it } from 'vitest';

import { emailRepliedEvent, emailSentEvent, leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { InMemoryExecutor } from '../executor/in-memory';
import {
  InMemoryAuditLog,
  InMemoryEventStore,
  InMemoryExceptionQueue,
  InMemoryStateStore,
  InMemoryWorkflowStateStore,
} from '../stores/in-memory';
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
    contact_defaults: () => ({
      contact_id: 'contact_1',
      full_name: 'Zhang San',
      email: 'buyer@acme.example',
      organization_id: 'org_acme',
      contact_preference: 'auto_allowed',
      contactability: 'reachable',
      is_new_contact: false,
      updated_at: '2026-09-24T10:00:00+08:00',
    }),
  });
  return { engine, audit, executor };
}

describe('Workflow result provider reference contract', () => {
  it('writes provider_reference from a matched result event into audit', async () => {
    const { engine, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' },
    }));
    await engine.handleEvent(leadAssignedEvent());

    const result = emailSentEvent({
      payload: { ...emailSentEvent().payload, provider_reference: 'mailgun:message-123' },
    });
    await engine.handleEvent(result);

    expect(audit.listByEventId(result.event_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: result.event_id,
          provider_reference: 'mailgun:message-123',
        }),
      ]),
    );
  });

  it('preserves provider_reference through a later reply audit chain', async () => {
    const { engine, audit } = createEngine();
    await engine.handleEvent(leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' },
    }));
    await engine.handleEvent(leadAssignedEvent());

    const sent = emailSentEvent({
      payload: { ...emailSentEvent().payload, provider_reference: 'sendgrid:message-456' },
    });
    await engine.handleEvent(sent);
    const reply = emailRepliedEvent({
      payload: { ...emailRepliedEvent().payload, provider_reference: 'sendgrid:event-789' },
    });
    await engine.handleEvent(reply);

    expect(audit.listByEventId(reply.event_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: reply.event_id,
          provider_reference: 'sendgrid:event-789',
        }),
      ]),
    );
  });
});
