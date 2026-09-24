import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { describeEventStoreContract } from './event-store-contract';
import { InMemoryEventStore } from './in-memory';
import { SqliteEventStore } from './sqlite';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-event-store-'));
  return join(dir, 'events.db');
}

describeEventStoreContract('SqliteEventStore 契约', () => {
  const store = new SqliteEventStore();
  return {
    store,
    cleanup: () => store.close(),
  };
});

describeEventStoreContract('SqliteEventStore 契约（文件库）', () => {
  const path = tempDbPath();
  const store = new SqliteEventStore({ path });
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(join(path, '..'), { recursive: true, force: true });
    },
  };
});

describe('SqliteEventStore 持久化与恢复', () => {
  it('进程重启后事件不丢失，processing_status 保留', () => {
    const path = tempDbPath();
    try {
      const first = new SqliteEventStore({ path });
      first.append(leadCreatedEvent());
      first.append(leadAssignedEvent());
      first.markProcessed('lead.created:crm:rec_1001');
      first.close();

      const second = new SqliteEventStore({ path });
      const list = second.list();

      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        sequence: 1,
        processing_status: 'processed',
        event: { event_id: 'evt_0001', type: 'lead.created' },
      });
      expect(list[1]).toMatchObject({
        sequence: 2,
        processing_status: 'pending',
        event: { event_id: 'evt_0002', type: 'lead.assigned' },
      });
      second.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('重启后同一事实重复投递仍返回 duplicate / retry，不重复落库', () => {
    const path = tempDbPath();
    try {
      const first = new SqliteEventStore({ path });
      first.append(leadCreatedEvent());
      first.markProcessed('lead.created:crm:rec_1001');
      first.close();

      const second = new SqliteEventStore({ path });
      expect(second.append(leadCreatedEvent()).status).toBe('duplicate');
      expect(second.list()).toHaveLength(1);
      second.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('重启后冲突事实仍被拒绝，不覆盖已持久化事件', () => {
    const path = tempDbPath();
    try {
      const first = new SqliteEventStore({ path });
      first.append(leadCreatedEvent());
      first.close();

      const second = new SqliteEventStore({ path });
      const conflict = second.append(
        leadCreatedEvent({ event_id: 'evt_other', payload: { lead_id: 'lead_x' } }),
      );

      expect(conflict.status).toBe('conflict');
      expect(second.list()).toHaveLength(1);
      expect(second.getByIdempotencyKey('lead.created:crm:rec_1001')?.event.event_id).toBe('evt_0001');
      second.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('多个 Store 实例打开同一文件时共享同一事实，append 仍幂等', () => {
    const path = tempDbPath();
    try {
      const writer = new SqliteEventStore({ path });
      const reader = new SqliteEventStore({ path });

      writer.append(leadCreatedEvent());
      expect(reader.list()).toHaveLength(1);
      expect(reader.append(leadCreatedEvent()).status).toBe('retry');
      expect(reader.list()).toHaveLength(1);

      writer.close();
      reader.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('同一 pending 事件仅一个 claimId 可持有租约', () => {
    const path = tempDbPath();
    try {
      const workerA = new SqliteEventStore({ path });
      const workerB = new SqliteEventStore({ path });
      workerA.append(leadCreatedEvent());
      const key = 'lead.created:crm:rec_1001';

      expect(workerA.tryClaim(key, 'claim-a', 1_000, 30_000)).toBe(true);
      expect(workerB.tryClaim(key, 'claim-b', 1_000, 30_000)).toBe(false);

      workerA.releaseClaim(key, 'claim-a');
      expect(workerB.tryClaim(key, 'claim-b', 1_000, 30_000)).toBe(true);

      workerA.close();
      workerB.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('租约过期后可被其他 worker 接管；processed 后不可再 claim', () => {
    const path = tempDbPath();
    try {
      const workerA = new SqliteEventStore({ path });
      const workerB = new SqliteEventStore({ path });
      workerA.append(leadCreatedEvent());
      const key = 'lead.created:crm:rec_1001';

      expect(workerA.tryClaim(key, 'claim-a', 1_000, 1_000)).toBe(true);
      expect(workerB.tryClaim(key, 'claim-b', 1_001, 1_000)).toBe(false);
      expect(workerB.tryClaim(key, 'claim-b', 3_000, 1_000)).toBe(true);

      workerA.markProcessed(key);
      expect(workerA.tryClaim(key, 'claim-a', 3_001, 1_000)).toBe(false);
      expect(workerB.tryClaim(key, 'claim-b', 3_001, 1_000)).toBe(false);

      workerA.close();
      workerB.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('releaseClaim 只释放自己的租约', () => {
    const path = tempDbPath();
    try {
      const store = new SqliteEventStore({ path });
      store.append(leadCreatedEvent());
      const key = 'lead.created:crm:rec_1001';

      expect(store.tryClaim(key, 'claim-a', 1_000, 30_000)).toBe(true);
      store.releaseClaim(key, 'claim-other');
      expect(store.tryClaim(key, 'claim-b', 1_001, 30_000)).toBe(false);
      store.releaseClaim(key, 'claim-a');
      expect(store.tryClaim(key, 'claim-b', 1_002, 30_000)).toBe(true);

      store.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('InMemory 与 Sqlite 对同一序列的 append 结果一致', () => {
    const path = tempDbPath();
    try {
      const memory = new InMemoryEventStore();
      const sqlite = new SqliteEventStore({ path });

      const events = [
        leadCreatedEvent(),
        leadAssignedEvent(),
        leadCreatedEvent({ event_id: 'evt_dup' }),
      ];

      for (const event of events) {
        expect(sqlite.append(event).status).toBe(memory.append(event).status);
      }

      memory.markProcessed('lead.created:crm:rec_1001');
      sqlite.markProcessed('lead.created:crm:rec_1001');

      expect(sqlite.append(leadCreatedEvent()).status).toBe(
        memory.append(leadCreatedEvent()).status,
      );

      expect(sqlite.list()).toEqual(memory.list());
      sqlite.close();
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });
});
