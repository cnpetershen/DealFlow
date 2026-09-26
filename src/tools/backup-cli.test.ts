import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openSqlite } from '../stores/sqlite-db';
import { runBackupCli } from './backup-cli';

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-backup-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): { lines: string[]; io: { write: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { write: (line) => { lines.push(line); } } };
}

function lastJson(lines: readonly string[]): Record<string, unknown> {
  const line = lines[lines.length - 1];
  if (line === undefined) {
    throw new Error('没有输出任何行');
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe('runBackupCli', () => {
  it('配置非法时输出结构化失败并返回 1，而不是抛出原始堆栈', () => {
    vi.stubEnv('DEALFLOW_MAX_CONNECTIONS', 'not-a-number');

    const { lines, io } = capture();
    const exitCode = runBackupCli([], io);

    expect(exitCode).toBe(1);
    expect(lastJson(lines)).toMatchObject({ level: 'error', message: 'dealflow.backup.failed' });
    expect(String(lastJson(lines).error)).not.toContain('at ');
  });

  it('源库不存在时输出结构化失败并返回 1', () => {
    const dir = tempDir();

    const { lines, io } = capture();
    const exitCode = runBackupCli(['--db', join(dir, 'missing.db'), '--out', join(dir, 'out.db')], io);

    expect(exitCode).toBe(1);
    expect(lastJson(lines)).toMatchObject({ level: 'error', message: 'dealflow.backup.failed' });
    expect(existsSync(join(dir, 'out.db'))).toBe(false);
  });

  it('备份成功时输出结果并返回 0', () => {
    const dir = tempDir();
    const source = join(dir, 'dealflow.db');
    const target = join(dir, 'out.db');
    const sqlite = openSqlite({ path: source });
    sqlite.db.exec('CREATE TABLE t (id INTEGER NOT NULL)');
    sqlite.close();

    const { lines, io } = capture();
    const exitCode = runBackupCli(['--db', source, '--out', target], io);

    expect(exitCode).toBe(0);
    expect(lastJson(lines)).toMatchObject({
      level: 'info',
      message: 'dealflow.backup.completed',
      source_path: source,
      target_path: target,
    });
    expect(existsSync(target)).toBe(true);
  });
});
