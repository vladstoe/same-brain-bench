import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BenchConfig, LedgerRow, Phase, RosterEntry } from "../src/types.ts";
import type { AttemptPaths } from "../src/paths.ts";
import type { TraycerAgent } from "../src/traycer-cli.ts";
import { readLedger } from "../src/ledger.ts";
import { exists, nowIso, walk } from "../src/util.ts";

/**
 * Stand-ins for a v3 dry run. No model is called: the agents' Claude sessions are
 * written where Claude Code would write them, and the ledger the proxy would have
 * kept is built from the calls those sessions record, plus one call no session
 * makes, so attribution has something foreign to find.
 */

/** The build the stand-in claude reports and writes, which the dry run's arm T writes too. */
export const DRY_CLAUDE_VERSION = "2.1.284";

export interface DryRecord {
  id: string;
  model: string;
  effort: string;
  /** Claude Code's build on the record; the stand-in's when absent. */
  version?: string;
  /** A tool call the record makes, for the audit to read. */
  toolUse?: { name: string; input: Record<string, string> };
}

/** Claude Code's project folder name for a working directory. */
export function claudeSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

function recordLines(sessionId: string, cwd: string, records: DryRecord[], extra: Record<string, unknown> = {}): string {
  return records
    .map((r) =>
      JSON.stringify({
        type: "assistant",
        sessionId,
        cwd,
        version: r.version ?? DRY_CLAUDE_VERSION,
        effort: r.effort,
        ...extra,
        message: {
          id: r.id,
          model: r.model,
          role: "assistant",
          content:
            r.toolUse === undefined
              ? [{ type: "text", text: "dry run" }]
              : [{ type: "tool_use", id: `toolu_${r.id}`, name: r.toolUse.name, input: r.toolUse.input }],
        },
        timestamp: nowIso(),
      }),
    )
    .join("\n") + "\n";
}

/** Appends to the session file, so a resumed session keeps both turns, as a real one does. */
export function writeDrySession(claudeConfigDir: string, cwd: string, sessionId: string, records: DryRecord[]): string {
  const dir = path.join(claudeConfigDir, "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.appendFileSync(file, recordLines(sessionId, cwd, records));
  return file;
}

/** A subagent's transcript and its meta file, beside the session as Claude Code 2.1.284 keeps them. */
export function writeDrySubagent(
  sessionFile: string,
  agentId: string,
  records: DryRecord[],
  meta: { agentType: string; description: string },
): string {
  const sessionId = path.basename(sessionFile, ".jsonl");
  const dir = path.join(path.dirname(sessionFile), sessionId, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  fs.appendFileSync(file, recordLines(sessionId, path.dirname(sessionFile), records, { isSidechain: true, agentId }));
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ ...meta, spawnDepth: 1 }) + "\n");
  return file;
}

/** One more call that reads a file outside every allowed root, for the audit to catch. */
export function withOutsideRead(records: DryRecord[]): DryRecord[] {
  const last = records[records.length - 1];
  if (last === undefined) return records;
  return [...records, { ...last, id: `${last.id}_outside`, toolUse: { name: "Read", input: { file_path: "/etc/hosts" } } }];
}

/** Message ids no earlier stand-in call used. */
export function dryRecords(prefix: string, count: number, model: string, effort: string): DryRecord[] {
  return Array.from({ length: count }, (_, i) => ({ id: `msg_${prefix}_${i + 1}`, model, effort }));
}

/**
 * The proxy's stand-in: one ledger row for every assistant record in `files` the
 * ledger does not have yet, in the turn given, with prompt tokens that grow call by
 * call as a session's context does. Then one call no session carries.
 */
export function dryLedgerFromSessions(cfg: BenchConfig, p: AttemptPaths, phase: Phase, files: string[], arm: string, n: number): void {
  const seen = new Set(readLedger(p.ledger).map((r) => r.messageId));
  const rows: LedgerRow[] = [];
  const row = (messageId: string, model: string, prompt: number): LedgerRow => ({
    ts: nowIso(),
    attemptId: p.attemptId,
    arm,
    n,
    phase,
    metered: true,
    method: "POST",
    path: "/v1/messages",
    status: 200,
    stream: true,
    requestId: `req_${messageId}`,
    messageId,
    model,
    clientMarker: messageId.slice(-16),
    retryCount: 0,
    auth: "bearer",
    attribution: "attributed",
    usage: {
      input: 50,
      output: 400,
      cacheRead: prompt - 50,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteTierAssumed: false,
      raw: { synthetic: true },
    },
    durationMs: 1000,
  });
  for (const file of files) {
    let i = 0;
    for (const line of (exists(file) ? fs.readFileSync(file, "utf8") : "").split("\n")) {
      if (line.trim() === "") continue;
      const r = JSON.parse(line) as { type?: string; message?: { id?: string; model?: string } };
      i += 1;
      const id = r.message?.id;
      if (r.type !== "assistant" || id === undefined || seen.has(id)) continue;
      seen.add(id);
      rows.push(row(id, r.message?.model ?? cfg.model.id, 20_000 + 5_000 * i));
    }
  }
  rows.push(row(`msg_dry_foreign_${arm}${phase}`, cfg.model.id, 30_000));
  fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
  for (const r of rows) fs.appendFileSync(p.ledger, JSON.stringify(r) + "\n");
}

/** Every transcript file under a directory: a session's own and its subagents'. */
export function transcriptsUnder(dir: string): string[] {
  return exists(dir) ? walk(dir).filter((f) => f.endsWith(".jsonl")) : [];
}

const TICKETS = ["01-holds-and-queues", "02-fines-and-statements", "03-renewals-and-suspension", "04-reports"];

/**
 * The stand-in coordinator's plan: a spec and one ticket per piece of work, open
 * after the plan turn and complete after the build turn.
 */
export function writeDryArtifacts(artifactsDir: string, phase: Phase): void {
  const plan = path.join(artifactsDir, "plan");
  fs.mkdirSync(plan, { recursive: true });
  fs.writeFileSync(path.join(plan, "index.md"), '---\nkind: spec\ntitle: "Plan"\n---\n\nThe design decisions.\n');
  for (const [i, name] of TICKETS.entries()) {
    const dir = path.join(plan, "tickets", name);
    fs.mkdirSync(dir, { recursive: true });
    const status = phase === "A" ? 0 : i === TICKETS.length - 1 ? 1 : 2;
    fs.writeFileSync(path.join(dir, "index.md"), `---\nkind: ticket\ntitle: "${name}"\nstatus: ${status}\n---\n\nWork.\n`);
  }
}

export interface DryChild {
  agent: TraycerAgent;
  roster: Omit<RosterEntry, "depth">;
  records: DryRecord[];
}

/**
 * Two children the stand-in coordinator creates for the build. Under `wrong-model`
 * the second runs on another model, configured and resolved, which the per-agent
 * check must catch; under `wrong-build` it runs on another Claude Code build.
 */
export function dryChildren(cfg: BenchConfig, coordinatorId: string, wrongModel: boolean, wrongBuild = false): DryChild[] {
  const ref = cfg.model.armModelRef["T"] ?? cfg.model.id;
  const effort = cfg.effort ?? "high";
  return [1, 2].map((k) => {
    const off = wrongModel && k === 2;
    const agentId = randomUUID();
    const sessionId = randomUUID();
    return {
      agent: {
        id: agentId,
        parentId: coordinatorId,
        active: false,
        harnessId: cfg.traycer.harness,
        surface: "gui",
        title: `ticket ${k} builder`,
        isSelf: false,
      },
      roster: {
        agentId,
        parentId: coordinatorId,
        title: `ticket ${k} builder`,
        harness: cfg.traycer.harness,
        configuredModel: off ? "sonnet" : ref,
        configuredEffort: effort,
        claudeSessionIds: [sessionId],
        nativeUsd: 0.5 * k,
        settingsFrom: "stub",
      },
      records: dryRecords(`dry_child${k}_${agentId.slice(0, 8)}`, 3, off ? "claude-sonnet-5-5" : cfg.model.id, effort).map((r) =>
        wrongBuild && k === 2 ? { ...r, version: "2.1.289" } : r,
      ),
    };
  });
}
