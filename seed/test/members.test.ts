import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditRows,
  call,
  createTestContext,
  expectGuard,
  insertBook,
  insertCopy,
  insertMember,
  type TestContext,
} from './helpers.js';

describe('members routes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  it('creates a member with a known role', async () => {
    const response = await call(ctx, 'POST', '/members', {
      body: { name: 'Katherine', role: 'patron' },
    });
    expect(response.status).toBe(201);
    const member = (await response.json()) as { id: number };
    expect(member).toMatchObject({ name: 'Katherine', role: 'patron' });
    expect(auditRows(ctx.db, 'member.created')).toContainEqual(
      expect.objectContaining({ entity_id: member.id }),
    );

    const unknown = await call(ctx, 'POST', '/members', {
      body: { name: 'Katherine', role: 'director' },
    });
    expect(unknown.status).toBe(400);
  });

  it('lists members filtered by role and name', async () => {
    insertMember(ctx.db, 'Katherine Johnson', 'clerk');

    const byRole = await call(ctx, 'GET', '/members?role=clerk');
    expect(await byRole.json()).toContainEqual(
      expect.objectContaining({ name: 'Katherine Johnson' }),
    );

    const byName = await call(ctx, 'GET', '/members?name=johnson');
    expect(await byName.json()).toEqual([expect.objectContaining({ role: 'clerk' })]);
    expect((await call(ctx, 'GET', '/members?role=director')).status).toBe(400);
  });

  it('reads and updates a member', async () => {
    const id = ctx.members.patron;
    const found = await call(ctx, 'GET', `/members/${id}`);
    expect(await found.json()).toMatchObject({ id, name: 'Pat' });

    const response = await call(ctx, 'PUT', `/members/${id}`, {
      body: { name: 'Pat Doe', role: 'clerk' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Pat Doe', role: 'clerk' });
    expect((await call(ctx, 'GET', '/members/999')).status).toBe(404);
  });

  it('shows what a member has out and owes', async () => {
    const copyId = insertCopy(ctx.db, insertBook(ctx.db), 'B-0001');
    await call(ctx, 'POST', '/loans', { body: { copy_id: copyId, member_id: ctx.members.patron } });
    await call(ctx, 'POST', `/members/${ctx.members.patron}/fines`, {
      body: { amount_cents: 1250, reason: 'lost copy' },
    });

    const response = await call(ctx, 'GET', `/members/${ctx.members.patron}/account`);
    expect(await response.json()).toMatchObject({
      member_id: ctx.members.patron,
      open_loans: 1,
      balance_cents: 1250,
      can_borrow: false,
    });
  });

  it('deletes a member without circulation history', async () => {
    const id = insertMember(ctx.db, 'Katherine', 'patron');
    expect((await call(ctx, 'DELETE', `/members/${id}`)).status).toBe(204);
    expect((await call(ctx, 'GET', `/members/${id}`)).status).toBe(404);
  });

  it('refuses to delete a member with loans', async () => {
    const copyId = insertCopy(ctx.db, insertBook(ctx.db), 'B-0001');
    await call(ctx, 'POST', '/loans', { body: { copy_id: copyId, member_id: ctx.members.patron } });
    expect((await call(ctx, 'DELETE', `/members/${ctx.members.patron}`)).status).toBe(409);
  });

  it('guards reads and writes', async () => {
    await expectGuard(ctx, 'GET', '/members', { denied: 'patron', allowed: 'clerk', status: 200 });
    await expectGuard(ctx, 'POST', '/members', {
      body: { name: 'Mary', role: 'patron' },
      denied: 'clerk',
      allowed: 'librarian',
      status: 201,
    });
  });
});
