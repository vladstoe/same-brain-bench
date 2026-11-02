import { Hono } from 'hono';
import { recordAudit } from '../audit.js';
import { isTimestamp } from '../clock.js';
import type { AppEnv, Db } from '../db.js';
import { requirePermission } from '../guards.js';
import { badRequest, conflict, idParam, notFound, now, readJson, stringField } from '../http.js';
import type { Copy } from '../types.js';
import { findBook } from './books.js';

export const copies = new Hono<AppEnv>();

type CopyWithLoan = Copy & { on_loan: boolean };

const SELECT_COPY = `
  SELECT copies.*, EXISTS (
    SELECT 1 FROM loans WHERE loans.copy_id = copies.id AND loans.returned_at IS NULL
  ) AS on_loan
  FROM copies`;

function withLoanFlag(row: Copy & { on_loan: number }): CopyWithLoan {
  return { ...row, on_loan: row.on_loan === 1 };
}

export function findCopy(db: Db, id: number): CopyWithLoan {
  const row = db.prepare(`${SELECT_COPY} WHERE copies.id = ?`).get(id) as
    | (Copy & { on_loan: number })
    | undefined;
  if (!row) {
    throw notFound('copy not found');
  }
  return withLoanFlag(row);
}

copies.get('/books/:id/copies', requirePermission('copies.read'), (c) => {
  const db = c.get('db');
  const book = findBook(db, idParam(c));
  const includeWithdrawn = c.req.query('include_withdrawn') === 'true';

  const rows = db
    .prepare(
      `${SELECT_COPY} WHERE copies.book_id = ?
       ${includeWithdrawn ? '' : 'AND copies.withdrawn_at IS NULL'}
       ORDER BY copies.id`,
    )
    .all(book.id) as (Copy & { on_loan: number })[];
  return c.json(rows.map(withLoanFlag));
});

copies.post('/books/:id/copies', requirePermission('copies.write'), async (c) => {
  const bookId = idParam(c);
  const body = await readJson(c);
  const barcode = stringField(body, 'barcode');
  if (body.acquired_at !== undefined && !isTimestamp(body.acquired_at)) {
    throw badRequest('acquired_at must be an ISO-8601 UTC timestamp');
  }
  const acquiredAt = (body.acquired_at as string | undefined) ?? now(c);
  const db = c.get('db');

  const copy = db.transaction(() => {
    findBook(db, bookId);
    if (db.prepare('SELECT 1 FROM copies WHERE barcode = ?').get(barcode)) {
      throw conflict(`barcode ${barcode} is already in use`);
    }
    const result = db
      .prepare('INSERT INTO copies (book_id, barcode, acquired_at) VALUES (?, ?, ?)')
      .run(bookId, barcode, acquiredAt);
    const id = Number(result.lastInsertRowid);
    recordAudit(c, {
      action: 'copy.added',
      entity: 'copy',
      entityId: id,
      data: { book_id: bookId, barcode, acquired_at: acquiredAt },
    });
    return findCopy(db, id);
  })();

  return c.json(copy, 201);
});

copies.get('/copies', requirePermission('copies.read'), (c) => {
  const barcode = c.req.query('barcode');
  if (!barcode) {
    throw badRequest('barcode query parameter is required');
  }
  const row = c.get('db').prepare(`${SELECT_COPY} WHERE copies.barcode = ?`).get(barcode) as
    | (Copy & { on_loan: number })
    | undefined;
  if (!row) {
    throw notFound('copy not found');
  }
  return c.json(withLoanFlag(row));
});

copies.get('/copies/:id', requirePermission('copies.read'), (c) => {
  return c.json(findCopy(c.get('db'), idParam(c)));
});

copies.post('/copies/:id/withdraw', requirePermission('copies.write'), (c) => {
  const id = idParam(c);
  const db = c.get('db');
  const withdrawnAt = now(c);

  const copy = db.transaction(() => {
    const before = findCopy(db, id);
    if (before.withdrawn_at !== null) {
      throw conflict('copy is already withdrawn');
    }
    if (before.on_loan) {
      throw conflict('copy is on loan');
    }
    db.prepare('UPDATE copies SET withdrawn_at = ? WHERE id = ?').run(withdrawnAt, id);
    recordAudit(c, {
      action: 'copy.withdrawn',
      entity: 'copy',
      entityId: id,
      data: { book_id: before.book_id, barcode: before.barcode },
    });
    return findCopy(db, id);
  })();

  return c.json(copy);
});
