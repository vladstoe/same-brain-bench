import { Hono } from 'hono';
import { recordAudit } from '../audit.js';
import type { AppEnv, Db } from '../db.js';
import { requirePermission } from '../guards.js';
import { conflict, idParam, notFound, readJson, stringField } from '../http.js';
import { Filters, page } from '../query.js';
import type { Author, Book } from '../types.js';

export const authors = new Hono<AppEnv>();

export function findAuthor(db: Db, id: number): Author {
  const author = db.prepare('SELECT * FROM authors WHERE id = ?').get(id) as Author | undefined;
  if (!author) {
    throw notFound('author not found');
  }
  return author;
}

authors.get('/authors', requirePermission('authors.read'), (c) => {
  const filters = new Filters();
  const name = c.req.query('name');
  if (name) {
    filters.add('name LIKE ?', `%${name}%`);
  }

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(`SELECT * FROM authors ${filters.where} ORDER BY name, id ${sql}`)
    .all(...filters.params, ...params) as Author[];
  return c.json(rows);
});

authors.post('/authors', requirePermission('authors.write'), async (c) => {
  const body = await readJson(c);
  const name = stringField(body, 'name');
  const db = c.get('db');

  const author = db.transaction(() => {
    const result = db.prepare('INSERT INTO authors (name) VALUES (?)').run(name);
    const id = Number(result.lastInsertRowid);
    recordAudit(c, { action: 'author.created', entity: 'author', entityId: id, data: { name } });
    return findAuthor(db, id);
  })();

  return c.json(author, 201);
});

authors.get('/authors/:id', requirePermission('authors.read'), (c) => {
  const db = c.get('db');
  const author = findAuthor(db, idParam(c));
  const authorBooks = db
    .prepare('SELECT * FROM books WHERE author_id = ? ORDER BY title, id')
    .all(author.id) as Book[];
  return c.json({ ...author, books: authorBooks });
});

authors.put('/authors/:id', requirePermission('authors.write'), async (c) => {
  const id = idParam(c);
  const body = await readJson(c);
  const name = stringField(body, 'name');
  const db = c.get('db');

  const author = db.transaction(() => {
    const before = findAuthor(db, id);
    db.prepare('UPDATE authors SET name = ? WHERE id = ?').run(name, id);
    recordAudit(c, {
      action: 'author.updated',
      entity: 'author',
      entityId: id,
      data: { before: { name: before.name }, after: { name } },
    });
    return findAuthor(db, id);
  })();

  return c.json(author);
});

authors.delete('/authors/:id', requirePermission('authors.write'), (c) => {
  const id = idParam(c);
  const db = c.get('db');

  db.transaction(() => {
    const author = findAuthor(db, id);
    if (db.prepare('SELECT 1 FROM books WHERE author_id = ?').get(id)) {
      throw conflict('author has books');
    }
    db.prepare('DELETE FROM authors WHERE id = ?').run(id);
    recordAudit(c, {
      action: 'author.deleted',
      entity: 'author',
      entityId: id,
      data: { name: author.name },
    });
  })();

  return c.body(null, 204);
});
