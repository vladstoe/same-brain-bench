import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditRows,
  call,
  createTestContext,
  expectGuard,
  insertBook,
  insertCopy,
  type TestContext,
} from './helpers.js';

describe('fines routes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  async function charge(cents: number, extra: Record<string, unknown> = {}): Promise<Response> {
    return call(ctx, 'POST', `/members/${ctx.members.patron}/fines`, {
      body: { amount_cents: cents, reason: 'water damage', ...extra },
    });
  }

  it('charges a fine and audits it', async () => {
    const response = await charge(1500);
    expect(response.status).toBe(201);
    const fine = (await response.json()) as { id: number };
    expect(fine).toMatchObject({
      amount_cents: 1500,
      loan_id: null,
      paid_cents: 0,
      balance_cents: 1500,
    });
    expect(auditRows(ctx.db, 'fine.charged')).toContainEqual(
      expect.objectContaining({ entity_id: fine.id }),
    );

    expect((await charge(0)).status).toBe(400);
    expect((await charge(12.5)).status).toBe(400);
    expect((await charge(100, { reason: '' })).status).toBe(400);
  });

  it("ties a fine to one of the member's loans", async () => {
    const copyId = insertCopy(ctx.db, insertBook(ctx.db), 'B-0001');
    const loan = (await (
      await call(ctx, 'POST', '/loans', {
        body: { copy_id: copyId, member_id: ctx.members.clerk },
      })
    ).json()) as { id: number };

    expect((await charge(500, { loan_id: loan.id })).status).toBe(400);
    expect((await charge(500, { loan_id: 999 })).status).toBe(404);

    const own = await call(ctx, 'POST', `/members/${ctx.members.clerk}/fines`, {
      body: { amount_cents: 500, reason: 'torn page', loan_id: loan.id },
    });
    expect(await own.json()).toMatchObject({ loan_id: loan.id });
  });

  it("lists a member's fines with balances", async () => {
    const settled = (await (await charge(300)).json()) as { id: number };
    await charge(700);
    await call(ctx, 'POST', `/fines/${settled.id}/payments`, { body: { amount_cents: 300 } });

    const all = await call(ctx, 'GET', `/members/${ctx.members.patron}/fines`);
    expect(await all.json()).toContainEqual(
      expect.objectContaining({ id: settled.id, paid_cents: 300, balance_cents: 0 }),
    );

    const outstanding = await call(
      ctx,
      'GET',
      `/members/${ctx.members.patron}/fines?outstanding=true`,
    );
    expect(await outstanding.json()).toEqual([expect.objectContaining({ amount_cents: 700 })]);
  });

  it('lists fines across members and reads one with its payments', async () => {
    const fine = (await (await charge(400)).json()) as { id: number };
    await call(ctx, 'POST', `/fines/${fine.id}/payments`, { body: { amount_cents: 150 } });

    const query = `member_id=${ctx.members.patron}&outstanding=true`;
    const listed = await call(ctx, 'GET', `/fines?${query}`);
    expect(await listed.json()).toContainEqual(
      expect.objectContaining({ id: fine.id, balance_cents: 250 }),
    );

    const detail = await call(ctx, 'GET', `/fines/${fine.id}`);
    expect(await detail.json()).toMatchObject({
      payments: [expect.objectContaining({ amount_cents: 150 })],
    });
    expect((await call(ctx, 'GET', '/fines/999')).status).toBe(404);
  });

  it('guards charges and reads', async () => {
    const fine = (await (await charge(1500)).json()) as { id: number };
    await expectGuard(ctx, 'POST', `/members/${ctx.members.patron}/fines`, {
      body: { amount_cents: 100, reason: 'lost dust jacket' },
      denied: 'clerk',
      allowed: 'librarian',
      status: 201,
    });
    await expectGuard(ctx, 'GET', `/fines/${fine.id}`, {
      denied: 'patron',
      allowed: 'clerk',
      status: 200,
    });
  });
});
