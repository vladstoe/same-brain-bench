import { Hono } from 'hono';
import { recordAudit } from '../audit.js';
import type { AppEnv, Db } from '../db.js';
import { requirePermission } from '../guards.js';
import { conflict, idField, idParam, notFound, readJson, stringField } from '../http.js';
import { Filters, idQuery, page } from '../query.js';
import type { Book } from '../types.js';
import { findAuthor } from './authors.js';

export const books = new Hono<AppEnv>();

export function findBook(db: Db, id: number): Book {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Book | undefined;
  if (!book) {
    throw notFound('book not found');
  }
  return book;
}

books.get('/books', requirePermission('books.read'), (c) => {
  const filters = new Filters();
  const authorId = idQuery(c, 'author_id');
  if (authorId !== undefined) {
    filters.add('author_id = ?', authorId);
  }
  const title = c.req.query('title');
  if (title) {
    filters.add('title LIKE ?', `%${title}%`);
  }

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(`SELECT * FROM books ${filters.where} ORDER BY title, id ${sql}`)
    .all(...filters.params, ...params) as Book[];
  return c.json(rows);
});

books.post('/books', requirePermission('books.write'), async (c) => {
  const body = await readJson(c);
  const title = stringField(body, 'title');
  const authorId = idField(body, 'author_id');
  const db = c.get('db');

  const book = db.transaction(() => {
    findAuthor(db, authorId);
    const result = db
      .prepare('INSERT INTO books (title, author_id) VALUES (?, ?)')
      .run(title, authorId);
    const id = Number(result.lastInsertRowid);
    recordAudit(c, {
      action: 'book.created',
      entity: 'book',
      entityId: id,
      data: { title, author_id: authorId },
    });
    return findBook(db, id);
  })();

  return c.json(book, 201);
});

books.get('/books/:id', requirePermission('books.read'), (c) => {
  const db = c.get('db');
  const book = findBook(db, idParam(c));
  return c.json({ ...book, author: findAuthor(db, book.author_id) });
});

books.put('/books/:id', requirePermission('books.write'), async (c) => {
  const id = idParam(c);
  const body = await readJson(c);
  const title = stringField(body, 'title');
  const authorId = idField(body, 'author_id');
  const db = c.get('db');

  const book = db.transaction(() => {
    const before = findBook(db, id);
    findAuthor(db, authorId);
    db.prepare('UPDATE books SET title = ?, author_id = ? WHERE id = ?').run(title, authorId, id);
    recordAudit(c, {
      action: 'book.updated',
      entity: 'book',
      entityId: id,
      data: {
        before: { title: before.title, author_id: before.author_id },
        after: { title, author_id: authorId },
      },
    });
    return findBook(db, id);
  })();

  return c.json(book);
});

books.delete('/books/:id', requirePermission('books.write'), (c) => {
  const id = idParam(c);
  const db = c.get('db');

  db.transaction(() => {
    const book = findBook(db, id);
    if (db.prepare('SELECT 1 FROM copies WHERE book_id = ?').get(id)) {
      throw conflict('book has copies');
    }
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    recordAudit(c, {
      action: 'book.deleted',
      entity: 'book',
      entityId: id,
      data: { title: book.title, author_id: book.author_id },
    });
  })();

  return c.body(null, 204);
});

books.get('/books/:id/availability', requirePermission('books.read'), (c) => {
  const db = c.get('db');
  const book = findBook(db, idParam(c));

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total_copies,
         COALESCE(SUM(NOT EXISTS (
           SELECT 1 FROM loans WHERE loans.copy_id = copies.id AND loans.returned_at IS NULL
         )), 0) AS available_copies
       FROM copies
       WHERE copies.book_id = ? AND copies.withdrawn_at IS NULL`,
    )
    .get(book.id) as { total_copies: number; available_copies: number };

  return c.json({ book_id: book.id, ...counts });
});
