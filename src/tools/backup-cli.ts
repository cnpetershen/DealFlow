import { loadConfigFromEnv } from '../config/config';
import { backupDatabase, defaultBackupPath, parseBackupArgs } from '../runtime/backup';

export interface BackupCliIo {
  /** 写出一行输出（默认 process.stdout）。注入后可在测试里断言，不必接管真实 stdio。 */
  readonly write: (line: string) => void;
}

/**
 * `npm run backup [-- --db <源库>] [--out <目标文件>]` 的可测试主体。
 *
 * 参数解析、配置读取与备份执行**全部**放在 try 内：配置非法（例如 .env 里写错一个数字）
 * 与源库不存在是同一类「预期失败」，都必须落成一条结构化的 `dealflow.backup.failed`
 * 并返回非 0 退出码。任何一句在 try 之外抛出，运维拿到的就是原始堆栈而不是可解析的 JSON。
 *
 * 返回值是进程退出码：0 成功，1 失败。
 */
export function runBackupCli(argv: readonly string[], io?: BackupCliIo): number {
  const write = io?.write ?? ((line: string) => process.stdout.write(line));

  try {
    const args = parseBackupArgs(argv);
    const sourcePath = args.source_path ?? loadConfigFromEnv().database.path;
    const targetPath = args.target_path ?? defaultBackupPath(sourcePath);
    const result = backupDatabase({ source_path: sourcePath, target_path: targetPath });

    write(`${JSON.stringify({ level: 'info', message: 'dealflow.backup.completed', ...result })}\n`);
    return 0;
  } catch (error) {
    write(
      `${JSON.stringify({
        level: 'error',
        message: 'dealflow.backup.failed',
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    return 1;
  }
}
