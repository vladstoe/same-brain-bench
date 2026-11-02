import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchConfig, Phase } from "./types.ts";
import { readJson } from "./util.ts";

export const rigRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `~/...` is the home directory; any other relative path is relative to the rig root. */
export function configPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(rigRoot, value);
}

export function loadConfig(file?: string): BenchConfig {
  const configFile = file ?? path.join(rigRoot, "bench.config.json");
  const cfg = readJson<BenchConfig>(configFile);
  if (cfg.protocol !== "v3") {
    throw new Error(`${configFile} is protocol ${cfg.protocol ?? "(none)"}; this rig runs protocol v3 only`);
  }
  cfg.benchRoot = configPath(cfg.benchRoot);
  cfg.seedRepoPath = configPath(cfg.seedRepoPath);
  if (cfg.claudeBinary !== undefined) cfg.claudeBinary = configPath(cfg.claudeBinary);
  const t = cfg.traycer;
  t.cliPath = configPath(t.cliPath);
  t.epicsRoot = configPath(t.epicsRoot);
  t.providerOverridesPath = configPath(t.providerOverridesPath);
  if (t.selectionGuidePath !== undefined) t.selectionGuidePath = configPath(t.selectionGuidePath);
  return cfg;
}

export function runsRoot(cfg: BenchConfig): string {
  return path.join(cfg.benchRoot, "runs");
}

/**
 * The config one turn runs under: the turn's own timeout and scripted-reply caps in
 * the places the arms already read them. Without `phaseLimits` it is the config itself.
 */
export function phaseConfig(cfg: BenchConfig, phase: Phase): BenchConfig {
  const limits = cfg.phaseLimits?.[phase];
  if (limits === undefined) return cfg;
  return {
    ...cfg,
    phaseTimeoutMs: limits.timeoutMs,
    maxScriptedReplies: limits.maxScriptedReplies.C,
    traycer: { ...cfg.traycer, maxScriptedReplies: limits.maxScriptedReplies.T },
  };
}

export function evaluatorDir(cfg: BenchConfig): string {
  return path.join(rigRoot, cfg.evaluatorDir ?? "evaluate");
}

export function apiKey(cfg: BenchConfig): string | undefined {
  return process.env[cfg.apiKeyEnvVar];
}
