import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const FILE_PATTERN = /^(\d+)_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    migrations.push({
      version: Number(match[1]),
      name: match[2],
      sql: readFileSync(join(dir, file), 'utf8'),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]?.version === migrations[i - 1]?.version) {
      throw new Error(`duplicate migration version ${migrations[i]?.version}`);
    }
  }
  return migrations;
}

export function migrate(db: Db, migrations: Migration[] = loadMigrations()): Migration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM _migrations').pluck().all() as number[],
  );
  const pending = migrations.filter((migration) => !applied.has(migration.version));
  const record = db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)');

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }

  return pending;
}
