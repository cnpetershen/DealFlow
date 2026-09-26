import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteEventStore } from '../stores/sqlite';
import { openSqlite } from '../stores/sqlite-db';
import { SqliteAuditLog } from '../stores/sqlite-stores';
import { auditEntryInput, leadCreatedEvent } from '../testing/fixtures';
import { backupDatabase, defaultBackupPath, parseBackupArgs } from './backup';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dealflow-backup-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 建库并写入事件与审计，作为备份源。 */
function seedDatabase(path: string): void {
  const sqlite = openSqlite({ path });
  const events = new SqliteEventStore({ sqlite });
  const audit = new SqliteAuditLog({ sqlite });
  events.append(leadCreatedEvent());
  audit.append(auditEntryInput());
  events.markProcessed('lead.created:crm:rec_1001');
  sqlite.close();
}

describe('backupDatabase', () => {
  it('生成可独立打开且数据一致的一致性备份', () => {
    const dir = tempDir();
    const source = join(dir, 'dealflow.db');
    const target = join(dir, 'backups', 'snapshot.db');
    seedDatabase(source);

    const result = backupDatabase({ source_path: source, target_path: target });

    expect(result.target_path).toBe(target);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(target)).toBe(true);

    // 备份可独立打开，且事件与审计内容一致。
    const restored = openSqlite({ path: target });
    try {
      const events = new SqliteEventStore({ sqlite: restored });
      const audit = new SqliteAuditLog({ sqlite: restored });
      expect(events.list()).toHaveLength(1);
      expect(events.getByIdempotencyKey('lead.created:crm:rec_1001')?.processing_status).toBe('processed');
      expect(audit.list()).toHaveLength(1);
    } finally {
      restored.close();
    }
  });

  it('源库不存在时拒绝备份', () => {
    const dir = tempDir();

    expect(() =>
      backupDatabase({ source_path: join(dir, 'missing.db'), target_path: join(dir, 'out.db') }),
    ).toThrow('源数据库不存在');
  });

  it('目标已存在时拒绝覆盖', () => {
    const dir = tempDir();
    const source = join(dir, 'dealflow.db');
    const target = join(dir, 'snapshot.db');
    seedDatabase(source);
    backupDatabase({ source_path: source, target_path: target });

    expect(() => backupDatabase({ source_path: source, target_path: target })).toThrow('拒绝覆盖');
  });

  it('写入事务进行中也能拿到一致性快照（无需停机）', () => {
    const dir = tempDir();
    const source = join(dir, 'dealflow.db');
    const target = join(dir, 'snapshot.db');
    const live = openSqlite({ path: source });
    const events = new SqliteEventStore({ sqlite: live });
    events.append(leadCreatedEvent());

    const result = backupDatabase({ source_path: source, target_path: target });

    expect(result.bytes).toBeGreaterThan(0);
    live.close();

    const restored = openSqlite({ path: target });
    try {
      expect(new SqliteEventStore({ sqlite: restored }).list()).toHaveLength(1);
    } finally {
      restored.close();
    }
  });
});

describe('defaultBackupPath / parseBackupArgs', () => {
  it('默认备份路径位于库目录下的 backups/，文件名带时间戳', () => {
    const path = defaultBackupPath('/srv/dealflow/data/dealflow.db', () => '2026-09-24T10:00:00.000Z');

    expect(path.replace(/\\/g, '/')).toContain('/data/backups/');
    expect(path.replace(/\\/g, '/')).toMatch(/dealflow-2026-09-24T10-00-00-000Z\.db$/);
  });

  it('解析 --db 与 --out', () => {
    expect(parseBackupArgs(['--db', 'a.db', '--out', 'b.db'])).toEqual({
      source_path: 'a.db',
      target_path: 'b.db',
    });
    expect(parseBackupArgs([])).toEqual({ source_path: null, target_path: null });
    expect(parseBackupArgs(['--out'])).toEqual({ source_path: null, target_path: null });
  });
});
