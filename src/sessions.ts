import path from "node:path";
import type { BackgroundCall, CallAttribution, ForeignCall, LedgerRow, Phase, PriceTable } from "./types.ts";
import type { AttemptPaths } from "./paths.ts";
import { rederive } from "./ledger.ts";
import { priceBuckets } from "./pricing.ts";

/**
 * Claude Code's project-slug for a working directory: every path separator becomes
 * a dash, so /a/b/c -> -a-b-c. Asserted against the observed slug in the selftests.
 */
export function claudeProjectSlug(worktree: string): string {
  return worktree.replace(/\//g, "-");
}

/** What one Claude Code session file says about the calls it made. */
export interface SessionFacts {
  sessionId: string;
  file: string;
  own: boolean;
  messageIds: Set<string>;
  /** `effort` on each assistant record, where the record carries one. */
  efforts: string[];
  assistantRecords: number;
}

/** Where a phase's Claude Code sessions are, and which of them are the phase's own agent's. */
export interface PhaseSessions {
  sessions: SessionFacts[];
  ownSessionIds: string[];
  ownSessionsFrom: CallAttribution["ownSessionsFrom"];
  note: string | null;
  /** v3: each own Claude session id and the agent that ran it, and every agent id of the attempt, subagents included. */
  owners?: { sessions: Map<string, string>; agentIds: Set<string> };
}

/** Arm C's subagent transcripts, copied beside the phase's own transcript. */
export function subagentArchiveDir(p: AttemptPaths, phase: Phase): string {
  return path.join(p.transcripts, `phase-${phase.toLowerCase()}.subagents`);
}

/**
 * Each of the phase's attributed ledger rows, matched by message id to the session
 * that made it. A row no session of the phase's own agent carries is foreign: made
 * by another agent in the same store, or by something the rig cannot see at all.
 * When the phase's own session cannot be found or carries no message id, nothing is
 * called foreign, because every row would then be.
 *
 * A row the proxy recorded Claude Code's session header on, and no transcript
 * carries, is the attempt's own background call when the header names one of its
 * own sessions, and another session's call when it names any other. A row without
 * the header is judged by message id alone, as every row was before the proxy read it.
 */
export function attributeCalls(
  rows: LedgerRow[],
  phase: Phase,
  found: PhaseSessions,
  prices: PriceTable,
): CallAttribution {
  const phaseRows = rows
    .map(rederive)
    .filter((r) => r.metered && r.attribution === "attributed" && r.phase === phase);
  const own = new Set<string>();
  for (const s of found.sessions) if (s.own) for (const id of s.messageIds) own.add(id);
  const other = new Map<string, string>();
  for (const s of found.sessions) if (!s.own) for (const id of s.messageIds) if (!other.has(id)) other.set(id, s.sessionId);

  const ownFiles = found.sessions.filter((s) => s.own);
  const available = ownFiles.length > 0 && own.size > 0;
  const note = available
    ? found.note
    : (found.note ??
      (ownFiles.length === 0 ? "the phase's own session file was not found" : "the phase's own session carries no message id"));

  const ownSessions = new Set(found.owners !== undefined ? found.owners.sessions.keys() : found.ownSessionIds);
  const ownerOf = (row: LedgerRow, sessionId: string): string | null => {
    if (row.agentId !== undefined && row.agentId !== null && found.owners?.agentIds.has(row.agentId)) return row.agentId;
    return found.owners?.sessions.get(sessionId) ?? null;
  };

  let matched = 0;
  let noMessageId = 0;
  const foreign: ForeignCall[] = [];
  const background: BackgroundCall[] = [];
  for (const row of phaseRows) {
    if (row.messageId === null || row.messageId === "") {
      noMessageId += 1;
      continue;
    }
    if (!available || own.has(row.messageId)) {
      if (available) matched += 1;
      continue;
    }
    const header = row.sessionId ?? null;
    const usage = row.usage === "unknown" ? null : row.usage;
    const figures = {
      messageId: row.messageId,
      ts: row.ts,
      model: row.model,
      usd: usage === null ? null : priceBuckets(usage, prices),
      promptTokens: usage === null ? null : usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h,
      outputTokens: usage === null ? null : usage.output,
    };
    if (header !== null && ownSessions.has(header)) {
      background.push({ ...figures, sessionId: header, xApp: row.xApp ?? null, agentId: ownerOf(row, header) });
      continue;
    }
    const sessionId = other.get(row.messageId) ?? header;
    foreign.push({ ...figures, belongsTo: sessionId === null ? "noSession" : "otherSession", sessionId });
  }

  return {
    available,
    note,
    ownSessionIds: found.ownSessionIds,
    ownSessionsFrom: found.ownSessionsFrom,
    sessions: found.sessions.map((s) => ({ sessionId: s.sessionId, file: s.file, own: s.own, messageIds: s.messageIds.size })),
    calls: phaseRows.length,
    matched,
    noMessageId,
    foreign,
    ...(phaseRows.some((r) => r.sessionId !== undefined) ? { background } : {}),
  };
}

/**
 * The ledger without the phase's foreign and background calls. A call no session of
 * the phase's own agent made is not that phase working, and a background call is no
 * turn of it, so both leave the context-gathering window before the window is cut;
 * the cost totals keep them.
 */
export function leaveOutForeign(rows: LedgerRow[], attribution: CallAttribution | undefined, phase: Phase): LedgerRow[] {
  const foreign = new Set([...(attribution?.foreign ?? []), ...(attribution?.background ?? [])].map((f) => f.messageId));
  if (foreign.size === 0) return rows;
  return rows.filter((r) => !(r.phase === phase && r.messageId !== null && foreign.has(r.messageId)));
}
