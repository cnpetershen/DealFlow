import { JsonLogger, type StructuredLogger } from '../observability/logger';

/** 只依赖 shutdown 的结构化入口，便于测试注入。 */
export interface ShutdownTarget {
  shutdown(reason?: string): Promise<void>;
}

export interface SignalHandlerOptions {
  readonly logger?: StructuredLogger;
  /**
   * 退出回调；`force` 为 true 表示运维第二次发信号要求立即终止。
   * 默认实现：优雅路径只写 `process.exitCode`（不打断正在写日志的进程），
   * 强制路径则先给 stdout 一个刷出窗口，随后 `process.exit` 硬退出——
   * Node 接管信号后已移除默认终止行为，若不真的调用 exit，
   * shutdown 卡住时反复 Ctrl+C 只会刷日志而进程永不退出。
   */
  readonly onExit?: (code: number, options?: { readonly force?: boolean }) => void;
  readonly signals?: readonly NodeJS.Signals[];
  /** 强制退出前留给 stdout 刷出日志的毫秒数。 */
  readonly force_exit_grace_ms?: number;
}

/**
 * 注册优雅关闭信号处理：首次信号触发 shutdown 并在完成后退出；
 * 再次收到信号表示运维希望立即终止，先刷日志再以非零码强制退出。
 * 返回注销函数，避免测试与多次启动之间泄漏监听器。
 */
export function installSignalHandlers(
  target: ShutdownTarget,
  options: SignalHandlerOptions = {},
): () => void {
  const logger = options.logger ?? new JsonLogger();
  const forceGraceMs = options.force_exit_grace_ms ?? 100;
  const onExit = options.onExit ?? ((code: number, exitOptions?: { readonly force?: boolean }) => {
    process.exitCode = code;
    if (exitOptions?.force === true) {
      const timer = setTimeout(() => {
        process.exit(code);
      }, forceGraceMs);
      timer.unref();
    }
  });
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const registered: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  let shuttingDown = false;
  let forced = false;

  for (const signal of signals) {
    const handler = (): void => {
      if (shuttingDown) {
        forced = true;
        logger.log('warn', 'dealflow.shutdown.forced', { signal });
        onExit(1, { force: true });
        return;
      }

      shuttingDown = true;
      logger.log('info', 'dealflow.shutdown.signal', { signal });

      void target
        .shutdown(signal)
        .then(() => {
          // 已被强制终止时不再写回成功退出码，避免覆盖运维的强制退出意图。
          if (!forced) {
            onExit(0);
          }
        })
        .catch((error: unknown) => {
          logger.log('error', 'dealflow.shutdown.failed', {
            signal,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!forced) {
            onExit(1);
          }
        });
    };

    process.on(signal, handler);
    registered.push({ signal, handler });
  }

  return () => {
    for (const { signal, handler } of registered) {
      process.off(signal, handler);
    }
  };
}
