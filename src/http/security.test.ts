import { describe, expect, it } from 'vitest';

import { bearerTokenMatches } from './auth';
import { signPayload, signatureFingerprint, verifySignature } from './hmac';
import { FixedWindowRateLimiter } from './rate-limit';
import { ReplayGuard } from './replay-guard';

const SECRET = 'webhook-secret';
const BODY = '{"event_id":"evt_1"}';
const TIMESTAMP = '1758700000';
const SIGNATURE = signPayload(SECRET, TIMESTAMP, BODY);

describe('verifySignature', () => {
  const base = {
    secret: SECRET,
    timestamp: TIMESTAMP,
    signature: SIGNATURE,
    body: BODY,
    now_ms: Number(TIMESTAMP) * 1_000,
    tolerance_seconds: 300,
  };

  it('接受匹配的签名与时间戳', () => {
    expect(verifySignature(base)).toEqual({ ok: true });
  });

  it('时间戳超出容忍窗口时拒绝（重放保护）', () => {
    expect(verifySignature({ ...base, now_ms: base.now_ms + 301_000 })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(verifySignature({ ...base, now_ms: base.now_ms - 301_000 })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('窗口边界内仍然接受', () => {
    expect(verifySignature({ ...base, now_ms: base.now_ms + 300_000 })).toEqual({ ok: true });
  });

  it('签名不匹配时拒绝', () => {
    expect(verifySignature({ ...base, signature: signPayload('wrong-secret', TIMESTAMP, BODY) })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('报文被篡改后签名失效', () => {
    expect(verifySignature({ ...base, body: '{"event_id":"evt_tampered"}' })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('时间戳被替换后签名失效（时间戳参与签名）', () => {
    expect(verifySignature({ ...base, timestamp: '1758700001' })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('缺少时间戳或签名时拒绝', () => {
    expect(verifySignature({ ...base, timestamp: null })).toEqual({ ok: false, reason: 'missing_timestamp' });
    expect(verifySignature({ ...base, signature: null })).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('时间戳非数字时拒绝', () => {
    expect(verifySignature({ ...base, timestamp: 'not-a-number' })).toEqual({
      ok: false,
      reason: 'invalid_timestamp',
    });
  });
});

describe('bearerTokenMatches', () => {
  it('完整且正确的 Bearer 头通过', () => {
    expect(bearerTokenMatches('Bearer s3cret', 's3cret')).toBe(true);
  });

  it('token 不匹配、缺失前缀或缺失头一律拒绝', () => {
    expect(bearerTokenMatches('Bearer s3cret', 's3cre')).toBe(false);
    expect(bearerTokenMatches('Bearer s3cret', 'other')).toBe(false);
    expect(bearerTokenMatches('s3cret', 's3cret')).toBe(false);
    expect(bearerTokenMatches('Basic s3cret', 's3cret')).toBe(false);
    expect(bearerTokenMatches(undefined, 's3cret')).toBe(false);
    expect(bearerTokenMatches('', 's3cret')).toBe(false);
  });

  it('token 长度不同也不会抛错（等长比较靠哈希归一化）', () => {
    expect(bearerTokenMatches('Bearer a-much-longer-token-value', 'x')).toBe(false);
    expect(bearerTokenMatches('Bearer x', 'a-much-longer-token-value')).toBe(false);
  });

  it('未配置 token 时一律拒绝', () => {
    expect(bearerTokenMatches('Bearer anything', null)).toBe(false);
  });
});

describe('ReplayGuard', () => {
  it('同一指纹在 TTL 内只接受一次，过期后可再次接受', () => {
    let now = 1_000;
    const guard = new ReplayGuard(500, () => now);
    const fingerprint = signatureFingerprint(SIGNATURE);

    expect(guard.accept(fingerprint)).toBe(true);
    expect(guard.accept(fingerprint)).toBe(false);

    now = 1_600;
    expect(guard.accept(fingerprint)).toBe(true);
  });

  it('不同指纹互不影响', () => {
    const guard = new ReplayGuard(1_000, () => 0);

    expect(guard.accept('a')).toBe(true);
    expect(guard.accept('b')).toBe(true);
    expect(guard.accept('a')).toBe(false);
  });

  it('记录数量有上限，避免无限增长', () => {
    let now = 0;
    const guard = new ReplayGuard(10_000, () => now, 3);

    for (let i = 0; i < 10; i += 1) {
      guard.accept(`fp-${i}`);
      now += 0;
    }

    expect(guard.size).toBeLessThanOrEqual(3);
  });
});

describe('FixedWindowRateLimiter', () => {
  it('窗口内超过上限后拒绝，并给出 Retry-After 秒数', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({ limit_per_window: 2, window_ms: 60_000, now: () => now });

    expect(limiter.check('client-a')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check('client-a')).toMatchObject({ allowed: true, remaining: 0 });

    const denied = limiter.check('client-a');
    expect(denied.allowed).toBe(false);
    expect(denied.retry_after_seconds).toBe(60);

    now = 60_000;
    expect(limiter.check('client-a')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('不同来源各自计数', () => {
    const limiter = new FixedWindowRateLimiter({ limit_per_window: 1, window_ms: 60_000, now: () => 0 });

    expect(limiter.check('client-a').allowed).toBe(true);
    expect(limiter.check('client-b').allowed).toBe(true);
    expect(limiter.check('client-a').allowed).toBe(false);
  });

  it('key 数量超过上限时清理旧窗口，内存有界', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit_per_window: 5,
      window_ms: 1_000,
      now: () => now,
      max_keys: 2,
    });

    limiter.check('a');
    limiter.check('b');
    now = 1_000;
    limiter.check('c');

    // 旧窗口的 key 会被清理，不会无限累积。
    expect(limiter.check('d').allowed).toBe(true);
  });

  it('max_keys 是硬上限：同一窗口内不断换 key 也不会让内存无界增长', () => {
    const limiter = new FixedWindowRateLimiter({
      limit_per_window: 3,
      window_ms: 60_000,
      now: () => 0,
      max_keys: 8,
    });

    for (let index = 0; index < 1_000; index += 1) {
      limiter.check(`spoofed-ip-${index}`);
    }

    expect(limiter.size).toBeLessThanOrEqual(8);

    // 留在表内的 key 配额仍然生效
    expect(limiter.check('spoofed-ip-999').allowed).toBe(true);
    expect(limiter.check('spoofed-ip-999').allowed).toBe(true);
    expect(limiter.check('spoofed-ip-999').allowed).toBe(false);
    expect(limiter.size).toBeLessThanOrEqual(8);
  });

  it('max_keys 至少为 1，0 也退化成单 key 限流而不是无限增长', () => {
    const limiter = new FixedWindowRateLimiter({
      limit_per_window: 2,
      window_ms: 60_000,
      now: () => 0,
      max_keys: 0,
    });

    limiter.check('a');
    limiter.check('b');

    expect(limiter.size).toBeLessThanOrEqual(1);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(false);
  });
});
