import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.js';
import { listFiles } from './workspace.js';

export type AddedLine = { file: string; line: string };

/**
 * Lines the worktree's src/ adds over the seed's, from a zero-context diff run in `root`, where
 * `seedDir` and `workDir` are relative subdirectories.
 */
export async function addedSourceLines(
  root: string,
  seedDir: string,
  workDir: string,
): Promise<AddedLine[]> {
  const result = await run(
    'git',
    [
      'diff',
      '--no-index',
      '--no-color',
      '--no-renames',
      '-U0',
      '--',
      `${seedDir}/src`,
      `${workDir}/src`,
    ],
    { cwd: root, timeoutMs: 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`git diff failed: ${result.stderr.trim()}`);
  }

  const added: AddedLine[] = [];
  const prefix = `b/${workDir}/`;
  let file: string | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4);
      file = path.startsWith(prefix) ? path.slice(prefix.length) : null;
      continue;
    }
    if (line.startsWith('+') && file !== null) added.push({ file, line: line.slice(1) });
  }
  return added;
}

const TIMER_CALL = /\bset(?:Interval|Timeout)\s*\(/;

export function timerCalls(added: AddedLine[]): AddedLine[] {
  return added
    .filter((entry) => TIMER_CALL.test(entry.line))
    .map((entry) => ({ file: entry.file, line: entry.line.trim() }));
}

const ROLE_LITERAL = /(['"`])(patron|clerk|librarian|admin)\1/g;

export function roleLiterals(added: AddedLine[]): Array<{ file: string; literal: string }> {
  const found: Array<{ file: string; literal: string }> = [];
  for (const entry of added) {
    if (entry.file.startsWith('src/migrations/')) continue;
    for (const match of entry.line.matchAll(ROLE_LITERAL)) {
      if (match[2] !== undefined) found.push({ file: entry.file, literal: match[2] });
    }
  }
  return found;
}

function sourceFiles(worktree: string): string[] {
  const src = join(worktree, 'src');
  if (!existsSync(src)) return [];
  return listFiles(src)
    .filter((path) => /\.(ts|tsx|js|mjs|cjs)$/.test(path))
    .map((path) => `src/${path}`);
}

function routePathLiterals(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(['"`])(\/[^'"`\n]*)\1/g)) {
    if (match[2] !== undefined) found.push(match[2]);
  }
  return found;
}

const NEW_ROUTES: Array<{ route: string; pattern: RegExp }> = [
  { route: 'POST /books/:id/holds', pattern: /^\/books\/:[A-Za-z0-9_]+\/holds$/ },
  { route: 'POST /holds/:id/cancel', pattern: /^\/holds\/:[A-Za-z0-9_]+\/cancel$/ },
  { route: 'POST /fines/:id/waive', pattern: /^\/fines\/:[A-Za-z0-9_]+\/waive$/ },
  { route: 'GET /reports/nightly/latest', pattern: /^\/reports\/nightly\/latest$/ },
  { route: 'GET /books/:id/holds', pattern: /^\/books\/:[A-Za-z0-9_]+\/holds$/ },
  { route: 'GET /members/:id/holds', pattern: /^\/members\/:[A-Za-z0-9_]+\/holds$/ },
  { route: 'POST /members/:id/suspend', pattern: /^\/members\/:[A-Za-z0-9_]+\/suspend$/ },
  { route: 'POST /members/:id/unsuspend', pattern: /^\/members\/:[A-Za-z0-9_]+\/unsuspend$/ },
  { route: 'GET /reports/weekly/latest', pattern: /^\/reports\/weekly\/latest$/ },
  { route: 'GET /members/:id/statement', pattern: /^\/members\/:[A-Za-z0-9_]+\/statement$/ },
];

export function observeGuardUse(
  worktree: string,
): Array<{ route: string; file: string | null; referencesRequirePermission: boolean | null }> {
  const files = sourceFiles(worktree).map((path) => ({
    path,
    source: readFileSync(join(worktree, path), 'utf8'),
  }));

  return NEW_ROUTES.map(({ route, pattern }) => {
    const hit = files.find((file) =>
      routePathLiterals(file.source).some((literal) => pattern.test(literal)),
    );
    if (!hit) return { route, file: null, referencesRequirePermission: null };
    return {
      route,
      file: hit.path,
      referencesRequirePermission: hit.source.includes('requirePermission'),
    };
  });
}
