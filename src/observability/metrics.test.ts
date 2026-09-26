import { describe, expect, it } from 'vitest';

import {
  InMemoryAuditLog,
  InMemoryExceptionQueue,
  InMemoryWorkflowStateStore,
} from '../stores/in-memory';
import type { AuditLogStore, ExceptionQueueStore, WorkflowStateStore } from '../stores/interfaces';
import { workflowState } from '../testing/fixtures';
import { RuntimeMetrics } from './metrics';

function createMetrics() {
  const workflow_store = new InMemoryWorkflowStateStore();
  const exception_queue = new InMemoryExceptionQueue();
  const audit_log = new InMemoryAuditLog();
  const metrics = new RuntimeMetrics({ workflow_store, exception_queue, audit_log });
  return { metrics, workflow_store, exception_queue, audit_log };
}

describe('RuntimeMetrics', () => {
  it('记录事件接收结果并单调累计', () => {
    const { metrics } = createMetrics();

    metrics.recordEvent('processed');
    metrics.recordEvent('processed');
    metrics.recordEvent('conflict');

    expect(metrics.get('events.total')).toBe(3);
    expect(metrics.get('events.processed')).toBe(2);
    expect(metrics.get('events.conflict')).toBe(1);
  });

  it('snapshot 派生当前 State 与异常/审计 gauges', () => {
    const { metrics, workflow_store, exception_queue, audit_log } = createMetrics();

    workflow_store.save(workflowState({ workflow_instance_id: 'wf_1', status: 'running' }));
    workflow_store.save(workflowState({ workflow_instance_id: 'wf_2', subject_id: 'lead_2', status: 'waiting_result' }));
    exception_queue.enqueue({
      occurred_at: '2026-09-24T10:00:00+08:00',
      reason: 'unmatched_event',
      event_id: 'evt_1',
      event: {},
      subject: null,
    });
    audit_log.append({
      occurred_at: '2026-09-24T10:00:00+08:00',
      actor: { actor_type: 'system', actor_id: 'x' },
      action: 'event_processed',
      subject: { subject_type: 'event', subject_id: 'evt_1', workflow_instance_id: null },
      event_id: 'evt_1',
      action_id: null,
      action_type: null,
      before_state: null,
      after_state: null,
      reason: null,
      policy_version: null,
      plan_version: null,
      source: 'webhook',
      result: 'succeeded',
      provider_reference: null,
      provider_receipt: null,
      exception_id: null,
    });

    const snapshot = metrics.snapshot();

    expect(snapshot.workflows_by_status).toEqual({ running: 1, waiting_result: 1 });
    expect(snapshot.open_exceptions).toBe(1);
    expect(snapshot.total_exceptions).toBe(1);
    expect(snapshot.audit_entries).toBe(1);
    expect(snapshot.counters['events.total']).toBeUndefined();
  });

  it('counters 返回按名称排序的副本', () => {
    const { metrics } = createMetrics();

    metrics.recordEvent('processed');
    metrics.recordEvent('failed');

    const counters = metrics.counters();
    expect(Object.keys(counters)).toEqual(['events.failed', 'events.processed', 'events.total']);
  });

  it('snapshot does not materialize whole tables', () => {
    const boom = (): never => {
      throw new Error('snapshot must not trigger a full table materialization');
    };
    const metrics = new RuntimeMetrics({
      workflow_store: {
        list: boom,
        countByStatus: () => ({ running: 2, failed: 1 }),
      } as unknown as WorkflowStateStore,
      exception_queue: {
        list: boom,
        listOpen: boom,
        count: (status?: string) => (status === 'open' ? 4 : 6),
      } as unknown as ExceptionQueueStore,
      audit_log: { list: boom, count: () => 128 } as unknown as AuditLogStore,
    });

    expect(metrics.snapshot()).toEqual({
      counters: {},
      workflows_by_status: { failed: 1, running: 2 },
      open_exceptions: 4,
      total_exceptions: 6,
      audit_entries: 128,
    });
  });
});
