import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db.js';
import { loadMigrations, migrate } from '../src/migrate.js';

describe('migration runner', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'library-migrate-'));
    db = openDatabase(join(dir, 'library.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function tables(): string[] {
    const query = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
    return query.pluck().all() as string[];
  }

  it('applies every migration and records it', () => {
    const applied = migrate(db);
    expect(applied.length).toBeGreaterThan(0);
    expect(tables()).toEqual(
      expect.arrayContaining(['books', 'copies', 'loans', 'fines', 'audit_log', '_migrations']),
    );

    const recorded = db.prepare('SELECT version, name FROM _migrations').all();
    expect(recorded).toContainEqual({ version: 1, name: 'catalogue' });
  });

  it('does nothing on a second run and leaves other schema objects alone', () => {
    migrate(db);
    db.exec('CREATE INDEX loans_due_at ON loans(due_at)');

    expect(migrate(db)).toHaveLength(0);
    const index = db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('loans_due_at');
    expect(index).toMatchObject({ name: 'loans_due_at', tbl_name: 'loans' });
  });

  it('applies files in numeric order and skips other files', () => {
    const source = join(dir, 'migrations');
    mkdirSync(source);
    writeFileSync(join(source, '010_third.sql'), 'INSERT INTO steps VALUES (3);');
    writeFileSync(join(source, '002_second.sql'), 'INSERT INTO steps VALUES (2);');
    writeFileSync(join(source, '001_first.sql'), 'CREATE TABLE steps (n INTEGER);');
    writeFileSync(join(source, 'README.md'), 'not a migration');

    const migrations = loadMigrations(source);
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 10]);
    migrate(db, migrations);
    expect(db.prepare('SELECT n FROM steps ORDER BY rowid').pluck().all()).toEqual([2, 3]);
  });

  it('rolls back a failing migration', () => {
    const broken = [
      { version: 1, name: 'broken', sql: 'CREATE TABLE a (id INTEGER); SELECT * FROM missing;' },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(tables()).not.toContain('a');
    expect(db.prepare('SELECT COUNT(*) FROM _migrations').pluck().get()).toBe(0);
  });
});
