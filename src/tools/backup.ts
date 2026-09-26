import { runBackupCli } from './backup-cli';

/**
 * 备份 CLI 入口。业务逻辑在 `backup-cli.ts`，这里只负责把退出码交回进程。
 */
process.exitCode = runBackupCli(process.argv.slice(2));
