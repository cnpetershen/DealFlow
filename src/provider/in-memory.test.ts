import { describe, expect, it } from 'vitest';

import { proposedAction } from '../testing/fixtures';
import { InMemoryProviderAdapter } from './in-memory';
import { providerAdapterContractCases } from './contract';
import { ProviderAdapterExecutor } from './executor';

describe('InMemoryProviderAdapter 契约', () => {
  for (const contractCase of providerAdapterContractCases(() => new InMemoryProviderAdapter())) {
    it(contractCase.name, async () => {
      expect(await contractCase.observe()).toMatchObject(contractCase.expected);
    });
  }
});

describe('InMemoryProviderAdapter 失败分类', () => {
  it('transient 失败提交后按 transient 分类且 submitted=false', async () => {
    const adapter = new InMemoryProviderAdapter();
    adapter.failNext(Object.assign(new Error('provider unavailable'), { classification: 'transient' as const }));

    await expect(adapter.submit(proposedAction())).rejects.toMatchObject({
      classification: 'transient',
      submitted: false,
    });
  });

  it('permanent 失败提交后按 permanent 分类且 submitted=false', async () => {
    const adapter = new InMemoryProviderAdapter();
    adapter.failNext(Object.assign(new Error('invalid recipient'), { classification: 'permanent' as const }));

    await expect(adapter.submit(proposedAction())).rejects.toMatchObject({
      classification: 'permanent',
      submitted: false,
    });
  });

  it('timeout 提交后按 transient 分类且 submitted=unknown', async () => {
    const adapter = new InMemoryProviderAdapter();
    adapter.failNext(Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' }));

    await expect(adapter.submit(proposedAction())).rejects.toMatchObject({
      classification: 'transient',
      submitted: 'unknown',
      code: 'TIMEOUT',
    });
  });

  it('失败后同一执行幂等 key 仍可重试，成功后 reconcile 到 submitted=true', async () => {
    const adapter = new InMemoryProviderAdapter();
    adapter.failNext(Object.assign(new Error('busy'), { classification: 'transient' as const }));
    const action = proposedAction();

    await expect(adapter.submit(action)).rejects.toMatchObject({ classification: 'transient' });

    const retry = await adapter.submit(action);
    expect(retry.status).toBe('accepted');
    expect(adapter.submitted()).toHaveLength(2);

    const reconciliation = await adapter.reconcile(action);
    expect(reconciliation).toMatchObject({ submitted: true });
  });
});

describe('ProviderAdapterExecutor', () => {
  it('按动作类型路由到声明的 Provider Adapter', async () => {
    const adapter = new InMemoryProviderAdapter({ provider: 'sendgrid', action_types: ['send_email'] });
    const executor = new ProviderAdapterExecutor([adapter]);

    const result = await executor.execute(proposedAction());

    expect(result).toMatchObject({ status: 'accepted', action_id: 'action_1' });
  });

  it('重复执行同一动作返回 duplicate', async () => {
    const adapter = new InMemoryProviderAdapter({ provider: 'sendgrid', action_types: ['send_email'] });
    const executor = new ProviderAdapterExecutor([adapter]);
    const action = proposedAction();

    await executor.execute(action);
    const duplicate = await executor.execute(action);

    expect(duplicate.status).toBe('duplicate');
  });

  it('没有适配器支持该动作类型时抛 permanent 失败', async () => {
    const adapter = new InMemoryProviderAdapter({ provider: 'sendgrid', action_types: ['send_email'] });
    const executor = new ProviderAdapterExecutor([adapter]);

    await expect(executor.execute(proposedAction({ action_type: 'schedule_meeting' }))).rejects.toMatchObject(
      { classification: 'permanent' },
    );
  });
});
