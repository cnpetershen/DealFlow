import type { PendingTask } from '../decision/context';
import type { ParsedEvent } from '../events/dictionary';
import type { AuditEntry } from '../stores/types';

/**
 * 待办任务推导。
 *
 * 引擎需要一个 `pending_tasks` 输入，`overdueRemedyRule` 才能识别「任务已逾期」并给出补救动作。
 * 这里不引入新的 Store：任务事实本来就在事件流里（`task.overdue`），
 * 「是否已被补救」则从只追加的 Audit Log 推导，因此重启后结论完全一致。
 *
 * 规则：
 * - 属于当前 Workflow 的 `task.overdue` 事件构成逾期任务（同一 task_id 以最后一次为准）；
 * - 该事件之后若已成功派发过 `create_task` 动作，则认为已补救，不再重复提出。
 */
export interface PendingTasksInput {
  readonly events: readonly ParsedEvent[];
  readonly audit_entries: readonly AuditEntry[];
  readonly workflow_instance_id: string;
  readonly lead_id: string | null;
}

/** 结果事件按 workflow_instance_id 匹配；缺失时回退到 lead_id 关联（与引擎的等待匹配一致）。 */
function belongsToWorkflow(event: ParsedEvent, input: PendingTasksInput): boolean {
  if (event.type !== 'task.overdue') {
    return false;
  }

  if (event.payload.workflow_instance_id === input.workflow_instance_id) {
    return true;
  }

  return input.lead_id !== null && event.payload.lead_id === input.lead_id;
}

function alreadyRemedied(event: ParsedEvent, auditEntries: readonly AuditEntry[]): boolean {
  const overdueAt = Date.parse(event.occurred_at);

  return auditEntries.some(
    (entry) =>
      entry.action === 'action_dispatched' &&
      entry.action_type === 'create_task' &&
      Date.parse(entry.occurred_at) >= overdueAt,
  );
}

export function derivePendingTasks(input: PendingTasksInput): readonly PendingTask[] {
  /** 同一 task_id 以最后一次投递为准，避免重复投递产生两条待办。 */
  const latest = new Map<string, ParsedEvent>();

  for (const event of input.events) {
    if (belongsToWorkflow(event, input) && event.type === 'task.overdue') {
      latest.set(event.payload.task_id, event);
    }
  }

  const tasks: PendingTask[] = [];

  for (const event of latest.values()) {
    if (event.type !== 'task.overdue' || alreadyRemedied(event, input.audit_entries)) {
      continue;
    }

    const payload = event.payload;
    if (payload.assigned_to === undefined) {
      continue;
    }

    tasks.push({
      task_id: payload.task_id,
      task_type: payload.task_type,
      assigned_to: payload.assigned_to,
      due_at: payload.due_at,
      status: 'overdue',
    });
  }

  return tasks.sort((left, right) => (left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0));
}
