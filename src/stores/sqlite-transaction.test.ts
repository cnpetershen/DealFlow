import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RuleBasedDecider } from '../decision/rule-based-decider';
import { InMemoryExecutor } from '../executor/in-memory';
import { RuleBasedPolicyEvaluator } from '../policy/rule-based-policy';
import {
  contactState,
  dealCreatedEvent,
  leadAssignedEvent,
  leadCreatedEvent,
  leadState,
  workflowState,
} from '../testing/fixtures';
import { WorkflowEngine } from '../workflow/engine';
import type { AuditLogStore, AuditQuery } from './interfaces';
import { SqliteEventStore } from './sqlite';
import { openSqlite } from './sqlite-db';
import {
  SqliteAuditLog,
  SqliteExceptionQueue,
  SqliteStateStore,
  SqliteWorkflowStateStore,
} from './sqlite-stores';
import { SqliteUnitOfWork } from './sqlite-unit-of-work';
import type { AuditEntry, ContactState, DealState, LeadState, NewAuditEntry } from './types';

const WORKFLOW_ID = 'wf_lead_follow_up_lead_1';
const LEAD_ASSIGNED_KEY = 'lead.assigned:lead_1:user_7:1';
const DEAL_CREATED_KEY = 'deal.created:deal_1';
const NOW = '2026-09-24T10:00:00+08:00';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-tx-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'dealflow.db');
}

/**
 * 故障注入用 Audit Log：委托真实 SQLite 实现，因此在事务内抛错会触发整体回滚，
 * 而不是像替换成内存 Store 那样绕过事务语义。
 */
class FaultyAuditLog implements AuditLogStore {
  readonly #inner: AuditLogStore;
  #remaining = 0;
  #matchAction: NewAuditEntry['action'] | null = null;

  constructor(inner: AuditLogStore) {
    this.#inner = inner;
  }

  /** 接下来 n 次 append 失败（任意 action）。 */
  failNext(times = 1): void {
    this.#remaining = times;
    this.#matchAction = null;
  }

  /** 只有指定 action 的 append 失败，便于精确命中某个事务阶段。 */
  failOnAction(action: NewAuditEntry['action'], times = 1): void {
    this.#remaining = times;
    this.#matchAction = action;
  }

  append(entry: NewAuditEntry): AuditEntry {
    if (this.#remaining > 0 && (this.#matchAction === null || this.#matchAction === entry.action)) {
      this.#remaining -= 1;
      throw new Error('audit unavailable (injected failure)');
    }
    return this.#inner.append(entry);
  }

  get(auditId: string): AuditEntry | undefined {
    return this.#inner.get(auditId);
  }

  list(): readonly AuditEntry[] {
    return this.#inner.list();
  }

  listByEventId(eventId: string): readonly AuditEntry[] {
    return this.#inner.listByEventId(eventId);
  }

  listByActionId(actionId: string): readonly AuditEntry[] {
    return this.#inner.listByActionId(actionId);
  }

  query(filter: AuditQuery): readonly AuditEntry[] {
    return this.#inner.query(filter);
  }

  count(filter: AuditQuery): number {
    return this.#inner.count(filter);
  }
}

interface Stack {
  engine: WorkflowEngine;
  events: SqliteEventStore;
  audit: FaultyAuditLog;
  workflows: SqliteWorkflowStateStore;
  leads: SqliteStateStore<LeadState>;
  deals: SqliteStateStore<DealState>;
  executor: InMemoryExecutor;
  close: () => void;
}

/** 全部 Store 复用同一 SQLite 连接，并注入 SqliteUnitOfWork。 */
function createStack(dbPath: string): Stack {
  const sqlite = openSqlite({ path: dbPath });
  const events = new SqliteEventStore({ sqlite });
  const audit = new FaultyAuditLog(new SqliteAuditLog({ sqlite }));
  const exceptions = new SqliteExceptionQueue({ sqlite });
  const workflows = new SqliteWorkflowStateStore({ sqlite });
  const leads = new SqliteStateStore<LeadState>('lead', (state) => state.lead_id, { sqlite });
  const contacts = new SqliteStateStore<ContactState>('contact', (state) => state.contact_id, { sqlite });
  const deals = new SqliteStateStore<DealState>('deal', (state) => state.deal_id, { sqlite });
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
    decider: new RuleBasedDecider({ createActionId: (() => { let n = 0; return () => `action_${++n}`; })() }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: (contactId) => contactState({ contact_id: contactId }),
    unit_of_work: new SqliteUnitOfWork(sqlite),
    now: () => NOW,
  });

  return { engine, events, audit, workflows, leads, deals, executor, close: () => sqlite.close() };
}

describe('SqliteUnitOfWork', () => {
  it('成功时把多个 Store 的写入作为一个事务一起提交', () => {
    const sqlite = openSqlite({ path: tempDbPath() });
    cleanups.push(() => sqlite.close());
    const workflows = new SqliteWorkflowStateStore({ sqlite });
    const leads = new SqliteStateStore<LeadState>('lead', (state) => state.lead_id, { sqlite });
    const unitOfWork = new SqliteUnitOfWork(sqlite);

    unitOfWork.run(() => {
      workflows.save(workflowState());
      leads.save(leadState());
    });

    expect(workflows.list()).toHaveLength(1);
    expect(leads.list()).toHaveLength(1);
  });

  it('抛错时整体回滚，不留下任何部分提交', () => {
    const sqlite = openSqlite({ path: tempDbPath() });
    cleanups.push(() => sqlite.close());
    const workflows = new SqliteWorkflowStateStore({ sqlite });
    const leads = new SqliteStateStore<LeadState>('lead', (state) => state.lead_id, { sqlite });
    const unitOfWork = new SqliteUnitOfWork(sqlite);

    expect(() =>
      unitOfWork.run(() => {
        workflows.save(workflowState());
        leads.save(leadState());
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(workflows.list()).toHaveLength(0);
    expect(leads.list()).toHaveLength(0);
  });

  it('嵌套调用复用外层事务，内层不会提前提交', () => {
    const sqlite = openSqlite({ path: tempDbPath() });
    cleanups.push(() => sqlite.close());
    const workflows = new SqliteWorkflowStateStore({ sqlite });
    const unitOfWork = new SqliteUnitOfWork(sqlite);

    expect(() =>
      unitOfWork.run(() => {
        unitOfWork.run(() => {
          workflows.save(workflowState());
        });
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');

    expect(workflows.list()).toHaveLength(0);
  });
});

describe('Event 处理的事务边界', () => {
  it('阶段一写入中途失败时整体回滚：Deal 与 Workflow 推进都不留部分提交', async () => {
    const stack = createStack(tempDbPath());
    cleanups.push(stack.close);

    await stack.engine.handleEvent(leadCreatedEvent());
    expect(stack.workflows.get(WORKFLOW_ID)?.last_processed_event_id).toBe('evt_0001');

    // deal.created 的事实合并先写 Deal，再推进 Workflow，最后写 event_processed 审计；
    // 让该审计失败，则前面两次写入必须一起回滚。
    stack.audit.failNext();
    const result = await stack.engine.handleEvent(dealCreatedEvent());

    expect(result.status).toBe('failed');
    expect(stack.deals.list()).toHaveLength(0);
    expect(stack.workflows.get(WORKFLOW_ID)?.last_processed_event_id).toBe('evt_0001');
    expect(stack.audit.listByEventId('evt_0006').some((entry) => entry.action === 'event_processed')).toBe(false);
    expect(stack.events.getByIdempotencyKey(DEAL_CREATED_KEY)?.processing_status).toBe('pending');
  });

  it('阶段二派发结果写入失败时回滚，且不重复触发外部副作用', async () => {
    const stack = createStack(tempDbPath());
    cleanups.push(stack.close);

    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );

    stack.audit.failOnAction('action_dispatched');
    const result = await stack.engine.handleEvent(leadAssignedEvent());

    expect(result.status).toBe('failed');
    // 阶段一已提交：Lead 事实保留（重试时按同一事件幂等合并）。
    expect(stack.leads.get('lead_1')).toMatchObject({ status: 'assigned', owner_id: 'user_7' });
    // 阶段二回滚：没有 action_dispatched，Workflow 未进入 waiting_result。
    expect(stack.audit.list().some((entry) => entry.action === 'action_dispatched')).toBe(false);
    expect(stack.workflows.get(WORKFLOW_ID)?.status).not.toBe('waiting_result');
    expect(stack.workflows.get(WORKFLOW_ID)?.current_step).not.toBe('send_email');
    expect(stack.events.getByIdempotencyKey(LEAD_ASSIGNED_KEY)?.processing_status).toBe('pending');
    expect(stack.executor.attempts()).toHaveLength(1);
  });

  it('成功处理时 Event 处理状态与 Workflow/Audit 在同一事务内提交', async () => {
    const stack = createStack(tempDbPath());
    cleanups.push(stack.close);

    await stack.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    const result = await stack.engine.handleEvent(leadAssignedEvent());

    expect(result.status).toBe('processed');
    expect(stack.workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
      current_step: 'send_email',
    });
    expect(stack.events.getByIdempotencyKey(LEAD_ASSIGNED_KEY)?.processing_status).toBe('processed');
    expect(stack.audit.list().some((entry) => entry.action === 'action_dispatched')).toBe(true);
  });

  it('回滚后重启：pending 事件在无故障环境下用同一 idempotency_key 完成处理', async () => {
    const dbPath = tempDbPath();

    const first = createStack(dbPath);
    await first.engine.handleEvent(leadCreatedEvent());
    first.audit.failNext();
    const failed = await first.engine.handleEvent(dealCreatedEvent());

    expect(failed.status).toBe('failed');
    expect(first.deals.list()).toHaveLength(0);
    expect(first.events.getByIdempotencyKey(DEAL_CREATED_KEY)?.processing_status).toBe('pending');
    first.close();

    const second = createStack(dbPath);
    cleanups.push(second.close);
    const retried = await second.engine.handleEvent(dealCreatedEvent());

    expect(retried.status).toBe('processed');
    expect(second.deals.get('deal_1')).toMatchObject({ deal_id: 'deal_1', stage: 'qualification' });
    expect(second.events.getByIdempotencyKey(DEAL_CREATED_KEY)?.processing_status).toBe('processed');
    expect(second.workflows.get(WORKFLOW_ID)?.last_processed_event_id).toBe('evt_0006');
  });

  it('重启后已提交的事务结果保持可读，不会重复产生业务效果', async () => {
    const dbPath = tempDbPath();

    const first = createStack(dbPath);
    await first.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    await first.engine.handleEvent(leadAssignedEvent());
    expect(first.executor.attempts()).toHaveLength(1);
    first.close();

    const second = createStack(dbPath);
    cleanups.push(second.close);
    expect(second.workflows.get(WORKFLOW_ID)).toMatchObject({
      status: 'waiting_result',
      awaiting_event_types: ['email.sent'],
    });
    expect(second.leads.get('lead_1')).toMatchObject({ status: 'assigned', owner_id: 'user_7' });

    // 同一事件再次投递：已处理，不再派发第二次外部副作用。
    const duplicate = await second.engine.handleEvent(
      leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }),
    );
    expect(duplicate.status).toBe('duplicate');
    expect(second.executor.attempts()).toHaveLength(0);
  });
});
