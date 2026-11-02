import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { list, register, run, UnknownJobError } from '../src/scheduler.js';

describe('scheduler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'library-scheduler-'));
  const db = openDatabase(join(dir, 'scheduler.db'));

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers a job and lists it by name', () => {
    register('count-tables', ({ db }) => ({
      tables: db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'").pluck().get(),
    }));
    expect(list()).toContain('count-tables');
  });

  it('runs a job with the database and the current time', () => {
    const now = new Date('2026-03-02T12:00:00.000Z');
    register('echo-time', (context) => ({ at: context.now.toISOString() }));

    expect(run('echo-time', { db, now })).toMatchObject({ at: '2026-03-02T12:00:00.000Z' });
    expect(run('count-tables', { db, now })).toMatchObject({ tables: 0 });
  });

  it('refuses a duplicate name', () => {
    expect(() => register('echo-time', () => ({}))).toThrow(/already registered/);
  });

  it('throws for a job that is not registered', () => {
    expect(() => run('missing', { db, now: new Date() })).toThrow(UnknownJobError);
  });
});
