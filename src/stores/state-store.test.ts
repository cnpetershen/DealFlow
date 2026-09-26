import { describe, expect, it } from 'vitest';

import { dealState, leadState, workflowState } from '../testing/fixtures';
import { InMemoryStateStore, InMemoryWorkflowStateStore } from './in-memory';
import { WorkflowBusinessKeyConflictError } from './interfaces';
import { workflowBusinessKey } from './types';

describe('InMemoryStateStore', () => {
  it('未写入的 id 返回 undefined', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof leadState>) => state.lead_id);

    expect(store.get('lead_1')).toBeUndefined();
  });

  it('保存后可读取当前事实', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof leadState>) => state.lead_id);
    store.save(leadState());

    expect(store.get('lead_1')).toEqual(leadState());
    expect(store.list()).toHaveLength(1);
  });

  it('同 id 重复保存覆盖旧事实，只保留一条当前事实', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof leadState>) => state.lead_id);
    store.save(leadState());
    store.save(leadState({ status: 'assigned', owner_id: 'user_7' }));

    expect(store.get('lead_1')?.status).toBe('assigned');
    expect(store.get('lead_1')?.owner_id).toBe('user_7');
    expect(store.list()).toHaveLength(1);
  });

  it('不同 id 各自保存', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof dealState>) => state.deal_id);
    store.save(dealState({ deal_id: 'deal_1' }));
    store.save(dealState({ deal_id: 'deal_2', stage: 'discovery' }));

    expect(store.list()).toHaveLength(2);
    expect(store.get('deal_2')?.stage).toBe('discovery');
  });

  it('保存的是快照：修改传入对象不影响当前事实', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof leadState>) => state.lead_id);
    const state = leadState();
    store.save(state);

    state.owner_id = 'user_7';
    state.status = 'assigned';

    expect(store.get('lead_1')?.owner_id).toBeNull();
    expect(store.get('lead_1')?.status).toBe('new');
  });

  it('读取到的当前事实不可被修改', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof leadState>) => state.lead_id);
    store.save(leadState());
    const stored = store.get('lead_1');

    expect(() => {
      (stored as { status: string }).status = 'tampered';
    }).toThrow(TypeError);
    expect(store.get('lead_1')?.status).toBe('new');
  });

  it('list 返回副本，外部修改不影响 Store', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof leadState>) => state.lead_id);
    store.save(leadState());

    const listed = store.list() as unknown[];
    listed.length = 0;

    expect(store.list()).toHaveLength(1);
  });

  it('listByLeadId 只返回带该 lead_id 的记录，且与 list() 插入序一致', () => {
    const store = new InMemoryStateStore((state: ReturnType<typeof dealState>) => state.deal_id);
    store.save(dealState());
    store.save(dealState({ deal_id: 'deal_2', lead_id: 'lead_2' }));
    store.save(dealState({ deal_id: 'deal_3', lead_id: 'lead_1' }));

    expect(store.listByLeadId('lead_1').map((deal) => deal.deal_id)).toEqual(['deal_1', 'deal_3']);
    expect(store.listByLeadId('lead_missing')).toEqual([]);
    expect(store.list()).toHaveLength(3);
  });

  it('没有 lead_id 字段的实体类型恒返回空，而不是抛错', () => {
    const workflows = new InMemoryStateStore(
      (state: ReturnType<typeof workflowState>) => state.workflow_instance_id,
    );
    workflows.save(workflowState());

    expect(workflows.listByLeadId('lead_1')).toEqual([]);
  });
});

describe('InMemoryWorkflowStateStore', () => {
  it('按业务 key 查找唯一实例', () => {
    const store = new InMemoryWorkflowStateStore();
    store.save(workflowState());

    const key = workflowBusinessKey({
      workflow_type: 'lead_follow_up',
      subject_type: 'lead',
      subject_id: 'lead_1',
    });

    expect(store.findByBusinessKey(key)?.workflow_instance_id).toBe('wf_1');
  });

  it('业务 key 未命中时返回 undefined', () => {
    const store = new InMemoryWorkflowStateStore();
    store.save(workflowState());

    expect(store.findByBusinessKey('lead_follow_up:lead:lead_2')).toBeUndefined();
  });

  it('同一实例重复保存是幂等的，只保留一条流程', () => {
    const store = new InMemoryWorkflowStateStore();
    store.save(workflowState());
    store.save(workflowState({ status: 'running', plan_version: 2 }));

    expect(store.list()).toHaveLength(1);
    expect(store.get('wf_1')?.plan_version).toBe(2);
  });

  it('同一业务 key 用不同实例 id 保存时拒绝创建第二条流程', () => {
    const store = new InMemoryWorkflowStateStore();
    store.save(workflowState());

    expect(() =>
      store.save(workflowState({ workflow_instance_id: 'wf_2' })),
    ).toThrow(WorkflowBusinessKeyConflictError);
    expect(store.list()).toHaveLength(1);
  });

  it('不同 workflow_type 的实例可以并存', () => {
    const store = new InMemoryWorkflowStateStore();
    store.save(workflowState());
    store.save(workflowState({ workflow_instance_id: 'wf_2', workflow_type: 'renewal' }));

    expect(store.list()).toHaveLength(2);
  });

  it('不同 subject_id 的实例可以并存', () => {
    const store = new InMemoryWorkflowStateStore();
    store.save(workflowState());
    store.save(workflowState({ workflow_instance_id: 'wf_2', subject_id: 'lead_2' }));

    expect(store.list()).toHaveLength(2);
  });
});