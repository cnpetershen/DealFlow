import { describe, expect, it } from 'vitest';

import { eventEnvelopeSchema } from './envelope';

const validEnvelope = {
  event_id: 'evt_0001',
  type: 'lead.created',
  version: 1,
  occurred_at: '2026-09-24T10:00:00+08:00',
  idempotency_key: 'lead.created:crm:rec_1001',
  payload: { lead_id: 'lead_1' },
  source: 'crm',
};

const envelopeFields = [
  'event_id',
  'type',
  'version',
  'occurred_at',
  'idempotency_key',
  'payload',
  'source',
] as const;

const nonEmptyStringFields = ['event_id', 'type', 'idempotency_key', 'source'] as const;

describe('eventEnvelopeSchema', () => {
  it('接受带时区偏移的完整事件信封', () => {
    expect(eventEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope);
  });

  it('接受以 Z 结尾的 UTC 时间', () => {
    const envelope = { ...validEnvelope, occurred_at: '2026-09-24T02:00:00Z' };
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it.each(envelopeFields)('缺少 %s 时校验失败', (field) => {
    const incomplete: Record<string, unknown> = { ...validEnvelope };
    delete incomplete[field];
    expect(eventEnvelopeSchema.safeParse(incomplete).success).toBe(false);
  });

  it('occurred_at 缺少时区偏移时校验失败', () => {
    const envelope = { ...validEnvelope, occurred_at: '2026-09-24T10:00:00' };
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('occurred_at 不是合法时间时校验失败', () => {
    const envelope = { ...validEnvelope, occurred_at: '2026-09-24 10:00' };
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it.each([0, -1, 1.5])('version 为 %s 时校验失败', (version) => {
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, version }).success).toBe(false);
  });

  it.each(nonEmptyStringFields)('%s 为空字符串时校验失败', (field) => {
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, [field]: '' }).success).toBe(false);
  });

  it('payload 不是对象时校验失败', () => {
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, payload: 'not-an-object' }).success).toBe(
      false,
    );
  });

  it('payload 为空对象时信封校验通过，payload 结构由事件字典负责', () => {
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, payload: {} }).success).toBe(true);
  });
});
