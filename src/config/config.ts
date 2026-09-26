import { z } from 'zod';

import type { PolicyContext } from '../decision/context';
import { ACTION_TYPES, type ActionType } from '../decision/types';

/**
 * 未识别的配置键一律报错而不是被静默丢弃：
 * 拼错键名时回退默认值，会让「关掉签名/限流」这类意图无声失效。
 */
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/**
 * 运行配置，覆盖引擎、Webhook 入口与观测能力。
 * 所有字段都可缺省，缺失时使用确定性默认值，保证「零配置」即可启动 MVP。
 */
export const dealFlowConfigSchema = z
  .object({
    workflow_type: z.string().min(1).default('lead_follow_up'),
    server: strict({
      host: z.string().min(1).default('127.0.0.1'),
      /** 0 表示由操作系统分配空闲端口（测试用）。 */
      port: z.number().int().min(0).max(65535).default(3000),
      /** 可用连接数上限；超出的连接会被拒绝，避免无限堆积。 */
      max_connections: z.number().int().positive().default(512),
    }).default({}),
    database: strict({
      path: z.string().min(1).default('data/dealflow.db'),
      /** SQLite 写锁忙等待超时（毫秒）。 */
      timeout_ms: z.number().int().positive().default(5_000),
    }).default({}),
    shutdown: strict({
      /** 优雅关闭宽限期：超时后强制关闭剩余连接。 */
      grace_ms: z.number().int().positive().default(10_000),
      /**
       * 强制断连后等待在途处理器收尾的上限（毫秒）。
       * 断开连接并不等于处理器跑完了——它可能正等外部调用返回并即将写审计/释放租约；
       * 这段时间必须在关库之前留出来，否则这些写入会打在已关闭的连接上。
       */
      abort_grace_ms: z.number().int().positive().default(5_000),
    }).default({}),
    webhook: strict({
      path: z.string().min(1).default('/webhooks/dealflow'),
      max_body_bytes: z.number().int().positive().default(1_000_000),
      /** 可选 Bearer Token；为 null 表示不校验该方式。 */
      bearer_token: z.string().min(1).nullable().default(null),
      /** 可选 HMAC-SHA256 共享密钥；为 null 表示不校验签名。 */
      hmac_secret: z.string().min(1).nullable().default(null),
      /** 签名时间戳容忍窗口（秒），用于拒绝重放。 */
      signature_tolerance_seconds: z.number().int().positive().default(300),
      /** 每个来源每分钟允许的请求数；null 表示不限流。 */
      rate_limit_per_minute: z.number().int().positive().nullable().default(600),
      /**
       * 是否信任 `X-Forwarded-For` 作为限流来源。
       *
       * 关在反向代理后面时 `socket.remoteAddress` 永远是代理自己，全部流量共用一个桶，
       * 单个活跃来源就能把整站打成 429。但该头在直连场景下可被客户端随意伪造，
       * 因此必须显式开启——只有确实处在可信代理之后才允许用它做来源。
       */
      trust_proxy_headers: z.boolean().default(false),
    }).default({}),
    observability: strict({
      enabled: z.boolean().default(true),
      /** 日志级别：低于该级别的日志被丢弃；null 表示输出全部级别。 */
      log_level: z.enum(['debug', 'info', 'warn', 'error']).nullable().default(null),
    }).default({}),
    /**
     * 控制面（人工审核、控制操作与只读查询）。
     * `bearer_token` 为 null 时回退使用 `webhook.bearer_token`；
     * 两者都为空时控制面保持关闭，避免无鉴权的审批入口被暴露。
     */
    control_plane: strict({
      enabled: z.boolean().default(true),
      bearer_token: z.string().min(1).nullable().default(null),
      /**
       * 控制面每分钟允许的请求数；null 表示不限流。
       *
       * 控制面有审批、取消、重试这类**有副作用**的写接口，必须有自己的桶——
       * 复用 webhook 的桶会让一次 webhook 突发把审批入口一起打成 429，
       * 完全不限流则意味着拿到 token 的人可以无限次重放审批。
       */
      rate_limit_per_minute: z.number().int().positive().nullable().default(120),
    }).default({}),
    /**
     * 失败实例自动重试调度器。
     * `failure_*` 字段本身就记录了「是否允许重试、何时重试」，但没有组件去读它，
     * transient 失败就会一直停在 failed 等人工介入；开启后由调度器按退避策略自动闭合。
     */
    retry_scheduler: strict({
      enabled: z.boolean().default(true),
      interval_ms: z.number().int().positive().default(30_000),
      max_attempts_per_workflow: z.number().int().positive().default(3),
      max_backoff_ms: z.number().int().positive().default(300_000),
    }).default({}),
    provider: strict({
      /** `http` 使用真实 Provider Adapter；`in-memory` 仅用于本地开发。 */
      kind: z.enum(['in-memory', 'http']).default('in-memory'),
      /** kind=http 时必填：提供商 API 根地址。 */
      base_url: z.string().url().nullable().default(null),
      timeout_ms: z.number().int().positive().default(5_000),
      bearer_token: z.string().min(1).nullable().default(null),
    }).default({}),
    policy: strict({
      policy_version: z.string().min(1).default('policy_v1'),
      automation_whitelist: z.array(z.enum(ACTION_TYPES)).default(['send_email', 'create_task'] as ActionType[]),
      permitted_action_types: z.array(z.enum(ACTION_TYPES)).default([...ACTION_TYPES]),
      business_timezone_offset_minutes: z.number().int().default(480),
      send_window: z
        .object({
          start_hour: z.number().int().min(0).max(23),
          end_hour: z.number().int().min(1).max(24),
        })
        .strict()
        .default({ start_hour: 9, end_hour: 18 }),
      max_auto_actions_per_day: z.number().int().positive().default(100),
      key_account_lead_ids: z.array(z.string()).default([]),
      high_value_deal_threshold: z.number().nonnegative().default(500_000),
    }).default({}),
  })
  .strict();

export type DealFlowConfig = z.infer<typeof dealFlowConfigSchema>;

/** 校验并补齐默认配置；非法输入抛 ZodError。 */
export function parseConfig(input: unknown): DealFlowConfig {
  return dealFlowConfigSchema.parse(input);
}

/** 读取默认配置并合并覆盖项。 */
export function loadConfig(overrides: unknown = {}): DealFlowConfig {
  return parseConfig(overrides);
}

/**
 * 部署参数的取值约定：
 * - 未设置（undefined）与空串都表示「未配置」，回退默认值。
 *   留空写在 `.env` / systemd EnvironmentFile 里是常见写法，
 *   若把 `''` 继续传给 schema，`min(1)` / `url()` 会让进程启动即崩溃。
 * - 数值、布尔必须是合法字面量，非法值直接报错并点名环境变量，
 *   绝不静默回退（`DEALFLOW_PORT=abc` 变成随机端口、`RETRY_ENABLED=0` 变成开启，
 *   都会让人以为配置生效了）。
 */
const TRUE_LITERALS = new Set(['1', 'true', 'yes', 'on', 'y', 't']);
const FALSE_LITERALS = new Set(['0', 'false', 'no', 'off', 'n', 'f']);

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = optionalText(env[name]);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigEnvError(name, raw, '数字');
  }
  return value;
}

function optionalBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = optionalText(env[name]);
  if (raw === undefined) return undefined;
  const literal = raw.toLowerCase();
  if (TRUE_LITERALS.has(literal)) return true;
  if (FALSE_LITERALS.has(literal)) return false;
  throw new ConfigEnvError(name, raw, '布尔值 (true/false/1/0/yes/no/on/off)');
}

/** 环境变量取值非法；message 面向运维，直接进启动失败日志。 */
export class ConfigEnvError extends Error {
  constructor(
    readonly variable: string,
    readonly value: string,
    readonly expected: string,
  ) {
    super(`环境变量 ${variable} 必须是${expected}，当前值: ${JSON.stringify(value)}`);
    this.name = 'ConfigEnvError';
  }
}

/** 限流上限：0 表示不限流（null），留空回退默认值 600。 */
function rateLimitFromEnv(env: NodeJS.ProcessEnv, name: string): number | null | undefined {
  const value = optionalNumber(env, name);
  if (value === undefined) return undefined;
  if (value === 0) return null;
  if (value < 0) throw new ConfigEnvError(name, String(value), '非负整数，0 表示不限流');
  return value;
}

/**
 * 从环境变量读取部署配置（DEALFLOW_*），未设置的项回退默认值。
 * 只映射部署相关字段；Policy 细则仍以代码内默认值为准，避免环境变量承载业务规则。
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DealFlowConfig {
  return parseConfig({
    workflow_type: optionalText(env.DEALFLOW_WORKFLOW_TYPE),
    server: {
      host: optionalText(env.DEALFLOW_HOST),
      port: optionalNumber(env, 'DEALFLOW_PORT'),
      max_connections: optionalNumber(env, 'DEALFLOW_MAX_CONNECTIONS'),
    },
    database: {
      path: optionalText(env.DEALFLOW_DB_PATH),
      timeout_ms: optionalNumber(env, 'DEALFLOW_DB_TIMEOUT_MS'),
    },
    shutdown: {
      grace_ms: optionalNumber(env, 'DEALFLOW_SHUTDOWN_GRACE_MS'),
      abort_grace_ms: optionalNumber(env, 'DEALFLOW_SHUTDOWN_ABORT_GRACE_MS'),
    },
    webhook: {
      path: optionalText(env.DEALFLOW_WEBHOOK_PATH),
      bearer_token: optionalText(env.DEALFLOW_WEBHOOK_TOKEN),
      max_body_bytes: optionalNumber(env, 'DEALFLOW_WEBHOOK_MAX_BODY_BYTES'),
      hmac_secret: optionalText(env.DEALFLOW_WEBHOOK_HMAC_SECRET),
      signature_tolerance_seconds: optionalNumber(env, 'DEALFLOW_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS'),
      /** 0 表示不限流；留空回退默认 600。 */
      rate_limit_per_minute: rateLimitFromEnv(env, 'DEALFLOW_WEBHOOK_RATE_LIMIT_PER_MINUTE'),
      trust_proxy_headers: optionalBoolean(env, 'DEALFLOW_WEBHOOK_TRUST_PROXY_HEADERS'),
    },
    observability: {
      enabled: optionalBoolean(env, 'DEALFLOW_OBSERVABILITY_ENABLED'),
      log_level: optionalText(env.DEALFLOW_LOG_LEVEL),
    },
    control_plane: {
      enabled: optionalBoolean(env, 'DEALFLOW_CONTROL_PLANE_ENABLED'),
      bearer_token: optionalText(env.DEALFLOW_CONTROL_PLANE_TOKEN),
      rate_limit_per_minute: rateLimitFromEnv(env, 'DEALFLOW_CONTROL_PLANE_RATE_LIMIT_PER_MINUTE'),
    },
    retry_scheduler: {
      enabled: optionalBoolean(env, 'DEALFLOW_RETRY_ENABLED'),
      interval_ms: optionalNumber(env, 'DEALFLOW_RETRY_INTERVAL_MS'),
      max_attempts_per_workflow: optionalNumber(env, 'DEALFLOW_RETRY_MAX_ATTEMPTS'),
      max_backoff_ms: optionalNumber(env, 'DEALFLOW_RETRY_MAX_BACKOFF_MS'),
    },
    provider: {
      kind: optionalText(env.DEALFLOW_PROVIDER_KIND),
      base_url: optionalText(env.DEALFLOW_PROVIDER_BASE_URL),
      bearer_token: optionalText(env.DEALFLOW_PROVIDER_TOKEN),
      timeout_ms: optionalNumber(env, 'DEALFLOW_PROVIDER_TIMEOUT_MS'),
    },
  });
}

/**
 * 从配置与运行时事实拼装引擎所需的 PolicyContext。
 * `evaluated_at`、`auto_actions_today`、`permitted_actor_ids` 是运行时值，不属于静态配置。
 */
export function policyContextFromConfig(
  config: DealFlowConfig,
  runtime: { readonly evaluated_at: string; readonly auto_actions_today: number; readonly permitted_actor_ids: readonly string[] },
): PolicyContext {
  return {
    policy_version: config.policy.policy_version,
    evaluated_at: runtime.evaluated_at,
    automation_whitelist: config.policy.automation_whitelist,
    permitted_action_types: config.policy.permitted_action_types,
    permitted_actor_ids: runtime.permitted_actor_ids,
    business_timezone_offset_minutes: config.policy.business_timezone_offset_minutes,
    send_window: config.policy.send_window,
    max_auto_actions_per_day: config.policy.max_auto_actions_per_day,
    auto_actions_today: runtime.auto_actions_today,
    key_account_lead_ids: config.policy.key_account_lead_ids,
    high_value_deal_threshold: config.policy.high_value_deal_threshold,
  };
}
