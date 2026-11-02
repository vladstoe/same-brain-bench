import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  createTestContext,
  expectGuard,
  insertBook,
  insertCopy,
  type TestContext,
} from './helpers.js';

describe('reports routes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  async function runDaily(): Promise<number> {
    const response = await call(ctx, 'POST', '/_jobs/daily-circulation/run');
    const { result } = (await response.json()) as { result: { report_id: number } };
    return result.report_id;
  }

  async function circulate(): Promise<void> {
    const bookId = insertBook(ctx.db);
    const first = insertCopy(ctx.db, bookId, 'B-0001');
    const second = insertCopy(ctx.db, bookId, 'B-0002');
    const body = (copy: number) => ({ body: { copy_id: copy, member_id: ctx.members.patron } });

    const loan = (await (await call(ctx, 'POST', '/loans', body(first))).json()) as { id: number };
    await call(ctx, 'POST', '/loans', body(second));
    await call(ctx, 'POST', `/loans/${loan.id}/renew`);
    await call(ctx, 'POST', `/loans/${loan.id}/return`);

    const charged = await call(ctx, 'POST', `/members/${ctx.members.patron}/fines`, {
      body: { amount_cents: 1200, reason: 'torn cover' },
    });
    const fine = (await charged.json()) as { id: number };
    await call(ctx, 'POST', `/fines/${fine.id}/payments`, { body: { amount_cents: 200 } });
  }

  it("summarises the day's circulation", async () => {
    await circulate();
    ctx.setNow('2026-03-02T23:00:00.000Z');
    await runDaily();

    const response = await call(ctx, 'GET', '/reports/daily/latest');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'daily-circulation',
      period: '2026-03-02',
      body: {
        borrows: 2,
        returns: 1,
        renewals: 1,
        fines_charged: 1,
        fines_charged_cents: 1200,
        payments: 1,
        payments_cents: 200,
      },
    });
  });

  it('counts only the day being reported', async () => {
    await circulate();
    ctx.setNow('2026-03-03T08:00:00.000Z');
    await runDaily();

    const latest = await (await call(ctx, 'GET', '/reports/daily/latest')).json();
    expect(latest).toMatchObject({ period: '2026-03-03', body: { borrows: 0, payments_cents: 0 } });
  });

  it('serves a report as CSV', async () => {
    await circulate();
    const id = await runDaily();

    const response = await call(ctx, 'GET', `/reports/${id}/csv`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const lines = (await response.text()).trim().split('\r\n');
    expect(lines[0]).toBe('metric,value');
    expect(lines).toContain('borrows,2');
    expect(lines).toContain('period,2026-03-02');
  });

  it('lists reports and reads one by id', async () => {
    expect((await call(ctx, 'GET', '/reports/daily/latest')).status).toBe(404);
    const id = await runDaily();

    const listed = await call(ctx, 'GET', '/reports?kind=daily-circulation&period=2026-03-02');
    expect(await listed.json()).toContainEqual(expect.objectContaining({ id }));
    const single = await call(ctx, 'GET', `/reports/${id}`);
    expect(await single.json()).toMatchObject({ id, body: { borrows: 0 } });
    expect((await call(ctx, 'GET', '/reports/999/csv')).status).toBe(404);
    expect((await call(ctx, 'GET', '/reports?period=March')).status).toBe(400);
  });

  it('guards report reads', async () => {
    await runDaily();
    await expectGuard(ctx, 'GET', '/reports/daily/latest', {
      denied: 'clerk',
      allowed: 'librarian',
      status: 200,
    });
  });
});
