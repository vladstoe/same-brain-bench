import { Hono } from 'hono';
import { isDay } from '../clock.js';
import { toCsv, type CsvValue } from '../csv.js';
import type { AppEnv, Db } from '../db.js';
import { requirePermission } from '../guards.js';
import { badRequest, idParam, notFound } from '../http.js';
import { DAILY_CIRCULATION } from '../jobs/daily-circulation.js';
import { Filters, page } from '../query.js';
import type { Report } from '../types.js';

export const reports = new Hono<AppEnv>();

function present(report: Report) {
  return { ...report, body: JSON.parse(report.body) as Record<string, unknown> };
}

function findReport(db: Db, id: number): Report {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as Report | undefined;
  if (!report) {
    throw notFound('report not found');
  }
  return report;
}

reports.get('/reports', requirePermission('reports.read'), (c) => {
  const filters = new Filters();
  const kind = c.req.query('kind');
  if (kind) {
    filters.add('kind = ?', kind);
  }
  const period = c.req.query('period');
  if (period !== undefined) {
    if (!isDay(period)) {
      throw badRequest('period must be a YYYY-MM-DD date');
    }
    filters.add('period = ?', period);
  }

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(
      `SELECT id, kind, period, generated_at FROM reports ${filters.where}
       ORDER BY generated_at DESC, id DESC ${sql}`,
    )
    .all(...filters.params, ...params);
  return c.json(rows);
});

reports.get('/reports/daily/latest', requirePermission('reports.read'), (c) => {
  const report = c
    .get('db')
    .prepare('SELECT * FROM reports WHERE kind = ? ORDER BY generated_at DESC, id DESC LIMIT 1')
    .get(DAILY_CIRCULATION) as Report | undefined;
  if (!report) {
    throw notFound('no daily report has been generated yet');
  }
  return c.json(present(report));
});

reports.get('/reports/:id', requirePermission('reports.read'), (c) => {
  return c.json(present(findReport(c.get('db'), idParam(c))));
});

reports.get('/reports/:id/csv', requirePermission('reports.read'), (c) => {
  const report = present(findReport(c.get('db'), idParam(c)));
  const rows: CsvValue[][] = Object.entries(report.body).map(([metric, value]) => [
    metric,
    typeof value === 'object' && value !== null ? JSON.stringify(value) : (value as CsvValue),
  ]);

  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="${report.kind}-${report.period}.csv"`);
  return c.body(toCsv(['metric', 'value'], rows));
});
