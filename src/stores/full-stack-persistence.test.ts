import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import { emailSentEvent, leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import { openSqlite, type SqliteDatabase } from './sqlite-db';
import { SqliteEventStore } from './sqlite';
import {
  SqliteAuditLog,
  SqliteExceptionQueue,
  SqliteStateStore,
  SqliteWorkflowStateStore,
} from './sqlite-stores';
import type { ContactState, DealState, LeadState } from './types';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 只创建临时目录与路径，连接由各 Stack 自行开关，避免 Windows EBUSY。 */
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-full-stack-'));
  const path = join(dir, 'dealflow.db');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

interface Stack {
  engine: WorkflowEngine;
  executor: InMemoryExecutor;
  events: SqliteEventStore;
  workflows: SqliteWorkflowStateStore;
  leads: SqliteStateStore<LeadState>;
  audit: SqliteAuditLog;
  exceptions: SqliteExceptionQueue;
  sqlite: SqliteDatabase;
  closeStores: () => void;
}

function createStack(path: string): Stack {
  const sqlite = openSqlite({ path });
  const events = new SqliteEventStore({ sqlite });
  const audit = new SqliteAuditLog({ sqlite });
  const exceptions = new SqliteExceptionQueue({ sqlite });
  const workflows = new SqliteWorkflowStateStore({ sqlite });
  const leads = new SqliteStateStore<LeadState>('lead', (s) => s.lead_id, { sqlite });
  const contacts = new SqliteStateStore<ContactState>('contact', (s) => s.contact_id, { sqlite });
  const deals = new SqliteStateStore<DealState>('deal', (s) => s.deal_id, { sqlite });
  const executor = new InMemoryExecutor();
  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    executor,
    decider: new RuleBasedDecider({
      createActionId: (() => {
        let n = 0;
        return () => `action_${++n}`;
      })(),
    }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: (contactId) => ({
      contact_id: contactId,
      full_name: 'Zhang San',
      email: 'buyer@acme.example',
      organization_id: 'org_acme',
      contact_preference: 'auto_allowed' as const,
      contactability: 'reachable' as const,
      is_new_contact: false,
      updated_at: '2026-09-24T10:00:00+08:00',
    }),
  });

  return {
    engine,
    executor,
    events,
    workflows,
    leads,
    audit,
    exceptions,
    sqlite,
    closeStores: () => {
      if (sqlite.db.isOpen) sqlite.close();
    },
  };
}

/** 清空 State / Audit / Exception，仅保留事件日志，模拟「空 State + 已落盘事件」恢复。 */
function clearDerivedState(stack: Stack): void {
  stack.sqlite.db.exec(`
    DELETE FROM workflows;
    DELETE FROM entity_states;
    DELETE FROM audit_log;
    DELETE FROM exceptions;
  `);
}

describe('全栈 SQLite 持久化恢复', () => {
  it('进程重启后 Event / Audit / Workflow / 实体仍可读，并可继续推进流程', async () => {
    const path = tempDbPath();
    let reboot: Stack | undefined;
    try {
      const live = createStack(path);
      await live.engine.handleEvent(
        leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
      );
      await live.engine.handleEvent(leadAssignedEvent());
      expect(live.executor.attempts()).toHaveLength(1);
      live.closeStores();

      reboot = createStack(path);
      expect(reboot.workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
        status: 'waiting_result',
        awaiting_event_types: ['email.sent'],
        failure_classification: null,
        failure_submitted: null,
      });
      expect(reboot.leads.get('lead_1')).toMatchObject({
        status: 'assigned',
        owner_id: 'user_7',
      });
      expect(reboot.audit.list().some((e) => e.action === 'action_dispatched')).toBe(true);
      expect(reboot.events.list().every((e) => e.processing_status === 'processed')).toBe(true);

      // 持久化状态上继续消费结果事件，无需 recoverFromEventLog
      const sent = await reboot.engine.handleEvent(emailSentEvent());
      expect(sent.status).toBe('processed');
      expect(reboot.workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
        status: 'waiting_result',
        awaiting_event_types: ['email.replied', 'task.overdue'],
      });
      // 重启后的 executor 是新实例；email.sent 只推进等待条件，不派发新动作
      expect(reboot.executor.attempts()).toHaveLength(0);
    } finally {
      reboot?.closeStores();
    }
  });

  it('清空 State 后仅凭事件日志 recover 可重建全流程状态', async () => {
    const path = tempDbPath();
    let reboot: Stack | undefined;
    try {
      const live = createStack(path);
      await live.engine.handleEvent(
        leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
      );
      await live.engine.handleEvent(leadAssignedEvent());
      live.closeStores();

      reboot = createStack(path);
      clearDerivedState(reboot);
      expect(reboot.workflows.list()).toHaveLength(0);

      const results = await reboot.engine.recoverFromEventLog();
      expect(results.map((r) => r.status)).toEqual(['processed', 'processed']);
      expect(reboot.workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
        status: 'waiting_result',
        awaiting_event_types: ['email.sent'],
      });
      expect(reboot.leads.get('lead_1')).toMatchObject({ status: 'assigned', owner_id: 'user_7' });
      expect(reboot.audit.list().some((e) => e.action === 'action_dispatched')).toBe(true);
      expect(reboot.events.list().every((e) => e.processing_status === 'processed')).toBe(true);
    } finally {
      reboot?.closeStores();
    }
  });

  it('失败分类与 submitted 落盘后，重启不 recover 也拒绝不安全自动重试', async () => {
    const path = tempDbPath();
    let reboot: Stack | undefined;
    try {
      const live = createStack(path);
      live.executor.failNext(Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' }));
      await live.engine.handleEvent(
        leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
      );
      await live.engine.handleEvent(leadAssignedEvent());
      live.closeStores();

      reboot = createStack(path);
      expect(reboot.workflows.get('wf_lead_follow_up_lead_1')).toMatchObject({
        status: 'failed',
        failure_classification: 'transient',
        failure_submitted: 'unknown',
      });
      await expect(reboot.engine.retry('wf_lead_follow_up_lead_1')).rejects.toThrow(
        '提交状态未知',
      );
    } finally {
      reboot?.closeStores();
    }
  });

  it('跨进程双 worker 对同一 pending 事件仅一侧完成业务处理', async () => {
    const path = tempDbPath();
    let workerA: Stack | undefined;
    let workerB: Stack | undefined;
    try {
      const writer = createStack(path);
      writer.events.append(
        leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
      );
      writer.closeStores();

      workerA = createStack(path);
      workerB = createStack(path);

      const [a, b] = await Promise.all([
        workerA.engine.handleEvent(
          leadCreatedEvent({
            payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' },
          }),
        ),
        workerB.engine.handleEvent(
          leadCreatedEvent({
            payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' },
          }),
        ),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['duplicate', 'processed']);
      expect(workerA.workflows.list()).toHaveLength(1);
      expect(workerB.workflows.list()).toHaveLength(1);
    } finally {
      workerA?.closeStores();
      workerB?.closeStores();
    }
  });
});
