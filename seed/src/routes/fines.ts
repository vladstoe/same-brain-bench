import { Hono } from 'hono';
import { recordAudit } from '../audit.js';
import type { AppEnv, Db } from '../db.js';
import { requirePermission } from '../guards.js';
import {
  badRequest,
  centsField,
  idParam,
  notFound,
  now,
  optionalIdField,
  readJson,
  stringField,
} from '../http.js';
import { Filters, idQuery, page } from '../query.js';
import type { Fine, Payment } from '../types.js';
import { findLoan } from './loans.js';
import { findMember } from './members.js';

export const fines = new Hono<AppEnv>();

type FineWithBalance = Fine & { paid_cents: number; balance_cents: number };

const SELECT_FINE_WITH_BALANCE = `
  SELECT fines.*,
         COALESCE(SUM(payments.amount_cents), 0) AS paid_cents,
         fines.amount_cents - COALESCE(SUM(payments.amount_cents), 0) AS balance_cents
  FROM fines
  LEFT JOIN payments ON payments.fine_id = fines.id`;

export function findFine(db: Db, id: number): FineWithBalance {
  const fine = db
    .prepare(`${SELECT_FINE_WITH_BALANCE} WHERE fines.id = ? GROUP BY fines.id`)
    .get(id) as FineWithBalance | undefined;
  if (!fine) {
    throw notFound('fine not found');
  }
  return fine;
}

fines.post('/members/:id/fines', requirePermission('fines.write'), async (c) => {
  const memberId = idParam(c);
  const body = await readJson(c);
  const amountCents = centsField(body, 'amount_cents');
  const reason = stringField(body, 'reason');
  const loanId = optionalIdField(body, 'loan_id');
  const db = c.get('db');
  const createdAt = now(c);

  const fine = db.transaction(() => {
    findMember(db, memberId);
    if (loanId !== null && findLoan(db, loanId).member_id !== memberId) {
      throw badRequest('loan_id belongs to a different member');
    }

    const result = db
      .prepare(
        `INSERT INTO fines (member_id, loan_id, amount_cents, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memberId, loanId, amountCents, reason, createdAt);
    const id = Number(result.lastInsertRowid);
    recordAudit(c, {
      action: 'fine.charged',
      entity: 'fine',
      entityId: id,
      data: { member_id: memberId, loan_id: loanId, amount_cents: amountCents, reason },
    });
    return findFine(db, id);
  })();

  return c.json(fine, 201);
});

fines.get('/members/:id/fines', requirePermission('fines.read'), (c) => {
  const db = c.get('db');
  const member = findMember(db, idParam(c));
  const outstanding = c.req.query('outstanding') === 'true';

  const rows = db
    .prepare(
      `${SELECT_FINE_WITH_BALANCE}
       WHERE fines.member_id = ?
       GROUP BY fines.id
       ${outstanding ? 'HAVING balance_cents > 0' : ''}
       ORDER BY fines.id`,
    )
    .all(member.id) as FineWithBalance[];
  return c.json(rows);
});

fines.get('/fines', requirePermission('fines.read'), (c) => {
  const filters = new Filters();
  const memberId = idQuery(c, 'member_id');
  if (memberId !== undefined) {
    filters.add('fines.member_id = ?', memberId);
  }
  const loanId = idQuery(c, 'loan_id');
  if (loanId !== undefined) {
    filters.add('fines.loan_id = ?', loanId);
  }
  const outstanding = c.req.query('outstanding') === 'true';

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(
      `${SELECT_FINE_WITH_BALANCE}
       ${filters.where}
       GROUP BY fines.id
       ${outstanding ? 'HAVING balance_cents > 0' : ''}
       ORDER BY fines.id DESC
       ${sql}`,
    )
    .all(...filters.params, ...params) as FineWithBalance[];
  return c.json(rows);
});

fines.get('/fines/:id', requirePermission('fines.read'), (c) => {
  const db = c.get('db');
  const fine = findFine(db, idParam(c));
  const finePayments = db
    .prepare('SELECT * FROM payments WHERE fine_id = ? ORDER BY id')
    .all(fine.id) as Payment[];
  return c.json({ ...fine, payments: finePayments });
});
