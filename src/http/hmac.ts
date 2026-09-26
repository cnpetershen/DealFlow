import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-dealflow-signature';
export const TIMESTAMP_HEADER = 'x-dealflow-timestamp';

/**
 * 签名载荷为 `${timestamp}.${body}`：时间戳参与签名，避免攻击者替换时间戳绕过重放窗口。
 * 这与主流 webhook 提供商（GitHub / Stripe 风格）的做法一致。
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export type SignatureFailureReason =
  | 'missing_timestamp'
  | 'missing_signature'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch';

export type SignatureVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SignatureFailureReason };

export interface VerifySignatureInput {
  readonly secret: string;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly body: string;
  /** 当前时间（epoch 毫秒）。显式传入以保证可复现与可测试。 */
  readonly now_ms: number;
  readonly tolerance_seconds: number;
}

/**
 * 校验 HMAC-SHA256 签名与时间戳窗口。
 * 使用 timingSafeEqual 做定长比较，避免通过响应时间泄漏签名信息。
 */
export function verifySignature(input: VerifySignatureInput): SignatureVerification {
  const { secret, timestamp, signature, body, now_ms: nowMs, tolerance_seconds: toleranceSeconds } = input;

  if (timestamp === null || timestamp.length === 0) {
    return { ok: false, reason: 'missing_timestamp' };
  }
  if (signature === null || signature.length === 0) {
    return { ok: false, reason: 'missing_signature' };
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  if (Math.abs(nowMs / 1_000 - seconds) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  if (!timingSafeEquals(signPayload(secret, timestamp, body), signature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true };
}

/** 重放缓存键：同一签名在窗口内只应被接受一次。 */
export function signatureFingerprint(signature: string): string {
  return createHash('sha256').update(signature).digest('hex');
}

function timingSafeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  // 长度不同必然不等；timingSafeEqual 要求等长输入。
  return a.length === b.length && timingSafeEqual(a, b);
}
