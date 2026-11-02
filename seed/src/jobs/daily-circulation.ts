import { dayRange, utcDay } from '../clock.js';
import type { JobContext } from '../scheduler.js';

export const DAILY_CIRCULATION = 'daily-circulation';

export type DailyCirculationBody = {
  period: string;
  borrows: number;
  returns: number;
  renewals: number;
  fines_charged: number;
  fines_charged_cents: number;
  payments: number;
  payments_cents: number;
};

type ActionTotals = { action: string; count: number; cents: number };

const COUNTED_ACTIONS = [
  'loan.borrowed',
  'loan.returned',
  'loan.renewed',
  'fine.charged',
  'payment.received',
];

export function dailyCirculation({ db, now }: JobContext): { report_id: number; period: string } {
  const period = utcDay(now);
  const { start, end } = dayRange(period);

  const rows = db
    .prepare(
      `SELECT action,
              COUNT(*) AS count,
              COALESCE(SUM(json_extract(data, '$.amount_cents')), 0) AS cents
       FROM audit_log
       WHERE at >= ? AND at < ?
         AND action IN (${COUNTED_ACTIONS.map(() => '?').join(', ')})
       GROUP BY action`,
    )
    .all(start, end, ...COUNTED_ACTIONS) as ActionTotals[];
  const totals = new Map(rows.map((row) => [row.action, row]));

  const body: DailyCirculationBody = {
    period,
    borrows: totals.get('loan.borrowed')?.count ?? 0,
    returns: totals.get('loan.returned')?.count ?? 0,
    renewals: totals.get('loan.renewed')?.count ?? 0,
    fines_charged: totals.get('fine.charged')?.count ?? 0,
    fines_charged_cents: totals.get('fine.charged')?.cents ?? 0,
    payments: totals.get('payment.received')?.count ?? 0,
    payments_cents: totals.get('payment.received')?.cents ?? 0,
  };

  const result = db
    .prepare('INSERT INTO reports (kind, period, generated_at, body) VALUES (?, ?, ?, ?)')
    .run(DAILY_CIRCULATION, period, now.toISOString(), JSON.stringify(body));

  return { report_id: Number(result.lastInsertRowid), period };
}
