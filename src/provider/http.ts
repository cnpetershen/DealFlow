import type { ActionType, ProposedAction } from '../decision/types';
import { ExecutionError } from '../executor/interfaces';
import type { ProviderAdapter, ProviderReceipt, ProviderReconciliation, SubmitOutcome } from './types';

export interface HttpProviderAdapterOptions {
  readonly provider: string;
  /** 提供商 API 根地址；适配器在其下调用 `POST /actions` 与 `GET /actions/{key}`。 */
  readonly base_url: string;
  readonly action_types: readonly ActionType[];
  /** 单次请求超时（毫秒）。超时表示「可能已提交」，不得盲目重试。 */
  readonly timeout_ms?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** 注入 fetch，便于测试；默认使用全局 fetch。 */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => string;
}

interface SubmitResponseBody {
  readonly provider_reference?: unknown;
  readonly correlation_id?: unknown;
  readonly duplicate?: unknown;
}

/**
 * 真实 Provider Adapter：通过 HTTP 调用提供商 API。
 *
 * 契约与语义：
 * - **idempotency**：每次请求携带 `Idempotency-Key: <execution_idempotency_key>`；提供商按该 key 去重，
 *   重复提交返回 `duplicate` 且复用同一 `provider_reference`。
 * - **provider_reference**：2xx 必须返回提供商侧回执标识，用于审计追溯与对账。
 * - **timeout / submitted=unknown**：请求超时或传输中断时无法判定提供商是否已接受，
 *   一律分类为 `transient` + `submitted: 'unknown'`，禁止简单 retry（见 docs/domain.md）。
 * - **reconcile**：`GET /actions/{execution_idempotency_key}` 用于判定一次不确定提交是否真的落到了提供商侧。
 */
export class HttpProviderAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly action_types: readonly ActionType[];

  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;

  constructor(options: HttpProviderAdapterOptions) {
    this.provider = options.provider;
    this.action_types = options.action_types;
    this.#baseUrl = options.base_url.replace(/\/+$/, '');
    this.#timeoutMs = options.timeout_ms ?? 5_000;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async submit(action: ProposedAction): Promise<SubmitOutcome> {
    const response = await this.#request(
      'POST',
      '/actions',
      {
        action_id: action.action_id,
        action_type: action.action_type,
        workflow_instance_id: action.workflow_instance_id,
        execution_idempotency_key: action.execution_idempotency_key,
        parameters: action.parameters,
      },
      action,
    );

    // 提供商以 409 表示该执行幂等 key 已提交过。
    if (response.status === 409) {
      const body = await readJson(response);
      return { status: 'duplicate', receipt: this.#receipt(action, body ?? {}) };
    }

    if (!response.ok) {
      throw httpFailure(response, action, this.provider, this.#now);
    }

    const body = await readJson(response);
    return {
      status: body?.duplicate === true ? 'duplicate' : 'accepted',
      receipt: this.#receipt(action, body ?? {}),
    };
  }

  async reconcile(action: ProposedAction): Promise<ProviderReconciliation> {
    const response = await this.#request(
      'GET',
      `/actions/${encodeURIComponent(action.execution_idempotency_key)}`,
      undefined,
      action,
    );

    if (response.status === 404) {
      return { submitted: false, provider_reference: null };
    }
    if (!response.ok) {
      throw httpFailure(response, action, this.provider, this.#now);
    }

    const body = await readJson(response);
    const reference = body?.provider_reference;
    // 提供商侧有这条记录、却没有可用的回执标识：无法确认效果，按 unknown 处理，禁止猜一个结论后重试。
    return reference === undefined
      ? { submitted: 'unknown', provider_reference: null }
      : { submitted: true, provider_reference: String(reference) };
  }

  #receipt(action: ProposedAction, body: SubmitResponseBody): ProviderReceipt {
    const reference = body.provider_reference;

    if (typeof reference !== 'string' || reference.length === 0) {
      // 2xx 但缺少回执：无法对账，按永久失败处理，避免产生无法追溯的外部效果。
      throw new ExecutionError(
        action.action_id,
        '提供商接受了请求但未返回 provider_reference，无法对账',
        'permanent',
        { code: 'MISSING_PROVIDER_REFERENCE', provider: this.provider, submitted: true },
      );
    }

    return {
      provider: this.provider,
      provider_reference: reference,
      correlation_id: typeof body.correlation_id === 'string' ? body.correlation_id : null,
    };
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    action: ProposedAction,
  ): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'idempotency-key': action.execution_idempotency_key,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...this.#headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw this.#transportFailure(error, action);
    }
  }

  /**
   * 传输层失败分类。关键区分是「请求是否可能已到达提供商」：
   * 连接未建立 → 确定未提交，可安全重试；超时/连接中断 → 提交状态未知，必须对账。
   */
  #transportFailure(error: unknown, action: ProposedAction): ExecutionError {
    const name = error instanceof Error ? error.name : '';
    const code = errorCode(error);

    if (name === 'TimeoutError' || name === 'AbortError' || isTimeoutCode(code)) {
      return new ExecutionError(
        action.action_id,
        `提供商请求超时（${this.#timeoutMs}ms）`,
        'transient',
        { code: 'TIMEOUT', provider: this.provider, submitted: 'unknown' },
      );
    }

    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH') {
      return new ExecutionError(
        action.action_id,
        `提供商不可达：${code}`,
        'transient',
        { code, provider: this.provider, submitted: false },
      );
    }

    // 其余传输错误（连接被重置、响应未完成等）无法排除已提交，按未知处理。
    return new ExecutionError(
      action.action_id,
      `提供商传输失败：${code ?? (name || 'unknown')}`,
      'transient',
      { code: code ?? (name || 'TRANSPORT_ERROR'), provider: this.provider, submitted: 'unknown' },
    );
  }
}

function isTimeoutCode(code: string | null): boolean {
  return (
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT'
  );
}

/** undici 会把底层错误包在 `cause` 里，两处都要看。 */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') {
    return direct;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === 'string') {
      return nested;
    }
  }
  return null;
}

async function readJson(response: Response): Promise<SubmitResponseBody | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as SubmitResponseBody) : null;
  } catch {
    return null;
  }
}

function httpFailure(
  response: Response,
  action: ProposedAction,
  provider: string,
  now: () => string,
): ExecutionError {
  const status = response.status;
  const code = `HTTP_${status}`;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now());

  if (status === 429) {
    return new ExecutionError(action.action_id, `提供商限流（${status}）`, 'transient', {
      code,
      provider,
      retry_after: retryAfter,
      // 限流在进入业务处理前被拒绝，可以确定未提交。
      submitted: false,
    });
  }

  if (status >= 500) {
    return new ExecutionError(action.action_id, `提供商服务端错误（${status}）`, 'transient', {
      code,
      provider,
      retry_after: retryAfter,
      // 服务端可能已应用效果后才失败，提交状态未知，必须先对账再重试。
      submitted: 'unknown',
    });
  }

  return new ExecutionError(action.action_id, `提供商拒绝请求（${status}）`, 'permanent', {
    code,
    provider,
    retry_after: retryAfter,
    submitted: false,
  });
}

/** Retry-After 支持秒数或 HTTP 日期；统一转成 ISO 时间戳。 */
function parseRetryAfter(header: string | null, now: string): string | null {
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(Date.parse(now) + seconds * 1_000).toISOString();
  }
  const parsed = Date.parse(header);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
