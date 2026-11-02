import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditRows, call, createTestContext, expectGuard, type TestContext } from './helpers.js';

describe('payments routes', () => {
  let ctx: TestContext;
  let fineId: number;

  beforeEach(async () => {
    ctx = createTestContext();
    const response = await call(ctx, 'POST', `/members/${ctx.members.patron}/fines`, {
      body: { amount_cents: 1500, reason: 'replacement barcode label' },
    });
    fineId = ((await response.json()) as { id: number }).id;
  });

  afterEach(() => {
    ctx.close();
  });

  function pay(cents: number, as = ctx.members.clerk): Promise<Response> {
    return call(ctx, 'POST', `/fines/${fineId}/payments`, { as, body: { amount_cents: cents } });
  }

  it('takes a partial payment and reports the new balance', async () => {
    const response = await pay(1000);
    expect(response.status).toBe(201);
    const payment = (await response.json()) as { id: number };
    expect(payment).toMatchObject({
      fine_id: fineId,
      amount_cents: 1000,
      received_by: ctx.members.clerk,
      fine: { paid_cents: 1000, balance_cents: 500 },
    });
    expect(auditRows(ctx.db, 'payment.received')).toContainEqual(
      expect.objectContaining({ entity_id: payment.id }),
    );
  });

  it('refuses a payment above the balance', async () => {
    await pay(1000);
    expect((await pay(501)).status).toBe(409);
    expect((await pay(500)).status).toBe(201);
    expect((await pay(1)).status).toBe(409);
    expect((await pay(-5)).status).toBe(400);
  });

  it('lists payments by day and by member', async () => {
    await pay(200);
    ctx.setNow('2026-03-03T10:00:00.000Z');
    await pay(300, ctx.members.librarian);

    const monday = await call(ctx, 'GET', '/payments?day=2026-03-02');
    const mondayRows = (await monday.json()) as unknown[];
    expect(mondayRows).toContainEqual(expect.objectContaining({ amount_cents: 200 }));
    expect(mondayRows).not.toContainEqual(expect.objectContaining({ amount_cents: 300 }));

    const byClerk = await call(ctx, 'GET', `/payments?received_by=${ctx.members.librarian}`);
    expect(await byClerk.json()).toEqual([expect.objectContaining({ amount_cents: 300 })]);

    const forMember = await call(ctx, 'GET', `/members/${ctx.members.patron}/payments`);
    expect(await forMember.json()).toContainEqual(
      expect.objectContaining({ member_id: ctx.members.patron, amount_cents: 200 }),
    );
    expect((await call(ctx, 'GET', '/payments?day=yesterday')).status).toBe(400);
  });

  it('guards taking and listing payments', async () => {
    await expectGuard(ctx, 'POST', `/fines/${fineId}/payments`, {
      body: { amount_cents: 100 },
      denied: 'patron',
      allowed: 'clerk',
      status: 201,
    });
    await expectGuard(ctx, 'GET', '/payments', { denied: 'patron', allowed: 'clerk', status: 200 });
  });
});
