import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import { ProviderAdapterExecutor } from '../provider/executor';
import { InMemoryProviderAdapter } from '../provider/in-memory';
import { emailRepliedEvent, emailSentEvent, leadAssignedEvent, leadCreatedEvent } from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import { openSqlite, type SqliteDatabase } from './sqlite-db';
import { SqliteEventStore } from './sqlite';
import {
  SqliteAuditLog,
  SqliteExceptionQueue,
  SqliteMemoryStore,
  SqlitePendingActionStore,
  SqliteStateStore,
  SqliteWorkflowStateStore,
} from './sqlite-stores';
import { SqliteUnitOfWork } from './sqlite-unit-of-work';
import type { ContactState, DealState, LeadState } from './types';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-reconcile-'));
  const path = join(dir, 'dealflow.db');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';

interface Stack {
  engine: WorkflowEngine;
  adapter: InMemoryProviderAdapter;
  events: SqliteEventStore;
  audit: SqliteAuditLog;
  exceptions: SqliteExceptionQueue;
  workflows: SqliteWorkflowStateStore;
  leads: SqliteStateStore<LeadState>;
  contacts: SqliteStateStore<ContactState>;
  deals: SqliteStateStore<DealState>;
  memory: SqliteMemoryStore;
  pendingActions: SqlitePendingActionStore;
  sqlite: SqliteDatabase;
}

/**
 * 每次 open 都新建一组 Store，因此「关闭再 open 同一路径」等价于进程重启：
 * 引擎内存里的动作表、失败分类、对账计数全部丢失，只剩 SQLite 里的持久化事实。
 */
function openStack(path: string, adapter: InMemoryProviderAdapter): Stack {
  const sqlite = openSqlite({ path });
  const events = new SqliteEventStore({ sqlite });
  const audit = new SqliteAuditLog({ sqlite });
  const exceptions = new SqliteExceptionQueue({ sqlite });
  const workflows = new SqliteWorkflowStateStore({ sqlite });
  const memory = new SqliteMemoryStore({ sqlite });
  const pendingActions = new SqlitePendingActionStore({ sqlite });
  const leads = new SqliteStateStore<LeadState>('lead', (s) => s.lead_id, { sqlite });
  const contacts = new SqliteStateStore<ContactState>('contact', (s) => s.contact_id, { sqlite });
  const deals = new SqliteStateStore<DealState>('deal', (s) => s.deal_id, { sqlite });

  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    memory_store: memory,
    pending_action_store: pendingActions,
    executor: new ProviderAdapterExecutor([adapter]),
    unit_of_work: new SqliteUnitOfWork(sqlite),
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
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

  return { engine, adapter, events, audit, exceptions, workflows, leads, contacts, deals, memory, pendingActions, sqlite };
}

function closeStack(stack: Stack): void {
  if (stack.sqlite.db.isOpen) {
    stack.sqlite.close();
  }
}

function timeoutError(): Error {
  return Object.assign(new Error('provider timeout'), {
    classification: 'transient' as const,
    code: 'TIMEOUT',
    submitted: 'unknown' as const,
  });
}

const leadWithContact = () =>
  leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } });

describe('SQLite 全栈：对账可恢复、可审计', () => {
  it('unknown submission 在重启后仍可对账，并按结论安全重试', async () => {
    const path = tempDbPath();
    const adapter = new InMemoryProviderAdapter({ provider: 'mailgun' });

    const first = openStack(path, adapter);
    first.adapter.failNext(timeoutError(), { record_receipt: false });
    await first.engine.handleEvent(leadWithContact());
    await first.engine.handleEvent(leadAssignedEvent());

    expect(first.workflows.get(WORKFLOW_ID)).toMatchObject({ status: 'failed', failure_submitted: 'unknown' });
    const originalKey = adapter.submitted()[0]?.execution_idempotency_key;
    closeStack(first);

    // 重启：内存里的动作表与失败分类全部丢失，对账仍必须可用
    const second = openStack(path, adapter);
    const result = await second.engine.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('not_submitted');
    expect(result.workflow.status).toBe('waiting_result');

    const submittedKeys = adapter.submitted().map((action) => action.execution_idempotency_key);
    expect(submittedKeys.at(-1)).toBe(originalKey);
    expect(new Set(submittedKeys).size).toBe(1);

    // 审计落库并可按动作追溯
    const reconciled = second.audit.list().find((entry) => entry.action === 'action_reconciled');
    expect(reconciled).toMatchObject({ result: 'succeeded', actor: { actor_id: 'user_7' } });
    expect(second.audit.listByActionId('action_1').length).toBeGreaterThan(0);

    closeStack(second);

    // 再次重启：流程继续按正常路径恢复
    const third = openStack(path, adapter);
    expect(third.workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });
    const resumed = await third.engine.handleEvent(
      emailSentEvent({ payload: { ...emailSentEvent().payload, provider_reference: 'mailgun:msg-1' } }),
    );
    expect(resumed.status).toBe('processed');
    closeStack(third);
  });

  it('对账确认已提交时，证明提供商副作用已发生的回执写入审计', async () => {
    const path = tempDbPath();
    const adapter = new InMemoryProviderAdapter({ provider: 'mailgun' });

    const first = openStack(path, adapter);
    first.adapter.failNext(timeoutError(), { record_receipt: true });
    await first.engine.handleEvent(leadWithContact());
    await first.engine.handleEvent(leadAssignedEvent());
    closeStack(first);

    const second = openStack(path, adapter);
    const result = await second.engine.reconcile(WORKFLOW_ID, 'user_7');

    expect(result.outcome).toBe('submitted');
    expect(result.workflow.status).toBe('waiting_result');
    // 已提交的动作不能再打一次
    expect(adapter.submitted()).toHaveLength(1);
    const reconciled = second.audit.list().find((entry) => entry.action === 'action_reconciled');
    expect(reconciled?.provider_receipt).toMatchObject({ provider: 'mailgun' });
    closeStack(second);
  });
});

describe('SQLite 全栈：异常处理与重放', () => {
  it('异常处理结论与审计一起落库，重启后仍可读', async () => {
    const path = tempDbPath();
    const adapter = new InMemoryProviderAdapter({ provider: 'mailgun' });

    const first = openStack(path, adapter);
    await first.engine.handleEvent(emailSentEvent());
    const exceptionId = first.exceptions.listOpen()[0]!.exception_id;
    first.engine.resolveException(exceptionId, {
      resolution: '已核对为历史数据',
      reason: '导入批次 2024-Q1',
      actor_id: 'user_7',
    });
    closeStack(first);

    const second = openStack(path, adapter);
    const record = second.exceptions.get(exceptionId);
    expect(record).toMatchObject({
      status: 'resolved',
      resolution: '已核对为历史数据',
      resolved_by: 'user_7',
    });
    expect(record?.resolved_at).toBeTruthy();

    const entry = second.audit.list().find((item) => item.action === 'exception_resolved');
    expect(entry).toMatchObject({
      exception_id: exceptionId,
      reason: '导入批次 2024-Q1',
      actor: { actor_type: 'user', actor_id: 'user_7' },
    });
    closeStack(second);
  });

  it('重放在重启后仍走正常路径且不产生重复业务效果', async () => {
    const path = tempDbPath();
    const adapter = new InMemoryProviderAdapter({ provider: 'mailgun' });

    const first = openStack(path, adapter);
    // 无 Workflow 的结果事件 → 异常且事件保持 pending
    await first.engine.handleEvent(emailSentEvent());
    const exceptionId = first.exceptions.listOpen()[0]!.exception_id;
    await first.engine.handleEvent(leadWithContact());
    await first.engine.handleEvent(leadAssignedEvent());
    const attemptsBefore = adapter.submitted().length;
    closeStack(first);

    const second = openStack(path, adapter);
    const replayed = await second.engine.replayException(exceptionId, {
      resolution: '补投历史事件',
      actor_id: 'user_7',
    });

    expect(replayed.event_status).toBe('processed');
    expect(replayed.exception.status).toBe('resolved');
    // 重放不会带来新的外部副作用
    expect(adapter.submitted()).toHaveLength(attemptsBefore);
    // 可继续按正常路径推进
    const replied = await second.engine.handleEvent(emailRepliedEvent());
    expect(replied.status).toBe('processed');
    expect(second.workflows.get(WORKFLOW_ID)?.status).toBe('needs_review');

    const audit = second.audit.list().find((entry) => entry.action === 'exception_replayed');
    expect(audit).toMatchObject({ exception_id: exceptionId, result: 'succeeded' });
    closeStack(second);
  });

  it('重放同一异常两次是幂等的：第二次返回 duplicate', async () => {
    const path = tempDbPath();
    const adapter = new InMemoryProviderAdapter({ provider: 'mailgun' });

    const stack = openStack(path, adapter);
    await stack.engine.handleEvent(emailSentEvent());
    const exceptionId = stack.exceptions.listOpen()[0]!.exception_id;
    await stack.engine.handleEvent(leadWithContact());
    await stack.engine.handleEvent(leadAssignedEvent());

    const first = await stack.engine.replayException(exceptionId, { resolution: '补投', actor_id: 'user_7' });
    const second = await stack.engine.replayException(exceptionId, { resolution: '再补一次', actor_id: 'user_7' });

    expect(first.event_status).toBe('processed');
    expect(second.event_status).toBe('duplicate');
    expect(adapter.submitted()).toHaveLength(1);
    closeStack(stack);
  });
});
