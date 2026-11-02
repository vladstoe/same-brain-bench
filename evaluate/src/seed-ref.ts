import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { columnsOf, listUserTables } from './audit.js';
import { run } from './proc.js';

export const DEFAULT_SEED_TAG = 'seed-v2';

/** The repo `scripts/make-seed-repo.sh` builds, in the root of the bench repo. */
export function defaultSeedRepo(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.seed-repo');
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Reads the tag with git archive, which never writes to the seed repository. */
export async function exportSeedTag(
  seedRepo: string,
  seedTag: string,
  destination: string,
): Promise<void> {
  if (!existsSync(join(seedRepo, '.git'))) {
    throw new Error(`seed repository not found at ${seedRepo}`);
  }

  const tagCheck = await run(
    'git',
    ['-C', seedRepo, 'rev-parse', '--verify', '--quiet', `refs/tags/${seedTag}^{commit}`],
    { timeoutMs: 30_000 },
  );
  if (tagCheck.code !== 0) {
    throw new Error(`tag '${seedTag}' not found in ${seedRepo}`);
  }

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  const archive = await run(
    'bash',
    [
      '-c',
      `git -C ${quote(seedRepo)} archive refs/tags/${seedTag} | tar -x -C ${quote(destination)}`,
    ],
    { timeoutMs: 60_000 },
  );
  if (archive.code !== 0) {
    throw new Error(`could not export ${seedTag}: ${archive.stderr.trim()}`);
  }
}

export type SeedSchema = {
  tables: string[];
  booksColumns: string[];
  copiesColumns: string[];
  membersColumns: string[];
  loansColumns: string[];
};

/** Applies the tag's migrations, in the seed runner's order, to a scratch database. */
export function seedSchema(seedExport: string, scratchDatabasePath: string): SeedSchema {
  const dir = join(seedExport, 'src', 'migrations');
  const files = readdirSync(dir)
    .map((file) => ({ file, match: /^(\d+)_([a-z0-9_]+)\.sql$/.exec(file) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => Number(a.match?.[1]) - Number(b.match?.[1]));

  rmSync(scratchDatabasePath, { force: true });
  const db = new Database(scratchDatabasePath);
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const { file } of files) db.exec(readFileSync(join(dir, file), 'utf8'));
    return {
      tables: listUserTables(db),
      booksColumns: columnsOf(db, 'books'),
      copiesColumns: columnsOf(db, 'copies'),
      membersColumns: columnsOf(db, 'members'),
      loansColumns: columnsOf(db, 'loans'),
    };
  } finally {
    db.close();
    rmSync(scratchDatabasePath, { force: true });
  }
}

export type Dependencies = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export function readDependencies(root: string): Dependencies | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as Partial<Dependencies>;
    return {
      dependencies: manifest.dependencies ?? {},
      devDependencies: manifest.devDependencies ?? {},
    };
  } catch {
    return null;
  }
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export function sameDependencies(a: Dependencies | null, b: Dependencies | null): boolean {
  if (a === null || b === null) return false;
  return (
    sameRecord(a.dependencies, b.dependencies) && sameRecord(a.devDependencies, b.devDependencies)
  );
}
