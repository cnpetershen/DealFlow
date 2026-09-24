import { z } from 'zod';

/**
 * 事件信封，对应 docs/events.md「通用事件约束」。
 *
 * 约定：文档中的「可为空」在 payload schema 中统一表达为 `nullable()`，
 * 即字段必须存在、值可以为 null，以保证事件作为不可变事实时字段存在性可被审计。
 */
export const eventEnvelopeSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().min(1),
  occurred_at: z.string().datetime({ offset: true }),
  idempotency_key: z.string().min(1),
  payload: z.record(z.unknown()),
  source: z.string().min(1),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
