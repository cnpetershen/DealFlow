import { describe, expect, it } from 'vitest';

import type { MemoryEntry } from '../stores/types';
import { summarizeMemory } from './memory-summary';

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    memory_id: 'mem_1',
    subject_type: 'lead',
    subject_id: 'lead_1',
    kind: 'interaction',
    content: 'email.sent',
    occurred_at: '2026-09-24T10:00:00+08:00',
    source: 'crm',
    ...overrides,
  };
}

describe('summarizeMemory', () => {
  it('空 Memory 得到空摘要', () => {
    expect(summarizeMemory([])).toEqual({
      interaction_count: 0,
      last_interaction_at: null,
      preferences: [],
    });
  });

  it('互动次数与最近互动时间取时间上最新的一条', () => {
    const summary = summarizeMemory([
      entry({ memory_id: 'mem_1', occurred_at: '2026-09-24T10:00:00+08:00' }),
      entry({ memory_id: 'mem_2', occurred_at: '2026-09-24T12:00:00+08:00', content: 'email.replied' }),
      entry({ memory_id: 'mem_3', occurred_at: '2026-09-24T11:00:00+08:00', content: 'email.sent' }),
    ]);

    expect(summary.interaction_count).toBe(3);
    expect(summary.last_interaction_at).toBe('2026-09-24T12:00:00+08:00');
  });

  it('偏好去重后输出，且不计入互动次数', () => {
    const summary = summarizeMemory([
      entry({ memory_id: 'mem_1', kind: 'preference', content: 'contact_preference:human_only' }),
      entry({ memory_id: 'mem_2', kind: 'preference', content: 'contact_preference:human_only' }),
      entry({ memory_id: 'mem_3', kind: 'preference', content: 'contact_preference:auto_allowed' }),
      entry({ memory_id: 'mem_4' }),
    ]);

    expect(summary.preferences).toEqual([
      'contact_preference:human_only',
      'contact_preference:auto_allowed',
    ]);
    expect(summary.interaction_count).toBe(1);
  });
});
