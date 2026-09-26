import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqlite, type SqliteDatabase } from './sqlite-db';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dealflow-${name}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'dealflow.db');
}

function open(path: string, timeoutMs?: number): SqliteDatabase {
  const sqlite = openSqlite(timeoutMs === undefined ? { path } : { path, timeoutMs });
  cleanups.push(() => {
    if (sqlite.db.isOpen) sqlite.close();
  });
  return sqlite;
}

describe('SqliteDatabase journal mode', () => {
  it('文件库启用 WAL', () => {
    const sqlite = open(tempPath('wal'));
    const row = sqlite.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };

    expect(row.journal_mode.toLowerCase()).toBe('wal');
  });

  it('内存库不强行改 journal_mode', () => {
    const sqlite = openSqlite();
    const row = sqlite.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };

    expect(row.journal_mode.toLowerCase()).not.toBe('wal');
    sqlite.close();
  });

  it('读事务未提交时写入与备份都不被阻塞', () => {
    const path = tempPath('wal-reader');
    const target = tempPath('wal-backup');

    const writer = open(path, 500);
    writer.db.prepare(
      `INSERT INTO events (idempotency_key, event, processing_status)
       VALUES (?, ?, 'processed')`,
    ).run('key_1', JSON.stringify({ event_id: 'evt_1' }));

    // 另一个连接持有未提交的读事务：回滚日志模式下这里会让下面的写入等到 busy_timeout
    const reader = open(path, 500);
    reader.db.exec('BEGIN');
    expect(reader.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });

    expect(() =>
      writer.transaction(() => {
        writer.db
          .prepare(
            `INSERT INTO events (idempotency_key, event, processing_status)
             VALUES (?, ?, 'processed')`,
          )
          .run('key_2', JSON.stringify({ event_id: 'evt_2' }));
      }),
    ).not.toThrow();

    expect(() => writer.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)).not.toThrow();

    reader.db.exec('ROLLBACK');
  });
});
