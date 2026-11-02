import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Loan } from '../src/types.js';
import {
  auditRows,
  call,
  createTestContext,
  expectGuard,
  insertBook,
  insertCopy,
  START,
  type TestContext,
} from './helpers.js';

describe('loans routes', () => {
  let ctx: TestContext;
  let bookId: number;
  let copyId: number;

  beforeEach(() => {
    ctx = createTestContext();
    bookId = insertBook(ctx.db);
    copyId = insertCopy(ctx.db, bookId, 'B-0001');
  });

  afterEach(() => {
    ctx.close();
  });

  function borrow(copy = copyId, member = ctx.members.patron): Promise<Response> {
    return call(ctx, 'POST', '/loans', { body: { copy_id: copy, member_id: member } });
  }

  async function borrowed(copy = copyId): Promise<Loan> {
    return (await (await borrow(copy)).json()) as Loan;
  }

  it('lends a copy for one loan period and audits it', async () => {
    const response = await borrow();
    expect(response.status).toBe(201);
    const loan = (await response.json()) as Loan;
    expect(loan).toMatchObject({
      copy_id: copyId,
      member_id: ctx.members.patron,
      borrowed_at: START,
      due_at: '2026-03-16T09:00:00.000Z',
      returned_at: null,
    });
    expect(auditRows(ctx.db, 'loan.borrowed')).toContainEqual(
      expect.objectContaining({ entity_id: loan.id }),
    );
  });

  it('refuses a copy that is on loan, withdrawn or unknown', async () => {
    expect((await borrow()).status).toBe(201);
    expect((await borrow()).status).toBe(409);

    const withdrawn = insertCopy(ctx.db, bookId, 'B-0002');
    await call(ctx, 'POST', `/copies/${withdrawn}/withdraw`);
    expect((await borrow(withdrawn)).status).toBe(409);

    expect((await borrow(999)).status).toBe(404);
    expect((await borrow(copyId, 999)).status).toBe(404);
  });

  it('refuses a member who owes too much', async () => {
    await call(ctx, 'POST', `/members/${ctx.members.patron}/fines`, {
      body: { amount_cents: 1000, reason: 'lost copy' },
    });
    const response = await borrow();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('owes') });
  });

  it('returns a loan once and frees the copy', async () => {
    const loan = await borrowed();
    ctx.setNow('2026-03-10T15:30:00.000Z');

    const response = await call(ctx, 'POST', `/loans/${loan.id}/return`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ returned_at: '2026-03-10T15:30:00.000Z' });
    expect((await call(ctx, 'POST', `/loans/${loan.id}/return`)).status).toBe(409);
    expect((await borrow()).status).toBe(201);
  });

  it('renews from the current due date until returned', async () => {
    const loan = await borrowed();

    const first = await call(ctx, 'POST', `/loans/${loan.id}/renew`);
    expect(await first.json()).toMatchObject({ due_at: '2026-03-30T09:00:00.000Z' });
    const second = await call(ctx, 'POST', `/loans/${loan.id}/renew`);
    expect(await second.json()).toMatchObject({ due_at: '2026-04-13T09:00:00.000Z' });
    expect(auditRows(ctx.db, 'loan.renewed')).toHaveLength(2);

    await call(ctx, 'POST', `/loans/${loan.id}/return`);
    expect((await call(ctx, 'POST', `/loans/${loan.id}/renew`)).status).toBe(409);
  });

  it("lists a member's loans with copy and book details", async () => {
    const first = await borrowed();
    await call(ctx, 'POST', `/loans/${first.id}/return`);
    await borrow();

    const all = await call(ctx, 'GET', `/members/${ctx.members.patron}/loans`);
    expect(await all.json()).toContainEqual(
      expect.objectContaining({ id: first.id, barcode: 'B-0001', title: 'The Dispossessed' }),
    );
    const open = await call(ctx, 'GET', `/members/${ctx.members.patron}/loans?status=open`);
    expect(await open.json()).not.toContainEqual(expect.objectContaining({ id: first.id }));
    expect((await call(ctx, 'GET', '/members/999/loans')).status).toBe(404);
  });

  it('lists loans by book and status', async () => {
    const other = insertCopy(ctx.db, insertBook(ctx.db, 'Kindred'), 'K-0001');
    const loan = await borrowed();
    await borrowed(other);

    const byBook = await call(ctx, 'GET', `/loans?book_id=${bookId}&status=open`);
    expect(await byBook.json()).toEqual([expect.objectContaining({ id: loan.id })]);
    expect(await (await call(ctx, 'GET', `/loans/${loan.id}`)).json()).toMatchObject({
      book_id: bookId,
    });
    expect((await call(ctx, 'GET', '/loans?status=lost')).status).toBe(400);
  });

  it('guards reads and writes', async () => {
    await expectGuard(ctx, 'POST', '/loans', {
      body: { copy_id: copyId, member_id: ctx.members.patron },
      denied: 'patron',
      allowed: 'clerk',
      status: 201,
    });
    await expectGuard(ctx, 'GET', `/members/${ctx.members.patron}/loans`, {
      denied: 'patron',
      allowed: 'clerk',
      status: 200,
    });
  });
});
