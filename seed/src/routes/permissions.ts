import { Hono } from 'hono';
import type { AppEnv } from '../db.js';
import { requirePermission } from '../guards.js';
import type { Permission } from '../types.js';

export const permissions = new Hono<AppEnv>();

permissions.get('/permissions', requirePermission('permissions.read'), (c) => {
  const db = c.get('db');
  const role = c.req.query('role');
  const rows = role
    ? db.prepare('SELECT role, action FROM permissions WHERE role = ? ORDER BY action').all(role)
    : db.prepare('SELECT role, action FROM permissions ORDER BY role, action').all();
  return c.json(rows as Permission[]);
});
