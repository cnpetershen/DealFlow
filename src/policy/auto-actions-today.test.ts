import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from '../stores/in-memory';
import type { AuditLogStore, AuditQuery } from '../stores/interfaces';
import type { AuditEntry, NewAuditEntry } from '../stores/types';
import { auditEntryInput } from '../testing/fixtures';
import { businessDayStartMs, countAutoActionsToday } from './auto-actions-today';

const OFFSET = 480; // UTC+8

function seed(entries: readonly Partial<AuditEntry>[]): AuditLogStore {
  const log = new InMemoryAuditLog();
  for (const entry of entries) {
    log.append(auditEntryInput(entry) as NewAuditEntry);
  }
  return log;
}

/** 记录最后一次查询条件，用于断言「按条件查询」而不是「读全表后过滤」。 */
function spy(log: AuditLogStore): { log: AuditLogStore; queries: AuditQuery[] } {
  const queries: AuditQuery[] = [];
  return {
    queries,
    log: {
      append: (entry) => log.append(entry),
      get: (id) => log.get(id),
      list: () => log.list(),
      listByEventId: (id) => log.listByEventId(id),
      listByActionId: (id) => log.listByActionId(id),
      query: (filter) => {
        queries.push(filter);
        return log.query(filter);
      },
      count: (filter) => {
        queries.push(filter);
        return log.count(filter);
      },
    },
  };
}

describe('countAutoActionsToday', () => {
  it('按业务时区而不是 UTC 归日', () => {
    // UTC+8 的 2026-09-24 00:00 对应 UTC 2026-09-23T16:00Z
    expect(businessDayStartMs('2026-09-24T10:00:00+08:00', OFFSET)).toBe(
      Date.parse('2026-09-24T00:00:00+08:00'),
    );
  });

  it('只统计当日 Policy 给出 Auto 结论的动作', () => {
    const log = seed([
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-24T09:00:00+08:00' },
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-24T11:00:00+08:00' },
      // 转人工审核：不是自动动作
      { action: 'policy_evaluated', result: 'pending', occurred_at: '2026-09-24T11:30:00+08:00' },
      // 硬性拒绝：不是自动动作
      { action: 'policy_rejected', result: 'failed', occurred_at: '2026-09-24T11:40:00+08:00' },
      // 前一天（业务时区）
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-23T23:00:00+08:00' },
    ]);

    expect(
      countAutoActionsToday({
        audit_log: log,
        now: '2026-09-24T12:00:00+08:00',
        business_timezone_offset_minutes: OFFSET,
      }),
    ).toBe(2);
  });

  it('判定时刻在业务日凌晨时只算当天', () => {
    const log = seed([
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-23T22:00:00+08:00' },
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-24T00:30:00+08:00' },
    ]);

    expect(
      countAutoActionsToday({
        audit_log: log,
        now: '2026-09-24T01:00:00+08:00',
        business_timezone_offset_minutes: OFFSET,
      }),
    ).toBe(1);
  });

  it('审计记录使用 Z 与 +08:00 混写时也能正确归日', () => {
    const log = seed([
      // 2026-09-24T00:30+08:00 == 2026-09-23T16:30Z
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-23T16:30:00.000Z' },
      // 2026-09-23T23:30+08:00 == 2026-09-23T15:30Z（业务时区属于前一天）
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-23T15:30:00.000Z' },
    ]);

    expect(
      countAutoActionsToday({
        audit_log: log,
        now: '2026-09-24T10:00:00+08:00',
        business_timezone_offset_minutes: OFFSET,
      }),
    ).toBe(1);
  });

  it('按条件统计而不是读全表', () => {
    const inner = seed([
      { action: 'policy_evaluated', result: 'succeeded', occurred_at: '2026-09-24T09:00:00+08:00' },
    ]);
    const wrapper = spy(inner);

    countAutoActionsToday({
      audit_log: wrapper.log,
      now: '2026-09-24T12:00:00+08:00',
      business_timezone_offset_minutes: OFFSET,
    });

    expect(wrapper.queries).toHaveLength(1);
    expect(wrapper.queries[0]).toMatchObject({ action: 'policy_evaluated', result: 'succeeded' });
    expect(wrapper.queries[0]?.occurred_at_from).toBeDefined();
    expect(wrapper.queries[0]?.occurred_at_to).toBeDefined();
  });
});
