import { Hono } from 'hono';
import { memberAccount } from '../accounts.js';
import { recordAudit } from '../audit.js';
import { addDays } from '../clock.js';
import { LOAN_PERIOD_DAYS } from '../config.js';
import type { AppEnv, Db } from '../db.js';
import { requirePermission } from '../guards.js';
import { badRequest, conflict, idField, idParam, notFound, now, readJson } from '../http.js';
import { Filters, idQuery, page } from '../query.js';
import type { Loan } from '../types.js';
import { findCopy } from './copies.js';
import { findMember } from './members.js';

export const loans = new Hono<AppEnv>();

type LoanDetail = Loan & { barcode: string; book_id: number; title: string };

const SELECT_LOAN_DETAIL = `
  SELECT loans.*, copies.barcode, copies.book_id, books.title
  FROM loans
  JOIN copies ON copies.id = loans.copy_id
  JOIN books ON books.id = copies.book_id`;

function statusFilter(status: string | undefined): string | null {
  switch (status ?? 'all') {
    case 'all':
      return null;
    case 'open':
      return 'loans.returned_at IS NULL';
    case 'returned':
      return 'loans.returned_at IS NOT NULL';
    default:
      throw badRequest('status must be one of all, open, returned');
  }
}

export function findLoan(db: Db, id: number): Loan {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(id) as Loan | undefined;
  if (!loan) {
    throw notFound('loan not found');
  }
  return loan;
}

function findOpenLoan(db: Db, id: number): Loan {
  const loan = findLoan(db, id);
  if (loan.returned_at !== null) {
    throw conflict('loan is already returned');
  }
  return loan;
}

loans.post('/loans', requirePermission('loans.write'), async (c) => {
  const body = await readJson(c);
  const copyId = idField(body, 'copy_id');
  const memberId = idField(body, 'member_id');
  const db = c.get('db');
  const borrowedAt = now(c);
  const dueAt = addDays(borrowedAt, LOAN_PERIOD_DAYS);

  const loan = db.transaction(() => {
    const copy = findCopy(db, copyId);
    findMember(db, memberId);
    if (copy.withdrawn_at !== null) {
      throw conflict('copy is withdrawn');
    }
    if (copy.on_loan) {
      throw conflict('copy is already on loan');
    }
    const { blocks } = memberAccount(db, memberId);
    if (blocks.length > 0) {
      throw conflict(blocks.join('; '));
    }

    const result = db
      .prepare('INSERT INTO loans (copy_id, member_id, borrowed_at, due_at) VALUES (?, ?, ?, ?)')
      .run(copyId, memberId, borrowedAt, dueAt);
    const id = Number(result.lastInsertRowid);
    recordAudit(c, {
      action: 'loan.borrowed',
      entity: 'loan',
      entityId: id,
      data: { copy_id: copyId, member_id: memberId, book_id: copy.book_id, due_at: dueAt },
    });
    return findLoan(db, id);
  })();

  return c.json(loan, 201);
});

loans.get('/loans', requirePermission('loans.read'), (c) => {
  const filters = new Filters();
  for (const [param, column] of [
    ['member_id', 'loans.member_id'],
    ['copy_id', 'loans.copy_id'],
    ['book_id', 'copies.book_id'],
  ] as const) {
    const value = idQuery(c, param);
    if (value !== undefined) {
      filters.add(`${column} = ?`, value);
    }
  }
  const status = statusFilter(c.req.query('status'));
  if (status) {
    filters.add(status);
  }

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(`${SELECT_LOAN_DETAIL} ${filters.where} ORDER BY loans.id DESC ${sql}`)
    .all(...filters.params, ...params) as LoanDetail[];
  return c.json(rows);
});

loans.get('/loans/:id', requirePermission('loans.read'), (c) => {
  const row = c.get('db').prepare(`${SELECT_LOAN_DETAIL} WHERE loans.id = ?`).get(idParam(c)) as
    | LoanDetail
    | undefined;
  if (!row) {
    throw notFound('loan not found');
  }
  return c.json(row);
});

loans.post('/loans/:id/return', requirePermission('loans.write'), (c) => {
  const id = idParam(c);
  const db = c.get('db');
  const returnedAt = now(c);

  const loan = db.transaction(() => {
    const open = findOpenLoan(db, id);
    db.prepare('UPDATE loans SET returned_at = ? WHERE id = ?').run(returnedAt, id);
    recordAudit(c, {
      action: 'loan.returned',
      entity: 'loan',
      entityId: id,
      data: { copy_id: open.copy_id, member_id: open.member_id, due_at: open.due_at },
    });
    return findLoan(db, id);
  })();

  return c.json(loan);
});

loans.post('/loans/:id/renew', requirePermission('loans.write'), (c) => {
  const id = idParam(c);
  const db = c.get('db');

  const loan = db.transaction(() => {
    const open = findOpenLoan(db, id);
    const dueAt = addDays(open.due_at, LOAN_PERIOD_DAYS);
    db.prepare('UPDATE loans SET due_at = ? WHERE id = ?').run(dueAt, id);
    recordAudit(c, {
      action: 'loan.renewed',
      entity: 'loan',
      entityId: id,
      data: {
        copy_id: open.copy_id,
        member_id: open.member_id,
        previous_due_at: open.due_at,
        due_at: dueAt,
      },
    });
    return findLoan(db, id);
  })();

  return c.json(loan);
});

loans.get('/members/:id/loans', requirePermission('loans.read'), (c) => {
  const db = c.get('db');
  const member = findMember(db, idParam(c));

  const filters = new Filters().add('loans.member_id = ?', member.id);
  const status = statusFilter(c.req.query('status'));
  if (status) {
    filters.add(status);
  }

  const rows = db
    .prepare(`${SELECT_LOAN_DETAIL} ${filters.where} ORDER BY loans.id`)
    .all(...filters.params) as LoanDetail[];
  return c.json(rows);
});
