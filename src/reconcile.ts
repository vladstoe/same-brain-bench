import type { Arm, AttemptRecord, BackgroundCall, CostReport, LedgerRow, Phase, PriceTable } from "./types.ts";
import { rederive } from "./ledger.ts";
import { priceBuckets } from "./pricing.ts";
import { attributeCalls } from "./sessions.ts";
import { phaseSessionsOf, readAgentRecords, type AgentFiles } from "./v3-measures.ts";

export interface PhaseReconciliation {
  phase: Phase;
  nativeSource: string | null;
  nativeTokens: number | null;
  ledgerTokens: number;
  tokenDelta: number | null;
  tokenRatio: number | null;
  nativeUsd: number | null;
  ledgerUsd: number | null;
  usdRatio: number | null;
  flagged: boolean;
  note: string | null;
  /** v3: the ledger figures compared with native, where they differ from the whole ledger. */
  comparedLedgerTokens?: number;
  comparedLedgerUsd?: number;
}

/** A background call, and the turn whose native figure it reached, if any. */
export interface BackgroundTiming {
  phase: Phase;
  messageId: string;
  ts: string;
  usd: number | null;
  sessionId: string;
  recordedIn: Phase | null;
}

/** v3: what the native counters cover that the whole ledger does not, or the other way round. */
export interface ReconcileAdjustments {
  /** Per turn, ledger calls whose tokens the native counter does not count. */
  tokensOutsideNative?: Partial<Record<Phase, { calls: number; tokens: number; why: string }>>;
  background?: BackgroundTiming[];
  /** Set when only USD may flag the turn; the tokens stay in the record for information. */
  usdOnly?: string;
  /** Per turn, the calls of sessions no agent names: native has them only if an agent's chat ran them. */
  unmapped?: Partial<Record<Phase, { calls: number; usd: number | null }>>;
}

/** Every bucket of a call, the way the ledger side's tokens are added up. */
function rowTokens(row: LedgerRow): number {
  const u = rederive(row).usage;
  return u === "unknown" ? 0 : u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/**
 * Arm C's `claude -p --output-format json` counts the main thread's tokens only, while
 * its USD covers subagents too, so the token comparison leaves subagent calls out of
 * the ledger side.
 */
export function subagentTokens(rows: LedgerRow[], subagentMessageIds: Set<string>): ReconcileAdjustments["tokensOutsideNative"] {
  const out: NonNullable<ReconcileAdjustments["tokensOutsideNative"]> = {};
  for (const row of rows) {
    if (!row.metered || row.attribution !== "attributed" || row.messageId === null || !subagentMessageIds.has(row.messageId)) continue;
    const phase = row.phase as Phase;
    const entry = (out[phase] ??= { calls: 0, tokens: 0, why: "claude -p reports the main thread's tokens only" });
    entry.calls += 1;
    entry.tokens += rowTokens(row);
  }
  return out;
}

/**
 * Traycer's native figure is each agent's cumulative cost as the host recorded it at
 * the end of a turn, so a background call reaches it only through a later turn of the
 * same session. The coordinator's cost is read at each turn's end; every other
 * agent's once, whole, into the build turn. `ownCalls` is each session's own
 * transcript calls; `wholeAtEnd` the sessions read only once.
 */
export function backgroundTiming(
  background: Partial<Record<Phase, BackgroundCall[]>>,
  ownCalls: Map<string, { ts: string; phase: Phase }[]>,
  wholeAtEnd: Set<string>,
): BackgroundTiming[] {
  const out: BackgroundTiming[] = [];
  for (const phase of ["A", "B"] as Phase[]) {
    for (const b of background[phase] ?? []) {
      const at = Date.parse(b.ts);
      const next = (ownCalls.get(b.sessionId) ?? [])
        .filter((c) => Date.parse(c.ts) > at)
        .sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts))[0];
      const recordedIn = next === undefined ? null : wholeAtEnd.has(b.sessionId) ? "B" : next.phase;
      out.push({ phase, messageId: b.messageId, ts: b.ts, usd: b.usd, sessionId: b.sessionId, recordedIn });
    }
  }
  return out;
}

export interface Reconciliation {
  attemptId: string;
  tolerance: number;
  phases: PhaseReconciliation[];
  flagged: boolean;
}

function ratio(native: number, ledger: number): number | null {
  if (ledger === 0) return native === 0 ? 0 : null;
  return Math.abs(native - ledger) / ledger;
}

/**
 * v3: arm C's native tokens leave out its subagents' calls, and arm T's native USD
 * leaves out a background call no later turn of its session recorded. Background
 * calls are known only where the ledger carries Claude Code's session header.
 *
 * Arm C is judged on USD alone: when the resumed build turn runs background
 * subagents, `claude -p`'s token figure stops tracking the main thread's ledger calls
 * (C-0: 1.14M against 3.59M with every subagent call left out), while its USD still
 * matches the whole ledger to the cent.
 */
export function reconcileAdjustmentsV3(arm: Arm, agents: AgentFiles[], rows: LedgerRow[], prices: PriceTable): ReconcileAdjustments {
  const idsOf = (a: AgentFiles): string[] => a.files.flatMap((f) => [...readAgentRecords(f.file).messageIds]);
  if (arm === "C") {
    return {
      tokensOutsideNative: subagentTokens(rows, new Set(agents.filter((a) => a.kind === "subagent").flatMap(idsOf))),
      usdOnly: "claude -p's token figure is not comparable once a resumed session runs background subagents",
    };
  }
  const found = phaseSessionsOf(agents, arm);
  const background: Partial<Record<Phase, BackgroundCall[]>> = {};
  for (const phase of ["A", "B"] as Phase[]) background[phase] = attributeCalls(rows, phase, found, prices).background ?? [];
  const attributed = rows.filter((r) => r.metered && r.attribution === "attributed" && r.messageId !== null);
  const ownCalls = new Map<string, { ts: string; phase: Phase }[]>();
  const wholeAtEnd = new Set<string>();
  for (const agent of agents.filter((a) => a.kind !== "subagent")) {
    for (const f of agent.files) {
      const ids = readAgentRecords(f.file).messageIds;
      const calls = attributed.filter((r) => ids.has(r.messageId as string)).map((r) => ({ ts: r.ts, phase: r.phase as Phase }));
      ownCalls.set(f.sessionId, [...(ownCalls.get(f.sessionId) ?? []), ...calls]);
      if (agent.kind !== "coordinator") wholeAtEnd.add(f.sessionId);
    }
  }
  const unmappedIds = new Set(agents.filter((a) => a.kind === "unmapped" || unmappedParent(a, agents)).flatMap(idsOf));
  const unmapped: NonNullable<ReconcileAdjustments["unmapped"]> = {};
  for (const row of attributed.map(rederive)) {
    if (!unmappedIds.has(row.messageId as string)) continue;
    const entry = (unmapped[row.phase as Phase] ??= { calls: 0, usd: 0 });
    entry.calls += 1;
    const priced = row.usage === "unknown" ? null : priceBuckets(row.usage, prices);
    entry.usd = priced === null || entry.usd === null ? null : entry.usd + priced;
  }
  return { background: backgroundTiming(background, ownCalls, wholeAtEnd), ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}) };
}

function unmappedParent(a: AgentFiles, agents: AgentFiles[]): boolean {
  return a.kind === "subagent" && agents.some((p) => p.kind === "unmapped" && p.agentId === a.parentId);
}

/**
 * Native counters are a cross-check only; the ledger stays the source of truth
 * whatever this reports.
 */
export function reconcile(
  record: AttemptRecord,
  cost: CostReport,
  tolerance: number,
  adjust: ReconcileAdjustments = {},
): Reconciliation {
  const phases: PhaseReconciliation[] = [];

  for (const phase of ["A", "B"] as Phase[]) {
    const rec = record.phases[phase];
    if (rec === undefined) continue;
    const ledger = cost.perPhase[phase];
    const ledgerBuckets = ledger?.buckets;
    const ledgerTokens =
      ledgerBuckets === undefined
        ? 0
        : ledgerBuckets.input +
          ledgerBuckets.output +
          ledgerBuckets.cacheRead +
          ledgerBuckets.cacheWrite5m +
          ledgerBuckets.cacheWrite1h;

    const native = rec.nativeUsage;
    // All-null token fields mean "not comparable", not zero. Summing them to 0
    // produced a tokenRatio of 1.0 that read as a 100% discrepancy.
    const tokenFields = native === null ? [] : [native.input, native.output, native.cacheRead, native.cacheWrite];
    const nativeTokens = tokenFields.every((v) => v === null || v === undefined)
      ? null
      : tokenFields.reduce((acc: number, v) => acc + (v ?? 0), 0);

    const notes: string[] = [];
    const outside = adjust.tokensOutsideNative?.[phase];
    const comparedTokens = outside === undefined || outside.calls === 0 ? ledgerTokens : ledgerTokens - outside.tokens;
    if (comparedTokens !== ledgerTokens && outside !== undefined && nativeTokens !== null) {
      notes.push(`tokens compared without ${outside.calls} subagent call(s), ${outside.tokens} tokens: ${outside.why}; USD compared whole`);
    }

    const leftOut = (adjust.background ?? []).filter((b) => b.phase === phase && b.recordedIn !== phase);
    const carriedIn = (adjust.background ?? []).filter((b) => b.phase !== phase && b.recordedIn === phase);
    let comparedUsd = ledger?.usd ?? null;
    if (comparedUsd !== null && (leftOut.length > 0 || carriedIn.length > 0)) {
      if ([...leftOut, ...carriedIn].some((b) => b.usd === null)) {
        notes.push("a background call carries no USD, so native is compared with the whole ledger");
      } else {
        comparedUsd = comparedUsd - leftOut.reduce((sum, b) => sum + (b.usd ?? 0), 0) + carriedIn.reduce((sum, b) => sum + (b.usd ?? 0), 0);
        const item = (b: BackgroundTiming): string => `${b.messageId} at ${b.ts}, $${(b.usd ?? 0).toFixed(4)}`;
        if (leftOut.length > 0) {
          notes.push(`native has not recorded ${leftOut.length} background call(s) made after the agent's last turn, subtracted: ${leftOut.map(item).join("; ")}`);
        }
        if (carriedIn.length > 0) {
          notes.push(`native recorded ${carriedIn.length} background call(s) from the plan turn with this turn, added: ${carriedIn.map(item).join("; ")}`);
        }
      }
    }

    const tokenRatio = nativeTokens === null ? null : ratio(nativeTokens, comparedTokens);
    const usdRatio =
      native?.usd === null || native?.usd === undefined || comparedUsd === null
        ? null
        : ratio(native.usd, comparedUsd);

    const unknown = ledger?.unknownCalls ?? 0;
    if (native === null) notes.push("no native counters recorded");
    if (native !== null && nativeTokens === null) {
      notes.push("native token fields are not comparable with a per-call ledger; USD only");
    }
    if (unknown > 0) notes.push(`${unknown} ledger call(s) with unknown usage`);
    if (usdRatio === null && native?.usd !== null && native?.usd !== undefined) {
      notes.push(
        ledger?.usd === null || ledger?.usd === undefined
          ? "ledger USD unavailable (price table)"
          : "native USD unavailable, so only tokens were compared",
      );
    }

    const unmapped = adjust.unmapped?.[phase];
    if (unmapped !== undefined) {
      notes.push(
        `${unmapped.calls} call(s), ${unmapped.usd === null ? "USD unknown" : `$${unmapped.usd.toFixed(4)}`}, came from sessions no agent names; ` +
          "native counts them only if an agent's chat ran them",
      );
    }
    if (adjust.usdOnly !== undefined) notes.push(`tokens for information only, flagged on USD alone: ${adjust.usdOnly}`);

    const usdOff = adjust.usdOnly !== undefined ? usdRatio === null || usdRatio > tolerance : usdRatio !== null && usdRatio > tolerance;
    const flagged =
      (adjust.usdOnly === undefined && tokenRatio !== null && tokenRatio > tolerance) ||
      usdOff ||
      unknown > 0 ||
      native === null;

    phases.push({
      phase,
      nativeSource: native?.source ?? null,
      nativeTokens,
      ledgerTokens,
      tokenDelta: nativeTokens === null ? null : nativeTokens - comparedTokens,
      tokenRatio,
      nativeUsd: native?.usd ?? null,
      ledgerUsd: ledger?.usd ?? null,
      usdRatio,
      flagged,
      note: notes.length > 0 ? notes.join("; ") : null,
      ...(comparedTokens !== ledgerTokens ? { comparedLedgerTokens: comparedTokens } : {}),
      ...(comparedUsd !== null && comparedUsd !== (ledger?.usd ?? null) ? { comparedLedgerUsd: comparedUsd } : {}),
    });
  }

  return {
    attemptId: record.attemptId,
    tolerance,
    phases,
    flagged: phases.some((p) => p.flagged),
  };
}
