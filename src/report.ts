import fs from "node:fs";
import path from "node:path";
import type {
  Arm,
  AttemptRecord,
  AuditRecord,
  BenchConfig,
  CostReport,
  EvaluatorResult,
  Phase,
} from "./types.ts";
import type { Reconciliation } from "./reconcile.ts";
import { attemptPaths } from "./paths.ts";
import { runsRoot } from "./config.ts";
import { clopperPearson, pct } from "./stats.ts";
import { addBuckets, emptyBuckets } from "./pricing.ts";
import { exists, readJson } from "./util.ts";

const ARMS: Arm[] = ["C", "T"];

interface Loaded {
  record: AttemptRecord;
  cost: CostReport | null;
  audit: AuditRecord | null;
  reconcile: Reconciliation | null;
  result: EvaluatorResult | null;
}

export function loadAttempts(cfg: BenchConfig): Loaded[] {
  const root = runsRoot(cfg);
  const out: Loaded[] = [];
  if (!exists(root)) return out;
  for (const arm of fs.readdirSync(root)) {
    // `_smoke` and `_preflight` are scratch, not attempts.
    if (arm.startsWith("_")) continue;
    const armDir = path.join(root, arm);
    if (!fs.statSync(armDir).isDirectory()) continue;
    for (const nDir of fs.readdirSync(armDir)) {
      const n = Number(nDir);
      if (!Number.isInteger(n)) continue;
      const p = attemptPaths(cfg, arm as Arm, n);
      if (!exists(p.record)) continue;
      out.push({
        record: readJson<AttemptRecord>(p.record),
        cost: exists(p.cost) ? readJson<CostReport>(p.cost) : null,
        audit: exists(p.audit) ? readJson<AuditRecord>(p.audit) : null,
        reconcile: exists(p.reconcile) ? readJson<Reconciliation>(p.reconcile) : null,
        result: exists(p.result) ? readJson<EvaluatorResult>(p.result) : null,
      });
    }
  }
  return out.sort((a, b) =>
    a.record.arm === b.record.arm ? a.record.n - b.record.n : a.record.arm.localeCompare(b.record.arm),
  );
}

function money(usd: number | null): string {
  return usd === null ? "n/a" : `$${usd.toFixed(4)}`;
}

function minutes(ms: number): string {
  return `${(ms / 60000).toFixed(1)} min`;
}

function phaseWall(record: AttemptRecord, phase: Phase): number {
  return record.phases[phase]?.wallClockMs ?? 0;
}

function decisionKeys(loaded: Loaded[]): string[] {
  const keys = new Set<string>();
  for (const l of loaded) {
    for (const k of Object.keys(l.result?.decisions ?? {})) keys.add(k);
  }
  return [...keys].sort();
}

export function buildReport(cfg: BenchConfig, loaded: Loaded[]): string {
  // n = 0 is the unscored live dry run; it is reported, never counted.
  const scoredLoaded = loaded.filter((l) => l.record.n >= 1);
  const unscored = loaded.filter((l) => l.record.n === 0);
  const lines: string[] = [];
  lines.push("# cold-handoff pilot — results");
  lines.push("");
  lines.push(
    `Pilot, k = ${cfg.k}. Three outcomes per arm, not three per phase. Counts with exact ` +
      "(Clopper-Pearson) 95% intervals; no p-values. Directional only.",
  );
  lines.push("");
  lines.push(
    `Pinned model: \`${cfg.model.id}\`${cfg.model.verified ? "" : " (id not yet confirmed against the API)"}. ` +
      `Prices: ${cfg.prices.verifiedOn === null ? "**not verified** — USD columns read n/a" : `verified ${cfg.prices.verifiedOn}`}.`,
  );
  lines.push("");

  const dryRuns = scoredLoaded.filter((l) => l.record.dryRun).length;
  if (dryRuns > 0) {
    lines.push(
      `> ${dryRuns} of ${loaded.length} attempt(s) in this report are **dry runs**. They exercise the ` +
        "rig, not any product, and must not be read as a result.",
    );
    lines.push("");
  }

  lines.push("## Headline");
  lines.push("");
  lines.push(
    "| Arm | Successes | 95% CI | End-to-end USD | Phase A USD | Phase B USD | Wall-clock total | Phase A | Phase B | Cost per success | Cost of failures | Completion alone | Excluded |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const arm of ARMS) {
    // n = 0 is the unscored live dry run: it never enters a count, an interval or
    // a cost total. It gets its own table below so the numbers stay visible.
    const attempts = loaded.filter((l) => l.record.arm === arm && l.record.n >= 1);
    if (attempts.length === 0) continue;
    const scored = attempts.filter((l) => l.record.classification?.outcome !== "infrastructureExcluded");
    const excluded = attempts.length - scored.length;
    const successes = scored.filter((l) => l.record.classification?.outcome === "success").length;
    const ci = clopperPearson(successes, scored.length);

    let total = 0;
    let a = 0;
    let b = 0;
    let anyUnpriced = false;
    let failureUsd = 0;
    for (const l of scored) {
      const t = l.cost?.totals.usd;
      const ac = l.cost?.perPhase["A"]?.usd;
      const bc = l.cost?.perPhase["B"]?.usd;
      if (t === null || t === undefined) anyUnpriced = true;
      else {
        total += t;
        if (l.record.classification?.outcome !== "success") failureUsd += t;
      }
      if (typeof ac === "number") a += ac;
      if (typeof bc === "number") b += bc;
    }

    const wall = scored.reduce(
      (acc, l) => acc + phaseWall(l.record, "A") + phaseWall(l.record, "B"),
      0,
    );
    const wallA = scored.reduce((acc, l) => acc + phaseWall(l.record, "A"), 0);
    const wallB = scored.reduce((acc, l) => acc + phaseWall(l.record, "B"), 0);

    const completionAlone = scored.filter((l) => {
      const completion = l.result?.completion;
      if (completion === undefined) return false;
      return Object.values(completion).every((v) => v === true) && l.result?.existingTests !== false;
    }).length;

    const perSuccess =
      anyUnpriced ? null : successes === 0 ? "undefined" : `$${(total / successes).toFixed(4)}`;

    lines.push(
      `| ${arm} | ${successes} / ${scored.length} | ${pct(ci.lower)} – ${pct(ci.upper)} | ` +
        `${anyUnpriced ? "n/a" : money(total)} | ${anyUnpriced ? "n/a" : money(a)} | ${anyUnpriced ? "n/a" : money(b)} | ` +
        `${minutes(wall)} | ${minutes(wallA)} | ${minutes(wallB)} | ${perSuccess ?? "n/a"} | ` +
        `${anyUnpriced ? "n/a" : money(failureUsd)} | ${completionAlone} / ${scored.length} | ${excluded} |`,
    );
  }

  lines.push("");
  lines.push(
    "Cost per success divides the arm's total cost, failures included, by its successes; " +
      "it reads `undefined` at zero successes and `n/a` while the price table is unverified. " +
      "Evaluator time is measured separately and is never part of an arm's wall-clock.",
  );
  lines.push("");

  const keys = decisionKeys(scoredLoaded);
  if (keys.length > 0) {
    lines.push("## Per-decision");
    lines.push("");
    lines.push(`| Arm | ${keys.join(" | ")} |`);
    lines.push(`| --- | ${keys.map(() => "---").join(" | ")} |`);
    for (const arm of ARMS) {
      const attempts = loaded.filter(
        (l) =>
          l.record.arm === arm &&
          l.record.n >= 1 &&
          l.record.classification?.outcome !== "infrastructureExcluded",
      );
      if (attempts.length === 0) continue;
      const cells = keys.map((k) => {
        const held = attempts.filter((l) => l.result?.decisions?.[k] === true).length;
        return `${held} / ${attempts.length}`;
      });
      lines.push(`| ${arm} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  lines.push("## Attempts");
  lines.push("");
  lines.push("| Attempt | Outcome | Cause | Dry run | Unknown usage | Reconciliation | Audit |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const l of scoredLoaded) {
    const c = l.record.classification;
    const unknown = l.cost?.totals.unknownCalls ?? 0;
    const auditState =
      l.audit === null ? "not run" : l.audit.clean ? "clean" : `${l.audit.offendingPaths.length} flagged`;
    lines.push(
      `| ${l.record.attemptId} | ${c?.outcome ?? "unclassified"} | ${c?.failureCause ?? c?.exclusionCause ?? "—"} | ` +
        `${l.record.dryRun ? "yes" : "no"} | ${unknown > 0 ? `**${unknown}**` : "0"} | ` +
        `${l.reconcile === null ? "not run" : l.reconcile.flagged ? "**mismatch**" : "ok"} | ${auditState} |`,
    );
  }
  lines.push("");

  if (unscored.length > 0) {
    lines.push("## Unscored live dry runs (n = 0)");
    lines.push("");
    lines.push(
      "Rehearsals of the full lifecycle against the real products. They are **excluded from " +
        "every count, interval and cost total above** and are shown only so their numbers are " +
        "visible. Never report them as outcomes.",
    );
    lines.push("");
    lines.push("| Attempt | Outcome | Cause | End-to-end USD | Wall-clock | Unknown usage | Audit |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const l of unscored) {
      const c = l.record.classification;
      const wall = phaseWall(l.record, "A") + phaseWall(l.record, "B");
      lines.push(
        `| ${l.record.attemptId} | ${c?.outcome ?? "unclassified"} | ${c?.failureCause ?? c?.exclusionCause ?? "—"} | ` +
          `${money(l.cost?.totals.usd ?? null)} | ${minutes(wall)} | ${l.cost?.totals.unknownCalls ?? 0} | ` +
          `${l.audit === null ? "not run" : l.audit.clean ? "clean" : `${l.audit.offendingPaths.length} flagged`} |`,
      );
    }
    lines.push("");
  }

  const flaggedAudits = loaded.filter((l) => l.audit !== null && !l.audit.clean);
  if (flaggedAudits.length > 0) {
    lines.push("### Flagged audits");
    lines.push("");
    for (const l of flaggedAudits) {
      for (const o of l.audit?.offendingPaths ?? []) {
        lines.push(
          `- \`${l.record.attemptId}\` phase ${o.phase}, \`${o.tool}\` read \`${o.path}\`${o.source !== undefined ? ` (${o.source})` : ""}`,
        );
      }
    }
    lines.push("");
  }

  // cost.json files written before unattributed tracking existed have no such field.
  const withUnattributed = loaded.filter((l) => (l.cost?.unattributed?.calls ?? 0) > 0);
  if (withUnattributed.length > 0) {
    lines.push("### Unattributed proxy traffic");
    lines.push("");
    lines.push(
      "Calls that reached the proxy while no phase was active. Arm T's routing is " +
        "per-provider, so any Traycer agent on the machine reaches it. These are listed " +
        "and **excluded from every total**.",
    );
    lines.push("");
    for (const l of withUnattributed) {
      const u = l.cost?.unattributed;
      lines.push(`- \`${l.record.attemptId}\` — ${u?.calls} call(s), tokens ${JSON.stringify(u?.buckets)}`);
    }
    lines.push("");
  }

  const authMismatch = loaded.filter(
    (l) => l.record.classification?.failureCause === "authChannelMismatch",
  );
  if (authMismatch.length > 0) {
    lines.push("### Authentication-channel mismatches");
    lines.push("");
    lines.push("Arm T turns that ran on the signed-in subscription rather than the bench API key. Not cost-comparable.");
    lines.push("");
    for (const l of authMismatch) {
      lines.push(`- \`${l.record.attemptId}\` — ${l.record.classification?.reason}`);
    }
    lines.push("");
  }

  const excludedAttempts = loaded.filter(
    (l) => l.record.classification?.outcome === "infrastructureExcluded",
  );
  lines.push("### Excluded attempts");
  lines.push("");
  if (excludedAttempts.length === 0) lines.push("None.");
  else {
    for (const l of excludedAttempts) {
      lines.push(
        `- \`${l.record.attemptId}\` — ${l.record.classification?.exclusionCause}: ${l.record.classification?.reason}`,
      );
    }
  }
  lines.push("");

  lines.push("## Appendix — raw token buckets");
  lines.push("");
  lines.push("| Attempt | Phase | Calls | Unknown | Input | Output | Cache read | Cache write 5m | Cache write 1h |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const l of scoredLoaded) {
    for (const [phase, cost] of Object.entries(l.cost?.perPhase ?? {})) {
      const bk = cost.buckets;
      lines.push(
        `| ${l.record.attemptId} | ${phase} | ${cost.calls} | ${cost.unknownCalls} | ${bk.input} | ${bk.output} | ${bk.cacheRead} | ${bk.cacheWrite5m} | ${bk.cacheWrite1h} |`,
      );
    }
  }
  lines.push("");

  const grand = scoredLoaded.reduce(
    (acc, l) => addBuckets(acc, l.cost?.totals.buckets ?? emptyBuckets()),
    emptyBuckets(),
  );
  lines.push(
    `Grand total across every attempt in this report: ${JSON.stringify(grand)}. ` +
      `Retry groups (same client marker, more than one response) are listed in each attempt's \`cost.json\`.`,
  );
  lines.push("");

  lines.push(...v3Sections(loaded, cfg));

  return lines.join("\n");
}

function yesNo(v: boolean | undefined): string {
  return v === undefined ? "—" : v ? "yes" : "no";
}

const TURN: Record<Phase, string> = { A: "plan", B: "build" };

/** The evaluator's completion checks that are features: every one but the seed's own tests. */
function featureKeys(loaded: Loaded[]): string[] {
  const keys: string[] = [];
  for (const l of loaded) for (const k of Object.keys(l.result?.completion ?? {})) if (!keys.includes(k)) keys.push(k);
  return keys.filter((k) => k !== "seedTests");
}

function featuresComplete(l: Loaded, keys: string[]): number | null {
  const c = l.result?.completion;
  if (c === undefined || c === null) return null;
  return keys.filter((k) => c[k] === true).length;
}

function foreignUsd(l: Loaded, phase?: Phase): number | null {
  let total = 0;
  for (const ph of phase === undefined ? (["A", "B"] as Phase[]) : [phase]) {
    for (const f of l.record.callAttribution?.[ph]?.foreign ?? []) {
      if (f.usd === null) return null;
      total += f.usd;
    }
  }
  return total;
}

/** The attempt's own background calls: how many, and what they cost. */
function background(l: Loaded, phase?: Phase): { calls: number; usd: number | null } {
  let calls = 0;
  let usd: number | null = 0;
  for (const ph of phase === undefined ? (["A", "B"] as Phase[]) : [phase]) {
    for (const b of l.record.callAttribution?.[ph]?.background ?? []) {
      calls += 1;
      usd = b.usd === null || usd === null ? null : usd + b.usd;
    }
  }
  return { calls, usd };
}

/** Ledger cost less the calls no session of the attempt's agents made; its own background calls stay in. */
function ownUsd(l: Loaded, phase?: Phase): number | null {
  const ledger = phase === undefined ? l.cost?.totals.usd : l.cost?.perPhase[phase]?.usd;
  const foreign = foreignUsd(l, phase);
  if (ledger === null || ledger === undefined || foreign === null) return null;
  return ledger - foreign;
}

function cell(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? "—" : v;
}

/** v3: one conversation of two turns, with each tool delegating its own way. */
function v3Sections(loaded: Loaded[], cfg: BenchConfig): string[] {
  const lines: string[] = [];
  const rows = loaded.filter((l) => l.record.n >= 1);
  if (rows.length === 0) return lines;
  const scored = rows.filter((l) => l.record.classification?.outcome !== "infrastructureExcluded");
  const keys = featureKeys(rows);

  lines.push("## v3 — one conversation, plan then build");
  lines.push("");
  lines.push(
    "Phase A is the plan turn and phase B the build turn of the same conversation: arm C resumes its session, " +
      "arm T sends the build turn to the coordinator the plan turn created. Every measure below covers every agent " +
      "the attempt used, Traycer's child agents and Claude Code's subagents included.",
  );
  lines.push("");

  lines.push("### Features complete");
  lines.push("");
  lines.push("Each feature's completion check from the evaluator, over the scored attempts that were not excluded.");
  lines.push("");
  lines.push(`| Check | ${ARMS.filter((a) => scored.some((l) => l.record.arm === a)).join(" | ")} |`);
  const arms = ARMS.filter((a) => scored.some((l) => l.record.arm === a));
  lines.push(`| --- | ${arms.map(() => "---").join(" | ")} |`);
  for (const k of [...keys, "seedTests"]) {
    const cells = arms.map((arm) => {
      const a = scored.filter((l) => l.record.arm === arm);
      return `${a.filter((l) => l.result?.completion?.[k] === true).length} / ${a.length}`;
    });
    lines.push(`| ${k === "seedTests" ? "seed tests" : k} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("| Attempt | Outcome | Features complete | Rules held | Seed tests | Primary |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const l of rows) {
    const done = featuresComplete(l, keys);
    const rules = Object.values(l.result?.decisions ?? {});
    const primary = l.result?.["primary"];
    lines.push(
      `| ${l.record.attemptId} | ${l.record.classification?.outcome ?? "unclassified"} | ` +
        `${done === null ? "—" : `${done} / ${keys.length}`} | ` +
        `${rules.length === 0 ? "—" : `${rules.filter((v) => v === true).length} / ${rules.length}`} | ` +
        `${yesNo(l.result?.completion?.["seedTests"])} | ${typeof primary === "boolean" ? yesNo(primary) : "—"} |`,
    );
  }
  lines.push("");

  lines.push("### Cost and time");
  lines.push("");
  lines.push(
    "Own cost is the ledger's cost less the calls no session of the attempt's agents made, which are listed further " +
      "down. It includes the attempt's own background calls: requests Claude Code makes on its own after a turn, which " +
      "no transcript carries but whose session header names one of the attempt's sessions. Cost per completed feature " +
      "divides an attempt's own cost by the features it completed.",
  );
  lines.push("");
  lines.push(
    "| Attempt | Plan USD | Build USD | Own USD | Foreign USD | Background calls | Background USD | Plan time | Build time | Total time | Features complete | USD per completed feature |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const l of rows) {
    const done = featuresComplete(l, keys);
    const own = ownUsd(l);
    const wallA = phaseWall(l.record, "A");
    const wallB = phaseWall(l.record, "B");
    const bg = background(l);
    lines.push(
      `| ${l.record.attemptId} | ${money(ownUsd(l, "A"))} | ${money(ownUsd(l, "B"))} | ${money(own)} | ${money(foreignUsd(l))} | ` +
        `${bg.calls} | ${money(bg.usd)} | ` +
        `${minutes(wallA)} | ${minutes(wallB)} | ${minutes(wallA + wallB)} | ${done ?? "—"} | ` +
        `${own === null || done === null ? "n/a" : done === 0 ? "undefined" : money(own / done)} |`,
    );
  }
  lines.push("");
  lines.push("| Arm | Scored | Successes | Own USD | Mean own USD per attempt | Mean time per attempt | USD per completed feature |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of arms) {
    const a = scored.filter((l) => l.record.arm === arm);
    const owns = a.map((l) => ownUsd(l));
    const priced = owns.every((v) => v !== null);
    const total = owns.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    const features = a.reduce((sum, l) => sum + (featuresComplete(l, keys) ?? 0), 0);
    const wall = a.reduce((sum, l) => sum + phaseWall(l.record, "A") + phaseWall(l.record, "B"), 0);
    lines.push(
      `| ${arm} | ${a.length} | ${a.filter((l) => l.record.classification?.outcome === "success").length} | ` +
        `${priced ? money(total) : "n/a"} | ${priced && a.length > 0 ? money(total / a.length) : "n/a"} | ` +
        `${a.length > 0 ? minutes(wall / a.length) : "—"} | ${!priced ? "n/a" : features === 0 ? "undefined" : money(total / features)} |`,
    );
  }
  lines.push("");

  lines.push("### Agents and subagents");
  lines.push("");
  lines.push(
    `Every agent each attempt used, with its parent, what it was configured with, the model its own records and its ` +
      `ledger calls show, and its own cost, the background calls it owns included. The pin is \`${cfg.model.armModelRef["T"] ?? cfg.model.id}\` → \`${cfg.model.id}\` ` +
      `at \`${cfg.effort ?? "none"}\`; an agent off it excludes the attempt as \`modelMismatch\`.`,
  );
  lines.push("");
  lines.push(
    "| Attempt | Agent | Kind | Parent | Depth | Title | Harness | Configured | Recorded model | Resolved model | Effort | Plan calls | Build calls | USD | Pin |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const l of rows) {
    const agents = l.record.agents;
    if (agents === undefined || agents === null) {
      lines.push(`| ${l.record.attemptId} | — | — | — | — | — | — | — | — | — | — | — | — | — | not measured |`);
      continue;
    }
    for (const a of agents) {
      const pin = a.mismatches.length > 0 ? `**off: ${a.mismatches.join("; ")}**` : a.verified ? "on" : "unverified";
      lines.push(
        `| ${l.record.attemptId} | \`${a.agentId.slice(0, 12)}\` | ${a.kind} | ${a.parentId === null ? "—" : `\`${a.parentId.slice(0, 12)}\``} | ` +
          `${a.depth} | ${cell(a.title)} | ${cell(a.harness)} | ${cell([a.configuredModel, a.configuredEffort].filter((v) => v !== null).join(", "))} | ` +
          `${cell(a.transcriptModels.join(", "))} | ${cell(a.ledgerModels.join(", "))} | ${cell(a.efforts.join(", "))} | ` +
          `${a.calls.A ?? 0} | ${a.calls.B ?? 0} | ${money(a.usd)}` +
          `${a.backgroundCalls !== undefined ? ` (${a.backgroundCalls} background, ${money(a.backgroundUsd ?? null)})` : ""} | ${pin} |`,
      );
    }
  }
  lines.push("");
  lines.push("| Attempt | Agents | Off the pin | Unverified |");
  lines.push("| --- | --- | --- | --- |");
  for (const l of rows) {
    const c = l.record.agentCheck;
    lines.push(
      c === undefined || c === null
        ? `| ${l.record.attemptId} | — | — | — |`
        : `| ${l.record.attemptId} | ${c.agents} | ${c.mismatched.length === 0 ? "0" : `**${c.mismatched.length}**`} | ${c.unverified.length} |`,
    );
  }
  lines.push("");

  lines.push("### Claude Code builds");
  lines.push("");
  lines.push(
    "The `version` on every record of every agent's sessions and subagent transcripts, counted, against the pinned " +
      "binary's own `--version`, beside Traycer's current pack as the launch check read it. A record on another build, " +
      "a session with no version at all, or a session the agent names that was never archived, excludes the attempt " +
      "as `buildMismatch`, which is reported ahead of `modelMismatch`.",
  );
  lines.push("");
  lines.push("| Attempt | Pinned | Traycer pack at launch | Recorded versions | Sessions with no version | Build |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const l of rows) {
    const b = l.record.buildCheck;
    const launch = l.record.launchBuild;
    if (b === undefined || b === null) {
      lines.push(`| ${l.record.attemptId} | ${launch?.pinnedVersion ?? "—"} | ${launch?.currentPack ?? "—"} | — | — | not measured |`);
      continue;
    }
    const versions = Object.entries(b.total).sort(([x], [y]) => x.localeCompare(y)).map(([v, k]) => `${v} × ${k}`);
    const unversioned = b.agents.reduce((sum, a) => sum + a.unversionedFiles.length, 0);
    lines.push(
      `| ${l.record.attemptId} | ${b.pinnedVersion ?? "unread"}${b.pinnedFrom === "measure" ? " (read at measure)" : ""} | ` +
        `${launch?.currentPack ?? "—"} | ${versions.join(", ") || "none"} | ${unversioned === 0 ? "0" : `**${unversioned}**`} | ` +
        `${b.offPin.length === 0 ? "on" : `**off: ${b.offPin.length} agent(s)**`} |`,
    );
  }
  lines.push("");
  const offBuild = rows.flatMap((l) => (l.record.buildCheck?.offPin ?? []).map((o) => ({ l, o })));
  for (const { l, o } of offBuild) {
    const kind = l.record.buildCheck?.agents.find((a) => a.agentId === o.agentId)?.kind ?? "agent";
    lines.push(`- \`${l.record.attemptId}\` ${kind} \`${o.agentId.slice(0, 12)}\`: ${o.reasons.join("; ")}`);
  }
  if (offBuild.length > 0) lines.push("");

  const traycer = rows.filter((l) => l.record.arm === "T");
  if (traycer.length > 0) {
    lines.push("### Sessions no agent names");
    lines.push("");
    lines.push(
      "Every session in the attempt's Claude project folder is the attempt's own. One that no agent's chat store names " +
        "is archived with its subagents, counted as own, and put through the model, effort and build checks as an " +
        "`unmapped` agent. A file with no user or assistant record made no call: it is listed and left out of every check.",
    );
    lines.push("");
    const unmapped = traycer.flatMap((l) => (l.record.unmappedSessions ?? []).map((u) => ({ l, u })));
    for (const { l, u } of unmapped) {
      lines.push(
        `- \`${l.record.attemptId}\` \`${u.sessionId}\`: ` +
          (u.bookkeeping
            ? "bookkeeping only, no call made, ignored"
            : `unmapped session of the attempt, ${u.assistantRecords} assistant record(s), ${u.subagentFiles} subagent transcript(s)`),
      );
    }
    for (const l of traycer) {
      for (const a of l.record.buildCheck?.agents ?? []) {
        for (const f of a.bookkeepingFiles ?? []) {
          lines.push(`- \`${l.record.attemptId}\` ${a.kind} \`${a.agentId.slice(0, 12)}\`: \`${path.basename(f)}\` is bookkeeping only, no call made, ignored`);
        }
      }
    }
    if (unmapped.length === 0 && traycer.every((l) => (l.record.buildCheck?.agents ?? []).every((a) => (a.bookkeepingFiles ?? []).length === 0))) {
      lines.push("None.");
    }
    lines.push("");

    lines.push("### Traycer's ticket artifacts");
    lines.push("");
    lines.push("Every ticket artifact in the attempt's epic once the build settled, with its final status: 0 todo, 1 in progress, 2 complete.");
    lines.push("");
    lines.push("| Attempt | Tickets | Complete | In progress | Todo | No status |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const l of traycer) {
      const t = (l.record.artifacts ?? []).filter((a) => a.kind === "ticket");
      lines.push(
        `| ${l.record.attemptId} | ${t.length} | ${t.filter((a) => a.status === 2).length} | ${t.filter((a) => a.status === 1).length} | ` +
          `${t.filter((a) => a.status === 0).length} | ${t.filter((a) => a.status === null).length} |`,
      );
    }
    lines.push("");
    for (const l of traycer) {
      for (const a of (l.record.artifacts ?? []).filter((x) => x.kind === "ticket")) {
        lines.push(`- \`${l.record.attemptId}\` \`${a.relPath}\`: ${a.title ?? "untitled"}, status ${a.status ?? "none"}`);
      }
    }
    lines.push("");
  }

  lines.push("### Harness overhead and context growth, per session");
  lines.push("");
  lines.push(
    "Each own session's calls in each turn. Prompt tokens are input plus cache read plus both cache writes. The first " +
      "call carries the harness's fixed prompt; the mean across the build turn is how far each session's context grew. " +
      "A subagent is its own session.",
  );
  lines.push("");
  lines.push("| Attempt | Turn | Agent | Session | Calls | Unknown usage | First call prompt tokens | Mean prompt tokens per call | USD |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const l of rows) {
    for (const sc of l.record.sessionCalls ?? []) {
      lines.push(
        `| ${l.record.attemptId} | ${TURN[sc.phase]} | \`${sc.agentId.slice(0, 12)}\` | \`${sc.sessionId.slice(0, 12)}\` | ${sc.calls} | ` +
          `${sc.unknownCalls} | ${sc.firstCallPromptTokens ?? "—"} | ${sc.meanPromptTokens ?? "—"} | ${money(sc.usd)} |`,
      );
    }
  }
  lines.push("");
  lines.push("| Attempt | Turn | Model calls | Unknown usage | First call prompt tokens | Mean prompt tokens per call |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const l of rows) {
    for (const phase of ["A", "B"] as Phase[]) {
      const o = l.record.harnessOverhead?.[phase];
      lines.push(
        o === undefined
          ? `| ${l.record.attemptId} | ${TURN[phase]} | — | — | — | — |`
          : `| ${l.record.attemptId} | ${TURN[phase]} | ${o.calls} | ${o.unknownCalls} | ${o.firstCallPromptTokens ?? "—"} | ${o.meanPromptTokens ?? "—"} |`,
      );
    }
  }
  lines.push("");

  lines.push("### Reasoning effort");
  lines.push("");
  lines.push(`Read from every own session's records, per turn. The config pins ${cfg.effort === undefined ? "none" : `\`${cfg.effort}\``}.`);
  lines.push("");
  lines.push("| Attempt | Turn | Observed | Records | Against the config |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const l of rows) {
    for (const phase of ["A", "B"] as Phase[]) {
      const e = l.record.effort?.[phase];
      lines.push(
        e === undefined
          ? `| ${l.record.attemptId} | ${TURN[phase]} | — | — | — |`
          : `| ${l.record.attemptId} | ${TURN[phase]} | ${e.observed.join(", ") || "none recorded"} | ${e.records} | ` +
              `${e.matchesConfig === null ? "—" : e.matchesConfig ? "matches" : "**differs**"} |`,
      );
    }
  }
  lines.push("");

  lines.push("### Calls outside the attempt's transcripts");
  lines.push("");
  lines.push(
    "A ledger call is the attempt's own when a session of any of its agents carries its message id. A call no " +
      "transcript carries is a background call when Claude Code's session header on it names one of the attempt's own " +
      "sessions: it counts in own cost and in its agent's, and in no per-session figure or model check. Anything else is " +
      "foreign: left out of own cost and of every per-session figure. A ledger recorded before the proxy read the header " +
      "has no background column to fill, and its calls are judged by message id alone. Both are listed here.",
  );
  lines.push("");
  lines.push("| Attempt | Turn | Calls | Matched | Foreign | Foreign USD | Background | Background USD | No message id |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const listed: string[] = [];
  for (const l of rows) {
    for (const phase of ["A", "B"] as Phase[]) {
      const a = l.record.callAttribution?.[phase];
      if (a === undefined) {
        lines.push(`| ${l.record.attemptId} | ${TURN[phase]} | — | — | — | — | — | — | — |`);
        continue;
      }
      const bg = background(l, phase);
      const bgCells = a.background === undefined ? "no header | —" : `${bg.calls} | ${money(bg.usd)}`;
      lines.push(
        a.available
          ? `| ${l.record.attemptId} | ${TURN[phase]} | ${a.calls} | ${a.matched} | ${a.foreign.length > 0 ? `**${a.foreign.length}**` : "0"} | ` +
              `${money(foreignUsd(l, phase))} | ${bgCells} | ${a.noMessageId} |`
          : `| ${l.record.attemptId} | ${TURN[phase]} | ${a.calls} | — | unavailable: ${a.note ?? "no own session"} | — | — | — | ${a.noMessageId} |`,
      );
      for (const b of a.background ?? []) {
        listed.push(
          `- \`${l.record.attemptId}\` ${TURN[phase]} turn, \`${b.messageId}\` at ${b.ts}, ${b.model ?? "unknown model"}, ${money(b.usd)}: ` +
            `background call in session \`${b.sessionId}\`${b.xApp !== null ? ` (\`x-app: ${b.xApp}\`)` : ""}` +
            `${b.agentId !== null ? `, agent \`${b.agentId.slice(0, 12)}\`` : ", agent unknown"}`,
        );
      }
      for (const f of a.foreign) {
        listed.push(
          `- \`${l.record.attemptId}\` ${TURN[phase]} turn, \`${f.messageId}\` at ${f.ts}, ${f.model ?? "unknown model"}, ${money(f.usd)}: ` +
            (f.belongsTo === "otherSession" ? `made in session \`${f.sessionId}\`, no agent of the attempt's` : "made by no session the rig can see"),
        );
      }
    }
  }
  lines.push("");
  if (listed.length > 0) {
    lines.push(...listed);
    lines.push("");
  }

  if (traycer.length > 0) {
    lines.push("### Traycer agents retired");
    lines.push("");
    lines.push(
      "Once the build settled, every agent in the epic was stopped and then archived, deepest first, and the sender last. " +
        "Depth is below the coordinator, which is 0.",
    );
    lines.push("");
    lines.push("| Attempt | Step | Action | Agent | Depth | Acting as | Result |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const l of traycer) {
      const r = l.record.phases.B?.traycer?.retired;
      if (r === undefined) {
        lines.push(`| ${l.record.attemptId} | — | — | — | — | — | not retired |`);
        continue;
      }
      for (const [i, st] of r.steps.entries()) {
        lines.push(
          `| ${l.record.attemptId} | ${i + 1} | ${st.action} | \`${st.agentId.slice(0, 12)}\` (${st.agent === "child" ? "coordinator" : st.agent}) | ` +
            `${st.depth ?? "—"} | \`${st.actingAs.slice(0, 12)}\` | ${st.ok ? "ok" : `**refused** (${st.detail ?? "no detail"})`}${st.tries > 1 ? `, ${st.tries} tries` : ""} |`,
        );
      }
    }
    lines.push("");
    lines.push("The build turn settles once the coordinator has replied and every agent under it has been idle for two polls in a row.");
    lines.push("");
    lines.push("| Attempt | Settled on | Coordinator's reply | Settled | Polls held open after the reply | Still working at settle |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const l of traycer) {
      const d = l.record.phases.B?.traycer;
      for (const st of d?.settles ?? []) {
        lines.push(
          `| ${l.record.attemptId} | ${st.kind} | ${st.firstReplyAt ?? "—"} | ${st.settledAt} | ${st.pollsHeldOpenAfterReply} | ${(d?.activeAtSettle ?? []).length} |`,
        );
      }
      if ((d?.settles ?? []).length === 0) lines.push(`| ${l.record.attemptId} | ${d?.completedBy ?? "—"} | — | — | — | ${(d?.activeAtSettle ?? []).length} |`);
    }
    lines.push("");
    const busy = traycer.filter((l) => (l.record.phases.B?.traycer?.activeAtSettle ?? []).length > 0);
    if (busy.length > 0) {
      for (const l of busy) {
        lines.push(
          `- \`${l.record.attemptId}\`: the build turn settled on the coordinator's reply while ` +
            `${l.record.phases.B?.traycer?.activeAtSettle?.length} agent(s) under it were still working`,
        );
      }
      lines.push("");
    }
  }
  return lines;
}
