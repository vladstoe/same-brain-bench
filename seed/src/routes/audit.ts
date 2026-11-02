import { Hono } from 'hono';
import { isTimestamp } from '../clock.js';
import type { AppEnv } from '../db.js';
import { requirePermission } from '../guards.js';
import { badRequest } from '../http.js';
import { Filters, idQuery, page } from '../query.js';
import type { AuditRow } from '../types.js';

export const audit = new Hono<AppEnv>();

function timestampQuery(value: string | undefined, name: string): string | undefined {
  if (value !== undefined && !isTimestamp(value)) {
    throw badRequest(`${name} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

audit.get('/audit-log', requirePermission('audit.read'), (c) => {
  const filters = new Filters();
  for (const name of ['action', 'entity'] as const) {
    const value = c.req.query(name);
    if (value) {
      filters.add(`${name} = ?`, value);
    }
  }
  for (const name of ['entity_id', 'actor_member_id'] as const) {
    const value = idQuery(c, name);
    if (value !== undefined) {
      filters.add(`${name} = ?`, value);
    }
  }
  const from = timestampQuery(c.req.query('from'), 'from');
  if (from) {
    filters.add('at >= ?', from);
  }
  const to = timestampQuery(c.req.query('to'), 'to');
  if (to) {
    filters.add('at < ?', to);
  }

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(`SELECT * FROM audit_log ${filters.where} ORDER BY id DESC ${sql}`)
    .all(...filters.params, ...params) as AuditRow[];
  return c.json(rows.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown })));
});
