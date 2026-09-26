import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type DealFlowConfig } from '../config/config';
import type { Executor } from '../executor/interfaces';
import { JsonLogger } from '../observability/logger';
import { isClaimableEventStore } from '../stores/interfaces';
import {
  contactRecordedEvent,
  emailRepliedEvent,
  emailSentEvent,
  leadAssignedEvent,
  leadCreatedEvent,
  meetingScheduledEvent,
} from '../testing/fixtures';
import { createApplication, type Application } from './bootstrap';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-bootstrap-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'dealflow.db');
}

function createTestApp(
  options: {
    dbPath: string;
    token?: string | null;
    controlToken?: string | null;
    executor?: Executor;
    recoveryRetryMs?: number;
    shutdown?: Partial<DealFlowConfig['shutdown']>;
  } = { dbPath: tempDbPath() },
) {
  const lines: string[] = [];
  const logger = new JsonLogger({
    sink: (line) => lines.push(line),
    now: () => '2026-09-24T10:00:00+08:00',
  });
  const config = loadConfig({
    server: { host: '127.0.0.1', port: 0 },
    database: { path: options.dbPath },
    shutdown: { grace_ms: 2_000, ...options.shutdown },
    webhook: { bearer_token: options.token ?? null },
    control_plane: { bearer_token: options.controlToken ?? null },
  });
  const app = createApplication({
    config,
    logger,
    now: () => '2026-09-24T10:00:00+08:00',
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.recoveryRetryMs === undefined ? {} : { recovery_retry_ms: options.recoveryRetryMs }),
  });
  cleanups.push(() => app.shutdown('test-cleanup'));

  return { app, lines, config };
}

async function startAndGetBaseUrl(app: Application): Promise<string> {
  const address = await app.start();
  if (address === null) {
    throw new Error('未能获取监听地址');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function postEvent(baseUrl: string, event: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/webhooks/dealflow`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(event),
  });
}

describe('Application bootstrap', () => {
  it('启动后 healthz 与 metrics 可用，shutdown 后停止监听并关闭数据库', async () => {
    const { app } = createTestApp();
    const baseUrl = await startAndGetBaseUrl(app);

    expect(app.started).toBe(true);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);

    await app.shutdown('test');

    expect(app.started).toBe(false);
    expect(app.sqlite.db.isOpen).toBe(false);
    await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
  });

  it('未启动时 shutdown 安全；重复 shutdown 只执行一次', async () => {
    const notStarted = createTestApp();
    await notStarted.app.shutdown('before-start');
    await notStarted.app.shutdown('again');
    expect(notStarted.app.started).toBe(false);

    const { app, lines } = createTestApp();
    await startAndGetBaseUrl(app);
    await Promise.all([app.shutdown('a'), app.shutdown('b')]);

    expect(lines.filter((line) => line.includes('dealflow.shutdown.complete'))).toHaveLength(1);
  });

  it('重复 start 抛错', async () => {
    const { app } = createTestApp();
    await startAndGetBaseUrl(app);

    await expect(app.start()).rejects.toThrow('Application 已启动');
  });

  it('事件经 HTTP 落库；重启后仍可读，重复投递返回 duplicate', async () => {
    const dbPath = tempDbPath();

    const first = createTestApp({ dbPath });
    const firstBaseUrl = await startAndGetBaseUrl(first.app);
    const created = await postEvent(firstBaseUrl, leadCreatedEvent());
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ status: 'processed' });
    await first.app.shutdown('restart');

    const second = createTestApp({ dbPath });
    const secondBaseUrl = await startAndGetBaseUrl(second.app);
    const duplicate = await postEvent(secondBaseUrl, leadCreatedEvent());

    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ status: 'duplicate' });
    expect(second.app.metrics.snapshot().workflows_by_status).toEqual({ running: 1 });
  });

  it('端到端：lead.created → lead.assigned 走完 Store/Engine/HTTP 全链路', async () => {
    const { app, lines } = createTestApp();
    const baseUrl = await startAndGetBaseUrl(app);

    expect((await postEvent(baseUrl, leadCreatedEvent())).status).toBe(200);
    const assigned = await postEvent(baseUrl, leadAssignedEvent());
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({ status: 'processed' });

    const metrics = (await (await fetch(`${baseUrl}/metrics`)).json()) as {
      counters: Record<string, number>;
      workflows_by_status: Record<string, number>;
    };
    expect(metrics.counters['events.processed']).toBe(2);
    // bootstrap 的默认联系人是「新联系人 + 仅人工联系且无邮箱」，Decider 不会编造参数；
    // 没有可执行动作时 Workflow 不再直接结束，而是按当前 Lead 事实进入等待事件（而不是假装完成）。
    expect(metrics.workflows_by_status).toEqual({ waiting_result: 1 });
    expect(lines.some((line) => line.includes('dealflow.started'))).toBe(true);
  });

  it('配置 bearer_token 时强制鉴权', async () => {
    const { app } = createTestApp({ dbPath: tempDbPath(), token: 'secret-token' });
    const baseUrl = await startAndGetBaseUrl(app);

    expect((await postEvent(baseUrl, leadCreatedEvent())).status).toBe(401);
    expect((await postEvent(baseUrl, leadCreatedEvent(), 'secret-token')).status).toBe(200);
  });

  it('每个请求写入结构化访问日志', async () => {
    const { app, lines } = createTestApp();
    const baseUrl = await startAndGetBaseUrl(app);

    await fetch(`${baseUrl}/healthz`);

    expect(lines.some((line) => line.includes('http.access') && line.includes('"outcome":"healthz"'))).toBe(true);
  });

  it('端到端闭环：contact.recorded 打开自动外发，人工审核经控制面批准后继续', async () => {
    const { app } = createTestApp({ dbPath: tempDbPath(), controlToken: 'control-secret' });
    const baseUrl = await startAndGetBaseUrl(app);
    const workflowId = 'wf_lead_follow_up_lead_1';

    const post = (event: unknown) => postEvent(baseUrl, event);
    const control = (path: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer control-secret',
          ...(init.headers ?? {}),
        },
      });

    expect((await post(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }))).status).toBe(200);
    // 联系人事实由事件声明；没有它，Policy/Decider 永远不会编造收件人
    expect((await post(contactRecordedEvent())).status).toBe(200);
    expect((await post(leadAssignedEvent())).status).toBe(200);
    // 首次跟进邮件为 Auto：Policy 白名单内、联系人允许自动联系、参数来自 verified_config
    expect(app.engine.getWorkflow(workflowId)).toMatchObject({ status: 'waiting_result', awaiting_event_types: ['email.sent'] });

    expect((await post(emailSentEvent())).status).toBe(200);
    expect((await post(emailRepliedEvent())).status).toBe(200);
    // 安排会议需要人工审核
    expect(app.engine.getWorkflow(workflowId)?.status).toBe('needs_review');

    const listed = await (await control('/workflows')).json() as {
      items: Array<{ workflow_instance_id: string; status: string; pending_action: { action_id: string; action_type: string } | null }>;
    };
    const pending = listed.items[0]?.pending_action;
    expect(pending?.action_type).toBe('schedule_meeting');

    const approved = await control(`/workflows/${workflowId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ action_id: pending?.action_id, actor_id: 'user_7' }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['meeting.scheduled'],
    });

    // 结果事件恢复流程；Lead 已 qualified 且尚无 Deal：等待 deal.created 而不是结束流程
    expect((await post(meetingScheduledEvent())).status).toBe(200);
    expect(app.engine.getWorkflow(workflowId)).toMatchObject({
      status: 'waiting_result',
      current_step: 'await_event',
      awaiting_event_types: ['deal.created', 'proposal.sent', 'task.overdue'],
    });
  });

  it('启动恢复：重启后重投 pending 事件，已进异常队列的事件不重复重投', async () => {
    const dbPath = tempDbPath();

    const first = createTestApp({ dbPath });
    const firstBaseUrl = await startAndGetBaseUrl(first.app);
    await postEvent(firstBaseUrl, leadCreatedEvent());
    // 未分配就直接收到 email.sent：违反 Lead 迁移规则，事件保持 pending 并进入异常队列
    await postEvent(firstBaseUrl, emailSentEvent());

    expect(first.app.engine.getWorkflow('wf_lead_follow_up_lead_1')?.status).toBe('failed');
    await first.app.shutdown('restart');

    const second = createTestApp({ dbPath });
    const report = await second.app.recoverOnStart();

    expect(report.rebuilt_from_event_log).toBe(false);
    expect(report.reprocessed_pending).toBe(0);
    expect(report.skipped_blocked).toBe(1);
  });

  it('shutdown 之后再 start 会拒绝，不会出现「已就绪但库已关闭」', async () => {
    const { app } = createTestApp();
    await startAndGetBaseUrl(app);
    await app.shutdown('test');

    await expect(app.start()).rejects.toThrow('关闭流程');
  });

  it('关库前等待在途请求跑完：派发后的状态写入不会落在已关闭的连接上', async () => {
    const dbPath = tempDbPath();
    let executorFinished = false;
    const executor: Executor = {
      async execute(action) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        executorFinished = true;
        return {
          status: 'accepted',
          action_id: action.action_id,
          execution_idempotency_key: `exec_${action.action_id}`,
          provider: 'in_memory',
          provider_reference: null,
          correlation_id: null,
        };
      },
    };
    // 宽限期 50ms < 处理耗时 300ms：连接会被强制断开，但处理器仍要跑完并写状态
    const { app } = createTestApp({
      dbPath,
      executor,
      shutdown: { grace_ms: 50, abort_grace_ms: 5_000 },
    });
    const baseUrl = await startAndGetBaseUrl(app);

    await postEvent(baseUrl, leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
    await postEvent(baseUrl, contactRecordedEvent());

    const inFlight = postEvent(baseUrl, leadAssignedEvent());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const shutdown = app.shutdown('test');
    await inFlight.then(
      () => undefined,
      () => undefined,
    );
    await shutdown;

    expect(executorFinished).toBe(true);
    expect(app.started).toBe(false);
    expect(app.in_flight).toBe(0);

    // 重开同一个库：派发后的审计与状态必须已经落盘，而不是被「database is not open」吞掉
    const reopened = createTestApp({ dbPath });
    expect(reopened.app.audit.list().some((entry) => entry.action === 'action_dispatched')).toBe(true);
    expect(reopened.app.engine.getWorkflow('wf_lead_follow_up_lead_1')?.status).toBe('waiting_result');
  });

  it('孤儿租约不阻塞启动恢复，延迟重投在租约过期后接手', async () => {
    const dbPath = tempDbPath();

    const first = createTestApp({ dbPath });
    const firstBaseUrl = await startAndGetBaseUrl(first.app);
    expect((await postEvent(firstBaseUrl, leadCreatedEvent())).status).toBe(200);

    // 上一次进程在处理途中被杀：事件仍是 pending，处理租约还被它占着
    const orphan = contactRecordedEvent();
    first.app.events.append(orphan);
    const claimable = isClaimableEventStore(first.app.events) ? first.app.events : null;
    expect(claimable).not.toBeNull();
    expect(claimable?.tryClaim(orphan.idempotency_key, 'orphan-worker', Date.now(), 800)).toBe(true);
    await first.app.shutdown('crash');

    const second = createTestApp({ dbPath, recoveryRetryMs: 700 });
    // 抢不到租约就让位，而不是把启动拖死或直接失败
    const report = await second.app.recoverOnStart();

    expect(report.reprocessed_pending).toBe(0);
    expect(report.failed).toEqual([]);
    expect(second.app.events.getByIdempotencyKey(orphan.idempotency_key)?.processing_status).toBe('pending');
    // 租约仍在：另一个 worker 此刻同样抢不到
    const secondClaimable = isClaimableEventStore(second.app.events) ? second.app.events : null;
    expect(secondClaimable?.tryClaim(orphan.idempotency_key, 'other-worker', Date.now(), 1_000)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(second.app.events.getByIdempotencyKey(orphan.idempotency_key)?.processing_status).toBe('processed');
  });

  it('observability.log_level 真正作用到默认 logger，info 级别可被关掉', async () => {
    const config = loadConfig({
      server: { host: '127.0.0.1', port: 0 },
      database: { path: tempDbPath() },
      observability: { log_level: 'warn' },
    });

    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });

    try {
      const app = createApplication({ config });
      cleanups.push(() => app.shutdown('test-cleanup'));
      const baseUrl = await startAndGetBaseUrl(app);
      await fetch(`${baseUrl}/healthz`);
      await app.shutdown('test');
    } finally {
      spy.mockRestore();
    }

    expect(written.some((line) => line.includes('dealflow.started'))).toBe(false);
    expect(written.some((line) => line.includes('dealflow.shutdown'))).toBe(false);
    // 每请求一条的访问日志用 log_level 就能关掉，这是它唯一的降噪开关
    expect(written.some((line) => line.includes('http.access'))).toBe(false);
  });
});
