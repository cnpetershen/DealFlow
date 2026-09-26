import type { MemorySummary } from '../decision/context';
import type { MemoryEntry } from '../stores/types';

/**
 * 把 Memory 记录汇总为 Decision Context 需要的摘要。
 *
 * Memory 存历史互动与偏好（docs/domain.md「边界与数据归属」），
 * Context 只取「互动次数、最近互动时间、偏好」这三项，避免把整段历史塞进判定输入。
 */
export function summarizeMemory(entries: readonly MemoryEntry[]): MemorySummary {
  const interactions = entries.filter((entry) => entry.kind === 'interaction');
  const last = interactions.reduce<string | null>((latest, entry) => {
    if (latest === null || Date.parse(entry.occurred_at) > Date.parse(latest)) {
      return entry.occurred_at;
    }
    return latest;
  }, null);

  const preferences = [
    ...new Set(entries.filter((entry) => entry.kind === 'preference').map((entry) => entry.content)),
  ];

  return {
    interaction_count: interactions.length,
    last_interaction_at: last,
    preferences,
  };
}
