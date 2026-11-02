import type { Context } from 'hono';
import type { AppEnv } from './db.js';
import { now } from './http.js';

export type AuditEntry = {
  action: string;
  entity: string;
  entityId: number | null;
  data: Record<string, unknown>;
};

export function recordAudit(c: Context<AppEnv>, entry: AuditEntry): void {
  c.get('db')
    .prepare(
      `INSERT INTO audit_log (at, actor_member_id, action, entity, entity_id, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now(c),
      c.get('member').id,
      entry.action,
      entry.entity,
      entry.entityId,
      JSON.stringify(entry.data),
    );
}
