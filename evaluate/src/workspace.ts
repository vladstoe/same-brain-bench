import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { run } from './proc.js';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.vitest', 'coverage']);
const SKIP_FILES = new Set(['.DS_Store']);

function skipEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) return SKIP_DIRECTORIES.has(name);
  if (SKIP_FILES.has(name)) return true;
  return /\.db(-shm|-wal)?$/.test(name);
}

export function listFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (skipEntry(entry.name, entry.isDirectory())) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(relative(root, full).split(sep).join('/'));
    }
  };

  walk(root);
  return found.sort();
}

export function copyWorktree(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (from) => {
      const name = from.split(sep).pop() ?? '';
      if (from === source) return true;
      let isDirectory = false;
      try {
        isDirectory = statSync(from).isDirectory();
      } catch {
        return false;
      }
      return !skipEntry(name, isDirectory);
    },
  });
}

export function hashWorktree(root: string): string {
  const digest = createHash('sha256');
  for (const path of listFiles(root)) {
    const fileHash = createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
    digest.update(`${path}\0${fileHash}\n`);
  }
  return `sha256:${digest.digest('hex')}`;
}

export type DiffStats = {
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  linesAdded: number;
  linesRemoved: number;
};

export async function diffStats(seedExport: string, worktree: string): Promise<DiffStats | null> {
  const result = await run(
    'git',
    ['diff', '--no-index', '--numstat', '--no-renames', '--', seedExport, worktree],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) return null;

  const seedFiles = new Set(listFiles(seedExport));
  const worktreeFiles = new Set(listFiles(worktree));

  const stats: DiffStats = {
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };

  for (const path of worktreeFiles) if (!seedFiles.has(path)) stats.filesAdded += 1;
  for (const path of seedFiles) if (!worktreeFiles.has(path)) stats.filesRemoved += 1;
  for (const path of seedFiles) {
    if (!worktreeFiles.has(path)) continue;
    const before = readFileSync(join(seedExport, path));
    const after = readFileSync(join(worktree, path));
    if (!before.equals(after)) stats.filesModified += 1;
  }

  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) continue;
    if (match[1] !== '-') stats.linesAdded += Number(match[1]);
    if (match[2] !== '-') stats.linesRemoved += Number(match[2]);
  }

  return stats;
}
