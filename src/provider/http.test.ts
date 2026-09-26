import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACTION_TYPES, type ProposedAction } from '../decision/types';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import { allowsSimpleRetry, classifyExecutionError } from '../executor/interfaces';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import {
  InMemoryAuditLog,
  InMemoryEventStore,
  InMemoryExceptionQueue,
  InMemoryStateStore,
  InMemoryWorkflowStateStore,
} from '../stores/in-memory';
import type { ContactState, DealState, LeadState } from '../stores/types';
import { contactState, leadAssignedEvent, leadCreatedEvent, proposedAction } from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import { providerAdapterContractCases } from './contract';
import { ProviderAdapterExecutor } from './executor';
import { HttpProviderAdapter } from './http';

type FakeMode = 'ok' | 'hang' | 'reset' | 'server_error' | 'client_error' | 'rate_limited' | 'missing_reference';

interface FakeProvider {
  readonly url: string;
  nextNamespace: (mode?: FakeMode) => string;
  setMode: (namespace: string, mode: FakeMode) => void;
  creates: (namespace: string) => readonly string[];
  close: () => Promise<void>;
}

/**
 * 真实 HTTP 假提供商：按 `Idempotency-Key` 去重并返回 provider_reference，
 * 可切换超时（hang）、连接重置、5xx、4xx、限流等模式来驱动适配器分类。
 */
async function startFakeProvider(): Promise<FakeProvider> {
  const receipts = new Map<string, Map<string, { provider_reference: string; correlation_id: string }>>();
  const modes = new Map<string, FakeMode>();
  const created = new Map<string, string[]>();
  const sockets = new Set<Socket>();
  let namespaceSeq = 0;
  let receiptSeq = 0;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end('{}');
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    const namespace = segments[0] ?? '';
    const mode = modes.get(namespace) ?? 'ok';
    const key = (req.headers['idempotency-key'] as string | undefined) ?? '';

    if (mode === 'hang') {
      // 不响应：由适配器侧超时。
      return;
    }
    if (mode === 'reset') {
      req.socket.destroy();
      return;
    }
    if (mode === 'server_error') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (mode === 'client_error') {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (mode === 'rate_limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' }).end('{}');
      return;
    }
    if (mode === 'missing_reference') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }

    await readBody(req);
    const bucket = receipts.get(namespace) ?? new Map<string, { provider_reference: string; correlation_id: string }>();
    receipts.set(namespace, bucket);

    if (req.method === 'GET') {
      const target = decodeURIComponent(segments[2] ?? '');
      const existing = bucket.get(target);
      if (existing === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(existing));
      return;
    }

    const existing = bucket.get(key);
    if (existing !== undefined) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...existing, duplicate: true }));
      return;
    }

    receiptSeq += 1;
    const receipt = { provider_reference: `${namespace}:ref-${receiptSeq}`, correlation_id: `corr-${receiptSeq}` };
    bucket.set(key, receipt);
    created.set(namespace, [...(created.get(namespace) ?? []), key]);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(receipt));
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    nextNamespace: (mode: FakeMode = 'ok') => {
      namespaceSeq += 1;
      const namespace = `ns${namespaceSeq}`;
      modes.set(namespace, mode);
      return namespace;
    },
    setMode: (namespace, mode) => {
      modes.set(namespace, mode);
    },
    creates: (namespace) => created.get(namespace) ?? [],
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider();
});

afterAll(async () => {
  await fake.close();
});

function adapterFor(namespace: string, timeoutMs = 2_000): HttpProviderAdapter {
  return new HttpProviderAdapter({
    provider: 'fake-provider',
    base_url: `${fake.url}/${namespace}`,
    action_types: [...ACTION_TYPES],
    timeout_ms: timeoutMs,
  });
}

describe('HttpProviderAdapter 契约', () => {
  for (const contractCase of providerAdapterContractCases(() => adapterFor(fake.nextNamespace()))) {
    it(contractCase.name, async () => {
      expect(await contractCase.observe()).toMatchObject(contractCase.expected);
    });
  }
});

describe('HttpProviderAdapter 真实 HTTP 行为', () => {
  it('提交成功后返回 accepted，携带 provider_reference 与 correlation_id', async () => {
    const adapter = adapterFor(fake.nextNamespace());

    const outcome = await adapter.submit(proposedAction());

    expect(outcome.status).toBe('accepted');
    if (outcome.status === 'accepted') {
      expect(outcome.receipt.provider_reference).toMatch(/^ns\d+:ref-\d+$/);
      expect(outcome.receipt.correlation_id).toMatch(/^corr-\d+$/);
    }
  });

  it('按 execution_idempotency_key 去重，重复提交只产生一次提供商侧效果', async () => {
    const namespace = fake.nextNamespace();
    fake.setMode(namespace, 'ok');
    const adapter = adapterFor(namespace);
    const action = proposedAction();

    const first = await adapter.submit(action);
    const second = await adapter.submit(action);

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    expect(fake.creates(namespace)).toEqual([action.execution_idempotency_key]);
    if (first.status === 'accepted' && second.status === 'duplicate') {
      expect(second.receipt.provider_reference).toBe(first.receipt.provider_reference);
    }
  });

  it('reconcile 依据提供商侧记录判断是否已提交', async () => {
    const adapter = adapterFor(fake.nextNamespace());
    const action = proposedAction();

    expect(await adapter.reconcile(action)).toEqual({ submitted: false, provider_reference: null });

    const accepted = await adapter.submit(action);
    const reconciliation = await adapter.reconcile(action);

    expect(reconciliation.submitted).toBe(true);
    if (accepted.status === 'accepted') {
      expect(reconciliation.provider_reference).toBe(accepted.receipt.provider_reference);
    }
  });

  it('提供商有记录但无法给出回执标识时，reconcile 返回 unknown 而不是猜测未提交', async () => {
    const namespace = fake.nextNamespace();
    const adapter = adapterFor(namespace);
    const action = proposedAction();

    await adapter.submit(action);
    // 切换为「200 但没有回执标识」：提供商侧有这条记录，但无法确认效果
    fake.setMode(namespace, 'missing_reference');

    const reconciliation = await adapter.reconcile(action);

    expect(reconciliation).toEqual({ submitted: 'unknown', provider_reference: null });
  });
});

describe('HttpProviderAdapter 失败分类与不可盲目重试', () => {
  it('超时：transient + submitted=unknown，禁止简单 retry', async () => {
    const adapter = adapterFor(fake.nextNamespace('hang'), 40);

    const error = await adapter.submit(proposedAction()).catch((caught: unknown) => caught);
    const classified = classifyExecutionError(error);

    expect(classified).toMatchObject({
      classification: 'transient',
      submitted: 'unknown',
      code: 'TIMEOUT',
      provider: 'fake-provider',
    });
    expect(allowsSimpleRetry(classified)).toBe(false);
  });

  it('传输中断（连接重置）：submitted=unknown，禁止简单 retry', async () => {
    const adapter = adapterFor(fake.nextNamespace('reset'), 2_000);

    const error = await adapter.submit(proposedAction()).catch((caught: unknown) => caught);
    const classified = classifyExecutionError(error);

    expect(classified).toMatchObject({ classification: 'transient', submitted: 'unknown' });
    expect(allowsSimpleRetry(classified)).toBe(false);
  });

  it('5xx：transient + submitted=unknown，需先对账', async () => {
    const adapter = adapterFor(fake.nextNamespace('server_error'));

    const error = await adapter.submit(proposedAction()).catch((caught: unknown) => caught);
    const classified = classifyExecutionError(error);

    expect(classified).toMatchObject({
      classification: 'transient',
      submitted: 'unknown',
      code: 'HTTP_500',
    });
    expect(allowsSimpleRetry(classified)).toBe(false);
  });

  it('429：transient + submitted=false，带 retry_after，允许重试', async () => {
    const adapter = new HttpProviderAdapter({
      provider: 'fake-provider',
      base_url: `${fake.url}/${fake.nextNamespace('rate_limited')}`,
      action_types: [...ACTION_TYPES],
      now: () => '2026-09-24T10:00:00.000Z',
    });

    const error = await adapter.submit(proposedAction()).catch((caught: unknown) => caught);
    const classified = classifyExecutionError(error);

    expect(classified).toMatchObject({
      classification: 'transient',
      submitted: false,
      code: 'HTTP_429',
      retry_after: '2026-09-24T10:00:30.000Z',
    });
    expect(allowsSimpleRetry(classified)).toBe(true);
  });

  it('4xx：permanent + submitted=false，禁止重试', async () => {
    const adapter = adapterFor(fake.nextNamespace('client_error'));

    const error = await adapter.submit(proposedAction()).catch((caught: unknown) => caught);
    const classified = classifyExecutionError(error);

    expect(classified).toMatchObject({
      classification: 'permanent',
      submitted: false,
      code: 'HTTP_400',
    });
    expect(allowsSimpleRetry(classified)).toBe(false);
  });

  it('连接被拒绝：确定未提交，允许安全重试', async () => {
    const probe = await startFakeProvider();
    const port = new URL(probe.url).port;
    await probe.close();

    const adapter = new HttpProviderAdapter({
      provider: 'fake-provider',
      base_url: `http://127.0.0.1:${port}`,
      action_types: [...ACTION_TYPES],
      timeout_ms: 1_000,
    });

    const error = await adapter.submit(proposedAction()).catch((caught: unknown) => caught);
    const classified = classifyExecutionError(error);

    expect(classified).toMatchObject({ classification: 'transient', submitted: false });
    expect(allowsSimpleRetry(classified)).toBe(true);
  });

  it('2xx 但缺少 provider_reference：永久失败且标记已提交', async () => {
    const adapter = adapterFor(fake.nextNamespace('missing_reference'));

    const error = await adapter.submit(proposedAction()).catch((caught: unknown) => caught);
    const classified = classifyExecutionError(error);

    expect(classified).toMatchObject({
      classification: 'permanent',
      submitted: true,
      code: 'MISSING_PROVIDER_REFERENCE',
    });
  });
});

describe('真实 Provider 与引擎集成', () => {
  function createEngine(executor: ProviderAdapterExecutor) {
    const leads = new InMemoryStateStore<LeadState>((state) => state.lead_id);
    const contacts = new InMemoryStateStore<ContactState>((state) => state.contact_id);
    const deals = new InMemoryStateStore<DealState>((state) => state.deal_id);
    const workflows = new InMemoryWorkflowStateStore();
    const engine = new WorkflowEngine({
      event_store: new InMemoryEventStore(),
      audit_log: new InMemoryAuditLog(),
      exception_queue: new InMemoryExceptionQueue(),
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

  async function driveToDispatch(engine: WorkflowEngine): Promise<void> {
    await engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await engine.handleEvent(leadAssignedEvent());
  }

  it('提供商超时后 Workflow 进入 failed 且 submitted=unknown，retry 被拒绝', async () => {
    const executor = new ProviderAdapterExecutor([adapterFor(fake.nextNamespace('hang'), 40)]);
    const { engine, workflows } = createEngine(executor);

    await driveToDispatch(engine);

    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: 'unknown',
    });
    await expect(engine.retry('wf_lead_follow_up_lead_1')).rejects.toThrow('提交状态未知');
  });

  it('提供商返回 5xx 后同样禁止盲目重试，必须先对账', async () => {
    const executor = new ProviderAdapterExecutor([adapterFor(fake.nextNamespace('server_error'))]);
    const { engine, workflows } = createEngine(executor);

    await driveToDispatch(engine);

    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'failed',
      failure_submitted: 'unknown',
    });
    await expect(engine.retry('wf_lead_follow_up_lead_1')).rejects.toThrow('提交状态未知');
  });

  it('成功提交后 Workflow 等待结果事件，重复事件不产生第二次提供商效果', async () => {
    const namespace = fake.nextNamespace('ok');
    const executor = new ProviderAdapterExecutor([adapterFor(namespace)]);
    const { engine, workflows } = createEngine(executor);

    await driveToDispatch(engine);

    expect(workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });
    expect(fake.creates(namespace)).toHaveLength(1);

    // 重复投递同一事件：幂等去重，不再次调用提供商。
    await engine.handleEvent(leadAssignedEvent());
    expect(fake.creates(namespace)).toHaveLength(1);
  });
});

describe('HttpProviderAdapter 与 Executor 端口', () => {
  it('execute 映射 submit 结果为 accepted/duplicate', async () => {
    const action: ProposedAction = proposedAction();
    const executor = new ProviderAdapterExecutor([adapterFor(fake.nextNamespace('ok'))]);

    const first = await executor.execute(action);
    const second = await executor.execute(action);

    expect(first).toMatchObject({ status: 'accepted', action_id: action.action_id });
    expect(second).toMatchObject({ status: 'duplicate', execution_idempotency_key: action.execution_idempotency_key });
  });
});
