import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './evaluate.js';
import { EXPECTATIONS, type Expectation } from './expectations.js';
import { run } from './proc.js';
import { DEFAULT_SEED_TAG, defaultSeedRepo } from './seed-ref.js';
import { COMPLETION_KEYS, DECISION_KEYS, type Result } from './types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = resolve(packageRoot, '..', 'fixtures');

type Row = {
  expectation: Expectation;
  result: Result | null;
  failures: string[];
  seconds: number | null;
};

/** A throwaway clone of the tag. The seed repository itself is only read. */
async function cloneSeed(seedRepo: string, seedTag: string, path: string): Promise<void> {
  const cloned = await run(
    'git',
    ['clone', '--quiet', '--no-local', '--single-branch', '--branch', seedTag, seedRepo, path],
    { timeoutMs: 120_000 },
  );
  if (cloned.code !== 0) throw new Error(`git clone failed: ${cloned.stderr.trim()}`);
}

async function seedRefs(seedRepo: string): Promise<string> {
  const refs = await run(
    'git',
    ['-C', seedRepo, 'for-each-ref', '--format=%(objectname) %(refname)'],
    {
      timeoutMs: 30_000,
    },
  );
  const commits = await run('git', ['-C', seedRepo, 'rev-list', '--all', '--count'], {
    timeoutMs: 30_000,
  });
  return `${refs.stdout.trim()}\ncommits: ${commits.stdout.trim()}`;
}

function hasHunks(patch: string): boolean {
  return /^diff --git /m.test(patch);
}

async function applyFixture(worktree: string, patchPath: string): Promise<void> {
  if (!hasHunks(readFileSync(patchPath, 'utf8'))) return;
  const applied = await run('git', ['-C', worktree, 'apply', '--whitespace=nowarn', patchPath], {
    timeoutMs: 60_000,
  });
  if (applied.code !== 0) {
    throw new Error(`git apply failed for ${patchPath}: ${applied.stderr.trim()}`);
  }
}

function compare(expectation: Expectation, result: Result): string[] {
  const failures: string[] = [];

  if (result.evaluatorError !== null) {
    failures.push(
      `evaluatorError at stage ${result.evaluatorError.stage}: ${result.evaluatorError.message.split('\n')[0]}`,
    );
  }
  for (const key of COMPLETION_KEYS) {
    if (result.completion[key] !== expectation.completion[key]) {
      failures.push(
        `completion.${key} expected ${expectation.completion[key]} got ${result.completion[key]}`,
      );
    }
  }
  for (const key of DECISION_KEYS) {
    if (result.decisions[key] !== expectation.decisions[key]) {
      failures.push(`${key} expected ${expectation.decisions[key]} got ${result.decisions[key]}`);
    }
  }
  if (result.primary !== expectation.primary) {
    failures.push(`primary expected ${expectation.primary} got ${result.primary}`);
  }
  return failures;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function printTable(rows: Row[]): void {
  const labels: Record<(typeof COMPLETION_KEYS)[number], string> = {
    holds: 'holds',
    holdQueues: 'queues',
    overdueFines: 'fines',
    waive: 'waive',
    renewalLimits: 'renew',
    suspension: 'suspend',
    nightly: 'nightly',
    weekly: 'weekly',
    statement: 'stmt',
    seedTests: 'tests',
  };
  const headers = [
    'fixture',
    ...COMPLETION_KEYS.map((key) => labels[key]),
    ...DECISION_KEYS,
    'primary',
    'secs',
    'verdict',
  ];

  const body = rows.map((row) => {
    const { result, expectation } = row;
    const cell = (actual: boolean | undefined, expected: boolean): string => {
      if (actual === undefined) return '??';
      return `${actual ? 'pass' : 'FAIL'}${actual === expected ? '' : '!'}`;
    };
    return [
      expectation.fixture,
      ...COMPLETION_KEYS.map((key) => cell(result?.completion[key], expectation.completion[key])),
      ...DECISION_KEYS.map((key) => cell(result?.decisions[key], expectation.decisions[key])),
      cell(result?.primary, expectation.primary),
      row.seconds === null ? '-' : row.seconds.toFixed(1),
      row.failures.length === 0 ? 'as expected' : 'MISMATCH',
    ];
  });

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...body.map((line) => (line[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => pad(cell, widths[column] ?? 0)).join('  ');

  process.stdout.write(`\n${line(headers)}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);
  for (const cells of body) process.stdout.write(`${line(cells)}\n`);
  process.stdout.write(
    '\nA trailing "!" marks a cell that differs from the expectation for that fixture.\n',
  );
}

async function main(): Promise<void> {
  const seedRepo = resolve(process.argv[2] ?? defaultSeedRepo());
  const seedTag = DEFAULT_SEED_TAG;
  const only = process.env.GATE_ONLY?.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const keepDir = process.env.GATE_OUT ? resolve(process.env.GATE_OUT) : null;
  const expectations = only
    ? EXPECTATIONS.filter((expectation) => only.includes(expectation.fixture))
    : EXPECTATIONS;

  process.stdout.write(`seed repository: ${seedRepo} at ${seedTag}\n`);
  process.stdout.write(`fixtures:        ${fixturesDir}\n`);

  const refsBefore = await seedRefs(seedRepo);
  const scratch = mkdtempSync(join(tmpdir(), 'cold-handoff-gate-v3-'));
  const rows: Row[] = [];

  try {
    for (const expectation of expectations) {
      const patchPath = join(fixturesDir, `${expectation.fixture}.patch`);
      if (!existsSync(patchPath)) {
        rows.push({
          expectation,
          result: null,
          failures: [`missing fixture ${patchPath}`],
          seconds: null,
        });
        continue;
      }

      const worktree = join(scratch, expectation.fixture);
      const outDir = join(keepDir ?? join(scratch, 'out'), expectation.fixture);
      process.stdout.write(`\n=== ${expectation.fixture} — ${expectation.note}\n`);

      try {
        await cloneSeed(seedRepo, seedTag, worktree);
        await applyFixture(worktree, patchPath);
        const started = Date.now();
        const result = await evaluate({
          worktree,
          outDir,
          seedRepo,
          seedTag,
          log: (message) => process.stdout.write(`    ${message}\n`),
        });
        const failures = compare(expectation, result);
        rows.push({ expectation, result, failures, seconds: (Date.now() - started) / 1000 });
        for (const failure of failures) process.stdout.write(`    MISMATCH: ${failure}\n`);
      } catch (error) {
        rows.push({
          expectation,
          result: null,
          failures: [(error as Error).message],
          seconds: null,
        });
        process.stdout.write(`    ERROR: ${(error as Error).message}\n`);
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  printTable(rows);

  const refsAfter = await seedRefs(seedRepo);
  const failed = rows.filter((row) => row.failures.length > 0);
  if (refsAfter !== refsBefore) {
    process.stdout.write(
      `\nthe seed repository's refs changed during the gate:\n${refsBefore}\n---\n${refsAfter}\n`,
    );
  }
  if (failed.length > 0 || refsAfter !== refsBefore) {
    process.stdout.write(`\ngate FAILED: ${failed.length} of ${rows.length} fixtures mismatched\n`);
    for (const row of failed) {
      process.stdout.write(`  ${row.expectation.fixture}: ${row.failures.join('; ')}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`\ngate PASSED: ${rows.length} of ${rows.length} fixtures as expected\n`);
}

void main();
