import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './db.js';
import type { Member } from './types.js';

export function requirePermission(action: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('x-member-id');
    if (!header) {
      return c.json({ error: 'x-member-id header is required' }, 401);
    }

    const db = c.get('db');
    const id = Number(header);
    const member = Number.isInteger(id)
      ? (db.prepare('SELECT * FROM members WHERE id = ?').get(id) as Member | undefined)
      : undefined;
    if (!member) {
      return c.json({ error: 'x-member-id does not match a member' }, 403);
    }

    const granted = db
      .prepare('SELECT 1 FROM permissions WHERE role = ? AND action = ?')
      .get(member.role, action);
    if (!granted) {
      return c.json({ error: `${action} permission required` }, 403);
    }

    c.set('member', member);
    await next();
  });
}
