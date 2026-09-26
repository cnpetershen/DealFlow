import type { IncomingMessage, ServerResponse } from 'node:http';

/** HTTP 入口共用的响应与报文工具，Webhook 与控制面共用，避免两份实现漂移。 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** 读取请求体；超过上限返回 null（调用方据此返回 413）。 */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface JsonBodyResult {
  readonly ok: true;
  readonly value: Record<string, unknown>;
}

export interface JsonBodyError {
  readonly ok: false;
  readonly status: 400 | 413;
  readonly error: string;
}

/**
 * 读取并解析 JSON 对象报文。
 * 空报文视为空对象，便于 `POST /workflows/:id/retry` 这类无参数控制操作调用。
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<JsonBodyResult | JsonBodyError> {
  const body = await readBody(req, maxBytes);
  if (body === null) {
    return { ok: false, status: 413, error: 'payload too large' };
  }
  if (body.trim() === '') {
    return { ok: true, value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
