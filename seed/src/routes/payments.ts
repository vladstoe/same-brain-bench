import { Hono } from 'hono';
import { recordAudit } from '../audit.js';
import { dayRange, isDay } from '../clock.js';
import type { AppEnv } from '../db.js';
import { requirePermission } from '../guards.js';
import { badRequest, centsField, conflict, idParam, now, readJson } from '../http.js';
import { Filters, idQuery, page } from '../query.js';
import type { Payment } from '../types.js';
import { findFine } from './fines.js';
import { findMember } from './members.js';

export const payments = new Hono<AppEnv>();

type PaymentWithMember = Payment & { member_id: number };

const SELECT_PAYMENT = `
  SELECT payments.*, fines.member_id
  FROM payments
  JOIN fines ON fines.id = payments.fine_id`;

payments.post('/fines/:id/payments', requirePermission('payments.write'), async (c) => {
  const fineId = idParam(c);
  const body = await readJson(c);
  const amountCents = centsField(body, 'amount_cents');
  const db = c.get('db');
  const paidAt = now(c);
  const receivedBy = c.get('member').id;

  const payment = db.transaction(() => {
    const fine = findFine(db, fineId);
    if (amountCents > fine.balance_cents) {
      throw conflict(`payment exceeds the balance of ${fine.balance_cents} cents`);
    }

    const result = db
      .prepare(
        'INSERT INTO payments (fine_id, amount_cents, paid_at, received_by) VALUES (?, ?, ?, ?)',
      )
      .run(fineId, amountCents, paidAt, receivedBy);
    const id = Number(result.lastInsertRowid);
    recordAudit(c, {
      action: 'payment.received',
      entity: 'payment',
      entityId: id,
      data: { fine_id: fineId, member_id: fine.member_id, amount_cents: amountCents },
    });
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Payment;
  })();

  return c.json({ ...payment, fine: findFine(db, fineId) }, 201);
});

payments.get('/payments', requirePermission('payments.read'), (c) => {
  const filters = new Filters();
  const day = c.req.query('day');
  if (day !== undefined) {
    if (!isDay(day)) {
      throw badRequest('day must be a YYYY-MM-DD date');
    }
    const { start, end } = dayRange(day);
    filters.add('payments.paid_at >= ? AND payments.paid_at < ?', start, end);
  }
  const receivedBy = idQuery(c, 'received_by');
  if (receivedBy !== undefined) {
    filters.add('payments.received_by = ?', receivedBy);
  }

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(`${SELECT_PAYMENT} ${filters.where} ORDER BY payments.paid_at, payments.id ${sql}`)
    .all(...filters.params, ...params) as PaymentWithMember[];
  return c.json(rows);
});

payments.get('/members/:id/payments', requirePermission('payments.read'), (c) => {
  const db = c.get('db');
  const member = findMember(db, idParam(c));
  const rows = db
    .prepare(`${SELECT_PAYMENT} WHERE fines.member_id = ? ORDER BY payments.paid_at, payments.id`)
    .all(member.id) as PaymentWithMember[];
  return c.json(rows);
});
