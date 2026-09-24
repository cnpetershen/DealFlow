import { beforeEach, describe, expect, it } from 'vitest';

import { leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { InMemoryEventStore } from './in-memory';
import { EventNotAppendedError, type StoredEvent } from './interfaces';

function expectAppended(result: ReturnType<InMemoryEventStore['append']>): StoredEvent {
  expect(result.status).toBe('appended');

  if (result.status !== 'appended') {
    throw new Error(`期望 appended，实际为 ${result.status}`);
  }

  return result.stored;
}

describe('InMemoryEventStore', () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it('首次投递登记事件并返回 appended', () => {
    const stored = expectAppended(store.append(leadCreatedEvent()));

    expect(stored.sequence).toBe(1);
    expect(stored.processing_status).toBe('pending');
    expect(store.getByIdempotencyKey('lead.created:crm:rec_1001')?.event.event_id).toBe('evt_0001');
  });

  it('按接收顺序分配 sequence', () => {
    const first = expectAppended(store.append(leadCreatedEvent()));
    const second = expectAppended(store.append(leadAssignedEvent()));

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(store.list().map((stored) => stored.event.event_id)).toEqual(['evt_0001', 'evt_0002']);
  });

  it('同一事实重复投递且未处理成功时返回 retry，不重复落库', () => {
    store.append(leadCreatedEvent());

    const replay = store.append(leadCreatedEvent({ event_id: 'evt_9999' }));

    expect(replay.status).toBe('retry');
    expect(store.list()).toHaveLength(1);
  });

  it('处理成功后的重复投递返回 duplicate', () => {
    store.append(leadCreatedEvent());
    store.markProcessed('lead.created:crm:rec_1001');

    expect(store.append(leadCreatedEvent()).status).toBe('duplicate');
    expect(store.list()).toHaveLength(1);
  });

  it('payload 键顺序不同但内容相同时视为同一事实', () => {
    store.append(leadCreatedEvent());

    const reordered = leadCreatedEvent({
      payload: {
        initial_owner_id: null,
        contact_id: null,
        company_name: 'Acme',
        source_record_id: 'rec_1001',
        source_channel: 'web_form',
        lead_id: 'lead_1',
      },
    });

    expect(store.append(reordered).status).toBe('retry');
    expect(store.list()).toHaveLength(1);
  });

  it('同一 idempotency_key 携带不同 payload 时返回 conflict，不覆盖原事件', () => {
    store.append(leadCreatedEvent());

    const conflict = store.append(
      leadCreatedEvent({ event_id: 'evt_0002', payload: { lead_id: 'lead_other' } }),
    );

    expect(conflict.status).toBe('conflict');

    if (conflict.status !== 'conflict') {
      throw new Error('期望 conflict');
    }

    expect(conflict.existing.event.event_id).toBe('evt_0001');
    expect(store.list()).toHaveLength(1);
    expect(store.getByIdempotencyKey('lead.created:crm:rec_1001')?.event.event_id).toBe('evt_0001');
  });

  it('同一 idempotency_key 携带不同事件类型时返回 conflict', () => {
    store.append(leadCreatedEvent());

    const conflict = store.append(
      leadAssignedEvent({ idempotency_key: 'lead.created:crm:rec_1001' }),
    );

    expect(conflict.status).toBe('conflict');
  });

  it('标记处理成功后 processing_status 变为 processed', () => {
    store.append(leadCreatedEvent());

    const processed = store.markProcessed('lead.created:crm:rec_1001');

    expect(processed.processing_status).toBe('processed');
    expect(store.getByIdempotencyKey('lead.created:crm:rec_1001')?.processing_status).toBe(
      'processed',
    );
    expect(store.list()[0]?.processing_status).toBe('processed');
  });

  it('重复标记处理成功是幂等的', () => {
    store.append(leadCreatedEvent());
    const first = store.markProcessed('lead.created:crm:rec_1001');
    const second = store.markProcessed('lead.created:crm:rec_1001');

    expect(second).toEqual(first);
  });

  it('标记未登记的事件抛出 EventNotAppendedError', () => {
    expect(() => store.markProcessed('unknown_key')).toThrow(EventNotAppendedError);
  });

  it('已落库的事件不可被修改', () => {
    const stored = expectAppended(store.append(leadCreatedEvent()));

    expect(() => {
      (stored.event as { type: string }).type = 'lead.tampered';
    }).toThrow(TypeError);
    expect(store.getByIdempotencyKey('lead.created:crm:rec_1001')?.event.type).toBe('lead.created');
  });

  it('落库后再修改传入的事件对象不影响已存事实', () => {
    const event = leadCreatedEvent();
    store.append(event);

    (event.payload as Record<string, unknown>).lead_id = 'tampered';

    expect(store.getByIdempotencyKey('lead.created:crm:rec_1001')?.event.payload).toEqual({
      lead_id: 'lead_1',
      source_channel: 'web_form',
      source_record_id: 'rec_1001',
      company_name: 'Acme',
      contact_id: null,
      initial_owner_id: null,
    });
  });

  it('list 返回副本，外部修改不影响 Store', () => {
    store.append(leadCreatedEvent());

    const listed = store.list() as StoredEvent[];
    listed.length = 0;

    expect(store.list()).toHaveLength(1);
  });
});