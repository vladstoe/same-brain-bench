import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditRows,
  call,
  createTestContext,
  expectGuard,
  insertAuthor,
  insertBook,
  revoke,
  type TestContext,
} from './helpers.js';

describe('authors routes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  it('creates an author and records it in the audit log', async () => {
    const response = await call(ctx, 'POST', '/authors', { body: { name: 'Octavia E. Butler' } });
    expect(response.status).toBe(201);
    const author = (await response.json()) as { id: number };
    expect(author).toMatchObject({ name: 'Octavia E. Butler' });

    expect(auditRows(ctx.db, 'author.created')).toContainEqual(
      expect.objectContaining({ entity_id: author.id }),
    );
  });

  it('rejects an author without a name', async () => {
    expect((await call(ctx, 'POST', '/authors', { body: { name: ' ' } })).status).toBe(400);
  });

  it('lists and searches authors', async () => {
    insertAuthor(ctx.db, 'Octavia E. Butler');
    insertAuthor(ctx.db, 'N. K. Jemisin');

    const response = await call(ctx, 'GET', '/authors?name=jemisin');
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual(
      expect.objectContaining({ name: 'N. K. Jemisin' }),
    );
  });

  it('reads an author with their books', async () => {
    const authorId = insertAuthor(ctx.db);
    insertBook(ctx.db, 'The Lathe of Heaven', authorId);

    const response = await call(ctx, 'GET', `/authors/${authorId}`);
    expect(await response.json()).toMatchObject({
      id: authorId,
      books: [expect.objectContaining({ title: 'The Lathe of Heaven' })],
    });
    expect((await call(ctx, 'GET', '/authors/999')).status).toBe(404);
  });

  it('renames an author', async () => {
    const id = insertAuthor(ctx.db, 'Ursula Le Guin');
    const response = await call(ctx, 'PUT', `/authors/${id}`, {
      body: { name: 'Ursula K. Le Guin' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, name: 'Ursula K. Le Guin' });
  });

  it('deletes an author only when they have no books', async () => {
    const lonely = insertAuthor(ctx.db, 'Anonymous');
    const busy = insertAuthor(ctx.db);
    insertBook(ctx.db, 'Earthsea', busy);

    expect((await call(ctx, 'DELETE', `/authors/${lonely}`)).status).toBe(204);
    expect((await call(ctx, 'DELETE', `/authors/${busy}`)).status).toBe(409);
  });

  it('guards reads and writes', async () => {
    revoke(ctx.db, 'patron', 'authors.read');
    await expectGuard(ctx, 'GET', '/authors', { denied: 'patron', allowed: 'clerk', status: 200 });
    await expectGuard(ctx, 'POST', '/authors', {
      body: { name: 'Iain M. Banks' },
      denied: 'clerk',
      allowed: 'librarian',
      status: 201,
    });
  });
});
