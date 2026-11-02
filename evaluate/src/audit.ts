import type Database from 'better-sqlite3';

export type Db = Database.Database;

export const AUDIT_TABLE = '_audit';
const TRIGGER_PREFIX = '_audit_';

export type AuditInstall = {
  audited: string[];
  skipped: Array<{ table: string; reason: string }>;
};

type TableInfo = { name: string; withoutRowid: boolean };

function listTables(db: Db): TableInfo[] {
  const rows = db.prepare('PRAGMA main.table_list').all() as Array<{
    name: string;
    type: string;
    wr: number;
  }>;
  return rows
    .filter(
      (row) => row.type === 'table' && !row.name.startsWith('sqlite_') && row.name !== AUDIT_TABLE,
    )
    .map((row) => ({ name: row.name, withoutRowid: row.wr === 1 }))
    .sort((a, b) => compare(a.name, b.name));
}

export function listUserTables(db: Db): string[] {
  return listTables(db).map((table) => table.name);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function triggerName(table: string, op: string): string {
  const safe = table.replaceAll(/[^A-Za-z0-9_]/g, '_');
  return `${TRIGGER_PREFIX}${safe}_${op}`;
}

function primaryKeyColumns(db: Db, table: string): string[] {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  return columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
}

/** The expression that identifies one row: its rowid, or its primary key for a table without one. */
function rowKey(db: Db, table: TableInfo, alias: string): string {
  if (!table.withoutRowid) return `${alias}.rowid`;
  const columns = primaryKeyColumns(db, table.name).map(
    (column) => `${alias}.${quoteIdentifier(column)}`,
  );
  return `json_array(${columns.join(', ')})`;
}

function installedTriggers(db: Db): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?`)
    .all(`${TRIGGER_PREFIX}%`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Idempotent: creates the audit table if absent and adds insert, update and delete triggers to any
 * table that does not have them yet.
 */
export function installAudit(db: Db): AuditInstall {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      seq INTEGER PRIMARY KEY,
      table_name TEXT NOT NULL,
      op TEXT NOT NULL,
      row_id
    );
  `);

  const existing = installedTriggers(db);
  const audited: string[] = [];
  const skipped: Array<{ table: string; reason: string }> = [];

  for (const table of listTables(db)) {
    let ok = true;
    for (const op of ['insert', 'update', 'delete']) {
      const name = triggerName(table.name, op);
      if (existing.has(name)) continue;
      try {
        const key = rowKey(db, table, op === 'delete' ? 'OLD' : 'NEW');
        db.exec(`
          CREATE TRIGGER ${quoteIdentifier(name)} AFTER ${op.toUpperCase()}
          ON ${quoteIdentifier(table.name)}
          BEGIN
            INSERT INTO ${AUDIT_TABLE} (table_name, op, row_id)
            VALUES (${literal(table.name)}, ${literal(op)}, ${key});
          END;
        `);
      } catch (error) {
        ok = false;
        skipped.push({ table: table.name, reason: `${op}: ${(error as Error).message}` });
      }
    }
    if (ok) audited.push(table.name);
  }

  return { audited, skipped };
}

export function clearAudit(db: Db): void {
  db.exec(`DELETE FROM ${AUDIT_TABLE};`);
}

export function lastSeq(db: Db): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${AUDIT_TABLE}`).get() as {
    seq: number;
  };
  return row.seq;
}

export type RowId = number | string | bigint | null;

export type Write = { table: string; op: string; rowId: RowId };

export function auditBetween(db: Db, afterSeq: number, uptoSeq: number): Write[] {
  const rows = db
    .prepare(
      `SELECT table_name, op, row_id FROM ${AUDIT_TABLE}
       WHERE seq > ? AND seq <= ? ORDER BY seq`,
    )
    .all(afterSeq, uptoSeq) as Array<{ table_name: string; op: string; row_id: RowId }>;
  return rows.map((row) => ({ table: row.table_name, op: row.op, rowId: row.row_id }));
}

export function auditSummary(
  db: Db,
  uptoSeq: number,
): Array<{
  table_name: string;
  op: string;
  count: number;
}> {
  return db
    .prepare(
      `SELECT table_name, op, COUNT(*) AS count FROM ${AUDIT_TABLE}
       WHERE seq <= ? GROUP BY table_name, op ORDER BY table_name, op`,
    )
    .all(uptoSeq) as Array<{ table_name: string; op: string; count: number }>;
}

export function rowIdsOf(db: Db, table: string): RowId[] {
  const info = listTables(db).find((candidate) => candidate.name === table);
  if (!info) return [];
  const key = rowKey(db, info, 't');
  return (
    db
      .prepare(`SELECT ${key} AS id FROM ${quoteIdentifier(table)} AS t ORDER BY 1`)
      .all() as Array<{
      id: RowId;
    }>
  ).map((row) => row.id);
}

export function readRow(db: Db, table: string, rowId: RowId): Record<string, unknown> | null {
  const info = listTables(db).find((candidate) => candidate.name === table);
  if (!info) return null;
  try {
    const key = rowKey(db, info, 't');
    const row = db
      .prepare(`SELECT t.* FROM ${quoteIdentifier(table)} AS t WHERE ${key} = ?`)
      .get(rowId) as Record<string, unknown> | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function columnsOf(db: Db, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

export function foreignKeysOf(
  db: Db,
  table: string,
): Array<{ from: string; table: string; to: string | null }> {
  return (
    db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Array<{
      from: string;
      table: string;
      to: string | null;
    }>
  )
    .map((key) => ({ from: key.from, table: key.table, to: key.to }))
    .sort((a, b) => compare(`${a.from}${a.table}`, `${b.from}${b.table}`));
}

/**
 * Attributes writes to calls. Before a call the caller notes the last sequence number; after it,
 * capture() returns the call's audit rows plus, for any table that appeared during the call, the
 * rows it holds, counted as inserted by that call. New tables get triggers at once.
 */
export class WriteTracker {
  private readonly known: Set<string>;
  readonly created: string[] = [];

  constructor(private readonly db: Db) {
    this.known = new Set(listUserTables(db));
  }

  mark(): number {
    return lastSeq(this.db);
  }

  capture(beforeSeq: number): { writes: Write[]; newTables: string[] } {
    const writes = auditBetween(this.db, beforeSeq, lastSeq(this.db));
    const newTables = listUserTables(this.db).filter((table) => !this.known.has(table));
    if (newTables.length > 0) {
      installAudit(this.db);
      for (const table of newTables) {
        this.known.add(table);
        this.created.push(table);
        for (const rowId of rowIdsOf(this.db, table)) {
          writes.push({ table, op: 'insert', rowId });
        }
      }
    }
    return { writes, newTables };
  }
}

export function summariseWrites(
  writes: Write[],
): Array<{ table: string; op: string; count: number }> {
  const counts = new Map<string, { table: string; op: string; count: number }>();
  for (const write of writes) {
    const key = `${write.table}\0${write.op}`;
    const entry = counts.get(key) ?? { table: write.table, op: write.op, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => compare(`${a.table}\0${a.op}`, `${b.table}\0${b.op}`));
}
