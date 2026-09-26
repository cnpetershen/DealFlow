import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

import { loadConfig } from '../config/config';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuntimeMetrics } from '../observability/metrics';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import {
  InMemoryAuditLog,
  InMemoryEventStore,
  InMemoryExceptionQueue,
  InMemoryStateStore,
  InMemoryWorkflowStateStore,
} from '../stores/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import { contactState, leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import { createWebhookServer } from './webhook';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

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
    executor,
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => contactState(),
  });
  return { engine, workflows, audit, exceptions };
}

async function startServer(options: { bearerToken?: string | null } = {}) {
  const stack = buildStack();
  const config = loadConfig({
    webhook: { bearer_token: options.bearerToken ?? null },
  });
  const metrics = new RuntimeMetrics({
    workflow_store: stack.workflows,
    exception_queue: stack.exceptions,
    audit_log: stack.audit,
  });
  const server = createWebhookServer({ engine: stack.engine, config, metrics });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { ...stack, metrics, config, baseUrl: `http://127.0.0.1:${port}` };
}

async function post(baseUrl: string, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('Webhook 入口', () => {
  it('healthz 存活探针返回 ok', async () => {
    const { baseUrl } = await startServer();

    const res = await fetch(`${baseUrl}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('接收事件并返回 processed，第二次重复投递返回 duplicate', async () => {
    const { baseUrl, workflows } = await startServer();

    const first = await post(baseUrl, '/webhooks/dealflow', leadCreatedEvent());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'processed' });

    const second = await post(baseUrl, '/webhooks/dealflow', leadCreatedEvent());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'duplicate', workflow_id: 'wf_lead_follow_up_lead_1' });

    expect(workflows.list()).toHaveLength(1);
  });

  it('幂等冲突返回 409', async () => {
    const { baseUrl } = await startServer();

    await post(baseUrl, '/webhooks/dealflow', leadCreatedEvent());
    const conflict = await post(baseUrl, '/webhooks/dealflow', leadCreatedEvent({
      payload: { ...leadCreatedEvent().payload, company_name: '另一家公司' },
    }));

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ status: 'conflict' });
  });

  it('非法 JSON 返回 400，非法事件同样返回 400', async () => {
    const { baseUrl } = await startServer();

    const badJson = await post(baseUrl, '/webhooks/dealflow', '{ not json');
    expect(badJson.status).toBe(400);

    const badEvent = await post(baseUrl, '/webhooks/dealflow', { type: 'lead.created' });
    expect(badEvent.status).toBe(400);
  });

  it('配置 bearer_token 时未授权返回 401', async () => {
    const { baseUrl } = await startServer({ bearerToken: 'secret-token' });

    const unauthorized = await post(baseUrl, '/webhooks/dealflow', leadCreatedEvent());
    expect(unauthorized.status).toBe(401);

    const authorized = await post(baseUrl, '/webhooks/dealflow', leadCreatedEvent(), 'secret-token');
    expect(authorized.status).toBe(200);
  });

  it('metrics 端点返回运行时观测快照', async () => {
    const { baseUrl, metrics } = await startServer();

    await post(baseUrl, '/webhooks/dealflow', leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await post(baseUrl, '/webhooks/dealflow', leadAssignedEvent());

    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);

    const snapshot = (await res.json()) as {
      counters: Record<string, number>;
      workflows_by_status: Record<string, number>;
    };
    expect(snapshot.counters['events.total']).toBe(2);
    expect(snapshot.workflows_by_status).toEqual({ waiting_result: 1 });
    expect(metrics.get('events.processed')).toBe(2);
  });

  it('未知路径返回 404', async () => {
    const { baseUrl } = await startServer();

    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
