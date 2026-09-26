import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { DealFlowConfig } from '../config/config';
import { parseEvent } from '../events/dictionary';
import type { StructuredLogger } from '../observability/logger';
import type { RuntimeMetrics } from '../observability/metrics';
import type { HandleEventResult, WorkflowEngine } from '../workflow/engine';
import { bearerTokenMatches } from './auth';
import type { ControlPlaneHandler } from './control-plane';
import { SIGNATURE_HEADER, signatureFingerprint, TIMESTAMP_HEADER, verifySignature } from './hmac';
import { FixedWindowRateLimiter, type RateLimiter } from './rate-limit';
import { ReplayGuard } from './replay-guard';
import { errorMessage, readBody, sendJson } from './respond';

export interface WebhookServerOptions {
  readonly engine: WorkflowEngine;
  readonly config: DealFlowConfig;
  readonly metrics?: RuntimeMetrics;
  /** 结构化访问日志；不提供则不记录。 */
  readonly logger?: StructuredLogger;
  /** 控制面处理器（人工审核/控制操作/查询）；不提供则不暴露控制面路由。 */
  readonly control_plane?: ControlPlaneHandler;
  /** 当前时间（epoch 毫秒），用于签名窗口、重放与限流；显式传入以保证可测试。 */
  readonly now?: () => number;
  readonly rate_limiter?: RateLimiter;
  readonly replay_guard?: ReplayGuard;
  /** 在途请求计数；生命周期管理者用它决定何时可以安全关闭数据库。 */
  readonly in_flight?: InFlightTracker;
}

/** 无框架的 node:http 请求处理器，便于单元测试与嵌入任意 HTTP 服务。 */
export type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * 在途请求计数器：`enter` 在请求开始、`exit` 在处理器完全结束（含所有后续写入）时触发。
 * 优雅关闭靠它判断「现在关数据库是否安全」——连接被强制断开并不等于处理器已经跑完。
 */
export interface InFlightTracker {
  enter(): void;
  exit(): void;
}

/**
 * HTTP/Webhook 入口：
 * - `GET /healthz`：存活探针
 * - `GET /metrics`：运行时观测快照（未启用观测时 404）
 * - `POST <config.webhook.path>`：接收事件
 *
 * 生产安全链路（按顺序）：限流 → Bearer Token → 读取报文（含大小上限）→ HMAC 签名与时间戳窗口
 * → 重放保护 → 事件校验 → 交给引擎。全部为进程内实现，不依赖外部基础设施。
 */
export function createWebhookHandler(options: WebhookServerOptions): WebhookHandler {
  const { engine, config } = options;
  const metrics = config.observability.enabled ? options.metrics : undefined;
  const now = options.now ?? (() => Date.now());
  const limiter = resolveRateLimiter(options, config, now);
  const replayGuard = options.replay_guard ?? new ReplayGuard(config.webhook.signature_tolerance_seconds * 1_000, now);

  return async (req, res) => {
    const startedAt = now();
    const client = resolveClientKey(req, config);
    let url: URL | null = null;
    let path = req.url ?? '/';
    let outcome = 'not_found';
    let eventId: string | null = null;
    let workflowId: string | null = null;
    let rateLimitRemaining: number | null = null;

    try {
      url = new URL(req.url ?? '/', 'http://localhost');
      path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') {
        outcome = 'healthz';
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (req.method === 'GET' && path === '/metrics') {
        if (metrics === undefined) {
          outcome = 'metrics_disabled';
          sendJson(res, 404, { error: 'metrics disabled' });
          return;
        }
        outcome = 'metrics';
        sendJson(res, 200, metrics.snapshot());
        return;
      }

      // 控制面路由由独立处理器判定；未命中时返回 false，继续走 Webhook 判定。
      // 把解析出的来源 key 一并传入：控制面有独立限流桶，也必须能区分真实客户端地址。
      if (options.control_plane !== undefined) {
        const handledByControlPlane = await options.control_plane(req, res, url, client);
        if (handledByControlPlane) {
          outcome = 'control_plane';
          return;
        }
      }

      if (req.method === 'POST' && path === config.webhook.path) {
        const handled = await handleEventPost(req, res, client);
        outcome = handled.outcome;
        eventId = handled.eventId;
        workflowId = handled.workflowId;
        rateLimitRemaining = handled.rateLimitRemaining;
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (url === null) {
        // 非法请求行（例如 `GET ////`）会让 new URL 抛 ERR_INVALID_URL。
        // 这属于客户端错误：既不能按 5xx 处理（会触发误告警），也不能跳过访问日志
        // （否则畸形请求在观测里完全不可见）。
        outcome = 'invalid_target';
        metrics?.recordEvent('invalid');
        sendJson(res, 400, { error: 'invalid request target' });
        return;
      }
      throw error;
    } finally {
      options.logger?.log('info', 'http.access', {
        method: req.method ?? 'UNKNOWN',
        path,
        status: res.statusCode,
        outcome,
        duration_ms: now() - startedAt,
        client,
        event_id: eventId,
        workflow_id: workflowId,
        rate_limit_remaining: rateLimitRemaining,
      });
    }
  };

  async function handleEventPost(
    req: IncomingMessage,
    res: ServerResponse,
    client: string,
  ): Promise<{ outcome: string; eventId: string | null; workflowId: string | null; rateLimitRemaining: number | null }> {
    const limitHeaders = (remaining: number | null): Record<string, string> =>
      remaining === null ? {} : { 'x-ratelimit-remaining': String(remaining) };
    let rateLimitRemaining: number | null = null;

    if (limiter !== null) {
      const decision = limiter.check(client);
      if (!decision.allowed) {
        metrics?.recordEvent('rate_limited');
        sendJson(res, 429, { error: 'rate limit exceeded' }, {
          'retry-after': String(decision.retry_after_seconds),
          'x-ratelimit-remaining': '0',
        });
        return { outcome: 'rate_limited', eventId: null, workflowId: null, rateLimitRemaining: 0 };
      }
      rateLimitRemaining = decision.remaining;
    }

    if (config.webhook.bearer_token !== null) {
      if (!bearerTokenMatches(req.headers.authorization, config.webhook.bearer_token)) {
        metrics?.recordEvent('invalid');
        sendJson(res, 401, { error: 'unauthorized' }, limitHeaders(rateLimitRemaining));
        return { outcome: 'unauthorized', eventId: null, workflowId: null, rateLimitRemaining };
      }
    }

    const body = await readBody(req, config.webhook.max_body_bytes);
    if (body === null) {
      metrics?.recordEvent('invalid');
      sendJson(res, 413, { error: 'payload too large' }, limitHeaders(rateLimitRemaining));
      return { outcome: 'payload_too_large', eventId: null, workflowId: null, rateLimitRemaining };
    }

    if (config.webhook.hmac_secret !== null) {
      const timestampHeader = firstHeader(req.headers[TIMESTAMP_HEADER]);
      const signatureHeader = firstHeader(req.headers[SIGNATURE_HEADER]);
      const verification = verifySignature({
        secret: config.webhook.hmac_secret,
        timestamp: timestampHeader,
        signature: signatureHeader,
        body,
        now_ms: now(),
        tolerance_seconds: config.webhook.signature_tolerance_seconds,
      });

      if (!verification.ok) {
        metrics?.recordEvent('invalid');
        sendJson(res, 401, { error: `invalid signature: ${verification.reason}` }, limitHeaders(rateLimitRemaining));
        return { outcome: `signature_${verification.reason}`, eventId: null, workflowId: null, rateLimitRemaining };
      }

      if (signatureHeader !== null && !replayGuard.accept(signatureFingerprint(signatureHeader))) {
        metrics?.recordEvent('replayed');
        sendJson(res, 409, { error: 'replayed signature' }, limitHeaders(rateLimitRemaining));
        return { outcome: 'replayed', eventId: null, workflowId: null, rateLimitRemaining };
      }
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      metrics?.recordEvent('invalid');
      sendJson(res, 400, { error: 'invalid JSON' }, limitHeaders(rateLimitRemaining));
      return { outcome: 'invalid_json', eventId: null, workflowId: null, rateLimitRemaining };
    }

    let event;
    try {
      event = parseEvent(raw);
    } catch (error) {
      metrics?.recordEvent('invalid');
      sendJson(res, 400, { error: errorMessage(error) }, limitHeaders(rateLimitRemaining));
      return { outcome: 'invalid_event', eventId: null, workflowId: null, rateLimitRemaining };
    }

    const result = await engine.handleEvent(event);
    metrics?.recordEvent(result.status);
    sendJson(
      res,
      result.status === 'conflict' ? 409 : 200,
      serializeResult(result),
      limitHeaders(rateLimitRemaining),
    );
    return {
      outcome: result.status,
      eventId: event.event_id,
      workflowId: result.status === 'conflict' ? null : result.workflow?.workflow_instance_id ?? null,
      rateLimitRemaining,
    };
  }
}

export function createWebhookServer(options: WebhookServerOptions): Server {
  const handler = createWebhookHandler(options);
  const tracker = options.in_flight;
  return createServer((req, res) => {
    tracker?.enter();
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      tracker?.exit();
    };
    handler(req, res)
      .catch((error) => {
        // 未捕获异常是服务端故障：回通用文案，原因只进日志——
        // 直接回传 error.message 会把内部实现（表名、连接串、堆栈语句）暴露给调用方。
        options.logger?.log('error', 'http.unhandled', { error: errorMessage(error) });
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal error' });
        } else {
          res.end();
        }
      })
      .then(settle, settle);
  });
}

function resolveRateLimiter(
  options: WebhookServerOptions,
  config: DealFlowConfig,
  now: () => number,
): RateLimiter | null {
  if (options.rate_limiter !== undefined) {
    return options.rate_limiter;
  }
  const limit = config.webhook.rate_limit_per_minute;
  return limit === null ? null : new FixedWindowRateLimiter({ limit_per_window: limit, window_ms: 60_000, now });
}

function resolveClientKey(req: IncomingMessage, config: DealFlowConfig): string {
  const socketKey = req.socket.remoteAddress ?? 'unknown';

  /**
   * 部署在反向代理之后时，`socket.remoteAddress` 永远是代理自己的地址——
   * 所有访客共享同一个限流桶，一个活跃来源就能把整站打成 429。
   * 但 `X-Forwarded-For` 在直连场景下可被客户端随意伪造（伪造地址即可绕过限流），
   * 所以只有显式 `trust_proxy_headers` 才读它，且只取最后一跳之前的第一段。
   */
  if (!config.webhook.trust_proxy_headers) {
    return socketKey;
  }
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return socketKey;
  const first = raw.split(',')[0]?.trim();
  return first === undefined || first.length === 0 ? socketKey : first;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function serializeResult(result: HandleEventResult): {
  /** Backward-compatible alias for event_status. */
  status: HandleEventResult['status'];
  event_status: HandleEventResult['status'];
  workflow_id: string | null;
  workflow_status: string | null;
} {
  return {
    status: result.status,
    event_status: result.status,
    workflow_id: result.status === 'conflict' ? null : result.workflow?.workflow_instance_id ?? null,
    workflow_status: result.status === 'conflict' ? null : result.workflow?.status ?? null,
  };
}
