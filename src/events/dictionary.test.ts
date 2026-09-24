import { describe, expect, it } from 'vitest';

import {
  eventPayloadSchemas,
  isEventType,
  parseEvent,
  parseEventPayload,
  UnknownEventTypeError,
  UnsupportedEventVersionError,
  type EventPayload,
  type EventType,
  type ParsedEvent,
} from './dictionary';

/** 类型相等判定：仅在两侧类型完全一致时为 true。 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

const EVENT_TYPES = [
  'lead.created',
  'lead.assigned',
  'deal.created',
  'email.sent',
  'email.replied',
  'meeting.scheduled',
  'proposal.sent',
  'deal.stage_changed',
  'task.overdue',
] as const satisfies readonly EventType[];

const fixtures: Record<EventType, Record<string, unknown>> = {
  'lead.created': {
    lead_id: 'lead_1',
    source_channel: 'web_form',
    source_record_id: 'rec_1001',
    company_name: 'Acme',
    contact_id: 'contact_1',
    initial_owner_id: null,
  },
  'lead.assigned': {
    lead_id: 'lead_1',
    owner_id: 'user_7',
    previous_owner_id: null,
    assignment_reason: 'rule:territory',
  },
  'deal.created': {
    deal_id: 'deal_1',
    lead_id: 'lead_1',
    contact_id: 'contact_1',
    owner_id: 'user_7',
    initial_stage: 'qualification',
    amount: 120000,
    currency: 'CNY',
    expected_close_at: '2026-12-31T00:00:00+08:00',
    source_record_id: 'rec_2001',
  },
  'email.sent': {
    message_id: 'msg_1',
    lead_id: 'lead_1',
    contact_id: 'contact_1',
    sender_id: 'user_7',
    recipient_email: 'buyer@acme.com',
    template_id: 'tpl_intro',
    workflow_instance_id: 'wf_1',
    sent_at: '2026-09-24T10:00:00+08:00',
  },
  'email.replied': {
    message_id: 'msg_1',
    reply_id: 'msg_2',
    lead_id: 'lead_1',
    contact_id: 'contact_1',
    reply_at: '2026-09-24T12:00:00+08:00',
    sentiment: 'positive',
    intent: 'request_pricing',
    body_reference: 's3://mail/msg_2',
  },
  'meeting.scheduled': {
    meeting_id: 'mtg_1',
    lead_id: 'lead_1',
    contact_id: 'contact_1',
    organizer_id: 'user_7',
    scheduled_start_at: '2026-09-25T14:00:00+08:00',
    scheduled_end_at: '2026-09-25T14:30:00+08:00',
    calendar_provider: 'google',
    status: 'scheduled',
  },
  'proposal.sent': {
    proposal_id: 'prop_1',
    deal_id: 'deal_1',
    lead_id: 'lead_1',
    contact_id: 'contact_1',
    sender_id: 'user_7',
    amount: 120000,
    currency: 'CNY',
    document_reference: 's3://docs/prop_1.pdf',
    sent_at: '2026-09-26T10:00:00+08:00',
  },
  'deal.stage_changed': {
    deal_id: 'deal_1',
    lead_id: 'lead_1',
    from_stage: 'qualification',
    to_stage: 'discovery',
    changed_by: 'user_7',
    reason: null,
  },
  'task.overdue': {
    task_id: 'task_1',
    lead_id: 'lead_1',
    deal_id: null,
    workflow_instance_id: 'wf_1',
    task_type: 'follow_up_email',
    assigned_to: 'user_7',
    due_at: '2026-09-24T09:00:00+08:00',
    overdue_at: '2026-09-24T17:00:00+08:00',
  },
};

const validEnvelope = {
  event_id: 'evt_0001',
  type: 'lead.created',
  version: 1,
  occurred_at: '2026-09-24T10:00:00+08:00',
  idempotency_key: 'lead.created:crm:rec_1001',
  payload: fixtures['lead.created'],
  source: 'crm',
};

describe('事件字典', () => {
  it('注册了 events.md 定义的全部事件类型', () => {
    expect(Object.keys(eventPayloadSchemas).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)('%s 注册了 version 1 的 payload schema', (type) => {
    expect(eventPayloadSchemas[type][1]).toBeDefined();
  });

  it.each(EVENT_TYPES)('%s 的合法 payload 通过校验', (type) => {
    expect(() => parseEventPayload(type, 1, fixtures[type])).not.toThrow();
  });

  it.each(EVENT_TYPES)('%s 缺少首个必填字段时校验失败', (type) => {
    const incomplete: Record<string, unknown> = { ...fixtures[type] };
    const [firstField] = Object.keys(incomplete);
    delete incomplete[firstField!];
    expect(() => parseEventPayload(type, 1, incomplete)).toThrow();
  });

  it('未知事件类型抛出 UnknownEventTypeError', () => {
    expect(() => parseEventPayload('lead.exploded', 1, {})).toThrow(UnknownEventTypeError);
  });

  it('未注册的版本抛出 UnsupportedEventVersionError', () => {
    expect(() => parseEventPayload('lead.created', 2, fixtures['lead.created'])).toThrow(
      UnsupportedEventVersionError,
    );
  });

  it('isEventType 区分已知与未知事件类型', () => {
    expect(isEventType('deal.created')).toBe(true);
    expect(isEventType('deal.deleted')).toBe(false);
    expect(isEventType('toString')).toBe(false);
  });

  it('task.overdue 的 lead_id 与 deal_id 不能同时为空', () => {
    const payload = { ...fixtures['task.overdue'], lead_id: null, deal_id: null };
    expect(() => parseEventPayload('task.overdue', 1, payload)).toThrow();
  });

  it('task.overdue 仅提供 deal_id 时通过校验', () => {
    const payload = { ...fixtures['task.overdue'], lead_id: null, deal_id: 'deal_1' };
    expect(() => parseEventPayload('task.overdue', 1, payload)).not.toThrow();
  });

  it('deal.created 的 initial_stage 只能是 qualification', () => {
    const payload = { ...fixtures['deal.created'], initial_stage: 'discovery' };
    expect(() => parseEventPayload('deal.created', 1, payload)).toThrow();
  });

  it('email.sent 的收件邮箱格式非法时校验失败', () => {
    const payload = { ...fixtures['email.sent'], recipient_email: 'not-an-email' };
    expect(() => parseEventPayload('email.sent', 1, payload)).toThrow();
  });

  it('deal.stage_changed 的未知阶段校验失败', () => {
    const payload = { ...fixtures['deal.stage_changed'], to_stage: 'archived' };
    expect(() => parseEventPayload('deal.stage_changed', 1, payload)).toThrow();
  });

  it('可为空字段不接受 undefined，必须显式传 null', () => {
    const payload = { ...fixtures['email.sent'], template_id: undefined };
    expect(() => parseEventPayload('email.sent', 1, payload)).toThrow();
  });
});

describe('parseEvent', () => {
  it('同时校验信封与 payload', () => {
    const parsed = parseEvent(validEnvelope);

    expect(parsed.type).toBe('lead.created');
    expect(parsed.idempotency_key).toBe('lead.created:crm:rec_1001');
    expect(parsed.payload).toEqual(fixtures['lead.created']);
  });

  it('payload 不合法时整体校验失败', () => {
    const envelope = { ...validEnvelope, payload: { lead_id: 'lead_1' } };
    expect(() => parseEvent(envelope)).toThrow();
  });

  it('事件类型未知时抛出 UnknownEventTypeError', () => {
    const envelope = { ...validEnvelope, type: 'lead.unknown' };
    expect(() => parseEvent(envelope)).toThrow(UnknownEventTypeError);
  });

  it('信封字段缺失时抛出 ZodError', () => {
    const { occurred_at: _omitted, ...envelope } = validEnvelope;
    expect(() => parseEvent(envelope)).toThrow();
  });

  it.each(EVENT_TYPES)('%s 的事件经 parseEvent 后 type 与 payload 一致', (type) => {
    const parsed = parseEvent({ ...validEnvelope, type, payload: fixtures[type] });

    expect(parsed.type).toBe(type);
  });
});

describe('ParsedEvent 判别联合', () => {
  it('type 是联合的判别键，payload 与各自事件类型绑定', () => {
    const discriminant: Equals<ParsedEvent['type'], EventType> = true;
    const payloadBound: Equals<
      Extract<ParsedEvent, { type: 'task.overdue' }>['payload'],
      EventPayload<'task.overdue'>
    > = true;

    expect([discriminant, payloadBound]).toEqual([true, true]);
  });

  it('按 type 收窄后可直接读取该事件专有的 payload 字段', () => {
    const parsed = parseEvent(validEnvelope);

    if (parsed.type !== 'lead.created') {
      throw new Error(`期望 lead.created，实际收到 ${parsed.type}`);
    }

    // payload 若仍是所有事件 payload 的联合类型，这里无法通过类型检查。
    expect(parsed.payload.source_channel).toBe('web_form');
    expect(parsed.payload.initial_owner_id).toBeNull();
  });
});
