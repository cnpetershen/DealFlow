import { afterEach, describe, expect, it } from 'vitest';
import { request, type Server } from 'node:http';

import { loadConfig } from '../config/config';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { JsonLogger } from '../observability/logger';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import {
  InMemoryAuditLog,
  InMemoryEventStore,
  InMemoryExceptionQueue,
  InMemoryStateStore,
  InMemoryWorkflowStateStore,
} from '../stores/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import { contactState, emailRepliedEvent, emailSentEvent, leadAssignedEvent, leadCreatedEvent, meetingScheduledEvent } from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import { createWebhookServer } from './webhook';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function buildEngine(executor = new InMemoryExecutor()) {
  const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
  const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
  const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
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
  return { engine, workflows };
}

async function start(executor = new InMemoryExecutor()) {
  const stack = buildEngine(executor);
  const server = createWebhookServer({ engine: stack.engine, config: loadConfig() });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { ...stack, url: `http://127.0.0.1:${port}/webhooks/dealflow` };
}

async function post(url: string, event: unknown): Promise<{ http: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  return { http: response.status, body: await response.json() as Record<string, unknown> };
}

describe('Webhook response status contract', () => {
  it('keeps HTTP 200 and separates processed event status from failed workflow status', async () => {
    const executor = new InMemoryExecutor();
    executor.failNext(Object.assign(new Error('provider unavailable'), {
      classification: 'transient' as const,
      submitted: false as const,
    }));
    const { url } = await start(executor);

    await post(url, leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' },
    }));
    const result = await post(url, leadAssignedEvent());

    expect(result.http).toBe(200);
    expect(result.body).toMatchObject({
      status: 'processed',
      event_status: 'processed',
      workflow_id: 'wf_lead_follow_up_lead_1',
      workflow_status: 'failed',
    });
  });

  it('returns duplicate as the event status and preserves the workflow status', async () => {
    const { url } = await start();
    await post(url, leadCreatedEvent());

    const result = await post(url, leadCreatedEvent());

    expect(result.http).toBe(200);
    expect(result.body).toMatchObject({
      status: 'duplicate',
      event_status: 'duplicate',
      workflow_id: 'wf_lead_follow_up_lead_1',
      workflow_status: 'running',
    });
  });

  it('returns unmatched with no workflow status when no workflow can claim the event', async () => {
    const { url } = await start();

    const result = await post(url, emailSentEvent({
      payload: { ...emailSentEvent().payload, lead_id: 'lead_unknown' },
    }));

    expect(result.http).toBe(200);
    expect(result.body).toMatchObject({
      status: 'unmatched',
      event_status: 'unmatched',
      workflow_id: null,
      workflow_status: null,
    });
  });

  it('returns processed when an event arrives while the workflow awaits human approval', async () => {
    const { url } = await start();
    await post(url, leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' },
    }));
    await post(url, leadAssignedEvent());
    await post(url, emailSentEvent());
    await post(url, emailRepliedEvent());

    const result = await post(url, meetingScheduledEvent({
      event_id: 'evt_late_receipt',
      idempotency_key: 'meeting.scheduled:mtg_late',
      payload: { ...meetingScheduledEvent().payload, meeting_id: 'mtg_late' },
    }));

    expect(result.http).toBe(200);
    expect(result.body).toMatchObject({
      status: 'processed',
      event_status: 'processed',
      workflow_id: 'wf_lead_follow_up_lead_1',
      workflow_status: 'needs_review',
    });
  });

  it('returns conflict with HTTP 409 and no workflow status', async () => {
    const { url } = await start();
    await post(url, leadCreatedEvent());

    const result = await post(url, leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, company_name: 'Conflicting company' },
    }));

    expect(result.http).toBe(409);
    expect(result.body).toMatchObject({
      status: 'conflict',
      event_status: 'conflict',
      workflow_id: null,
      workflow_status: null,
    });
  });
});

describe('Malformed request target', () => {
  it('returns 400 with an access log instead of a silent 5xx', async () => {
    const lines: string[] = [];
    const stack = buildEngine();
    const server = createWebhookServer({
      engine: stack.engine,
      config: loadConfig(),
      logger: new JsonLogger({ sink: (line) => lines.push(line) }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    // `////` 让 new URL(req.url, base) 抛 ERR_INVALID_URL；它必须被当成客户端错误处理，
    // 否则畸形请求要么按 5xx 触发误告警，要么连访问日志都不留。
    const result = await rawRequest(port, '////');

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid request target' });

    const access = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(access).toContainEqual(
      expect.objectContaining({ message: 'http.access', outcome: 'invalid_target', status: 400 }),
    );
  });
});

function rawRequest(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // 保留原始文本
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
