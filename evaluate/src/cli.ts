import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluate } from './evaluate.js';
import { DEFAULT_SEED_TAG, defaultSeedRepo } from './seed-ref.js';

function usage(): never {
  process.stderr.write(
    'usage: evaluate <worktree> <out-dir> [--seed-repo <path>] [--seed-tag <tag>] [--keep-temp] [--quiet]\n',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let seedRepo = defaultSeedRepo();
  let seedTag = DEFAULT_SEED_TAG;
  let keepTemp = false;
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--seed-repo' || arg === '--seed-tag') {
      const value = argv[index + 1];
      if (value === undefined) usage();
      if (arg === '--seed-repo') seedRepo = value;
      else seedTag = value;
      index += 1;
    } else if (arg === '--keep-temp') {
      keepTemp = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === undefined || arg.startsWith('-')) {
      usage();
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) usage();
  const worktree = resolve(positional[0] as string);
  const outDir = resolve(positional[1] as string);

  if (!existsSync(worktree)) {
    process.stderr.write(`worktree not found: ${worktree}\n`);
    process.exit(2);
  }

  const result = await evaluate({
    worktree,
    outDir,
    seedRepo: resolve(seedRepo),
    seedTag,
    keepTemp,
    log: quiet ? () => {} : (message) => process.stderr.write(`[evaluate] ${message}\n`),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.evaluatorError === null ? 0 : 1);
}

void main();
