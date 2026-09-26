import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { openSqlite } from '../stores/sqlite-db';

export interface BackupOptions {
  readonly source_path: string;
  readonly target_path: string;
}

export interface BackupResult {
  readonly source_path: string;
  readonly target_path: string;
  readonly bytes: number;
}

/**
 * 生成 SQLite 一致性备份。
 *
 * 使用 `VACUUM INTO`：SQLite 在单一读事务中把整个数据库写出到新文件，
 * 因此**不需要停机**，也不会像「直接拷贝 .db 文件」那样在并发写入或 WAL 模式下拿到破损快照。
 * 目标文件必须不存在（避免覆盖既有备份）。
 */
export function backupDatabase(options: BackupOptions): BackupResult {
  const source = resolve(options.source_path);
  const target = resolve(options.target_path);

  if (!existsSync(source)) {
    throw new Error(`源数据库不存在: ${source}`);
  }
  if (existsSync(target)) {
    throw new Error(`备份目标已存在，拒绝覆盖: ${target}`);
  }

  mkdirSync(dirname(target), { recursive: true });

  const sqlite = openSqlite({ path: source });
  try {
    // VACUUM INTO 不接受绑定参数，路径以转义后的字面量内联（单引号翻倍）。
    sqlite.db.exec(`VACUUM INTO '${escapeSqlString(target)}'`);
  } finally {
    sqlite.close();
  }

  return { source_path: source, target_path: target, bytes: statSync(target).size };
}

/** 默认备份路径：`<库目录>/backups/<库名>-<时间戳>.db`。 */
export function defaultBackupPath(
  sourcePath: string,
  now: () => string = () => new Date().toISOString(),
): string {
  const source = resolve(sourcePath);
  const stamp = now().replace(/[:.]/g, '-');
  const base = basename(source).replace(/\.db$/i, '');
  return join(dirname(source), 'backups', `${base}-${stamp}.db`);
}

export interface BackupArgs {
  readonly source_path: string | null;
  readonly target_path: string | null;
}

/** 解析 `--db <source>` 与 `--out <target>`；缺失时由调用方回退到默认值。 */
export function parseBackupArgs(argv: readonly string[]): BackupArgs {
  let sourcePath: string | null = null;
  let targetPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--db') {
      sourcePath = argv[index + 1] ?? null;
      index += 1;
    } else if (flag === '--out') {
      targetPath = argv[index + 1] ?? null;
      index += 1;
    }
  }

  return { source_path: sourcePath, target_path: targetPath };
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
