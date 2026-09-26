import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { auditEntryInput, dealState, exceptionInput, leadCreatedEvent, leadState, workflowState } from '../testing/fixtures';
import { openSqlite, type SqliteDatabase } from './sqlite-db';
import { SqliteEventStore } from './sqlite';
import {
  SqliteAuditLog,
  SqliteExceptionQueue,
  SqliteStateStore,
  SqliteWorkflowStateStore,
} from './sqlite-stores';
import { ExceptionNotFoundError, WorkflowBusinessKeyConflictError } from './interfaces';
import { workflowBusinessKey, type DealState, type LeadState } from './types';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDb(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-sqlite-stores-'));
  const dbPath = join(dir, 'dealflow.db');
  const sqlite = openSqlite({ path: dbPath });
  cleanups.push(() => {
    if (sqlite.db.isOpen) sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return sqlite;
}

describe('SqliteAuditLog', () => {
  it('append-only：追加并生成递增 audit_id，重启后仍可查询', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dealflow-audit-')), 'a.db');
    cleanups.push(() => rmSync(join(path, '..'), { recursive: true, force: true }));

    const first = new SqliteAuditLog({ path });
    const one = first.append(auditEntryInput());
    const two = first.append(auditEntryInput({ event_id: 'evt_0002' }));
    first.close();

    const second = new SqliteAuditLog({ path });
    expect(one.audit_id).toBe('audit_1');
    expect(two.audit_id).toBe('audit_2');
    expect(second.get('audit_1')).toEqual(one);
    expect(second.list()).toHaveLength(2);
    second.close();
  });

  it('可按 event_id 与 action_id 查询链路', () => {
    const sqlite = tempDb();
    const log = new SqliteAuditLog({ sqlite });

    log.append(auditEntryInput({ action: 'event_processed' }));
    log.append(auditEntryInput({ action: 'action_dispatched', action_id: 'action_1' }));
    log.append(auditEntryInput({ event_id: 'evt_0002', action: 'event_processed' }));

    expect(log.listByEventId('evt_0001').map((e) => e.action)).toEqual([
      'event_processed',
      'action_dispatched',
    ]);
    expect(log.listByActionId('action_1').map((e) => e.action)).toEqual(['action_dispatched']);
  });

  it('保存的是深拷贝：修改传入对象不影响已写入记录', () => {
    const sqlite = tempDb();
    const log = new SqliteAuditLog({ sqlite });
    const input = auditEntryInput();
    log.append(input);
    input.reason = 'tampered';

    expect(log.get('audit_1')?.reason).toBeNull();
  });
});

describe('SqliteExceptionQueue', () => {
  it('入队生成 exception_id，resolve/discard 后 listOpen 不再返回', () => {
    const sqlite = tempDb();
    const queue = new SqliteExceptionQueue({ sqlite });

    const first = queue.enqueue(exceptionInput({ reason: 'idempotency_conflict' }));
    const second = queue.enqueue(exceptionInput({ reason: 'stale_event', event_id: 'evt_0003' }));

    expect(first.exception_id).toBe('exc_1');
    expect(first.status).toBe('open');
    expect(queue.listOpen()).toHaveLength(2);

    queue.resolve(second.exception_id, '已按当前事实重建');
    expect(queue.listOpen().map((r) => r.reason)).toEqual(['idempotency_conflict']);
    expect(queue.get(second.exception_id)).toMatchObject({
      status: 'resolved',
      resolution: '已按当前事实重建',
    });

    queue.discard(first.exception_id, '重复投递');
    expect(queue.listOpen()).toHaveLength(0);
  });

  it('处理不存在的异常抛出 ExceptionNotFoundError', () => {
    const sqlite = tempDb();
    const queue = new SqliteExceptionQueue({ sqlite });

    expect(() => queue.resolve('exc_404', 'x')).toThrow(ExceptionNotFoundError);
    expect(() => queue.discard('exc_404', 'x')).toThrow(ExceptionNotFoundError);
  });

  it('重启后异常记录不丢失', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dealflow-exc-')), 'e.db');
    cleanups.push(() => rmSync(join(path, '..'), { recursive: true, force: true }));

    const first = new SqliteExceptionQueue({ path });
    const record = first.enqueue(exceptionInput());
    first.close();

    const second = new SqliteExceptionQueue({ path });
    expect(second.get(record.exception_id)).toEqual(record);
    expect(second.listOpen()).toHaveLength(1);
    second.close();
  });
});

describe('SqliteWorkflowStateStore', () => {
  it('按业务 key 查找唯一实例，同一实例重复保存幂等', () => {
    const sqlite = tempDb();
    const store = new SqliteWorkflowStateStore({ sqlite });

    store.save(workflowState());
    store.save(workflowState({ status: 'running', plan_version: 2 }));

    const key = workflowBusinessKey({
      workflow_type: 'lead_follow_up',
      subject_type: 'lead',
      subject_id: 'lead_1',
    });
    expect(store.findByBusinessKey(key)?.plan_version).toBe(2);
    expect(store.list()).toHaveLength(1);
  });

  it('同一业务 key 用不同实例 id 保存时拒绝创建第二条流程', () => {
    const sqlite = tempDb();
    const store = new SqliteWorkflowStateStore({ sqlite });
    store.save(workflowState());

    expect(() => store.save(workflowState({ workflow_instance_id: 'wf_2' }))).toThrow(
      WorkflowBusinessKeyConflictError,
    );
    expect(store.list()).toHaveLength(1);
  });

  it('重启后 Workflow 状态与失败分类仍可读取', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dealflow-wf-')), 'w.db');
    cleanups.push(() => rmSync(join(path, '..'), { recursive: true, force: true }));

    const first = new SqliteWorkflowStateStore({ path });
    first.save(
      workflowState({
        status: 'failed',
        failure_classification: 'transient',
        failure_submitted: 'unknown',
        failure_retry_after: '2026-09-24T11:00:00+08:00',
      }),
    );
    first.close();

    const second = new SqliteWorkflowStateStore({ path });
    expect(second.get('wf_1')).toMatchObject({
      status: 'failed',
      failure_classification: 'transient',
      failure_submitted: 'unknown',
      failure_retry_after: '2026-09-24T11:00:00+08:00',
    });
    second.close();
  });
});

describe('SqliteStateStore', () => {
  it('Lead 与 Deal 按 entity_type 隔离存储当前事实', () => {
    const sqlite = tempDb();
    const leads = new SqliteStateStore('lead', (s: ReturnType<typeof leadState>) => s.lead_id, {
      sqlite,
    });
    const deals = new SqliteStateStore('deal', (s: ReturnType<typeof dealState>) => s.deal_id, {
      sqlite,
    });

    leads.save(leadState());
    deals.save(dealState());

    expect(leads.get('lead_1')).toEqual(leadState());
    expect(leads.get('deal_1')).toBeUndefined();
    expect(deals.get('deal_1')).toEqual(dealState());
    expect(leads.list()).toHaveLength(1);
    expect(deals.list()).toHaveLength(1);

    leads.save(leadState({ status: 'assigned', owner_id: 'user_7' }));
    expect(leads.get('lead_1')).toMatchObject({ status: 'assigned', owner_id: 'user_7' });
    expect(leads.list()).toHaveLength(1);
  });
});

describe('按 JSON 字段的点查', () => {
  it('Deal 按 lead_id 反查只返回该线索的记录，顺序与 list() 一致', () => {
    const sqlite = tempDb();
    const deals = new SqliteStateStore<DealState>('deal', (s) => s.deal_id, { sqlite });

    deals.save(dealState());
    deals.save(dealState({ deal_id: 'deal_2', lead_id: 'lead_2' }));
    deals.save(dealState({ deal_id: 'deal_3', lead_id: 'lead_1' }));

    expect(deals.listByLeadId('lead_1').map((deal) => deal.deal_id)).toEqual(['deal_1', 'deal_3']);
    expect(deals.listByLeadId('lead_missing')).toEqual([]);
    expect(deals.list()).toHaveLength(3);
  });

  it('Deal 反查走 idx_entity_state_lead，而不是扫全部 Deal', () => {
    const sqlite = tempDb();
    const leads = new SqliteStateStore<LeadState>('lead', (s) => s.lead_id, { sqlite });
    const deals = new SqliteStateStore<DealState>('deal', (s) => s.deal_id, { sqlite });
    for (let index = 0; index < 400; index += 1) {
      leads.save(leadState({ lead_id: `lead_${index}` }));
      deals.save(dealState({ deal_id: `deal_a_${index}`, lead_id: `lead_${index % 40}` }));
      deals.save(dealState({ deal_id: `deal_b_${index}`, lead_id: `lead_x_${index % 40}` }));
    }
    // 打开连接时表还是空的，统计要在数据落地后才反映索引选择性
    sqlite.refreshQueryStats();

    const plan = sqlite.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT state FROM entity_states
         WHERE entity_type = ? AND json_extract(state, '$.lead_id') = ?
         ORDER BY entity_id`,
      )
      .all('deal', 'lead_7') as unknown as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join('\n')).toContain('idx_entity_state_lead');
    expect(plan.map((row) => row.detail).join('\n')).not.toContain('SCAN entity_states');
  });

  it('事件按 event_id 取回单条，并走 idx_events_event_id', () => {
    const sqlite = tempDb();
    const events = new SqliteEventStore({ sqlite });
    events.append(leadCreatedEvent());
    events.append(leadCreatedEvent({ event_id: 'evt_0042', idempotency_key: 'lead.created:crm:rec_2002' }));

    expect(events.getByEventId('evt_0042')?.event.event_id).toBe('evt_0042');
    expect(events.getByEventId('evt_0001')?.event.idempotency_key).toBe('lead.created:crm:rec_1001');
    expect(events.getByEventId('evt_missing')).toBeUndefined();

    const plan = sqlite.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT sequence, idempotency_key, event, processing_status
         FROM events WHERE json_extract(event, '$.event_id') = ?
         ORDER BY sequence LIMIT 1`,
      )
      .all('evt_0001') as unknown as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join('\n')).toContain('idx_events_event_id');
    expect(plan.map((row) => row.detail).join('\n')).not.toContain('SCAN events');
  });
});

describe('分页与计数下推', () => {
  it('Workflow 列表按 status/limit/offset 下推，计数走 COUNT 而非全表物化', () => {
    const sqlite = tempDb();
    const store = new SqliteWorkflowStateStore({ sqlite });
    for (let index = 1; index <= 5; index += 1) {
      store.save(
        workflowState({
          workflow_instance_id: `wf_${index}`,
          subject_id: `lead_${index}`,
          status: index <= 2 ? 'failed' : 'waiting_result',
        }),
      );
    }

    expect(store.count()).toBe(5);
    expect(store.count('failed')).toBe(2);
    expect(store.countByStatus()).toEqual({ failed: 2, waiting_result: 3 });

    // 翻页顺序稳定（workflow_instance_id 升序），多取一条即可判断 has_more
    expect(store.list({ limit: 2 }).map((w) => w.workflow_instance_id)).toEqual(['wf_1', 'wf_2']);
    expect(store.list({ limit: 2, offset: 2 }).map((w) => w.workflow_instance_id)).toEqual([
      'wf_3',
      'wf_4',
    ]);
    expect(store.list({ limit: 2, offset: 4 }).map((w) => w.workflow_instance_id)).toEqual(['wf_5']);
    expect(store.list()).toHaveLength(5);

    // 状态过滤同样下推，而不是先把 5 条全读出来再在内存里筛
    expect(store.list({ status: 'failed' }).map((w) => w.workflow_instance_id)).toEqual([
      'wf_1',
      'wf_2',
    ]);
    expect(
      store.list({ status: 'failed', limit: 1, offset: 1 }).map((w) => w.workflow_instance_id),
    ).toEqual(['wf_2']);
    expect(store.count('missing')).toBe(0);
    expect(store.countByStatus()['missing']).toBeUndefined();
  });

  it('异常列表按 status/limit/offset 下推，count 用 COUNT(*)', () => {
    const sqlite = tempDb();
    const queue = new SqliteExceptionQueue({ sqlite });
    queue.enqueue(exceptionInput());
    queue.enqueue(exceptionInput({ reason: 'idempotency_conflict' }));
    const third = queue.enqueue(exceptionInput({ reason: 'unmatched_event' }));
    queue.resolve(third.exception_id, '人工确认后补录');

    expect(queue.count()).toBe(3);
    expect(queue.count('open')).toBe(2);
    expect(queue.count('resolved')).toBe(1);

    expect(queue.list({ limit: 2 })).toHaveLength(2);
    expect(queue.list({ limit: 2, offset: 2 })).toHaveLength(1);
    expect(queue.list({ status: 'open' })).toHaveLength(2);
    expect(queue.list({ status: 'resolved' })).toHaveLength(1);
    expect(queue.listOpen({ limit: 1 })).toHaveLength(1);
    expect(queue.listOpen()).toHaveLength(2);
    expect(queue.list()).toHaveLength(3);
  });
});

describe('共享连接', () => {
  it('Event / Audit / Workflow / Exception 复用同一 SqliteDatabase 时互不干扰', () => {
    const sqlite = tempDb();
    expect(sqlite.db.isOpen).toBe(true);

    const audit = new SqliteAuditLog({ sqlite });
    const exceptions = new SqliteExceptionQueue({ sqlite });
    const workflows = new SqliteWorkflowStateStore({ sqlite });
    audit.append(auditEntryInput());
    exceptions.enqueue(exceptionInput());
    workflows.save(workflowState());

    expect(audit.list()).toHaveLength(1);
    expect(exceptions.list()).toHaveLength(1);
    expect(workflows.list()).toHaveLength(1);

    // 外部持有 sqlite 时 close 不应关闭底层连接
    audit.close();
    expect(sqlite.db.isOpen).toBe(true);
  });
});
