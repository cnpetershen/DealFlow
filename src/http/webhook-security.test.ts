import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

import { loadConfig } from '../config/config';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { JsonLogger } from '../observability/logger';
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
import { contactState, leadCreatedEvent } from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import { SIGNATURE_HEADER, signPayload, TIMESTAMP_HEADER } from './hmac';
import { createWebhookServer } from './webhook';

const HMAC_SECRET = 'integration-secret';
const FIXED_TIMESTAMP = '1758700000';
const FIXED_NOW_MS = Number(FIXED_TIMESTAMP) * 1_000;
const EVENT_PATH = '/webhooks/dealflow';

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
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const engine = new WorkflowEngine({
    event_store: new InMemoryEventStore(),
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    executor: new InMemoryExecutor(),
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => contactState(),
  });
  return { engine, workflows, audit, exceptions };
}

interface ServerOptions {
  readonly hmac_secret?: string | null;
  readonly bearer_token?: string | null;
  readonly rate_limit_per_minute?: number | null;
}

async function startServer(options: ServerOptions = {}) {
  const stack = buildStack();
  const lines: string[] = [];
  const logger = new JsonLogger({
    sink: (line) => lines.push(line),
    now: () => new Date(FIXED_NOW_MS).toISOString(),
  });
  const config = loadConfig({
    server: { host: '127.0.0.1', port: 0 },
    webhook: {
      hmac_secret: options.hmac_secret ?? null,
      bearer_token: options.bearer_token ?? null,
      rate_limit_per_minute: options.rate_limit_per_minute ?? null,
    },
  });
  const metrics = new RuntimeMetrics({
    workflow_store: stack.workflows,
    exception_queue: stack.exceptions,
    audit_log: stack.audit,
  });
  const server = createWebhookServer({
    engine: stack.engine,
    config,
    metrics,
    logger,
    now: () => FIXED_NOW_MS,
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { ...stack, metrics, lines, baseUrl: `http://127.0.0.1:${port}` };
}

function eventBody(): string {
  return JSON.stringify(leadCreatedEvent());
}

function signedRequest(
  baseUrl: string,
  options: { secret?: string; timestamp?: string; signature?: string; body?: string; path?: string } = {},
): Promise<Response> {
  const body = options.body ?? eventBody();
  const timestamp = options.timestamp ?? FIXED_TIMESTAMP;
  const signature = options.signature ?? signPayload(options.secret ?? HMAC_SECRET, timestamp, body);

  return fetch(`${baseUrl}${options.path ?? EVENT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
    },
    body,
  });
}

describe('Webhook HMAC 签名', () => {
  it('签名有效时接收事件', async () => {
    const { baseUrl } = await startServer({ hmac_secret: HMAC_SECRET });

    const response = await signedRequest(baseUrl);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'processed' });
  });

  it('签名错误时拒绝并返回 401', async () => {
    const { baseUrl } = await startServer({ hmac_secret: HMAC_SECRET });

    const response = await signedRequest(baseUrl, { secret: 'wrong-secret' });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('signature_mismatch') });
  });

  it('缺少签名头时拒绝', async () => {
    const { baseUrl } = await startServer({ hmac_secret: HMAC_SECRET });

    const response = await fetch(`${baseUrl}${EVENT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: eventBody(),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('missing_timestamp') });
  });

  it('报文被篡改时拒绝', async () => {
    const { baseUrl } = await startServer({ hmac_secret: HMAC_SECRET });
    const body = eventBody();

    const response = await fetch(`${baseUrl}${EVENT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signPayload(HMAC_SECRET, FIXED_TIMESTAMP, body),
        [TIMESTAMP_HEADER]: FIXED_TIMESTAMP,
      },
      body: `${body} `,
    });

    expect(response.status).toBe(401);
  });

  it('时间戳超出容忍窗口时拒绝（重放保护）', async () => {
    const { baseUrl } = await startServer({ hmac_secret: HMAC_SECRET });
    const staleTimestamp = String(Number(FIXED_TIMESTAMP) - 600);

    const response = await signedRequest(baseUrl, { timestamp: staleTimestamp });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('timestamp_out_of_tolerance'),
    });
  });

  it('同一签名重复投递被判定为重放并返回 409', async () => {
    const { baseUrl, lines } = await startServer({ hmac_secret: HMAC_SECRET });

    const first = await signedRequest(baseUrl);
    const replay = await signedRequest(baseUrl);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: 'replayed signature' });
    expect(lines.some((line) => line.includes('"outcome":"replayed"'))).toBe(true);
  });

  it('不同签名（重新签名的新报文）不会被误判为重放', async () => {
    const { baseUrl } = await startServer({ hmac_secret: HMAC_SECRET });
    const otherBody = JSON.stringify(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, lead_id: 'lead_2' }, idempotency_key: 'lead.created:crm:rec_2', event_id: 'evt_0002' }),
    );

    expect((await signedRequest(baseUrl)).status).toBe(200);
    expect((await signedRequest(baseUrl, { body: otherBody })).status).toBe(200);
  });
});

describe('Webhook Bearer Token 与 HMAC 组合', () => {
  it('两者都配置时必须同时满足', async () => {
    const { baseUrl } = await startServer({ hmac_secret: HMAC_SECRET, bearer_token: 'token-1' });

    const noToken = await signedRequest(baseUrl);
    expect(noToken.status).toBe(401);

    const body = eventBody();
    const withToken = await fetch(`${baseUrl}${EVENT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-1',
        [SIGNATURE_HEADER]: signPayload(HMAC_SECRET, FIXED_TIMESTAMP, body),
        [TIMESTAMP_HEADER]: FIXED_TIMESTAMP,
      },
      body,
    });
    expect(withToken.status).toBe(200);
  });
});

describe('Webhook 限流', () => {
  it('超过每分钟上限后返回 429 与 Retry-After', async () => {
    const { baseUrl } = await startServer({ rate_limit_per_minute: 2 });

    expect((await signedRequest(baseUrl)).status).toBe(200);
    expect((await signedRequest(baseUrl)).status).toBe(200);

    const limited = await signedRequest(baseUrl);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(await limited.json()).toMatchObject({ error: 'rate limit exceeded' });
  });

  it('未开启限流时不受影响', async () => {
    const { baseUrl } = await startServer({ rate_limit_per_minute: null });

    for (let i = 0; i < 5; i += 1) {
      expect((await signedRequest(baseUrl)).status).toBe(200);
    }
  });

  it('健康检查与观测端点不受限流影响', async () => {
    const { baseUrl } = await startServer({ rate_limit_per_minute: 1 });

    expect((await signedRequest(baseUrl)).status).toBe(200);
    expect((await signedRequest(baseUrl)).status).toBe(429);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);
  });
});

describe('结构化访问日志', () => {
  it('每个请求记录一行 JSON，包含方法、路径、状态与结果', async () => {
    const { baseUrl, lines } = await startServer({ hmac_secret: HMAC_SECRET });

    await signedRequest(baseUrl);
    await fetch(`${baseUrl}/healthz`);

    const entries = lines
      .filter((line) => line.includes('http.access'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: 'info',
      message: 'http.access',
      method: 'POST',
      path: EVENT_PATH,
      status: 200,
      outcome: 'processed',
      event_id: 'evt_0001',
      workflow_id: 'wf_lead_follow_up_lead_1',
    });
    expect(typeof entries[0]?.['duration_ms']).toBe('number');
    expect(entries[1]).toMatchObject({ method: 'GET', path: '/healthz', status: 200, outcome: 'healthz' });
  });

  it('拒绝请求同样记录结构化结果', async () => {
    const { baseUrl, lines } = await startServer({ hmac_secret: HMAC_SECRET });

    await signedRequest(baseUrl, { secret: 'wrong-secret' });

    const entry = lines
      .filter((line) => line.includes('http.access'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .at(-1);

    expect(entry).toMatchObject({ status: 401, outcome: 'signature_signature_mismatch' });
  });
});
