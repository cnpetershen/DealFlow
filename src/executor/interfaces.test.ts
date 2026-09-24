import { describe, expect, it } from 'vitest';

import { proposedAction } from '../testing/fixtures';
import { InMemoryExecutor } from './in-memory';


describe('InMemoryExecutor', () => {
  it('成功发起动作并按执行幂等 key 去重', async () => {
    const executor = new InMemoryExecutor();
    const action = proposedAction();

    const first = await executor.execute(action);
    const second = await executor.execute(action);

    expect(first.status).toBe('accepted');
    expect(second).toMatchObject({ status: 'duplicate', execution_idempotency_key: action.execution_idempotency_key });
    expect(executor.attempts()).toHaveLength(1);
  });

  it('连接器失败时返回 failed 且允许同一 key 重试', async () => {
    let attempts = 0;
    const executor = new InMemoryExecutor({
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('provider unavailable');
        }
      },
    });
    const action = proposedAction();

    await expect(executor.execute(action)).rejects.toThrow('provider unavailable');
    const retry = await executor.execute(action);

    expect(retry.status).toBe('accepted');
    expect(executor.attempts()).toHaveLength(2);
  });

  it('不会把 Executor 接受动作误报为外部结果事件', async () => {
    const executor = new InMemoryExecutor();
    const result = await executor.execute(proposedAction());

    expect(result).toMatchObject({ status: 'accepted', action_id: 'action_1' });
    expect(result).not.toHaveProperty('result_event');
  });
});
