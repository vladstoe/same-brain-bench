import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BenchConfig, ManifestCheck } from "./types.ts";
import { nowIso, run, sha256, sha256File } from "./util.ts";

/** CLAUDE.md and AGENTS.md are the two legitimate note surfaces and are not hashed. */
export const UNHASHED = new Set(["CLAUDE.md", "AGENTS.md"]);

export interface SeedManifest {
  seedRepo: string;
  seedTag: string;
  seedCommit: string;
  builtAt: string;
  unhashed: string[];
  files: Record<string, string>;
  manifestHash: string;
  /**
   * The note surfaces as the seed has them, kept out of `files` and the manifest hash
   * because phase A may change them. Absent from manifests built before it existed.
   */
  noteSurfaces?: Record<string, string>;
}

export async function trackedFiles(cfg: BenchConfig): Promise<string[]> {
  const res = await run("git", ["-C", cfg.seedRepoPath, "ls-tree", "-r", "--name-only", cfg.seedTag]);
  if (res.code !== 0) {
    throw new Error(`git ls-tree failed for tag ${cfg.seedTag}: ${res.stderr.trim()}`);
  }
  return res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

export async function seedCommit(cfg: BenchConfig): Promise<string> {
  const res = await run("git", ["-C", cfg.seedRepoPath, "rev-parse", `${cfg.seedTag}^{commit}`]);
  if (res.code !== 0) throw new Error(`git rev-parse ${cfg.seedTag} failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

export async function buildManifest(cfg: BenchConfig, worktree: string): Promise<SeedManifest> {
  const all = await trackedFiles(cfg);
  const files: Record<string, string> = {};
  const noteSurfaces: Record<string, string> = {};
  for (const rel of all) {
    if (UNHASHED.has(rel)) {
      const full = path.join(worktree, rel);
      if (fs.existsSync(full)) noteSurfaces[rel] = sha256File(full);
      continue;
    }
    files[rel] = sha256File(path.join(worktree, rel));
  }
  const manifestHash = sha256(
    Object.keys(files)
      .sort()
      .map((k) => `${k} ${files[k]}`)
      .join("\n"),
  );
  return {
    seedRepo: cfg.seedRepoPath,
    seedTag: cfg.seedTag,
    seedCommit: await seedCommit(cfg),
    builtAt: nowIso(),
    unhashed: [...UNHASHED].sort(),
    files,
    manifestHash,
    noteSurfaces,
  };
}

/**
 * The seed's hash of each note surface it ships. Read from the manifest, or from the
 * tag itself for a manifest built before the manifest kept them.
 */
export function seedNoteHashes(manifest: SeedManifest): Record<string, string> {
  if (manifest.noteSurfaces !== undefined) return manifest.noteSurfaces;
  const out: Record<string, string> = {};
  for (const rel of UNHASHED) {
    try {
      const blob = execFileSync(
        "git",
        ["-C", manifest.seedRepo, "cat-file", "blob", `${manifest.seedTag}:${rel}`],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      out[rel] = sha256(blob);
    } catch {
      // Not in the seed, so any copy in the worktree was added by phase A.
    }
  }
  return out;
}

export function verifyManifest(manifest: SeedManifest, worktree: string): ManifestCheck {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [rel, want] of Object.entries(manifest.files)) {
    const full = path.join(worktree, rel);
    if (!fs.existsSync(full)) {
      missing.push(rel);
      continue;
    }
    if (sha256File(full) !== want) changed.push(rel);
  }
  return {
    checkedAt: nowIso(),
    ok: changed.length === 0 && missing.length === 0,
    changed: changed.sort(),
    missing: missing.sort(),
  };
}
