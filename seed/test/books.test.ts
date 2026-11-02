import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditRows,
  call,
  createTestContext,
  expectGuard,
  insertAuthor,
  insertBook,
  insertCopy,
  revoke,
  type TestContext,
} from './helpers.js';

describe('books routes', () => {
  let ctx: TestContext;
  let authorId: number;

  beforeEach(() => {
    ctx = createTestContext();
    authorId = insertAuthor(ctx.db);
  });

  afterEach(() => {
    ctx.close();
  });

  it('creates a book for an existing author', async () => {
    const response = await call(ctx, 'POST', '/books', {
      body: { title: 'The Left Hand of Darkness', author_id: authorId },
    });
    expect(response.status).toBe(201);
    const book = (await response.json()) as { id: number };
    expect(book).toMatchObject({ title: 'The Left Hand of Darkness', author_id: authorId });
    expect(auditRows(ctx.db, 'book.created')).toContainEqual(
      expect.objectContaining({ entity_id: book.id }),
    );

    const orphan = await call(ctx, 'POST', '/books', { body: { title: 'Nobody', author_id: 999 } });
    expect(orphan.status).toBe(404);
    expect((await call(ctx, 'POST', '/books', { body: { title: 'No author' } })).status).toBe(400);
  });

  it('filters books by author and title', async () => {
    insertBook(ctx.db, 'The Dispossessed', authorId);
    insertBook(ctx.db, 'Kindred', insertAuthor(ctx.db, 'Octavia E. Butler'));

    const byAuthor = await call(ctx, 'GET', `/books?author_id=${authorId}`);
    expect(await byAuthor.json()).toEqual([expect.objectContaining({ title: 'The Dispossessed' })]);

    const byTitle = await call(ctx, 'GET', '/books?title=kind');
    expect(await byTitle.json()).toContainEqual(expect.objectContaining({ title: 'Kindred' }));
  });

  it('reads a book with its author', async () => {
    const id = insertBook(ctx.db, 'The Dispossessed', authorId);
    const response = await call(ctx, 'GET', `/books/${id}`);
    expect(await response.json()).toMatchObject({ id, author: { id: authorId } });
    expect((await call(ctx, 'GET', '/books/999')).status).toBe(404);
  });

  it('updates a book', async () => {
    const id = insertBook(ctx.db, 'Dispossessed', authorId);
    const response = await call(ctx, 'PUT', `/books/${id}`, {
      body: { title: 'The Dispossessed', author_id: authorId },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, title: 'The Dispossessed' });
  });

  it('deletes a book only when it has no copies', async () => {
    const empty = insertBook(ctx.db, 'Draft', authorId);
    const stocked = insertBook(ctx.db, 'The Dispossessed', authorId);
    insertCopy(ctx.db, stocked, 'B-0001');

    expect((await call(ctx, 'DELETE', `/books/${empty}`)).status).toBe(204);
    expect((await call(ctx, 'DELETE', `/books/${stocked}`)).status).toBe(409);
  });

  it('reports availability from copies and open loans', async () => {
    const id = insertBook(ctx.db, 'The Dispossessed', authorId);
    const lent = insertCopy(ctx.db, id, 'B-0001');
    insertCopy(ctx.db, id, 'B-0002');
    const withdrawn = insertCopy(ctx.db, id, 'B-0003');
    await call(ctx, 'POST', `/copies/${withdrawn}/withdraw`);
    await call(ctx, 'POST', '/loans', { body: { copy_id: lent, member_id: ctx.members.patron } });

    const response = await call(ctx, 'GET', `/books/${id}/availability`, {
      as: ctx.members.patron,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      book_id: id,
      total_copies: 2,
      available_copies: 1,
    });
  });

  it('guards reads and writes', async () => {
    revoke(ctx.db, 'patron', 'books.read');
    await expectGuard(ctx, 'GET', '/books', { denied: 'patron', allowed: 'clerk', status: 200 });
    await expectGuard(ctx, 'POST', '/books', {
      body: { title: 'Lavinia', author_id: authorId },
      denied: 'clerk',
      allowed: 'librarian',
      status: 201,
    });
  });
});
