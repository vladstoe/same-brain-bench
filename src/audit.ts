import fs from "node:fs";
import path from "node:path";
import type { Arm, AuditRecord, Phase } from "./types.ts";
import type { AttemptPaths } from "./paths.ts";
import { claudeProjectSlug } from "./sessions.ts";
import { exists, isInside, nowIso } from "./util.ts";

const PATH_KEYS = /^(file_?path|filepath|notebook_?path|path|target|dir|directory)$/i;
const COMMAND_KEYS = /^(command|cmd|script)$/i;
const READ_TOOLS = /^(read|glob|grep|notebookread|list|ls|view|cat|search|bash|shell|run)$/i;
/** Dot-directories and system config: where a leak would go, route strings never do. */
const SENSITIVE_PATH = /(^|\/)\.[A-Za-z0-9_-]+\/|^\/etc\/|^\/var\/(root|db)\//;

const ABSOLUTE_PATH = /(?:^|[\s"'=(:])(\/(?:[A-Za-z0-9._~@+-]+\/?)+)/g;

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  /** The transcript record's own time, when it carries one. */
  at?: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function collectToolCalls(node: unknown, out: ToolCall[], depth = 0): void {
  if (depth > 40) return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolCalls(item, out, depth + 1);
    return;
  }
  if (!isRecord(node)) return;

  const name = node["name"] ?? node["tool"] ?? node["tool_name"];
  const rawInput =
    node["input"] ??
    node["args"] ??
    node["arguments"] ??
    (isRecord(node["state"]) ? (node["state"] as Record<string, unknown>)["input"] : undefined);
  if (typeof name === "string" && isRecord(rawInput)) {
    out.push({ tool: name, input: rawInput });
  }

  for (const value of Object.values(node)) collectToolCalls(value, out, depth + 1);
}

function parseTranscript(file: string): { calls: ToolCall[]; records: number } {
  const text = fs.readFileSync(file, "utf8");
  const calls: ToolCall[] = [];
  let records = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try {
      const record = JSON.parse(trimmed) as unknown;
      const before = calls.length;
      collectToolCalls(record, calls);
      const stamp = isRecord(record) ? (record["timestamp"] ?? record["at"]) : undefined;
      const at = typeof stamp === "string" ? Date.parse(stamp) : NaN;
      for (const call of calls.slice(before)) call.at = Number.isNaN(at) ? null : at;
      records += 1;
    } catch {
      continue;
    }
  }
  if (records === 0) {
    try {
      collectToolCalls(JSON.parse(text), calls);
      records = 1;
    } catch {
      /* not a single JSON document either */
    }
  }
  return { calls, records };
}

function candidatePaths(call: ToolCall): { value: string; evidence: string }[] {
  const out: { value: string; evidence: string }[] = [];
  for (const [key, value] of Object.entries(call.input)) {
    if (typeof value !== "string") continue;
    if (PATH_KEYS.test(key)) {
      // An explicit path argument names a read target whether or not it still
      // exists, so it is always a candidate.
      out.push({ value, evidence: `${call.tool}.${key}=${value}` });
    } else if (COMMAND_KEYS.test(key)) {
      for (const m of value.matchAll(ABSOLUTE_PATH)) {
        const candidate = m[1] as string;
        // A command string also carries source code the agent is writing, and a
        // route literal like `/loans/999/renew` is indistinguishable from a path by
        // shape alone. Two ways to be a real candidate: the path is on disk, or it
        // names somewhere secrets live even if it is absent now. Route literals are
        // neither; a deleted-since read under a dot-directory is still caught.
        if (!exists(candidate) && !SENSITIVE_PATH.test(candidate)) continue;
        // `2>/dev/null` is a redirect, not a read, and the device exists on every
        // machine, so the existence test alone flagged it in every attempt.
        if (candidate === "/dev/null") continue;
        out.push({ value: candidate, evidence: `${call.tool}.${key}: ${value.slice(0, 200)}` });
      }
    }
  }
  return out;
}

/** What each turn may read, one root set for both or one per turn. */
export type AllowedRoots = string[] | Partial<Record<Phase, string[]>>;

function rootsFor(allowed: AllowedRoots, phase: Phase): string[] {
  const list = Array.isArray(allowed) ? allowed : (allowed[phase] ?? []);
  return list.map((r) => path.resolve(r));
}

/**
 * One transcript to audit. v3 names whose it is in `source`, and gives `buildFrom`
 * where one file holds both turns: a call recorded from then on is the build turn's.
 */
export interface AuditTranscript {
  phase: Phase;
  file: string;
  source?: string;
  buildFrom?: number;
}

export function auditTranscripts(
  attemptId: string,
  allowedRoots: AllowedRoots,
  transcripts: AuditTranscript[],
): AuditRecord & {
  unreadableTranscripts: string[];
  toolCallsSeen: number;
  allowedRootsByPhase: Partial<Record<Phase, string[]>>;
} {
  const offending: AuditRecord["offendingPaths"] = [];
  const unreadable: string[] = [];
  const recorded = new Set<string>();
  const byPhase: Partial<Record<Phase, string[]>> = {};
  let seen = 0;

  for (const { phase: filePhase, file, source, buildFrom } of transcripts) {
    if (!exists(file)) continue;
    const { calls, records } = parseTranscript(file);
    if (records === 0 && fs.statSync(file).size > 0) unreadable.push(file);
    const phaseOf = (call: ToolCall): Phase =>
      buildFrom === undefined || call.at === null || call.at === undefined ? filePhase : call.at >= buildFrom ? "B" : "A";
    for (const phase of [...new Set(calls.map(phaseOf)), filePhase]) {
      const roots = rootsFor(allowedRoots, phase);
      for (const root of roots) recorded.add(root);
      byPhase[phase] = roots;
    }
    for (const call of calls) {
      if (!READ_TOOLS.test(call.tool)) continue;
      seen += 1;
      const phase = phaseOf(call);
      const roots = rootsFor(allowedRoots, phase);
      for (const candidate of candidatePaths(call)) {
        if (!path.isAbsolute(candidate.value)) continue;
        const resolved = path.resolve(candidate.value);
        if (roots.some((root) => isInside(root, resolved))) continue;
        offending.push({ phase, tool: call.tool, path: resolved, evidence: candidate.evidence, ...(source !== undefined ? { source } : {}) });
      }
    }
  }

  return {
    attemptId,
    checkedAt: nowIso(),
    allowedRoots: [...recorded].sort(),
    allowedRootsByPhase: byPhase,
    offendingPaths: offending,
    clean: offending.length === 0,
    unreadableTranscripts: unreadable,
    toolCallsSeen: seen,
  };
}

export interface CarriedStateOptions {
  /** Arm T: the attempt's epic, whole. It is the conversation's own working surface. */
  epicA?: string | null;
  /** The shared read-only dependency mount the worktree's node_modules links to. */
  sharedNodeModules?: string | null;
  /** Arm T only: the real Claude config dir, whose project slug is scoped below. */
  realClaudeConfigDir?: string | null;
  /** Arm T only: where Traycer keeps the skills its own agents load. */
  traycerSkillsRoot?: string | null;
}

export function carriedState(
  arm: Arm,
  p: AttemptPaths,
  opts: CarriedStateOptions = {},
): string[] {
  const { epicA, sharedNodeModules, realClaudeConfigDir, traycerSkillsRoot } = opts;
  // Every arm may read the shared node_modules: the worktree's own node_modules is a
  // symlink to it, so resolving a dependency lands there and is the rig's own doing.
  const shared = sharedNodeModules !== undefined && sharedNodeModules !== null ? [sharedNodeModules] : [];
  if (arm === "C") return [p.work, p.claudeConfig, ...shared];
  const roots = [p.work, ...shared];
  // Arm T's children run under the real ~/.claude because Traycer owns that config,
  // so the harness spills oversized tool output to
  // projects/<slug of this worktree>/<session>/tool-results/. Reading its own spill
  // back is not a leak. Scoped to this attempt's own slug: another attempt's
  // directory sits beside it and still offends.
  if (realClaudeConfigDir !== undefined && realClaudeConfigDir !== null) {
    roots.push(path.join(realClaudeConfigDir, "projects", claudeProjectSlug(p.work)));
  }
  // The harness also hands each session a scratchpad under
  // /tmp/claude-<uid>/<slug of this worktree>/<session>/scratchpad, and a turn that
  // builds a throwaway database to try its own work out writes there. Same claim as
  // the spill directory: the harness's own scratch for this attempt, scoped to this
  // worktree's slug. Both spellings, because /tmp is a symlink to /private/tmp on
  // macOS and a command can name either.
  for (const tmpRoot of ["/tmp", "/private/tmp"]) {
    roots.push(path.join(tmpRoot, `claude-${process.getuid?.() ?? ""}`, claudeProjectSlug(p.work)));
  }
  // Traycer's own skill files. A skill the harness loads tells the agent to read
  // its references, so these reads are the harness describing itself, not attempt
  // state. Scoped to skills/: the rest of ~/.traycer, the host's chat stores above
  // all, stays offending.
  if (traycerSkillsRoot !== undefined && traycerSkillsRoot !== null) {
    roots.push(traycerSkillsRoot);
  }
  if (epicA !== undefined && epicA !== null) roots.push(epicA);
  return roots;
}
