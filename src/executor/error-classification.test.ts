import { describe, expect, it } from 'vitest';

import { proposedAction } from '../testing/fixtures';
import { InMemoryExecutor } from './in-memory';

describe('Executor error classification contract', () => {
  it('transient and permanent failures are distinguishable', async () => {
    const transient = Object.assign(new Error('provider unavailable'), {
      classification: 'transient' as const,
    });
    const permanent = Object.assign(new Error('invalid recipient'), {
      classification: 'permanent' as const,
    });
    const transientExecutor = new InMemoryExecutor();
    const permanentExecutor = new InMemoryExecutor();
    transientExecutor.failNext(transient);
    permanentExecutor.failNext(permanent);

    await expect(transientExecutor.execute(proposedAction())).rejects.toMatchObject({
      classification: 'transient',
    });
    await expect(permanentExecutor.execute(proposedAction())).rejects.toMatchObject({
      classification: 'permanent',
    });
  });

  it('timeout is classified as transient by default', async () => {
    const timeout = Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' });
    const executor = new InMemoryExecutor();
    executor.failNext(timeout);

    await expect(executor.execute(proposedAction())).rejects.toMatchObject({
      classification: 'transient',
    });
  });
});
