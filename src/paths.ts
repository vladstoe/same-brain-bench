import path from "node:path";
import type { Arm, BenchConfig, Phase } from "./types.ts";
import { runsRoot } from "./config.ts";

export interface AttemptPaths {
  attemptId: string;
  dir: string;
  work: string;
  claudeConfig: string;
  record: string;
  ledger: string;
  cost: string;
  reconcile: string;
  audit: string;
  evaluatorOut: string;
  snapshot: string;
  snapshotRecord: string;
  result: string;
  seedManifest: string;
  postAManifest: string;
  transcripts: string;
  proxyLog: string;
}

export function attemptId(arm: Arm, n: number): string {
  return `${arm}-${n}`;
}

/**
 * Scratch for the smoke and the preflight probes. Deliberately outside the
 * `<arm>/<n>` namespace: n = 0 is a real (unscored) attempt, and the two used to
 * collide there. The leading underscore is also what keeps `rig report` from
 * walking them.
 */
export function scratchPaths(cfg: BenchConfig, kind: "smoke" | "preflight", arm: Arm): AttemptPaths {
  const dir =
    kind === "smoke"
      ? path.join(runsRoot(cfg), "_smoke", arm)
      : path.join(runsRoot(cfg), "_preflight");
  return pathsUnder(dir, `_${kind}-${arm}`);
}

export function attemptPaths(cfg: BenchConfig, arm: Arm, n: number): AttemptPaths {
  return pathsUnder(path.join(runsRoot(cfg), arm, String(n)), attemptId(arm, n));
}

function pathsUnder(dir: string, id: string): AttemptPaths {
  return {
    attemptId: id,
    dir,
    work: path.join(dir, "work"),
    claudeConfig: path.join(dir, "claude-config"),
    record: path.join(dir, "attempt.json"),
    ledger: path.join(dir, "ledger.jsonl"),
    cost: path.join(dir, "cost.json"),
    reconcile: path.join(dir, "reconcile.json"),
    audit: path.join(dir, "audit.json"),
    evaluatorOut: path.join(dir, "evaluator-out"),
    snapshot: path.join(dir, "snapshot"),
    snapshotRecord: path.join(dir, "snapshot.json"),
    result: path.join(dir, "evaluator-out", "result.json"),
    seedManifest: path.join(dir, "manifest.seed.json"),
    postAManifest: path.join(dir, "manifest.post-a.json"),
    transcripts: path.join(dir, "transcripts"),
    proxyLog: path.join(dir, "proxy.log"),
  };
}

export function transcriptPath(p: AttemptPaths, phase: Phase, ext: string): string {
  return path.join(p.transcripts, `phase-${phase.toLowerCase()}.${ext}`);
}

export function sharedNodeModules(cfg: BenchConfig): string {
  return path.join(cfg.benchRoot, "shared", "node_modules");
}
