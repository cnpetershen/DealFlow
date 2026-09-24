import { describe, expect, it } from 'vitest';

import { proposedAction } from '../testing/fixtures';
import {
  allowsSimpleRetry,
  classifyExecutionError,
  ExecutionError,
} from './interfaces';
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

  it('timeout is classified as transient with submitted unknown', () => {
    const timeout = Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' });
    const classified = classifyExecutionError(timeout);

    expect(classified).toMatchObject({
      classification: 'transient',
      submitted: 'unknown',
      code: 'TIMEOUT',
    });
    expect(allowsSimpleRetry(classified)).toBe(false);
  });

  it('permanent without submitted is safe to mark as not submitted', () => {
    const permanent = classifyExecutionError(new Error('invalid recipient'));

    expect(permanent).toMatchObject({ classification: 'permanent', submitted: false });
    expect(allowsSimpleRetry(permanent)).toBe(false);
  });

  it('explicit transient without submitted defaults to submitted=false (safe retry)', () => {
    const transient = classifyExecutionError(
      Object.assign(new Error('busy'), { classification: 'transient' as const }),
    );

    expect(transient.submitted).toBe(false);
    expect(allowsSimpleRetry(transient)).toBe(true);
  });

  it('explicit submitted unknown blocks simple retry even when transient', () => {
    const classified = classifyExecutionError(
      Object.assign(new Error('socket hang up'), {
        classification: 'transient' as const,
        submitted: 'unknown' as const,
      }),
    );

    expect(classified).toMatchObject({ classification: 'transient', submitted: 'unknown' });
    expect(allowsSimpleRetry(classified)).toBe(false);
  });

  it('ExecutionError carries production contract fields', () => {
    const error = new ExecutionError('action_1', 'provider rejected', 'permanent', {
      code: 'INVALID_RECIPIENT',
      provider: 'sendgrid',
      provider_reference: null,
      retry_after: null,
      submitted: false,
    });

    expect(error).toMatchObject({
      actionId: 'action_1',
      classification: 'permanent',
      code: 'INVALID_RECIPIENT',
      provider: 'sendgrid',
      provider_reference: null,
      retry_after: null,
      submitted: false,
    });
  });

  it('classify preserves provider and retry_after when present', () => {
    const classified = classifyExecutionError(
      Object.assign(new Error('rate limited'), {
        classification: 'transient' as const,
        provider: 'mailgun',
        retry_after: '2026-09-24T11:00:00+08:00',
        submitted: false as const,
      }),
    );

    expect(classified).toMatchObject({
      provider: 'mailgun',
      retry_after: '2026-09-24T11:00:00+08:00',
      submitted: false,
    });
    expect(allowsSimpleRetry(classified)).toBe(true);
  });
});
