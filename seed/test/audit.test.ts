import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createTestContext, expectGuard, insertAuthor, type TestContext } from './helpers.js';

describe('audit log', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  function count(): number {
    return ctx.db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get() as number;
  }

  it('records the actor, time and data of a write', async () => {
    const created = await call(ctx, 'POST', '/authors', {
      as: ctx.members.librarian,
      body: { name: 'Italo Calvino' },
    });
    const author = (await created.json()) as { id: number };

    const response = await call(ctx, 'GET', `/audit-log?entity=author&entity_id=${author.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual(
      expect.objectContaining({
        at: '2026-03-02T09:00:00.000Z',
        actor_member_id: ctx.members.librarian,
        action: 'author.created',
        data: { name: 'Italo Calvino' },
      }),
    );
  });

  it('writes nothing for reads, failed writes or direct inserts', async () => {
    await call(ctx, 'GET', '/authors');
    await call(ctx, 'POST', '/authors', { body: { name: '' } });
    insertAuthor(ctx.db, 'Jorge Luis Borges');
    expect(count()).toBe(0);
  });

  it('filters by action, actor and time', async () => {
    await call(ctx, 'POST', '/authors', { body: { name: 'Italo Calvino' } });
    ctx.setNow('2026-03-04T09:00:00.000Z');
    await call(ctx, 'POST', '/authors', { as: ctx.members.librarian, body: { name: 'Borges' } });

    const early = await (await call(ctx, 'GET', '/audit-log?to=2026-03-03T00:00:00.000Z')).json();
    expect(early).toContainEqual(expect.objectContaining({ data: { name: 'Italo Calvino' } }));
    expect(early).not.toContainEqual(expect.objectContaining({ data: { name: 'Borges' } }));

    const path = `/audit-log?actor_member_id=${ctx.members.librarian}`;
    const byActor = await (await call(ctx, 'GET', path)).json();
    expect(byActor).toContainEqual(expect.objectContaining({ data: { name: 'Borges' } }));
    expect(byActor).not.toContainEqual(
      expect.objectContaining({ data: { name: 'Italo Calvino' } }),
    );

    expect((await call(ctx, 'GET', '/audit-log?from=yesterday')).status).toBe(400);
  });

  it('pages through entries newest first', async () => {
    for (const name of ['A', 'B', 'C']) {
      await call(ctx, 'POST', '/authors', { body: { name } });
    }
    const second = await call(ctx, 'GET', '/audit-log?action=author.created&limit=1&offset=1');
    expect(await second.json()).toMatchObject([{ data: { name: 'B' } }]);
    expect((await call(ctx, 'GET', '/audit-log?limit=0')).status).toBe(400);
  });

  it('guards the audit log', async () => {
    await expectGuard(ctx, 'GET', '/audit-log', {
      denied: 'librarian',
      allowed: 'admin',
      status: 200,
    });
  });
});
