import { Hono } from 'hono';
import { memberAccount } from '../accounts.js';
import { recordAudit } from '../audit.js';
import type { AppEnv, Db } from '../db.js';
import { requirePermission } from '../guards.js';
import {
  badRequest,
  conflict,
  idParam,
  notFound,
  readJson,
  stringField,
  type JsonObject,
} from '../http.js';
import { Filters, page } from '../query.js';
import { MEMBER_ROLES, type Member, type MemberRole } from '../types.js';

export const members = new Hono<AppEnv>();

function isRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value);
}

function roleField(body: JsonObject): MemberRole {
  if (!isRole(body.role)) {
    throw badRequest(`role must be one of ${MEMBER_ROLES.join(', ')}`);
  }
  return body.role;
}

export function findMember(db: Db, id: number): Member {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id) as Member | undefined;
  if (!member) {
    throw notFound('member not found');
  }
  return member;
}

members.get('/members', requirePermission('members.read'), (c) => {
  const filters = new Filters();
  const role = c.req.query('role');
  if (role !== undefined) {
    filters.add('role = ?', roleField({ role }));
  }
  const name = c.req.query('name');
  if (name) {
    filters.add('name LIKE ?', `%${name}%`);
  }

  const { sql, params } = page(c);
  const rows = c
    .get('db')
    .prepare(`SELECT * FROM members ${filters.where} ORDER BY name, id ${sql}`)
    .all(...filters.params, ...params) as Member[];
  return c.json(rows);
});

members.post('/members', requirePermission('members.write'), async (c) => {
  const body = await readJson(c);
  const name = stringField(body, 'name');
  const role = roleField(body);
  const db = c.get('db');

  const member = db.transaction(() => {
    const result = db.prepare('INSERT INTO members (name, role) VALUES (?, ?)').run(name, role);
    const id = Number(result.lastInsertRowid);
    recordAudit(c, {
      action: 'member.created',
      entity: 'member',
      entityId: id,
      data: { name, role },
    });
    return findMember(db, id);
  })();

  return c.json(member, 201);
});

members.get('/members/:id', requirePermission('members.read'), (c) => {
  return c.json(findMember(c.get('db'), idParam(c)));
});

members.get('/members/:id/account', requirePermission('members.read'), (c) => {
  const db = c.get('db');
  const member = findMember(db, idParam(c));
  return c.json(memberAccount(db, member.id));
});

members.put('/members/:id', requirePermission('members.write'), async (c) => {
  const id = idParam(c);
  const body = await readJson(c);
  const name = stringField(body, 'name');
  const role = roleField(body);
  const db = c.get('db');

  const member = db.transaction(() => {
    const before = findMember(db, id);
    db.prepare('UPDATE members SET name = ?, role = ? WHERE id = ?').run(name, role, id);
    recordAudit(c, {
      action: 'member.updated',
      entity: 'member',
      entityId: id,
      data: { before: { name: before.name, role: before.role }, after: { name, role } },
    });
    return findMember(db, id);
  })();

  return c.json(member);
});

members.delete('/members/:id', requirePermission('members.write'), (c) => {
  const id = idParam(c);
  const db = c.get('db');

  db.transaction(() => {
    const member = findMember(db, id);
    const history = db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM loans WHERE member_id = ?)
             OR EXISTS (SELECT 1 FROM fines WHERE member_id = ?)
             OR EXISTS (SELECT 1 FROM payments WHERE received_by = ?)`,
      )
      .pluck()
      .get(id, id, id);
    if (history) {
      throw conflict('member has loans, fines or payments on record');
    }
    db.prepare('DELETE FROM members WHERE id = ?').run(id);
    recordAudit(c, {
      action: 'member.deleted',
      entity: 'member',
      entityId: id,
      data: { name: member.name, role: member.role },
    });
  })();

  return c.body(null, 204);
});
