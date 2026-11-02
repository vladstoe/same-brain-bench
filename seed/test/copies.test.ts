import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditRows,
  call,
  createTestContext,
  expectGuard,
  insertBook,
  insertCopy,
  revoke,
  type TestContext,
} from './helpers.js';

describe('copies routes', () => {
  let ctx: TestContext;
  let bookId: number;

  beforeEach(() => {
    ctx = createTestContext();
    bookId = insertBook(ctx.db);
  });

  afterEach(() => {
    ctx.close();
  });

  it('adds a copy with a unique barcode', async () => {
    const add = () =>
      call(ctx, 'POST', `/books/${bookId}/copies`, { body: { barcode: 'B-0001' } });

    const response = await add();
    expect(response.status).toBe(201);
    const copy = (await response.json()) as { id: number };
    expect(copy).toMatchObject({
      book_id: bookId,
      barcode: 'B-0001',
      acquired_at: '2026-03-02T09:00:00.000Z',
      withdrawn_at: null,
      on_loan: false,
    });
    expect(auditRows(ctx.db, 'copy.added')).toContainEqual(
      expect.objectContaining({ entity_id: copy.id }),
    );
    expect((await add()).status).toBe(409);
  });

  it('accepts an acquisition time and rejects a malformed one', async () => {
    const dated = await call(ctx, 'POST', `/books/${bookId}/copies`, {
      body: { barcode: 'B-0002', acquired_at: '2025-11-20T10:00:00.000Z' },
    });
    expect(await dated.json()).toMatchObject({ acquired_at: '2025-11-20T10:00:00.000Z' });

    const malformed = await call(ctx, 'POST', `/books/${bookId}/copies`, {
      body: { barcode: 'B-0003', acquired_at: '20 Nov 2025' },
    });
    expect(malformed.status).toBe(400);
  });

  it("lists a book's copies and finds one by barcode", async () => {
    insertCopy(ctx.db, bookId, 'B-0001');
    const withdrawn = insertCopy(ctx.db, bookId, 'B-0002');
    await call(ctx, 'POST', `/copies/${withdrawn}/withdraw`);

    expect(await (await call(ctx, 'GET', `/books/${bookId}/copies`)).json()).toHaveLength(1);
    const all = await call(ctx, 'GET', `/books/${bookId}/copies?include_withdrawn=true`);
    expect(await all.json()).toContainEqual(expect.objectContaining({ id: withdrawn }));

    const found = await call(ctx, 'GET', '/copies?barcode=B-0001');
    expect(await found.json()).toMatchObject({ barcode: 'B-0001', book_id: bookId });
    expect((await call(ctx, 'GET', '/copies?barcode=NOPE')).status).toBe(404);
  });

  it('withdraws a copy unless it is on loan or already withdrawn', async () => {
    const lent = insertCopy(ctx.db, bookId, 'B-0001');
    const shelved = insertCopy(ctx.db, bookId, 'B-0002');
    await call(ctx, 'POST', '/loans', { body: { copy_id: lent, member_id: ctx.members.patron } });

    expect((await call(ctx, 'POST', `/copies/${lent}/withdraw`)).status).toBe(409);

    const response = await call(ctx, 'POST', `/copies/${shelved}/withdraw`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: shelved, withdrawn_at: expect.any(String) });
    expect((await call(ctx, 'POST', `/copies/${shelved}/withdraw`)).status).toBe(409);
  });

  it('guards reads and writes', async () => {
    const copyId = insertCopy(ctx.db, bookId, 'B-0001');
    revoke(ctx.db, 'patron', 'copies.read');
    await expectGuard(ctx, 'GET', `/copies/${copyId}`, {
      denied: 'patron',
      allowed: 'clerk',
      status: 200,
    });
    await expectGuard(ctx, 'POST', `/copies/${copyId}/withdraw`, {
      denied: 'clerk',
      allowed: 'librarian',
      status: 200,
    });
  });
});
