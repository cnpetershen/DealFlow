import { describe, expect, it } from 'vitest';

import { JsonLogger } from '../observability/logger';
import { installSignalHandlers } from './signals';

function silentLogger(): JsonLogger {
  return new JsonLogger({ sink: () => {}, now: () => '2026-09-24T10:00:00+08:00' });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('installSignalHandlers', () => {
  it('SIGTERM 触发优雅关闭并以 0 退出', async () => {
    const reasons: string[] = [];
    const exits: number[] = [];
    const dispose = installSignalHandlers(
      {
        shutdown: async (reason?: string) => {
          reasons.push(reason ?? 'none');
        },
      },
      { logger: silentLogger(), onExit: (code) => exits.push(code), signals: ['SIGTERM'] },
    );

    try {
      process.emit('SIGTERM');
      await flushMicrotasks();

      expect(reasons).toEqual(['SIGTERM']);
      expect(exits).toEqual([0]);
    } finally {
      dispose();
    }
  });

  it('重复信号表示希望立即终止，直接以非零码退出', async () => {
    const reasons: string[] = [];
    const exits: number[] = [];
    const dispose = installSignalHandlers(
      {
        shutdown: async (reason?: string) => {
          reasons.push(reason ?? 'none');
        },
      },
      { logger: silentLogger(), onExit: (code) => exits.push(code), signals: ['SIGINT'] },
    );

    try {
      process.emit('SIGINT');
      process.emit('SIGINT');
      await flushMicrotasks();

      expect(reasons).toEqual(['SIGINT']);
      // 强制退出码优先，且不会被优雅关闭的完成回调覆盖。
      expect(exits).toEqual([1]);
    } finally {
      dispose();
    }
  });

  it('shutdown 失败时以 1 退出且记录结构化错误', async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const logger = new JsonLogger({
      sink: (line) => lines.push(line),
      now: () => '2026-09-24T10:00:00+08:00',
    });
    const dispose = installSignalHandlers(
      {
        shutdown: async () => {
          throw new Error('sqlite busy');
        },
      },
      { logger, onExit: (code) => exits.push(code), signals: ['SIGTERM'] },
    );

    try {
      process.emit('SIGTERM');
      await flushMicrotasks();

      expect(exits).toEqual([1]);
      expect(lines.some((line) => line.includes('dealflow.shutdown.failed') && line.includes('sqlite busy'))).toBe(true);
    } finally {
      dispose();
    }
  });

  it('退出回调带 force 标记：强制路径才会触发硬退出', async () => {
    const calls: Array<{ code: number; force: boolean }> = [];
    const dispose = installSignalHandlers(
      { shutdown: async () => {} },
      {
        logger: silentLogger(),
        onExit: (code, exitOptions) => calls.push({ code, force: exitOptions?.force === true }),
        signals: ['SIGINT'],
      },
    );

    try {
      process.emit('SIGINT');
      await flushMicrotasks();
      expect(calls).toEqual([{ code: 0, force: false }]);

      process.emit('SIGINT');
      await flushMicrotasks();
      // 第二次信号：默认实现据此调用 process.exit，否则卡住的 shutdown 永远杀不掉进程。
      expect(calls).toEqual([
        { code: 0, force: false },
        { code: 1, force: true },
      ]);
    } finally {
      dispose();
    }
  });

  it('dispose 注销全部监听器，不泄漏信号处理', () => {
    const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    const dispose = installSignalHandlers(
      { shutdown: async () => {} },
      { logger: silentLogger(), onExit: () => {} },
    );

    expect(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')).toBe(before + 2);

    dispose();

    expect(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')).toBe(before);
  });
});
