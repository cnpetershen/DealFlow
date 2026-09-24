import { z } from 'zod';

import { DEAL_STAGES } from '../state-machine/states';
import { eventEnvelopeSchema, type EventEnvelope } from './envelope';

/**
 * 事件字典，对应 docs/events.md「事件字典」。
 *
 * 约定：「可为空」表达为 `nullable()`，字段必须存在、值可为 null。
 */
const identifier = z.string().min(1);
const occurredAt = z.string().datetime({ offset: true });

/** Deal 阶段，对应 docs/state-machine.md「Deal Stage」。状态定义以 state-machine/states 为唯一来源。 */
export const dealStageSchema = z.enum(DEAL_STAGES);

export const leadCreatedV1 = z.object({
  lead_id: identifier,
  source_channel: identifier,
  source_record_id: identifier,
  company_name: identifier.nullable(),
  contact_id: identifier.nullable(),
  initial_owner_id: identifier.nullable(),
});

export const leadAssignedV1 = z.object({
  lead_id: identifier,
  owner_id: identifier,
  previous_owner_id: identifier.nullable(),
  assignment_reason: identifier,
});

export const dealCreatedV1 = z.object({
  deal_id: identifier,
  lead_id: identifier,
  contact_id: identifier.nullable(),
  owner_id: identifier.nullable(),
  initial_stage: z.literal('qualification'),
  amount: z.number().nonnegative().nullable(),
  currency: identifier.nullable(),
  expected_close_at: occurredAt.nullable(),
  source_record_id: identifier,
});

export const emailSentV1 = z.object({
  message_id: identifier,
  lead_id: identifier,
  contact_id: identifier,
  sender_id: identifier,
  recipient_email: z.string().email(),
  template_id: identifier.nullable(),
  workflow_instance_id: identifier.nullable(),
  sent_at: occurredAt,
});

export const emailRepliedV1 = z.object({
  message_id: identifier,
  reply_id: identifier,
  lead_id: identifier,
  contact_id: identifier,
  reply_at: occurredAt,
  sentiment: identifier.nullable(),
  intent: identifier.nullable(),
  body_reference: identifier,
});

export const meetingScheduledV1 = z.object({
  meeting_id: identifier,
  lead_id: identifier,
  contact_id: identifier,
  organizer_id: identifier,
  scheduled_start_at: occurredAt,
  scheduled_end_at: occurredAt,
  calendar_provider: identifier,
  status: identifier,
});

export const proposalSentV1 = z.object({
  proposal_id: identifier,
  deal_id: identifier,
  lead_id: identifier,
  contact_id: identifier,
  sender_id: identifier,
  amount: z.number().nonnegative().nullable(),
  currency: identifier.nullable(),
  document_reference: identifier,
  sent_at: occurredAt,
});

export const dealStageChangedV1 = z.object({
  deal_id: identifier,
  lead_id: identifier,
  from_stage: dealStageSchema,
  to_stage: dealStageSchema,
  changed_by: identifier,
  reason: identifier.nullable(),
});

export const taskOverdueV1 = z
  .object({
    task_id: identifier,
    lead_id: identifier.nullable(),
    deal_id: identifier.nullable(),
    workflow_instance_id: identifier,
    task_type: identifier,
    assigned_to: identifier,
    due_at: occurredAt,
    overdue_at: occurredAt,
  })
  .refine((payload) => payload.lead_id !== null || payload.deal_id !== null, {
    message: 'lead_id 与 deal_id 至少一个不为空',
    path: ['lead_id'],
  });

export interface EventPayloadMap {
  'lead.created': z.infer<typeof leadCreatedV1>;
  'lead.assigned': z.infer<typeof leadAssignedV1>;
  'deal.created': z.infer<typeof dealCreatedV1>;
  'email.sent': z.infer<typeof emailSentV1>;
  'email.replied': z.infer<typeof emailRepliedV1>;
  'meeting.scheduled': z.infer<typeof meetingScheduledV1>;
  'proposal.sent': z.infer<typeof proposalSentV1>;
  'deal.stage_changed': z.infer<typeof dealStageChangedV1>;
  'task.overdue': z.infer<typeof taskOverdueV1>;
}

export type EventType = keyof EventPayloadMap;

export type EventPayload<T extends EventType> = EventPayloadMap[T];

export const eventPayloadSchemas: { [T in EventType]: Record<number, z.ZodTypeAny> } = {
  'lead.created': { 1: leadCreatedV1 },
  'lead.assigned': { 1: leadAssignedV1 },
  'deal.created': { 1: dealCreatedV1 },
  'email.sent': { 1: emailSentV1 },
  'email.replied': { 1: emailRepliedV1 },
  'meeting.scheduled': { 1: meetingScheduledV1 },
  'proposal.sent': { 1: proposalSentV1 },
  'deal.stage_changed': { 1: dealStageChangedV1 },
  'task.overdue': { 1: taskOverdueV1 },
};

export class UnknownEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`未知事件类型: ${eventType}`);
    this.name = 'UnknownEventTypeError';
  }
}

export class UnsupportedEventVersionError extends Error {
  constructor(
    readonly eventType: string,
    readonly version: number,
  ) {
    super(`事件 ${eventType} 不支持版本 ${version}`);
    this.name = 'UnsupportedEventVersionError';
  }
}

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(eventPayloadSchemas, value);
}

export function getEventPayloadSchema(type: string, version: number): z.ZodTypeAny {
  if (!isEventType(type)) {
    throw new UnknownEventTypeError(type);
  }

  const schema = eventPayloadSchemas[type][version];
  if (schema === undefined) {
    throw new UnsupportedEventVersionError(type, version);
  }

  return schema;
}

export function parseEventPayload(
  type: string,
  version: number,
  payload: unknown,
): EventPayload<EventType> {
  return getEventPayloadSchema(type, version).parse(payload) as EventPayload<EventType>;
}

/** 单个事件类型的完整事件：`type` 与 `payload` 一一绑定。 */
export type ParsedEventOf<T extends EventType> = Omit<EventEnvelope, 'type' | 'payload'> & {
  type: T;
  payload: EventPayload<T>;
};

/**
 * 以 `type` 为判别键的事件联合类型。
 *
 * 收窄后 payload 即为该事件自己的 schema 输出，调用方无需 `as EventType`
 * 或对 payload 断言；这是引擎与决策器读取业务字段的类型基础。
 */
export type ParsedEvent = { [T in EventType]: ParsedEventOf<T> }[EventType];

/**
 * 接入边界入口：先校验信封，再按 type + version 校验 payload。
 *
 * zod 分别校验 `type` 与 `payload`，其输出无法在类型层面表达二者的绑定关系，
 * 因此确认 `type` 已知后在这里集中断言一次，此后全链路都依赖判别联合。
 */
export function parseEvent(input: unknown): ParsedEvent {
  const envelope = eventEnvelopeSchema.parse(input);
  const { type, version, payload: rawPayload } = envelope;

  if (!isEventType(type)) {
    throw new UnknownEventTypeError(type);
  }

  const payload = parseEventPayload(type, version, rawPayload);

  return { ...envelope, type, payload } as ParsedEvent;
}
