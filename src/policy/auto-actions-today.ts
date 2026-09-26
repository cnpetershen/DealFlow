import type { AuditLogStore } from '../stores/interfaces';

/**
 * 当日已执行的自动动作次数。
 *
 * Policy 用 `auto_actions_today` 约束自动化频率（docs/decision-policy.md「可自动执行的条件」第 5 条：
 * 频率与发送窗口必须满足），但装配时如果恒为 0，`max_auto_actions_per_day` 就永远不会生效。
 *
 * 判定依据是只追加的 Audit Log：`policy_evaluated` 且 `result = succeeded` 表示那次判定给出 Auto 结论
 * 并把动作交给了 Executor。时间按业务时区归日，不依赖服务器本地时区。
 *
 * 实现必须走 `AuditLogStore.count`（持久化实现用 COUNT + 表达式索引），
 * 不能读全表后在内存里数：这一判定在每个事件处理时都会执行。
 */
export interface AutoActionsTodayInput {
  readonly audit_log: AuditLogStore;
  readonly now: string;
  readonly business_timezone_offset_minutes: number;
}

const DAY_MS = 86_400_000;

/** 业务时区当天 00:00 对应的 UTC 毫秒时间戳。 */
export function businessDayStartMs(now: string, offsetMinutes: number): number {
  const shifted = Date.parse(now) + offsetMinutes * 60_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - offsetMinutes * 60_000;
}

/** 业务时区当天结束时刻（次日 00:00 前 1 毫秒）。 */
export function businessDayEndMs(now: string, offsetMinutes: number): number {
  return businessDayStartMs(now, offsetMinutes) + DAY_MS - 1;
}

export function countAutoActionsToday(input: AutoActionsTodayInput): number {
  const start = businessDayStartMs(input.now, input.business_timezone_offset_minutes);
  const end = businessDayEndMs(input.now, input.business_timezone_offset_minutes);

  return input.audit_log.count({
    action: 'policy_evaluated',
    result: 'succeeded',
    occurred_at_from: new Date(start).toISOString(),
    occurred_at_to: new Date(end).toISOString(),
  });
}
