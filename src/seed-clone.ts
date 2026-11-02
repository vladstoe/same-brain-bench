import fs from "node:fs";
import path from "node:path";
import type { BenchConfig, SeedCloneCheck } from "./types.ts";
import type { Check } from "./preflight.ts";
import { evaluatorDir } from "./config.ts";
import { exists, readJson, run } from "./util.ts";

async function git(args: string[]): Promise<string> {
  const res = await run("git", args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/**
 * What an attempt's clone holds, and what is wrong with it. The clone must be the
 * tag's commit and nothing else: one ref, no remote, a clean tree.
 */
export async function inspectSeedClone(
  work: string,
  seedTag: string,
  expectedHead: string,
): Promise<{ check: SeedCloneCheck; problems: string[] }> {
  const head = (await git(["-C", work, "rev-parse", "HEAD"])).trim();
  const refs = lines(await git(["-C", work, "for-each-ref", "--format=%(refname)"]));
  const remotes = lines(await git(["-C", work, "remote"]));
  const status = await git(["-C", work, "status", "--porcelain"]);
  const check: SeedCloneCheck = { head, refs, remotes, statusClean: status.trim() === "" };

  const problems: string[] = [];
  if (head !== expectedHead) problems.push(`HEAD is ${head}, expected ${expectedHead}`);
  if (refs.length !== 1 || refs[0] !== `refs/tags/${seedTag}`) {
    problems.push(`refs are ${refs.join(", ") || "none"}, expected only refs/tags/${seedTag}`);
  }
  if (remotes.length > 0) problems.push(`remotes remain: ${remotes.join(", ")}`);
  if (!check.statusClean) problems.push(`working tree is not clean:\n${status.trimEnd()}`);
  return { check, problems };
}

/**
 * A single-branch clone of the tag with its remote removed, so the attempt has no
 * path back to the seed repository and its commits stay its own.
 */
export async function cloneSeed(
  cfg: BenchConfig,
  work: string,
  expectedHead: string,
): Promise<{ check: SeedCloneCheck; problems: string[] }> {
  await git([
    "clone",
    "--quiet",
    "--no-local",
    "--single-branch",
    "--branch",
    cfg.seedTag,
    cfg.seedRepoPath,
    work,
  ]);
  await git(["-C", work, "remote", "remove", "origin"]);
  return inspectSeedClone(work, cfg.seedTag, expectedHead);
}

/** A file from the seed tag, read without touching the seed repository's checkout. */
export async function seedTagFile(cfg: BenchConfig, rel: string): Promise<string> {
  return git(["-C", cfg.seedRepoPath, "show", `${cfg.seedTag}:${rel}`]);
}

/** The seed repository must stay as built: one commit, and only `main` and the tag. */
export async function seedRepoChecks(cfg: BenchConfig): Promise<Check[]> {
  const allowed = ["refs/heads/main", `refs/tags/${cfg.seedTag}`];
  let detail: string;
  let ok: boolean;
  try {
    const commits = Number((await git(["-C", cfg.seedRepoPath, "rev-list", "--all", "--count"])).trim());
    const refs = lines(await git(["-C", cfg.seedRepoPath, "for-each-ref", "--format=%(refname)"]));
    const extra = refs.filter((r) => !allowed.includes(r));
    ok = commits === 1 && extra.length === 0;
    detail =
      `${commits} reachable commit(s); refs: ${refs.join(", ") || "none"}` +
      (extra.length > 0 ? ` — unexpected: ${extra.join(", ")}` : "");
  } catch (err) {
    ok = false;
    detail = String(err).split("\n")[0] ?? "git failed";
  }

  const dir = evaluatorDir(cfg);
  const missing = ["package.json", path.join("src", "cli.ts"), "node_modules"].filter(
    (f) => !exists(path.join(dir, f)),
  );
  let version: string | null = null;
  if (exists(path.join(dir, "package.json"))) {
    const v = readJson<{ version?: unknown }>(path.join(dir, "package.json")).version;
    version = typeof v === "string" ? v : null;
  }
  const evaluatorOk = missing.length === 0 && version === cfg.evaluatorVersion;

  return [
    {
      name: `seed repository has one commit and no refs beyond ${allowed.join(" and ")}`,
      status: ok ? "pass" : "fail",
      detail,
    },
    {
      name: `evaluator ${path.basename(dir)}/ is installed at version ${cfg.evaluatorVersion}`,
      status: evaluatorOk ? "pass" : "fail",
      detail:
        missing.length > 0
          ? `${dir} is missing ${missing.join(", ")}`
          : version !== cfg.evaluatorVersion
            ? `${dir}/package.json is version ${version ?? "(none)"}, the config says ${cfg.evaluatorVersion}`
            : `${dir}, version ${version}`,
    },
  ];
}

/** Writes the tag's package.json and lockfile into `dir`, for the shared install. */
export async function writeSeedManifests(cfg: BenchConfig, dir: string): Promise<void> {
  for (const file of ["package.json", "package-lock.json"]) {
    fs.writeFileSync(path.join(dir, file), await seedTagFile(cfg, file));
  }
}
