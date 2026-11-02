import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase, type AppEnv, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import type { MemberRole } from '../src/types.js';

export type TestContext = {
  app: Hono<AppEnv>;
  db: Db;
  dir: string;
  members: Record<MemberRole, number>;
  setNow: (timestamp: string) => void;
  close: () => void;
};

export const START = '2026-03-02T09:00:00.000Z';

export function createTestContext(): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'library-api-'));
  const db = openDatabase(join(dir, 'library.db'));
  migrate(db);

  let current = new Date(START);
  const members = {
    patron: insertMember(db, 'Pat', 'patron'),
    clerk: insertMember(db, 'Cleo', 'clerk'),
    librarian: insertMember(db, 'Lin', 'librarian'),
    admin: insertMember(db, 'Ada', 'admin'),
  };

  return {
    app: createApp(db, { clock: () => current }),
    db,
    dir,
    members,
    setNow: (timestamp) => {
      current = new Date(timestamp);
    },
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertMember(db: Db, name: string, role: MemberRole): number {
  const result = db.prepare('INSERT INTO members (name, role) VALUES (?, ?)').run(name, role);
  return Number(result.lastInsertRowid);
}

export function insertAuthor(db: Db, name = 'Ursula K. Le Guin'): number {
  return Number(db.prepare('INSERT INTO authors (name) VALUES (?)').run(name).lastInsertRowid);
}

export function insertBook(db: Db, title = 'The Dispossessed', authorId?: number): number {
  const result = db
    .prepare('INSERT INTO books (title, author_id) VALUES (?, ?)')
    .run(title, authorId ?? insertAuthor(db));
  return Number(result.lastInsertRowid);
}

export function insertCopy(db: Db, bookId: number, barcode: string): number {
  return Number(
    db
      .prepare('INSERT INTO copies (book_id, barcode, acquired_at) VALUES (?, ?, ?)')
      .run(bookId, barcode, START).lastInsertRowid,
  );
}

export function auditRows(db: Db, action: string): { entity_id: number | null; data: string }[] {
  return db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
    entity_id: number | null;
    data: string;
  }[];
}

export function revoke(db: Db, role: MemberRole, action: string): void {
  db.prepare('DELETE FROM permissions WHERE role = ? AND action = ?').run(role, action);
}

export type CallInit = {
  as?: number | null;
  body?: unknown;
};

export async function call(
  ctx: TestContext,
  method: string,
  path: string,
  init: CallInit = {},
): Promise<Response> {
  const actor = init.as === undefined ? ctx.members.admin : init.as;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (actor !== null) {
    headers['x-member-id'] = String(actor);
  }
  return ctx.app.request(path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function expectGuard(
  ctx: TestContext,
  method: string,
  path: string,
  expected: { denied: MemberRole; allowed: MemberRole; status: number; body?: unknown },
): Promise<void> {
  const { denied, allowed, status, body } = expected;
  expect((await call(ctx, method, path, { as: null, body })).status).toBe(401);
  expect((await call(ctx, method, path, { as: 9999, body })).status).toBe(403);
  expect((await call(ctx, method, path, { as: ctx.members[denied], body })).status).toBe(403);
  expect((await call(ctx, method, path, { as: ctx.members[allowed], body })).status).toBe(status);
}
