import fs from "node:fs";
import path from "node:path";
import type {
  AgentCheck,
  AgentMeasure,
  ArtifactStatus,
  AttemptRecord,
  BackgroundCall,
  BenchConfig,
  BuildCheck,
  HarnessOverhead,
  LedgerRow,
  Phase,
  PhaseEffort,
  RosterEntry,
  SessionCalls,
  UnmappedSession,
} from "./types.ts";
import type { AttemptPaths } from "./paths.ts";
import type { PhaseSessions, SessionFacts } from "./sessions.ts";
import { claudeProjectSlug, subagentArchiveDir } from "./sessions.ts";
import { rederive } from "./ledger.ts";
import { priceBuckets } from "./pricing.ts";
import { exists, walk } from "./util.ts";
import type { AuditTranscript } from "./audit.ts";

/** What Claude Code writes on an assistant record it made up itself, such as an API error. */
const SYNTHETIC_MODEL = "<synthetic>";

export interface AgentRecords {
  messageIds: Set<string>;
  models: string[];
  efforts: string[];
  assistantRecords: number;
}

/** One transcript's assistant records: the ids the ledger matches on, and the model and effort each ran at. */
export function readAgentRecords(file: string): AgentRecords {
  const messageIds = new Set<string>();
  const models = new Set<string>();
  const efforts = new Set<string>();
  let assistantRecords = 0;
  const text = exists(file) ? fs.readFileSync(file, "utf8") : "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "" || t[0] !== "{") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "assistant") continue;
    assistantRecords += 1;
    const message = record["message"] as Record<string, unknown> | undefined;
    if (message !== undefined && message !== null) {
      if (typeof message["id"] === "string") messageIds.add(message["id"]);
      if (typeof message["model"] === "string" && message["model"] !== SYNTHETIC_MODEL) models.add(message["model"]);
    }
    if (typeof record["effort"] === "string") efforts.add(record["effort"]);
  }
  return { messageIds, models: [...models].sort(), efforts: [...efforts].sort(), assistantRecords };
}

export interface SubagentFile {
  agentId: string;
  file: string;
  agentType: string | null;
  description: string | null;
  spawnDepth: number | null;
}

/**
 * Claude Code 2.1.284 keeps each subagent's transcript beside its session file, at
 * `<project>/<session id>/subagents/[<subdir>/]agent-<id>.jsonl`, with an
 * `agent-<id>.meta.json` beside it naming the agent's type and task.
 */
export function subagentFilesUnder(dir: string): SubagentFile[] {
  if (!exists(dir)) return [];
  const out: SubagentFile[] = [];
  for (const file of walk(dir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(path.basename(file));
    if (m === null) continue;
    const metaFile = file.replace(/\.jsonl$/, ".meta.json");
    let meta: Record<string, unknown> = {};
    try {
      meta = exists(metaFile) ? (JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    out.push({
      agentId: m[1] as string,
      file,
      agentType: typeof meta["agentType"] === "string" ? meta["agentType"] : null,
      description: typeof meta["description"] === "string" ? meta["description"] : null,
      spawnDepth: typeof meta["spawnDepth"] === "number" ? meta["spawnDepth"] : null,
    });
  }
  return out;
}

/** One agent the attempt used, with the transcript files that are its own. */
export interface AgentFiles {
  agentId: string;
  kind: AgentMeasure["kind"];
  parentId: string | null;
  depth: number;
  title: string | null;
  harness: string | null;
  configuredModel: string | null;
  configuredEffort: string | null;
  sessionIds: string[];
  files: { sessionId: string; file: string }[];
}

/** Where a v3 arm-T attempt keeps each agent's Claude sessions, copied out of the config they were written under. */
export function sessionsDir(p: AttemptPaths): string {
  return path.join(p.dir, "sessions");
}

/**
 * A session file by id: the worktree's own project folder first, then any project
 * folder, because an agent may run in a worktree of its own.
 */
export function findSessionFile(claudeConfigDir: string, worktree: string, sessionId: string): string | null {
  const projects = path.join(claudeConfigDir, "projects");
  const preferred = path.join(projects, claudeProjectSlug(worktree), `${sessionId}.jsonl`);
  if (exists(preferred)) return preferred;
  if (!exists(projects)) return null;
  for (const dir of fs.readdirSync(projects).sort()) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Copies every session of every agent in the roster, and its subagents' transcripts,
 * into the attempt. Copied, never moved: the files under Claude Code's config are
 * the host's, and nothing needs them cleared. Returns the ids not found.
 */
export function collectSessions(roster: RosterEntry[], claudeConfigDir: string, worktree: string, dest: string): string[] {
  const missing: string[] = [];
  for (const agent of roster) {
    for (const sessionId of agent.claudeSessionIds) {
      const file = findSessionFile(claudeConfigDir, worktree, sessionId);
      if (file === null) {
        missing.push(sessionId);
        continue;
      }
      copySessionTree(file, sessionId, path.join(dest, agent.agentId));
    }
  }
  return missing;
}

/** A session file and its subagent tree, copied into `to`; returns the subagent files copied. */
function copySessionTree(file: string, sessionId: string, to: string): number {
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(file, path.join(to, `${sessionId}.jsonl`));
  const subagents = path.join(path.dirname(file), sessionId, "subagents");
  const files = exists(subagents) ? walk(subagents) : [];
  for (const f of files) {
    const target = path.join(to, sessionId, "subagents", path.relative(subagents, f));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f, target);
  }
  return files.filter((f) => f.endsWith(".jsonl")).length;
}

/**
 * The worktree's own project folder. Claude Code turns every character but a letter or
 * digit into `-`; `claudeProjectSlug` turns only `/`, which names the same folder only
 * while the path holds no `.` or `_`.
 */
export function projectFolder(claudeConfigDir: string, worktree: string): string {
  return path.join(claudeConfigDir, "projects", worktree.replace(/[^A-Za-z0-9]/g, "-"));
}

/** Where a session no agent names is kept: beside the agents' folders, which are named by agent id. */
export function unmappedDir(p: AttemptPaths): string {
  return path.join(sessionsDir(p), "unmapped");
}

/** How many user and assistant records a transcript holds; a file with neither made no call. */
export function conversationRecords(file: string): { user: number; assistant: number } {
  let user = 0;
  let assistant = 0;
  for (const line of (exists(file) ? fs.readFileSync(file, "utf8") : "").split("\n")) {
    const t = line.trim();
    if (t === "" || t[0] !== "{") continue;
    try {
      const type = (JSON.parse(t) as Record<string, unknown>)["type"];
      if (type === "user") user += 1;
      else if (type === "assistant") assistant += 1;
    } catch {
      continue;
    }
  }
  return { user, assistant };
}

/**
 * Every session in the attempt's project folder that no agent of the attempt names,
 * copied with its subagent tree. The folder is the attempt's worktree's own, so each
 * session in it is the attempt's, whether or not the host's store still says whose.
 */
export function collectUnmapped(roster: RosterEntry[], claudeConfigDir: string, worktree: string, dest: string): UnmappedSession[] {
  const claimed = new Set(roster.filter((a) => a.depth >= 0).flatMap((a) => a.claudeSessionIds));
  const folder = projectFolder(claudeConfigDir, worktree);
  if (!exists(folder)) return [];
  const out: UnmappedSession[] = [];
  for (const name of fs.readdirSync(folder).sort()) {
    const file = path.join(folder, name);
    if (!name.endsWith(".jsonl") || !fs.statSync(file).isFile()) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (claimed.has(sessionId)) continue;
    const subagentFiles = copySessionTree(file, sessionId, dest);
    const kept = path.join(dest, name);
    const records = conversationRecords(kept);
    out.push({
      sessionId,
      file: kept,
      userRecords: records.user,
      assistantRecords: records.assistant,
      bookkeeping: records.user + records.assistant === 0,
      subagentFiles,
    });
  }
  return out;
}

function subagentsOf(parentId: string, dirs: string[], configuredModel: string | null): AgentFiles[] {
  const seen = new Map<string, AgentFiles>();
  for (const dir of dirs) {
    for (const s of subagentFilesUnder(dir)) {
      if (seen.has(s.agentId)) continue;
      seen.set(s.agentId, {
        agentId: s.agentId,
        kind: "subagent",
        parentId,
        depth: s.spawnDepth ?? 1,
        title: s.description ?? s.agentType,
        harness: "claude",
        configuredModel,
        configuredEffort: null,
        sessionIds: [],
        files: [{ sessionId: s.agentId, file: s.file }],
      });
    }
  }
  return [...seen.values()];
}

/**
 * Every agent of the attempt and its own files. Arm C: the one session, kept whole in
 * the build turn's transcript because the build resumed it, and its subagents. Arm T:
 * every agent in the coordinator's subtree, from the roster, with each Claude session
 * the host ran it in and any subagents of those, then each session of the attempt's
 * project folder that no agent names but that holds a conversation.
 */
export function attemptAgents(cfg: BenchConfig, record: AttemptRecord, p: AttemptPaths): AgentFiles[] {
  const subagentModel = cfg.harnessEnv?.["CLAUDE_CODE_SUBAGENT_MODEL"] ?? null;
  if (record.arm !== "T") {
    const last = record.phases.B ?? record.phases.A;
    if (last === undefined) return [];
    const sessionId = last.sessionId ?? "";
    const main: AgentFiles = {
      agentId: sessionId,
      kind: "session",
      parentId: null,
      depth: 0,
      title: null,
      harness: "claude",
      configuredModel: cfg.model.armModelRef["C"] ?? cfg.model.id,
      configuredEffort: cfg.effort ?? null,
      sessionIds: [sessionId],
      files: exists(last.transcriptPath) ? [{ sessionId, file: last.transcriptPath }] : [],
    };
    const dirs = (["B", "A"] as Phase[]).filter((ph) => record.phases[ph] !== undefined).map((ph) => subagentArchiveDir(p, ph));
    return [main, ...subagentsOf(sessionId, dirs, subagentModel)];
  }

  const out: AgentFiles[] = [];
  for (const agent of (record.roster ?? []).filter((a) => a.depth >= 0)) {
    const dir = path.join(sessionsDir(p), agent.agentId);
    const files = agent.claudeSessionIds
      .map((sessionId) => ({ sessionId, file: path.join(dir, `${sessionId}.jsonl`) }))
      .filter((f) => exists(f.file));
    out.push({
      agentId: agent.agentId,
      kind: agent.depth === 0 ? "coordinator" : "child",
      parentId: agent.parentId,
      depth: agent.depth,
      title: agent.title,
      harness: agent.harness,
      configuredModel: agent.configuredModel,
      configuredEffort: agent.configuredEffort,
      sessionIds: agent.claudeSessionIds,
      files,
    });
    const dirs = agent.claudeSessionIds.map((sessionId) => path.join(dir, sessionId, "subagents"));
    for (const sub of subagentsOf(agent.agentId, dirs, subagentModel)) out.push({ ...sub, depth: agent.depth + sub.depth });
  }
  for (const u of (record.unmappedSessions ?? []).filter((s) => !s.bookkeeping)) {
    out.push({
      agentId: u.sessionId,
      kind: "unmapped",
      parentId: null,
      depth: 0,
      title: null,
      harness: null,
      configuredModel: null,
      configuredEffort: null,
      sessionIds: [u.sessionId],
      files: exists(u.file) ? [{ sessionId: u.sessionId, file: u.file }] : [],
    });
    const dirs = [path.join(path.dirname(u.file), u.sessionId, "subagents")];
    out.push(...subagentsOf(u.sessionId, dirs, subagentModel));
  }
  return out;
}

/** Every agent's files as the sessions call attribution and the effort measure read. */
export function phaseSessionsOf(agents: AgentFiles[], arm: string): PhaseSessions {
  const sessions: SessionFacts[] = [];
  for (const agent of agents) {
    for (const f of agent.files) {
      const r = readAgentRecords(f.file);
      // `efforts` keeps one entry per record, so an effort measure counts records.
      sessions.push({
        sessionId: f.sessionId,
        file: f.file,
        own: true,
        messageIds: r.messageIds,
        efforts: effortsPerRecord(f.file),
        assistantRecords: r.assistantRecords,
      });
    }
  }
  const ownSessionIds = [...new Set(agents.flatMap((a) => a.files.map((f) => f.sessionId)))];
  const owners = new Map<string, string>();
  for (const agent of agents) for (const id of agent.sessionIds) if (id !== "" && !owners.has(id)) owners.set(id, agent.agentId);
  return {
    sessions,
    ownSessionIds,
    ownSessionsFrom: arm === "T" ? "chatStore" : "transcript",
    note: sessions.length === 0 ? "no session of any of the attempt's agents was found" : null,
    owners: { sessions: owners, agentIds: new Set(agents.map((a) => a.agentId)) },
  };
}

function effortsPerRecord(file: string): string[] {
  const out: string[] = [];
  for (const line of (exists(file) ? fs.readFileSync(file, "utf8") : "").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r["type"] === "assistant" && typeof r["effort"] === "string") out.push(r["effort"]);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Each turn's effort, from the records of the calls the ledger places in that turn:
 * one session runs both turns, so its records alone cannot say which turn they were.
 */
export function turnEffort(agents: AgentFiles[], rows: LedgerRow[], phase: Phase, configured: string | undefined): PhaseEffort {
  const inTurn = new Set(
    rows.filter((r) => r.phase === phase && r.messageId !== null).map((r) => r.messageId as string),
  );
  const efforts: string[] = [];
  for (const agent of agents) {
    for (const f of agent.files) {
      for (const line of (exists(f.file) ? fs.readFileSync(f.file, "utf8") : "").split("\n")) {
        if (!line.includes('"assistant"')) continue;
        try {
          const r = JSON.parse(line) as { type?: string; effort?: unknown; message?: { id?: unknown } };
          if (r.type !== "assistant" || typeof r.effort !== "string" || typeof r.message?.id !== "string") continue;
          if (inTurn.has(r.message.id)) efforts.push(r.effort);
        } catch {
          continue;
        }
      }
    }
  }
  const observed = [...new Set(efforts)].sort();
  return {
    configured: (configured ?? null) as PhaseEffort["configured"],
    observed,
    records: efforts.length,
    matchesConfig: configured === undefined || observed.length === 0 ? null : observed.length === 1 && observed[0] === configured,
  };
}

function promptTokens(u: Exclude<LedgerRow["usage"], "unknown">): number {
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

export interface AgentMeasures {
  agents: AgentMeasure[];
  check: AgentCheck;
  sessionCalls: SessionCalls[];
}

/**
 * Each agent's model, effort, calls and cost, from its own records and the ledger
 * calls they carry, and whether every one of them ran on the pinned model and
 * effort. An agent is off the pin if its harness, its configured model or effort,
 * a model on its records, a model the ledger resolved its calls to, or an effort on
 * its records says so. The background calls an agent owns add to its cost only:
 * they are Claude Code's own side requests, not the agent's turns, so they take no
 * part in the pin.
 */
export function measureAgents(
  cfg: BenchConfig,
  agents: AgentFiles[],
  rows: LedgerRow[],
  background: BackgroundCall[] = [],
): AgentMeasures {
  const pinnedRef = cfg.model.armModelRef["T"] ?? cfg.model.id;
  const ledger = rows.map(rederive).filter((r) => r.metered && r.attribution === "attributed");
  const byId = new Map<string, LedgerRow[]>();
  for (const r of ledger) {
    if (r.messageId === null || r.messageId === "") continue;
    const list = byId.get(r.messageId) ?? [];
    list.push(r);
    byId.set(r.messageId, list);
  }

  const measures: AgentMeasure[] = [];
  const sessionCalls: SessionCalls[] = [];
  for (const agent of agents) {
    const transcriptModels = new Set<string>();
    const efforts = new Set<string>();
    const ledgerModels = new Set<string>();
    const calls: Partial<Record<Phase, number>> = {};
    let usd: number | null = 0;

    for (const f of agent.files) {
      const r = readAgentRecords(f.file);
      for (const m of r.models) transcriptModels.add(m);
      for (const e of r.efforts) efforts.add(e);
      const mine = [...r.messageIds].flatMap((id) => byId.get(id) ?? []);
      for (const phase of ["A", "B"] as Phase[]) {
        const phaseRows = mine
          .filter((row) => row.phase === phase)
          .map((row, i) => ({ row, i, start: Date.parse(row.ts) - row.durationMs }))
          .sort((a, b) => (a.start === b.start ? a.i - b.i : a.start - b.start))
          .map((x) => x.row);
        if (phaseRows.length === 0) continue;
        calls[phase] = (calls[phase] ?? 0) + phaseRows.length;
        const known = phaseRows.filter((row) => row.usage !== "unknown");
        const prompts = known.map((row) => promptTokens(row.usage as Exclude<LedgerRow["usage"], "unknown">));
        let sessionUsd: number | null = 0;
        for (const row of known) {
          const priced = priceBuckets(row.usage as Exclude<LedgerRow["usage"], "unknown">, cfg.prices);
          sessionUsd = priced === null || sessionUsd === null ? null : sessionUsd + priced;
        }
        sessionCalls.push({
          agentId: agent.agentId,
          sessionId: f.sessionId,
          file: f.file,
          phase,
          calls: phaseRows.length,
          unknownCalls: phaseRows.length - known.length,
          firstCallPromptTokens: prompts[0] ?? null,
          meanPromptTokens: prompts.length === 0 ? null : Math.round(prompts.reduce((a, b) => a + b, 0) / prompts.length),
          usd: sessionUsd,
        });
        usd = sessionUsd === null || usd === null ? null : usd + sessionUsd;
      }
      for (const row of mine) if (row.model !== null) ledgerModels.add(row.model);
    }

    const owned = background.filter((b) => b.agentId === agent.agentId);
    let backgroundUsd: number | null = 0;
    for (const b of owned) backgroundUsd = b.usd === null || backgroundUsd === null ? null : backgroundUsd + b.usd;
    if (owned.length > 0) usd = usd === null || backgroundUsd === null ? null : usd + backgroundUsd;

    const mismatches: string[] = [];
    const expectedRef = agent.kind === "session" ? (cfg.model.armModelRef["C"] ?? cfg.model.id) : pinnedRef;
    if (agent.harness !== null && agent.harness !== cfg.traycer.harness) mismatches.push(`harness ${agent.harness}`);
    if (agent.configuredModel !== null && agent.configuredModel !== expectedRef) {
      mismatches.push(`configured model ${agent.configuredModel}`);
    }
    if (agent.configuredEffort !== null && cfg.effort !== undefined && agent.configuredEffort !== cfg.effort) {
      mismatches.push(`configured effort ${agent.configuredEffort}`);
    }
    for (const m of [...transcriptModels].sort()) if (m !== cfg.model.id) mismatches.push(`recorded model ${m}`);
    for (const m of [...ledgerModels].sort()) if (m !== cfg.model.id) mismatches.push(`resolved model ${m}`);
    if (cfg.effort !== undefined) for (const e of [...efforts].sort()) if (e !== cfg.effort) mismatches.push(`effort ${e}`);

    measures.push({
      agentId: agent.agentId,
      kind: agent.kind,
      parentId: agent.parentId,
      depth: agent.depth,
      title: agent.title,
      harness: agent.harness,
      configuredModel: agent.configuredModel,
      configuredEffort: agent.configuredEffort,
      sessionIds: agent.sessionIds,
      files: agent.files.map((f) => f.file),
      transcriptModels: [...transcriptModels].sort(),
      efforts: [...efforts].sort(),
      ledgerModels: [...ledgerModels].sort(),
      calls,
      usd,
      ...(owned.length > 0 ? { backgroundCalls: owned.length, backgroundUsd } : {}),
      mismatches,
      verified: transcriptModels.size > 0 || ledgerModels.size > 0,
    });
  }

  return {
    agents: measures,
    check: {
      pinnedModel: cfg.model.id,
      pinnedModelRef: pinnedRef,
      pinnedEffort: cfg.effort ?? null,
      agents: measures.length,
      mismatched: measures.filter((m) => m.mismatches.length > 0).map((m) => ({ agentId: m.agentId, reasons: m.mismatches })),
      unverified: measures.filter((m) => !m.verified && m.mismatches.length === 0).map((m) => m.agentId),
    },
    sessionCalls,
  };
}

/** Every top-level `version` on a transcript's records, with how many records carry each. */
export function readVersions(file: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of (exists(file) ? fs.readFileSync(file, "utf8") : "").split("\n")) {
    if (!line.includes('"version"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const v = record["version"];
    if (typeof v === "string") out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

/**
 * Every Claude Code version on the records of every file `attemptAgents` gives, against
 * the pinned binary's. A file with no version at all counts as off the pin: Claude Code
 * writes one on every user, assistant, attachment and system record, and leaves it off
 * only bookkeeping records such as queue operations and titles; a file of nothing but
 * those made no call, so it is listed rather than flagged. A session id the agent
 * names with no archived file is off the pin, since nothing about its build can be read.
 */
export function tallyVersions(
  agents: AgentFiles[],
  pinnedVersion: string | null,
  pinnedFrom: BuildCheck["pinnedFrom"],
): BuildCheck {
  const total: Record<string, number> = {};
  const rows: BuildCheck["agents"] = [];
  const offPin: BuildCheck["offPin"] = [];
  for (const agent of agents) {
    const versions: Record<string, number> = {};
    const unversionedFiles: string[] = [];
    const bookkeepingFiles: string[] = [];
    for (const f of agent.files) {
      const seen = readVersions(f.file);
      if (Object.keys(seen).length === 0) {
        const records = conversationRecords(f.file);
        if (exists(f.file) && records.user + records.assistant === 0) bookkeepingFiles.push(f.file);
        else unversionedFiles.push(f.file);
      }
      for (const [v, n] of Object.entries(seen)) {
        versions[v] = (versions[v] ?? 0) + n;
        total[v] = (total[v] ?? 0) + n;
      }
    }
    rows.push({ agentId: agent.agentId, kind: agent.kind, versions, unversionedFiles, ...(bookkeepingFiles.length > 0 ? { bookkeepingFiles } : {}) });
    const reasons: string[] = [];
    if (pinnedVersion === null && agent.files.length > bookkeepingFiles.length) reasons.push("no pinned version to compare with");
    for (const [v, n] of Object.entries(versions).sort(([a], [b]) => a.localeCompare(b))) {
      if (pinnedVersion !== null && v !== pinnedVersion) reasons.push(`version ${v} on ${n} record(s)`);
    }
    for (const file of unversionedFiles) reasons.push(`no version in ${path.basename(file)}`);
    const archived = new Set(agent.files.map((f) => f.sessionId));
    for (const id of agent.sessionIds) if (id !== "" && !archived.has(id)) reasons.push(`session ${id} not archived`);
    if (reasons.length > 0) offPin.push({ agentId: agent.agentId, reasons });
  }
  return { pinnedVersion, pinnedFrom, agents: rows, total, offPin };
}

/** Every `index.md` under an epic's artifacts, with the kind, title and status its frontmatter gives. */
export function artifactStatuses(root: string): ArtifactStatus[] {
  if (!exists(root)) return [];
  const out: ArtifactStatus[] = [];
  for (const file of walk(root)) {
    if (path.basename(file) !== "index.md") continue;
    const text = fs.readFileSync(file, "utf8");
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    const field = (name: string): string | null => {
      const m = new RegExp(`^${name}:\\s*(.*)$`, "m").exec(front);
      return m === null ? null : (m[1] as string).trim().replace(/^"(.*)"$/, "$1");
    };
    const status = field("status");
    out.push({
      relPath: path.relative(root, path.dirname(file)) || ".",
      kind: field("kind"),
      title: field("title"),
      status: status !== null && /^\d+$/.test(status) ? Number(status) : null,
    });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function label(agent: AgentFiles, byId: Map<string, AgentFiles>): string {
  if (agent.kind === "session") return `session ${agent.agentId}`;
  if (agent.kind === "unmapped") return `unmapped session ${agent.agentId}`;
  const parent = agent.parentId === null ? null : byId.get(agent.parentId);
  if (agent.kind === "subagent") {
    return `subagent ${agent.agentId} of ${parent === undefined || parent === null ? `session ${agent.parentId}` : label(parent, byId)}`;
  }
  return agent.kind === "coordinator" ? `coordinator ${agent.agentId}` : `child ${agent.agentId} (parent ${agent.parentId ?? "none"})`;
}

/**
 * Every transcript of every agent the attempt used, each named for the audit. Arm C:
 * the session and each subagent's transcript. Arm T: the coordinator's chat as each
 * turn recorded it, every other agent's chat from `chats`, and every Claude session
 * and subagent transcript of them all. A file that spans both turns is split at the
 * build turn's launch.
 */
export function auditTranscriptsV3(
  cfg: BenchConfig,
  record: AttemptRecord,
  p: AttemptPaths,
  chats: Map<string, string>,
): AuditTranscript[] {
  const agents = attemptAgents(cfg, record, p);
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const launched = record.phases.B?.launchedAt;
  const buildFrom = launched === undefined ? undefined : Date.parse(launched);
  const lastPhase: Phase = record.phases.B !== undefined ? "B" : "A";
  const out: AuditTranscript[] = [];
  const coordinator = agents.find((a) => a.kind === "coordinator");
  if (coordinator !== undefined) {
    for (const phase of ["A", "B"] as Phase[]) {
      const file = record.phases[phase]?.transcriptPath;
      if (file !== undefined) out.push({ phase, file, source: `${label(coordinator, byId)}, chat` });
    }
  }
  for (const agent of agents) {
    const chat = chats.get(agent.agentId);
    if (chat !== undefined && agent.kind !== "coordinator") {
      out.push({ phase: lastPhase, file: chat, source: `${label(agent, byId)}, chat`, ...(buildFrom !== undefined ? { buildFrom } : {}) });
    }
    for (const f of agent.files) {
      out.push({
        phase: lastPhase,
        file: f.file,
        source: agent.kind === "child" || agent.kind === "coordinator" ? `${label(agent, byId)}, session ${f.sessionId}` : label(agent, byId),
        ...(buildFrom !== undefined ? { buildFrom } : {}),
      });
    }
  }
  return out;
}

/**
 * What a phase costs before it has chosen to read anything. The first call carries
 * only the harness's system prompt and tools, the auto-loaded notes and the task.
 * Calls are ordered by when they started; a call whose usage is unknown carries no
 * prompt tokens and is counted apart.
 */
export function harnessOverhead(rows: LedgerRow[], phase: Phase): HarnessOverhead {
  const phaseRows = rows
    .map(rederive)
    .filter((r) => r.metered && r.attribution === "attributed" && r.phase === phase);
  const known = phaseRows
    .map((r, i) => ({ r, i, start: Date.parse(r.ts) - r.durationMs }))
    .filter((x) => x.r.usage !== "unknown")
    .sort((a, b) => (a.start === b.start ? a.i - b.i : a.start - b.start));
  const prompt = known.map(({ r }) => {
    const u = r.usage as Exclude<LedgerRow["usage"], "unknown">;
    return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  });
  return {
    calls: known.length,
    unknownCalls: phaseRows.length - known.length,
    firstCallPromptTokens: prompt[0] ?? null,
    meanPromptTokens:
      prompt.length === 0 ? null : Math.round(prompt.reduce((a, b) => a + b, 0) / prompt.length),
  };
}
