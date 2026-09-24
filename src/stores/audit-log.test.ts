import { beforeEach, describe, expect, it } from 'vitest';

import { auditEntryInput } from '../testing/fixtures';
import { InMemoryAuditLog } from './in-memory';

describe('InMemoryAuditLog', () => {
  let log: InMemoryAuditLog;

  beforeEach(() => {
    log = new InMemoryAuditLog();
  });

  it('追加记录并生成递增的 audit_id', () => {
    const first = log.append(auditEntryInput());
    const second = log.append(auditEntryInput({ event_id: 'evt_0002' }));

    expect(first.audit_id).toBe('audit_1');
    expect(second.audit_id).toBe('audit_2');
    expect(log.get('audit_1')).toEqual(first);
  });

  it('完整保留主体、前后状态、Policy 与计划版本', () => {
    const entry = log.append(
      auditEntryInput({
        actor: { actor_type: 'user', actor_id: 'user_7' },
        action: 'action_approved',
        action_id: 'action_1',
        before_state: 'needs_review',
        after_state: 'replanning',
        reason: '内容合适',
        policy_version: 'policy_v3',
        plan_version: 4,
      }),
    );

    expect(entry).toMatchObject({
      actor: { actor_type: 'user', actor_id: 'user_7' },
      action: 'action_approved',
      action_id: 'action_1',
      before_state: 'needs_review',
      after_state: 'replanning',
      reason: '内容合适',
      policy_version: 'policy_v3',
      plan_version: 4,
    });
  });

  it('记录只追加且不可修改：顶层字段被冻结', () => {
    const entry = log.append(auditEntryInput());

    expect(() => {
      (entry as { reason: string | null }).reason = 'tampered';
    }).toThrow(TypeError);
    expect(log.get('audit_1')?.reason).toBeNull();
  });

  it('嵌套的 actor 与 subject 同样被冻结', () => {
    const entry = log.append(auditEntryInput());

    expect(() => {
      (entry.actor as { actor_id: string }).actor_id = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      (entry.subject as { subject_id: string }).subject_id = 'tampered';
    }).toThrow(TypeError);
    expect(log.get('audit_1')?.actor.actor_id).toBe('event_processor');
  });

  it('追加后再修改传入对象不影响已写入的审计记录', () => {
    const input = auditEntryInput();
    log.append(input);

    input.reason = 'tampered';

    expect(log.get('audit_1')?.reason).toBeNull();
  });

  it('list 返回副本，外部修改不影响日志', () => {
    log.append(auditEntryInput());

    const listed = log.list() as unknown[];
    listed.length = 0;

    expect(log.list()).toHaveLength(1);
  });

  it('可查询同一事件的完整处理链路', () => {
    log.append(auditEntryInput({ action: 'event_processed' }));
    log.append(auditEntryInput({ action: 'policy_evaluated', occurred_at: '2026-09-24T10:00:02+08:00' }));
    log.append(auditEntryInput({ action: 'action_dispatched', occurred_at: '2026-09-24T10:00:03+08:00' }));
    log.append(auditEntryInput({ event_id: 'evt_0002', action: 'event_processed' }));

    expect(log.listByEventId('evt_0001').map((entry) => entry.action)).toEqual([
      'event_processed',
      'policy_evaluated',
      'action_dispatched',
    ]);
  });

  it('可查询同一 ProposedAction 的审批与执行链路', () => {
    log.append(auditEntryInput({ action: 'action_approved', action_id: 'action_1' }));
    log.append(auditEntryInput({ action: 'action_dispatched', action_id: 'action_1' }));
    log.append(auditEntryInput({ action: 'action_approved', action_id: 'action_2' }));

    expect(log.listByActionId('action_1').map((entry) => entry.action)).toEqual([
      'action_approved',
      'action_dispatched',
    ]);
  });

  it('区分人工拒绝与 Policy 硬性禁止', () => {
    log.append(auditEntryInput({ action: 'action_rejected', reason: '内容不合适' }));
    log.append(auditEntryInput({ action: 'policy_rejected', reason: '联系人已退订' }));

    expect(log.list().map((entry) => entry.action)).toEqual(['action_rejected', 'policy_rejected']);
  });
});