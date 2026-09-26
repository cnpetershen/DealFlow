import { describe, expect, it } from 'vitest';

import { auditEntryInput, taskOverdueEvent } from '../testing/fixtures';
import type { ParsedEvent } from '../events/dictionary';
import type { AuditEntry } from '../stores/types';
import { derivePendingTasks } from './pending-tasks';

const WORKFLOW = 'wf_lead_follow_up_lead_1';

function events(...list: ParsedEvent[]): readonly ParsedEvent[] {
  return list;
}

function dispatchedTask(
  actionType: AuditEntry['action_type'],
  occurredAt: string,
): AuditEntry {
  return {
    ...auditEntryInput({
      action: 'action_dispatched',
      occurred_at: occurredAt,
    }),
    action_type: actionType,
    audit_id: 'audit_x',
  };
}

describe('derivePendingTasks', () => {
  it('属于当前 Workflow 的 task.overdue 构成逾期待办', () => {
    const tasks = derivePendingTasks({
      events: events(taskOverdueEvent()),
      audit_entries: [],
      workflow_instance_id: WORKFLOW,
      lead_id: 'lead_1',
    });

    expect(tasks).toEqual([
      {
        task_id: 'task_1',
        task_type: 'follow_up_email',
        assigned_to: 'user_7',
        due_at: '2026-09-24T09:00:00+08:00',
        status: 'overdue',
      },
    ]);
  });

  it('其他 Workflow 的逾期任务不进入当前实例', () => {
    const tasks = derivePendingTasks({
      events: events(
        taskOverdueEvent({
          payload: { ...taskOverdueEvent().payload, workflow_instance_id: 'wf_other', lead_id: 'lead_other' },
        }),
      ),
      audit_entries: [],
      workflow_instance_id: WORKFLOW,
      lead_id: 'lead_1',
    });

    expect(tasks).toEqual([]);
  });

  it('已派发过补救任务后不再重复提出', () => {
    const tasks = derivePendingTasks({
      events: events(taskOverdueEvent()),
      audit_entries: [dispatchedTask('create_task', '2026-09-24T17:05:00+08:00')],
      workflow_instance_id: WORKFLOW,
      lead_id: 'lead_1',
    });

    expect(tasks).toEqual([]);
  });

  it('补救任务派发发生在逾期之前的旧记录不视为已补救', () => {
    const tasks = derivePendingTasks({
      events: events(taskOverdueEvent()),
      audit_entries: [dispatchedTask('create_task', '2026-09-24T08:00:00+08:00')],
      workflow_instance_id: WORKFLOW,
      lead_id: 'lead_1',
    });

    expect(tasks).toHaveLength(1);
  });

  it('其他动作类型的派发不算补救', () => {
    const tasks = derivePendingTasks({
      events: events(taskOverdueEvent()),
      audit_entries: [dispatchedTask('send_email', '2026-09-24T17:05:00+08:00')],
      workflow_instance_id: WORKFLOW,
      lead_id: 'lead_1',
    });

    expect(tasks).toHaveLength(1);
  });

  it('同一 task_id 重复投递只产生一条待办', () => {
    const tasks = derivePendingTasks({
      events: events(
        taskOverdueEvent(),
        taskOverdueEvent({ event_id: 'evt_other', idempotency_key: 'task.overdue:task_1:again' }),
      ),
      audit_entries: [],
      workflow_instance_id: WORKFLOW,
      lead_id: 'lead_1',
    });

    expect(tasks).toHaveLength(1);
  });
});
