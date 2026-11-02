import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createTestContext, expectGuard, revoke, type TestContext } from './helpers.js';

describe('permissions', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  it('lists permission rows, optionally for one role', async () => {
    const all = await call(ctx, 'GET', '/permissions');
    expect(all.status).toBe(200);
    expect(await all.json()).toContainEqual({ role: 'clerk', action: 'loans.write' });

    const patron = await (await call(ctx, 'GET', '/permissions?role=patron')).json();
    expect(patron).toContainEqual({ role: 'patron', action: 'books.read' });
    expect(patron).not.toContainEqual(expect.objectContaining({ role: 'clerk' }));
  });

  it('grants each role the default actions', async () => {
    const rows = await (await call(ctx, 'GET', '/permissions')).json();
    expect(rows).toContainEqual({ role: 'librarian', action: 'fines.write' });
    expect(rows).toContainEqual({ role: 'admin', action: 'jobs.run' });
    expect(rows).not.toContainEqual({ role: 'patron', action: 'loans.write' });
    expect(rows).not.toContainEqual({ role: 'clerk', action: 'books.write' });
  });

  it('applies a permission change on the next request', async () => {
    const asClerk = { as: ctx.members.clerk };
    expect((await call(ctx, 'GET', '/members', asClerk)).status).toBe(200);

    revoke(ctx.db, 'clerk', 'members.read');
    expect((await call(ctx, 'GET', '/members', asClerk)).status).toBe(403);

    ctx.db.prepare("INSERT INTO permissions (role, action) VALUES ('clerk', 'members.read')").run();
    expect((await call(ctx, 'GET', '/members', asClerk)).status).toBe(200);
  });

  it('rejects a malformed member id', async () => {
    expect((await call(ctx, 'GET', '/books', { as: Number.NaN })).status).toBe(403);
  });

  it('guards the permission listing', async () => {
    await expectGuard(ctx, 'GET', '/permissions', {
      denied: 'librarian',
      allowed: 'admin',
      status: 200,
    });
  });
});
