import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

import type { DealFlowConfig } from '../config/config';
import { loadConfigFromEnv, policyContextFromConfig } from '../config/config';
import { RuleBasedDecider } from '../decision/rule-based-decider';
import type { Executor } from '../executor/interfaces';
import type { ParsedEvent } from '../events/dictionary';
import { createControlPlaneHandler } from '../http/control-plane';
import { FixedWindowRateLimiter } from '../http/rate-limit';
import { createWebhookServer, type InFlightTracker } from '../http/webhook';
import { JsonLogger, type StructuredLogger } from '../observability/logger';
import { RuntimeMetrics } from '../observability/metrics';
import { countAutoActionsToday } from '../policy/auto-actions-today';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import { RetryScheduler } from '../runtime/retry-scheduler';
import { ACTION_TYPES } from '../decision/types';
import { ProviderAdapterExecutor } from '../provider/executor';
import { HttpProviderAdapter } from '../provider/http';
import { InMemoryProviderAdapter } from '../provider/in-memory';
import type { ProviderAdapter } from '../provider/types';
import type { AuditLogStore, EventStore, ExceptionQueueStore } from '../stores/interfaces';
import { SqliteEventStore } from '../stores/sqlite';
import { openSqlite, type SqliteDatabase } from '../stores/sqlite-db';
import { SqliteUnitOfWork } from '../stores/sqlite-unit-of-work';
import {
  SqliteAuditLog,
  SqliteExceptionQueue,
  SqliteMemoryStore,
  SqlitePendingActionStore,
  SqliteStateStore,
  SqliteWorkflowStateStore,
} from '../stores/sqlite-stores';
import type { ContactState, DealState, LeadState } from '../stores/types';
import { isClaimTimeoutError, RECOVERY_CLAIM_WAIT_MS, WorkflowEngine } from '../workflow/engine';

/**
 * 孤儿租约的延迟重投节奏：处理租约 30s（见 WorkflowEngine），5s 重试一次、最多 8 次，
 * 保证崩溃重启后既不阻塞启动，也一定能等到租约过期。
 */
const DEFERRED_RETRY_MS = 5_000;
const DEFERRED_MAX_ATTEMPTS = 8;

export interface CreateApplicationOptions {
  readonly config?: DealFlowConfig;
  readonly logger?: StructuredLogger;
  /** 注入 Provider Adapter；默认使用内存适配器，便于本地开发与单进程冒烟。 */
  readonly adapters?: readonly ProviderAdapter[];
  /** 直接注入 Executor（优先级高于 adapters）。 */
  readonly executor?: Executor;
  readonly now?: () => string;
  /** 孤儿租约的延迟重投间隔（毫秒）；默认 5_000。测试注入以避免真实等待。 */
  readonly recovery_retry_ms?: number;
}

export interface ApplicationDependencies {
  readonly config: DealFlowConfig;
  readonly logger: StructuredLogger;
  readonly sqlite: SqliteDatabase;
  readonly engine: WorkflowEngine;
  readonly metrics: RuntimeMetrics;
  readonly events: EventStore;
  readonly exceptions: ExceptionQueueStore;
  readonly audit_log: AuditLogStore;
  readonly server: Server;
  /** 失败实例自动重试调度器；未启用时为 null。 */
  readonly retry_scheduler?: RetryScheduler | null;
  /** 在途请求计数；缺省时使用内部实例（不接 HTTP 入口的场景）。 */
  readonly in_flight?: InFlightCounter;
  /** 孤儿租约的延迟重投间隔（毫秒）；缺省 5_000。 */
  readonly recovery_retry_ms?: number;
}

/**
 * 在途请求计数器：处理器完全结束才递减。
 * 优雅关闭用它保证「先让在途写入落地，再关数据库」。
 */
export class InFlightCounter implements InFlightTracker {
  #count = 0;
  readonly #waiters: Array<() => void> = [];

  enter(): void {
    this.#count += 1;
  }

  exit(): void {
    this.#count = Math.max(0, this.#count - 1);
    if (this.#count === 0) {
      for (const waiter of this.#waiters.splice(0)) waiter();
    }
  }

  get count(): number {
    return this.#count;
  }

  /** 等待归零，超时返回（关闭流程必须有上界）。 */
  waitUntilIdle(timeoutMs: number): Promise<void> {
    if (this.#count === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve();
      }, timeoutMs);
      timer.unref();
      this.#waiters.push(waiter);
    });
  }
}

/** 启动恢复结果，用于日志与运维核对。 */
export interface RecoveryReport {
  readonly rebuilt_from_event_log: boolean;
  readonly replayed_events: number;
  readonly reprocessed_pending: number;
  readonly skipped_blocked: number;
  readonly failed: readonly string[];
}

/**
 * 应用生命周期：持有 SQLite 连接、Store、Engine 与 HTTP Server，
 * 提供幂等的 start / shutdown，保证退出时先停止接收新请求再关闭数据库。
 */
export class Application {
  readonly #config: DealFlowConfig;
  readonly #logger: StructuredLogger;
  readonly #sqlite: SqliteDatabase;
  readonly #engine: WorkflowEngine;
  readonly #metrics: RuntimeMetrics;
  readonly #events: EventStore;
  readonly #exceptions: ExceptionQueueStore;
  readonly #audit: AuditLogStore;
  readonly #retryScheduler: RetryScheduler | null;
  readonly #server: Server;
  readonly #inFlight: InFlightCounter;
  #started = false;
  #shutdown: Promise<void> | null = null;
  /** 进行中的启动恢复；关库前必须等它结束，否则恢复中的写入会打在已关闭的连接上。 */
  #recovery: Promise<RecoveryReport> | null = null;
  /** 孤儿租约的延迟重投定时器；关闭时取消，避免在已关闭的库上继续写。 */
  #deferredTimer: NodeJS.Timeout | null = null;
  readonly #deferredRetryMs: number;
  /** 当前正在执行的延迟重投；关库前先等它结束。 */
  #deferredWork: Promise<void> | null = null;

  constructor(dependencies: ApplicationDependencies) {
    this.#config = dependencies.config;
    this.#logger = dependencies.logger;
    this.#sqlite = dependencies.sqlite;
    this.#engine = dependencies.engine;
    this.#metrics = dependencies.metrics;
    this.#events = dependencies.events;
    this.#exceptions = dependencies.exceptions;
    this.#audit = dependencies.audit_log;
    this.#retryScheduler = dependencies.retry_scheduler ?? null;
    this.#server = dependencies.server;
    this.#inFlight = dependencies.in_flight ?? new InFlightCounter();
    this.#deferredRetryMs = dependencies.recovery_retry_ms ?? DEFERRED_RETRY_MS;
  }

  /** 在途请求数；0 表示此刻没有 handler 可能再写数据库。 */
  get in_flight(): number {
    return this.#inFlight.count;
  }

  get config(): DealFlowConfig {
    return this.#config;
  }

  get engine(): WorkflowEngine {
    return this.#engine;
  }

  get metrics(): RuntimeMetrics {
    return this.#metrics;
  }

  get sqlite(): SqliteDatabase {
    return this.#sqlite;
  }

  get server(): Server {
    return this.#server;
  }

  /** 事件日志；测试与运维用来核对 pending / 租约状态。 */
  get events(): EventStore {
    return this.#events;
  }

  /** 追加式审计日志；测试与运维用来核对动作是否真的落了盘。 */
  get audit(): AuditLogStore {
    return this.#audit;
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * 启动恢复：让「Workflow Resume」在重启后真正发生。
   *
   * 1. State Store 为空而事件日志非空（例如从备份只恢复了事件）：按 sequence 重放全部事件重建 State，
   *    重放期间不调用外部 Executor，避免重复外部副作用；
   * 2. 否则只处理仍为 `pending` 的事件（上次处理中途崩溃），重试复用同一 idempotency_key；
   * 3. 已经有未处理异常的事件不再自动重投，交给人工处理，避免每次启动都刷一条异常。
   */
  async recoverOnStart(): Promise<RecoveryReport> {
    if (this.#shutdown !== null) {
      throw new Error('Application 已进入关闭流程，无法执行启动恢复');
    }
    const run = this.#doRecoverOnStart();
    this.#recovery = run;
    try {
      return await run;
    } finally {
      if (this.#recovery === run) {
        this.#recovery = null;
      }
    }
  }

  async #doRecoverOnStart(): Promise<RecoveryReport> {
    const entries = this.#events.list();
    const empty: RecoveryReport = {
      rebuilt_from_event_log: false,
      replayed_events: 0,
      reprocessed_pending: 0,
      skipped_blocked: 0,
      failed: [],
    };

    if (entries.length === 0) {
      return empty;
    }

    if (this.#engine.listWorkflows().length === 0) {
      const results = await this.#engine.recoverFromEventLog({ claim_wait_ms: RECOVERY_CLAIM_WAIT_MS });
      const failed = results
        .filter((result) => result.status === 'failed')
        .map((result) => (result.status === 'failed' ? result.workflow?.workflow_instance_id ?? 'unknown' : ''));

      this.#logger.log('info', 'dealflow.recovery.replayed', {
        events: results.length,
        failed: failed.length,
      });

      const report = { ...empty, rebuilt_from_event_log: true, replayed_events: results.length, failed };
      this.#scheduleDeferredRecovery();
      return report;
    }

    const blocked = new Set(this.#exceptions.listOpen().map((record) => record.event_id));
    const pending = entries.filter((entry) => entry.processing_status === 'pending');
    const reprocessable = pending.filter((entry) => !blocked.has(entry.event.event_id));
    const failed: string[] = [];
    let processed = 0;

    for (const entry of reprocessable) {
      try {
        const result = await this.#engine.handleEvent(entry.event, { claim_wait_ms: RECOVERY_CLAIM_WAIT_MS });
        if (result.status === 'failed') {
          failed.push(entry.event.event_id);
        } else {
          processed += 1;
        }
      } catch (error) {
        // 孤儿租约：不算失败，交给延迟重投在租约过期后接手，启动不因此中断。
        if (isClaimTimeoutError(error)) {
          continue;
        }
        throw error;
      }
    }

    if (pending.length > 0) {
      this.#logger.log('info', 'dealflow.recovery.pending', {
        pending: pending.length,
        reprocessed: processed,
        skipped_blocked: pending.length - reprocessable.length,
        failed: failed.length,
      });
    }

    const report: RecoveryReport = {
      ...empty,
      reprocessed_pending: processed,
      skipped_blocked: pending.length - reprocessable.length,
      failed,
    };
    this.#scheduleDeferredRecovery();
    return report;
  }

  /**
   * 上一次进程在处理途中被杀会留下未过期的孤儿租约，此时事件仍是 `pending`。
   * 启动不等待租约过期（那会让崩溃重启卡住 30 秒甚至直接失败），改为后台按固定节奏重投，
   * 租约一过期就接手；进程关闭时取消未触发的重投。
   */
  #scheduleDeferredRecovery(): void {
    const candidates = this.#pendingUnblockedEvents();
    if (candidates.length === 0) {
      return;
    }
    this.#logger.log('warn', 'dealflow.recovery.deferred', {
      events: candidates.length,
      retry_ms: this.#deferredRetryMs,
      max_attempts: DEFERRED_MAX_ATTEMPTS,
    });
    this.#deferredWork = this.#deferredRetry(candidates, 1);
  }

  #pendingUnblockedEvents(): ParsedEvent[] {
    const blocked = new Set(this.#exceptions.listOpen().map((record) => record.event_id));
    return this.#events
      .list()
      .filter((entry) => entry.processing_status === 'pending' && !blocked.has(entry.event.event_id))
      .map((entry) => entry.event);
  }

  async #deferredRetry(pending: readonly ParsedEvent[], attempt: number): Promise<void> {
    const remaining: ParsedEvent[] = [];

    for (const event of pending) {
      if (this.#shutdown !== null) {
        return;
      }
      const stored = this.#events.getByIdempotencyKey(event.idempotency_key);
      if (stored === undefined || stored.processing_status === 'processed') {
        continue;
      }
      if (this.#exceptions.listOpen().some((record) => record.event_id === event.event_id)) {
        continue;
      }
      try {
        await this.#engine.handleEvent(event, { claim_wait_ms: RECOVERY_CLAIM_WAIT_MS });
      } catch (error) {
        if (isClaimTimeoutError(error)) {
          remaining.push(event);
          continue;
        }
        this.#logger.log('error', 'dealflow.recovery.deferred.failed', {
          event_id: event.event_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (remaining.length === 0) {
      this.#logger.log('info', 'dealflow.recovery.deferred.settled', { attempt, reprocessed: pending.length });
      return;
    }
    if (attempt >= DEFERRED_MAX_ATTEMPTS) {
      this.#logger.log('warn', 'dealflow.recovery.deferred.give_up', {
        events: remaining.length,
        attempts: attempt,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (this.#deferredTimer === timer) {
        this.#deferredTimer = null;
      }
      if (this.#shutdown === null) {
        this.#deferredWork = this.#deferredRetry(remaining, attempt + 1);
      }
    }, this.#deferredRetryMs);
    timer.unref();
    this.#deferredTimer = timer;
  }

  async start(): Promise<AddressInfo | null> {
    if (this.#shutdown !== null) {
      throw new Error('Application 已进入关闭流程，无法启动');
    }
    if (this.#started) {
      throw new Error('Application 已启动');
    }

    const { host, port } = this.#config.server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(port, host);
    });

    // listen() 期间可能收到关闭信号：此时数据库或许已关闭，绝不能对外宣称就绪。
    if (this.#shutdown !== null) {
      throw new Error('启动期间收到关闭信号，已放弃启动');
    }

    this.#started = true;
    const address = this.#server.address();
    // 恢复已完成后再启动自动重试，避免与启动恢复争用同一批实例。
    this.#retryScheduler?.start();
    this.#logger.log('info', 'dealflow.started', {
      host,
      port: typeof address === 'object' && address !== null ? address.port : port,
      workflow_type: this.#config.workflow_type,
      webhook_path: this.#config.webhook.path,
      database_path: this.#config.database.path,
      retry_scheduler: this.#retryScheduler !== null,
    });

    return typeof address === 'object' ? address : null;
  }

  /** 幂等：重复调用共享同一次关闭。未启动时调用也是安全的。 */
  async shutdown(reason = 'manual'): Promise<void> {
    this.#shutdown ??= this.#doShutdown(reason);
    return this.#shutdown;
  }

  async #doShutdown(reason: string): Promise<void> {
    this.#logger.log('info', 'dealflow.shutdown.begin', { reason });
    const graceMs = this.#config.shutdown.grace_ms;

    // 先停止后台重试，再停 HTTP、最后关库，保证不会在关库后触发新的写入。
    this.#retryScheduler?.stop();
    if (this.#deferredTimer !== null) {
      clearTimeout(this.#deferredTimer);
      this.#deferredTimer = null;
    }

    await closeServer(this.#server, graceMs);
    this.#started = false;

    // 关库前的收尾等待（共用 abort_grace_ms 一个预算，不是各自一份）：
    // 1. 启动恢复可能仍在跑（信号在 recoverOnStart 期间到达）；
    // 2. 延迟重投可能正在把孤儿事件重新入队；
    // 3. 连接被强制断开不等于处理器跑完了——它可能正等外部调用返回并即将写审计/释放租约。
    // 这些写入如果落在已关闭的连接上，会变成 500 和永久卡住的租约。
    const abortDeadline = Date.now() + this.#config.shutdown.abort_grace_ms;
    const budget = (): number => Math.max(0, abortDeadline - Date.now());
    await waitFor(this.#recovery, budget());
    await waitFor(this.#deferredWork, budget());
    await this.#inFlight.waitUntilIdle(budget());

    this.#sqlite.close();

    this.#logger.log('info', 'dealflow.shutdown.complete', { reason });
  }
}

/** 等待 promise 结束，超时后放弃等待继续关闭（关闭流程必须有上界）。 */
async function waitFor(work: Promise<unknown> | null, timeoutMs: number): Promise<void> {
  if (work === null) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  await Promise.race([work.then(() => undefined, () => undefined), timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

/**
 * 停止接收新连接，等待在途请求结束后关闭；超过宽限期则强制关闭剩余连接，
 * 避免 keep-alive 或长请求让进程无法退出。
 */
async function closeServer(server: Server, graceMs: number): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, graceMs);
    timer.unref();

    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    // close() 只停止接收新连接；空闲的 keep-alive 连接立即释放，缩短退出时间。
    server.closeIdleConnections();
  });
}

/** 组装配置、SQLite、Store、Provider、Engine、观测与 HTTP Server。 */
export function createApplication(options: CreateApplicationOptions = {}): Application {
  const config = options.config ?? loadConfigFromEnv();
  const logger = options.logger ?? new JsonLogger({ level: config.observability.log_level });
  const now = options.now ?? (() => new Date().toISOString());

  ensureDatabaseDirectory(config.database.path);
  const sqlite = openSqlite({ path: config.database.path, timeoutMs: config.database.timeout_ms });

  const events = new SqliteEventStore({ sqlite });
  const audit = new SqliteAuditLog({ sqlite });
  const exceptions = new SqliteExceptionQueue({ sqlite });
  const workflows = new SqliteWorkflowStateStore({ sqlite });
  const memory = new SqliteMemoryStore({ sqlite });
  const pendingActions = new SqlitePendingActionStore({ sqlite });
  const leads = new SqliteStateStore<LeadState>('lead', (state) => state.lead_id, { sqlite });
  const contacts = new SqliteStateStore<ContactState>('contact', (state) => state.contact_id, { sqlite });
  const deals = new SqliteStateStore<DealState>('deal', (state) => state.deal_id, { sqlite });

  const executor = options.executor ?? buildExecutor(config, options.adapters);

  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    memory_store: memory,
    pending_action_store: pendingActions,
    executor,
    // 所有 SQLite Store 共享同一连接，因此一次处理的写入可由单一事务覆盖。
    unit_of_work: new SqliteUnitOfWork(sqlite),
    decider: new RuleBasedDecider(),
    policy: new RuleBasedPolicyEvaluator(),
    workflow_type: config.workflow_type,
    now,
    policy_context: (workflow, evaluatedAt) => {
      const lead = leads.get(workflow.subject_id) ?? null;
      return policyContextFromConfig(config, {
        evaluated_at: evaluatedAt,
        // 当日已执行的自动动作数从只追加审计推导（COUNT + 索引），否则 max_auto_actions_per_day 永远不会生效。
        auto_actions_today: countAutoActionsToday({
          audit_log: audit,
          now: evaluatedAt,
          business_timezone_offset_minutes: config.policy.business_timezone_offset_minutes,
        }),
        permitted_actor_ids: lead?.owner_id ? [lead.owner_id] : [],
      });
    },
    // 未知联系人按最保守方式登记：新联系人 + 仅人工联系，避免自动外发到未经确认的对象。
    // 真实的邮箱与联系偏好必须由 `contact.recorded` 事件声明，而不是由引擎猜测。
    contact_defaults: (contactId) => ({
      contact_id: contactId,
      full_name: null,
      email: null,
      organization_id: null,
      contact_preference: 'human_only',
      contactability: 'reachable',
      is_new_contact: true,
      updated_at: now(),
    }),
  });

  const metrics = new RuntimeMetrics({
    workflow_store: workflows,
    exception_queue: exceptions,
    audit_log: audit,
  });
  const retryScheduler = config.retry_scheduler.enabled
    ? new RetryScheduler({
        engine,
        workflow_store: workflows,
        logger,
        interval_ms: config.retry_scheduler.interval_ms,
        max_attempts_per_workflow: config.retry_scheduler.max_attempts_per_workflow,
        max_backoff_ms: config.retry_scheduler.max_backoff_ms,
        now: () => Date.parse(now()),
      })
    : null;
  const inFlight = new InFlightCounter();
  /**
   * 控制面独立限流桶：审批/取消/重试都是有副作用的写接口，必须有自己的配额。
   * 与 webhook 共桶会让一次 webhook 突发把审批入口一起打成 429，
   * 完全不限流则意味着拿到 token 的人可以无限次重放审批。
   */
  const controlPlaneRate = config.control_plane.rate_limit_per_minute;
  const controlPlane = createControlPlaneHandler({
    engine,
    audit_log: audit,
    exception_queue: exceptions,
    pending_action_store: pendingActions,
    lead_store: leads,
    deal_store: deals,
    config,
    metrics,
    logger,
    ...(controlPlaneRate === null ? {} : {
      rate_limiter: new FixedWindowRateLimiter({
        limit_per_window: controlPlaneRate,
        window_ms: 60_000,
        now: () => Date.parse(now()),
      }),
    }),
  });

  const server = createWebhookServer({
    engine,
    config,
    metrics,
    logger,
    in_flight: inFlight,
    control_plane: controlPlane,
  });
  server.maxConnections = config.server.max_connections;

  return new Application({
    config,
    logger,
    sqlite,
    engine,
    metrics,
    events,
    exceptions,
    audit_log: audit,
    server,
    retry_scheduler: retryScheduler,
    in_flight: inFlight,
    ...(options.recovery_retry_ms === undefined ? {} : { recovery_retry_ms: options.recovery_retry_ms }),
  });
}

/**
 * 默认执行器：把 Provider Adapter 组合成引擎的 Executor 端口。
 * 优先使用显式注入的适配器；其次按配置选择真实 HTTP 提供商；最后回退内存实现（仅本地开发）。
 */
function buildExecutor(
  config: DealFlowConfig,
  adapters: readonly ProviderAdapter[] | undefined,
): Executor {
  return new ProviderAdapterExecutor(adapters ?? [buildAdapter(config)]);
}

function buildAdapter(config: DealFlowConfig): ProviderAdapter {
  const { kind, base_url: baseUrl, timeout_ms: timeoutMs, bearer_token: token } = config.provider;

  if (kind === 'http') {
    if (baseUrl === null) {
      throw new Error('provider.kind=http 时必须配置 provider.base_url（DEALFLOW_PROVIDER_BASE_URL）');
    }
    return new HttpProviderAdapter({
      provider: 'http',
      base_url: baseUrl,
      action_types: [...ACTION_TYPES],
      timeout_ms: timeoutMs,
      ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    });
  }

  return new InMemoryProviderAdapter({ provider: 'local-dev' });
}

function ensureDatabaseDirectory(path: string): void {
  if (path === ':memory:') {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
}
