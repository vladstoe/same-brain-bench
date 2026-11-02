import { Hono } from 'hono';
import { recordAudit } from '../audit.js';
import type { AppEnv } from '../db.js';
import { requirePermission } from '../guards.js';
import { notFound } from '../http.js';
import { list, run, UnknownJobError } from '../scheduler.js';

export const jobs = new Hono<AppEnv>();

jobs.get('/_jobs', requirePermission('jobs.read'), (c) => {
  return c.json(list().map((name) => ({ name })));
});

jobs.post('/_jobs/:name/run', requirePermission('jobs.run'), (c) => {
  const name = c.req.param('name');
  const db = c.get('db');
  const startedAt = c.get('clock')();

  try {
    const result = db.transaction(() => {
      const output = run(name, { db, now: startedAt });
      recordAudit(c, {
        action: 'job.ran',
        entity: 'job',
        entityId: null,
        data: { name, ...output },
      });
      return output;
    })();
    return c.json({ name, result });
  } catch (err) {
    if (err instanceof UnknownJobError) {
      throw notFound(err.message);
    }
    throw err;
  }
});
