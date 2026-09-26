import { createApplication } from './app/bootstrap';
import { checkRuntime } from './app/runtime';
import { installSignalHandlers } from './app/signals';
import { loadConfigFromEnv } from './config/config';
import { JsonLogger, type StructuredLogger } from './observability/logger';

/**
 * 进程入口：校验运行时 → 加载配置 → 初始化 SQLite/Store/Engine/Provider/HTTP Server → 监听。
 * 收到 SIGTERM / SIGINT 时先停止接收新请求，再关闭 SQLite，保证不产生部分提交。
 */
// 配置还没加载时也要能记错误，先给一个不过滤的兜底 logger；
// 读到 observability.log_level 之后换成带级别的 logger。
let logger: StructuredLogger = new JsonLogger();
const runtime = checkRuntime();

if (!runtime.ok) {
  logger.log('error', 'dealflow.runtime.unsupported', {
    version: runtime.version,
    minimum: runtime.minimum,
    detail: runtime.detail,
  });
  process.exitCode = 1;
} else {
  // createApplication 也放在 try 内：配置非法（ZodError / ConfigEnvError）必须走
  // dealflow.start.failed 这条结构化日志 + 优雅关闭，而不是抛裸堆栈出去。
  let app: ReturnType<typeof createApplication> | undefined;
  try {
    const config = loadConfigFromEnv();
    logger = new JsonLogger({ level: config.observability.log_level });

    app = createApplication({ config, logger });
    installSignalHandlers(app, { logger });

    // 先做启动恢复（重放事件日志 / 重投 pending 事件），再开始接收请求：
    // 这样恢复期间的写入不会与在途请求相互干扰。
    const recovery = await app.recoverOnStart();
    if (recovery.rebuilt_from_event_log || recovery.reprocessed_pending > 0 || recovery.skipped_blocked > 0) {
      logger.log('info', 'dealflow.recovery.complete', { ...recovery });
    }

    const address = await app.start();
    logger.log('info', 'dealflow.ready', {
      url: address === null ? null : `http://${app.config.server.host}:${address.port}`,
    });
  } catch (error) {
    logger.log('error', 'dealflow.start.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (app !== undefined) {
      await app.shutdown('start-failed');
    }
    process.exitCode = 1;
  }
}
