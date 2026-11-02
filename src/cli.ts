import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  Arm,
  AttemptRecord,
  CostReport,
  EvaluatorResult,
  Phase,
  PhaseRecord,
  PriceTable,
} from "./types.ts";
import { subscriptionCredential, type ArmContext } from "../arms/types.ts";
import { loadConfig, rigRoot, apiKey, evaluatorDir, phaseConfig } from "./config.ts";
import { attemptPaths, scratchPaths, sharedNodeModules, type AttemptPaths } from "./paths.ts";
import {
  buildManifest,
  seedCommit,
  seedNoteHashes,
  verifyManifest,
  type SeedManifest,
} from "./manifest.ts";
import { promptHashes, promptText } from "./prompts.ts";
import { phasePolicy } from "./reply-policy.ts";
import { readLedger, summarise } from "./ledger.ts";
import { reconcile, reconcileAdjustmentsV3 } from "./reconcile.ts";
import { auditTranscripts, carriedState } from "./audit.ts";
import { classify } from "./classify.ts";
import { buildReport, loadAttempts } from "./report.ts";
import { startProxy } from "./proxyctl.ts";
import { readChat, readChatAt, storeUsage, toAuditTranscript, TRAYCER_NATIVE_SOURCE } from "./traycer-store.ts";
import {
  CANARY_TOKEN,
  ancestorInstructionFiles,
  canaryPaths,
  freeChecks,
  missingArmCredential,
  pinnedBuildProblem,
  plantCanary,
  readPinnedBuild,
  readProviderOverrides,
  type Check,
} from "./preflight.ts";
import { DryRunTraycerCli, RealTraycerCli, type DryScenario, type TraycerCli } from "./traycer-cli.ts";
import { runTraycer, type TraycerArmContext } from "../arms/traycer.ts";
import { dryChat } from "../arms/traycer-dryrun.ts";
import { epicFor } from "./traycer-epic.ts";
import { ensureDirs, exists, fail, nowIso, readJson, run, sha256File, walk, writeJson } from "./util.ts";
import { noteSurfaceSources, takeSnapshot, type SnapshotSource } from "./snapshot.ts";
import { runClaude } from "../arms/claude.ts";
import { cloneSeed, writeSeedManifests } from "./seed-clone.ts";
import { writeRouting, routingEnv } from "./routing.ts";
import { depthsBelow, retireEpic } from "./retire.ts";
import { attributeCalls, claudeProjectSlug, leaveOutForeign } from "./sessions.ts";
import type { CallAttribution, LaunchBuild, PhaseEffort, RosterEntry, UnmappedSession } from "./types.ts";
import { closeWindow, equalSetupChecks, openWindow, windowState } from "./equal-setup.ts";
import {
  artifactStatuses,
  attemptAgents,
  collectSessions,
  collectUnmapped,
  harnessOverhead,
  measureAgents,
  phaseSessionsOf,
  auditTranscriptsV3,
  sessionsDir,
  tallyVersions,
  turnEffort,
  unmappedDir,
} from "./v3-measures.ts";
import { chatDbPath, readChatSettingsAt, rosterSessionIds } from "./traycer-store.ts";
import {
  dryChildren,
  dryLedgerFromSessions,
  dryRecords,
  transcriptsUnder,
  writeDryArtifacts,
  writeDrySession,
  withOutsideRead,
  writeDrySubagent,
} from "../arms/dryrun-v3.ts";
import { subagentArchiveDir } from "./sessions.ts";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

const cfg = loadConfig(flagValue("config"));
const dryRun = flags.has("--dry-run");

function parseArm(value: string | undefined): Arm {
  if (value === "C" || value === "T") return value;
  return fail(`arm must be C or T (got ${value ?? "nothing"})`);
}

/** 0 is the unscored live dry run; 1..k are the scored attempts. */
function parseN(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return fail(`attempt number must be 0 or a positive integer`);
  return n;
}

function loadRecord(p: AttemptPaths): AttemptRecord {
  if (!exists(p.record)) fail(`no attempt at ${p.dir} — run \`rig new\` first`);
  return readJson<AttemptRecord>(p.record);
}

/**
 * Both `rig new` and `rig phase-*` can be invoked on their own, so the refusal
 * sits on each rather than on the combined `rig run`.
 */
function assertArmCredential(arm: Arm): void {
  if (dryRun) return;
  const missing = missingArmCredential(cfg, arm);
  if (missing !== null) {
    fail(
      `arm ${arm} cannot run: ${missing} is unset.\n` +
        `  every arm runs on the Claude subscription, and arm ${arm}'s isolated config directory ` +
        "starts signed out.\n  run `rig preflight` for how to obtain it",
    );
  }
}

/**
 * Both arms refuse to start unless the pinned binary and Traycer's current pack are
 * one readable build. Traycer repoints current.json on its own, and every agent it
 * starts afterwards runs the new build while arm C keeps running the pin.
 */
async function assertPinnedBuild(): Promise<LaunchBuild> {
  const build = cfg.claudeBinary === undefined ? null : await readPinnedBuild(cfg.claudeBinary);
  const problem = pinnedBuildProblem(build);
  if (build === null || problem !== null) fail(`refusing to start the attempt: ${problem ?? "no pinned build"}`);
  return { binary: build.binary, pinnedVersion: build.pinnedVersion as string, currentPack: build.current as string, checkedAt: nowIso() };
}

async function cmdNew(arm: Arm, n: number): Promise<AttemptRecord> {
  assertArmCredential(arm);
  const ancestors = ancestorInstructionFiles(cfg.benchRoot);
  if (ancestors.length > 0) {
    fail(
      `bench root ${cfg.benchRoot} has instruction files above it:\n  ${ancestors.join("\n  ")}\n` +
        "move the bench root, or move those files, before creating any attempt",
    );
  }

  const p = attemptPaths(cfg, arm, n);
  if (exists(p.work)) fail(`${p.work} already exists; remove that attempt by hand to redo it`);
  if (arm === "T") epicFor(cfg, n);

  ensureDirs([p.dir, p.transcripts]);
  if (arm === "C") ensureDirs([p.claudeConfig]);

  const commit = await seedCommit(cfg);
  const cloned = await cloneSeed(cfg, p.work, commit);
  if (cloned.problems.length > 0) {
    fail(
      `the clone at ${p.work} is not a clean copy of ${cfg.seedTag}:\n  ${cloned.problems.join("\n  ")}\n` +
        "remove that attempt by hand before trying again",
    );
  }
  const seedClone = cloned.check;

  const shared = sharedNodeModules(cfg);
  if (exists(shared)) {
    fs.symlinkSync(shared, path.join(p.work, "node_modules"), "dir");
  } else {
    console.warn(
      `rig: ${shared} is absent, so the worktree has no node_modules. Run \`rig prepare\` first if the phase needs to build or test.`,
    );
  }

  const manifest = await buildManifest(cfg, p.work);
  writeJson(p.seedManifest, manifest);

  const record: AttemptRecord = {
    attemptId: p.attemptId,
    arm,
    n,
    dryRun,
    protocol: "v3",
    createdAt: nowIso(),
    benchRoot: cfg.benchRoot,
    worktree: p.work,
    seedRepo: cfg.seedRepoPath,
    seedTag: cfg.seedTag,
    seedCommit: commit,
    seedClone,
    pinnedModelId: cfg.model.id,
    promptHashes: promptHashes(cfg),
    seedManifestHash: manifest.manifestHash,
    phases: {},
    manifestCheckAfterA: null,
    evaluator: null,
    classification: null,
  };
  writeJson(p.record, record);
  console.log(`created ${p.dir}`);
  console.log(`  clone         ${p.work} @ ${record.seedCommit.slice(0, 12)}, refs ${seedClone.refs.join(", ")}, no remote`);
  console.log(`  seed manifest ${Object.keys(manifest.files).length} files, ${manifest.manifestHash.slice(0, 16)}`);
  return record;
}

/**
 * Where Traycer keeps the skills its own agents load, beside the epics tree. A skill
 * points the agent at its own reference files, so those reads are the harness, not
 * attempt state.
 */
function traycerSkillsRoot(c: typeof cfg): string {
  return path.join(path.dirname(c.traycer.epicsRoot), ".claude", "skills");
}

/**
 * The planning state for grading, taken after the plan turn. Arm T's epic
 * artifacts, either arm's auto-memory, the note surfaces, and whatever the plan turn
 * added to or changed in the worktree, in both arms. It is a record only: nothing is
 * copied anywhere the build turn reads.
 */
function snapshotSources(
  arm: Arm,
  n: number,
  p: AttemptPaths,
  manifest: SeedManifest,
): { sources: SnapshotSource[]; unchangedNoteSurfaces: string[] } {
  const sources: SnapshotSource[] = [];
  if (arm === "T") {
    const { epicId } = epicFor(cfg, n);
    const root = dryRun ? dryEpicsRoot(n) : cfg.traycer.epicsRoot;
    sources.push({ from: path.join(root, epicId, "artifacts"), relTarget: "artifacts", origin: "epic/artifacts" });
    const memory = path.join(armTClaudeConfigDir(p), "projects", claudeProjectSlug(p.work), "memory");
    if (exists(memory)) sources.push({ from: memory, relTarget: "auto-memory", origin: "autoMemory" });
  }
  const notes = noteSurfaceSources(p.work, seedNoteHashes(manifest));
  sources.push(...notes.sources);
  const tracked = new Set(Object.keys(manifest.files));
  for (const file of walk(p.work)) {
    const rel = path.relative(p.work, file);
    if (rel.startsWith("node_modules") || rel.startsWith(".git")) continue;
    if (rel === "CLAUDE.md" || rel === "AGENTS.md") continue;
    const known = tracked.has(rel);
    if (known && sha256File(file) === manifest.files[rel]) continue;
    sources.push({ from: file, relTarget: path.join("worktree", rel), origin: known ? "changed" : "added" });
  }
  const memory = path.join(p.claudeConfig, "projects");
  if (arm === "C" && exists(memory)) {
    for (const dir of walk(memory, { includeDirs: true })) {
      if (path.basename(dir) === "memory") sources.push({ from: dir, relTarget: "auto-memory", origin: "autoMemory" });
    }
  }
  return { sources, unchangedNoteSurfaces: notes.unchanged };
}

/** Where a dry run keeps arm T's stand-in epics, inside the attempt rather than under ~/.traycer. */
function dryEpicsRoot(n: number): string {
  return path.join(cfg.benchRoot, "runs", "T", String(n), "epics-stub");
}

function scenario(): DryScenario {
  const v = flagValue("scenario") ?? "success";
  if (
    v === "success" ||
    v === "question" ||
    v === "no-reply" ||
    v === "timeout" ||
    v === "reply-question" ||
    v === "approval" ||
    v === "wrong-model" ||
    v === "wrong-build" ||
    v === "plan-violation" ||
    v === "late-child"
  ) {
    return v;
  }
  return fail(
    `--scenario must be success, question, approval, no-reply, timeout, reply-question, wrong-model, wrong-build, plan-violation or late-child (got ${v})`,
  );
}

/** What arm T refuses to start without, live: the routing, no API key, and no other agent at work. */
async function armTRefusals(epicId: string, senderId: string, ownRoot: string | null = null): Promise<RealTraycerCli> {
  const overrides = readProviderOverrides(cfg);
  const subscription = cfg.auth.mode === "subscription";
  if (!overrides.routed) {
    fail(
      `arm T refuses to run: ${overrides.path} does not route ${cfg.traycer.providerId} through the rig proxy` +
        `${overrides.baseUrlMatches ? " with the configured environment" : ""}.\n` +
        `  expected ${Object.entries(routingEnv(cfg)).map(([k, v]) => `${k}=${v}`).join(", ")}\n` +
        "  run `rig routing set` before the attempt and `rig routing clear` after it",
    );
  }
  if (subscription && overrides.apiKeySet && !cfg.auth.allowApiKey) {
    fail(
      `arm T refuses to run: ANTHROPIC_API_KEY is set in ${overrides.path}.\n` +
        "  in subscription mode every arm runs on the signed-in profile; remove that override",
    );
  }
  if (cfg.traycer.selectionGuidePath !== undefined) {
    const state = windowState(cfg);
    if (!state.open || !state.guideIsBench) {
      fail(
        `arm T refuses to run outside the equal-setup window: ${state.open ? "the bench guide is not in place" : "no window is open"}.\n` +
          "  run `rig routing set` before the attempt and `rig routing clear` after it",
      );
    }
  }
  const live = new RealTraycerCli(cfg);
  const listed = await live.list(epicId, senderId);
  // v3's build turn: agents under the plan turn's coordinator are the attempt's own.
  const own = ownRoot === null ? new Map<string, number>() : depthsBelow(listed, ownRoot);
  const others = listed.filter((a) => a.active && a.id !== senderId && (own.get(a.id) ?? -1) < 0);
  if (others.length > 0) {
    fail(
      `arm T refuses to run while other Traycer agents are active: ${others.map((a) => `${a.title} (${a.id})`).join(", ")}.\n` +
        "  routing is per-provider, so their traffic would land in this attempt's ledger",
    );
  }
  return live;
}

/** The stand-in build: the evaluator's reference implementation, applied over what the plan turn left. */
const STAND_IN_PATCH = path.join(rigRoot, "fixtures", "compliant.patch");

/**
 * Arm T. The plan turn creates the coordinator and sends it the planning prompt;
 * the build turn sends the build prompt to that same coordinator, in the same epic.
 * Once the build settles every agent in the epic is read, then retired deepest
 * first, and each agent's Claude sessions are copied into the attempt.
 */
async function runTraycerPhase(base: ArmContext, record: AttemptRecord): Promise<PhaseRecord> {
  const { epicId, senderAgentId } = epicFor(cfg, base.n);
  const coordinatorId = base.phase === "B" ? (record.phases.A?.traycer?.childAgentId ?? null) : null;
  if (base.phase === "B" && coordinatorId === null) {
    fail(`${record.attemptId} has no coordinator from the plan turn to send the build turn to`);
  }

  let cli: TraycerCli;
  let dryCli: DryRunTraycerCli | null = null;
  let readChatOverride: TraycerArmContext["readChatOverride"];
  if (!dryRun) {
    cli = await armTRefusals(epicId, senderAgentId, coordinatorId);
  } else {
    const stand = new DryRunTraycerCli(scenario(), () => "");
    if (coordinatorId !== null) stand.adopt(coordinatorId);
    dryCli = stand;
    cli = stand;
    readChatOverride = async (_epicId, chatId) =>
      dryChat(chatId, scenario(), base.paths.work, process.env["RIG_DRYRUN_AUDIT_DIRTY"] === "1", stand.turn, {
        senderAgentId: stand.senderAgentId,
        responseId: stand.lastResponseId,
        stamps: stand.turnStamps,
        phase: base.phase,
      });
  }

  // The stand-in coordinator's children exist while the build runs, so the settle rule sees them.
  const children = dryCli !== null && base.phase === "B" ? dryChildren(cfg, coordinatorId as string, scenario() === "wrong-model", scenario() === "wrong-build") : [];
  if (dryCli !== null) {
    dryCli.descendants.push(...children.map((c) => c.agent));
    const late = children[0];
    if (scenario() === "late-child" && late !== undefined) dryCli.activeFor.set(late.agent.id, 4);
  }

  const phaseRecord = await runTraycer({
    ...base,
    cli,
    epic: { epicId, senderAgentId },
    ...(base.phase === "B" ? { waitForSubtree: true } : {}),
    ...(coordinatorId !== null ? { coordinatorId } : {}),
    ...(readChatOverride !== undefined ? { readChatOverride } : {}),
  });
  const detail = phaseRecord.traycer as NonNullable<PhaseRecord["traycer"]>;
  const coordinator = detail.childAgentId as string;
  for (const st of detail.settles ?? []) {
    console.log(
      `  settled       on ${st.kind === "reply" ? `the reply of ${st.firstReplyAt ?? "an inbox message"}` : "an idle subtree with no reply"}` +
        `, held open ${st.pollsHeldOpenAfterReply} more poll(s) until every agent under the coordinator was idle`,
    );
  }

  // The dry run's stand-ins for what the host and Claude Code would have written.
  let dryRoster: RosterEntry[] | null = null;
  if (dryCli !== null) {
    const configDir = armTClaudeConfigDir(base.paths);
    const sessionId = record.phases.A?.traycer?.claudeSessionIds?.[0] ?? randomUUID();
    const effort = cfg.effort ?? "high";
    const files = [
      writeDrySession(configDir, base.paths.work, sessionId, dryRecords(`dry_coord_${base.phase}_${sessionId.slice(0, 8)}`, 3, cfg.model.id, effort)),
    ];
    detail.claudeSessionIds = [sessionId];
    writeDryArtifacts(path.join(dryEpicsRoot(base.n), epicId, "artifacts"), base.phase);
    if (base.phase === "A" && scenario() === "plan-violation") {
      fs.appendFileSync(path.join(base.paths.work, "src", "routes", "loans.ts"), "\n// edited during the plan turn\n");
    }
    if (base.phase === "B") {
      // RIG_DRYRUN_AUDIT_DIRTY=child or =subagent puts a read outside the roots in that transcript.
      const dirtyIn = process.env["RIG_DRYRUN_AUDIT_DIRTY"];
      for (const [i, c] of children.entries()) {
        const records = i === 0 && dirtyIn === "child" ? withOutsideRead(c.records) : c.records;
        files.push(writeDrySession(configDir, base.paths.work, c.roster.claudeSessionIds[0] as string, records));
      }
      const first = files[1] as string;
      const subRecords = dryRecords(`dry_sub_${path.basename(first).slice(0, 8)}`, 2, cfg.model.id, effort);
      files.push(
        writeDrySubagent(first, `a${path.basename(first, ".jsonl").slice(0, 8)}`, dirtyIn === "subagent" ? withOutsideRead(subRecords) : subRecords, {
          agentType: "Explore",
          description: "Read the routes",
        }),
      );
      const ref = cfg.model.armModelRef["T"] ?? cfg.model.id;
      dryRoster = [
        {
          agentId: coordinator,
          parentId: senderAgentId,
          depth: 0,
          title: `bench-${base.paths.attemptId}-A`,
          harness: cfg.traycer.harness,
          configuredModel: ref,
          configuredEffort: effort,
          claudeSessionIds: [sessionId],
          nativeUsd: (phaseRecord.nativeUsage?.usd ?? 0) + (record.phases.A?.nativeUsage?.usd ?? 0),
          settingsFrom: "stub",
        },
        ...children.map((c) => ({ ...c.roster, depth: 1 })),
      ];
      if (scenario() === "success" || scenario() === "wrong-model" || scenario() === "wrong-build" || scenario() === "late-child") {
        execFileSync("git", ["-C", base.paths.work, "apply", STAND_IN_PATCH], { stdio: ["ignore", "pipe", "pipe"] });
      }
    }
    dryLedgerFromSessions(cfg, base.paths, base.phase, files, "T", base.n);
  }

  if (base.phase !== "B") return phaseRecord;

  // Read before retirement: the host's list is what names every agent and its parent.
  const listed = (await cli.list(epicId, senderAgentId)).filter((a) => a.id !== senderAgentId);
  if (cfg.traycer.retireAgents === true) {
    const retired = await retireEpic(cli, epicId, senderAgentId, coordinator, { retryMs: dryRun ? 10 : cfg.traycer.pollIntervalMs });
    detail.retired = retired;
    console.log(
      `  retired       ${retired.steps.map((s2) => `${s2.action} ${s2.agentId.slice(0, 8)}${s2.depth !== undefined ? `@${s2.depth}` : " (sender)"} ${s2.ok ? "ok" : `REFUSED (${s2.detail ?? "no detail"})`}`).join(", ")}`,
    );
  }

  const roster = dryRoster ?? (await readRoster(listed, coordinator, epicId, senderAgentId, base.paths));
  record.roster = roster;
  const missing = collectSessions(
    roster.filter((a) => a.depth >= 0),
    armTClaudeConfigDir(base.paths),
    base.paths.work,
    sessionsDir(base.paths),
  );
  if (missing.length > 0) console.warn(`  sessions      not found under the Claude config: ${missing.join(", ")}`);
  record.unmappedSessions = collectUnmapped(roster, armTClaudeConfigDir(base.paths), base.paths.work, unmappedDir(base.paths));
  printUnmapped(record.unmappedSessions);

  const artifactsRoot = path.join(dryRun ? dryEpicsRoot(base.n) : cfg.traycer.epicsRoot, epicId, "artifacts");
  record.artifacts = artifactStatuses(artifactsRoot);
  const finalCopy = path.join(base.paths.dir, "artifacts-final");
  for (const file of exists(artifactsRoot) ? walk(artifactsRoot) : []) {
    const dest = path.join(finalCopy, path.relative(artifactsRoot, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }

  // The host's cost counter is cumulative per chat, so the build's is the coordinator's
  // growth since the plan turn plus every other agent's whole chat.
  const own = roster.filter((a) => a.depth >= 0);
  if (own.every((a) => a.nativeUsd !== null)) {
    const coordinatorUsd = own.find((a) => a.depth === 0)?.nativeUsd ?? 0;
    const others = own.filter((a) => a.depth > 0).reduce((sum, a) => sum + (a.nativeUsd ?? 0), 0);
    phaseRecord.nativeUsage = {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      usd: coordinatorUsd - (record.phases.A?.nativeUsage?.usd ?? 0) + others,
      source: `${TRAYCER_NATIVE_SOURCE}; the coordinator's growth since the plan turn plus ${own.length - 1} other agent(s)`,
    };
  }
  console.log(
    `  agents        ${own.length} in the coordinator's subtree, ${roster.length - own.length} elsewhere in the epic; ` +
      `${record.artifacts.filter((a) => a.kind === "ticket").length} ticket artifact(s)`,
  );
  return phaseRecord;
}

function printUnmapped(unmapped: UnmappedSession[]): void {
  for (const u of unmapped) {
    console.warn(
      `  sessions      ${u.sessionId} is in the attempt's project folder but no agent names it: ` +
        (u.bookkeeping ? "bookkeeping only, no call made, ignored" : `${u.assistantRecords} assistant record(s), counted as the attempt's own`),
    );
  }
}

/**
 * Arm T: each agent's Claude sessions re-read from the chat-store copies the attempt
 * kept, then every session in the attempt's project folder copied in again. For an
 * attempt stored before the roster read the message rows; a session id the run-time
 * roster had is kept even if the copy no longer shows it.
 */
async function cmdRecollect(arm: Arm, n: number): Promise<void> {
  if (arm !== "T") fail("recollect is for arm T only");
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);
  if (record.roster === undefined || record.roster === null) fail(`${p.attemptId} has no roster to re-read`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rig-recollect-"));
  try {
    for (const agent of record.roster) {
      const copy = path.join(p.dir, `chat-${agent.agentId}.db`);
      if (!exists(copy)) continue;
      const found = rosterSessionIds(await readChatAt(copy, agent.agentId, scratch));
      const added = found.filter((id) => !agent.claudeSessionIds.includes(id));
      agent.claudeSessionIds = [...agent.claudeSessionIds, ...added];
      console.log(`  roster        ${agent.agentId.slice(0, 12)} depth ${agent.depth}: ${agent.claudeSessionIds.join(", ") || "no session"}${added.length > 0 ? ` (${added.length} added)` : ""}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const own = record.roster.filter((a) => a.depth >= 0);
  const missing = collectSessions(own, armTClaudeConfigDir(p), p.work, sessionsDir(p));
  if (missing.length > 0) console.warn(`  sessions      not found under the Claude config: ${missing.join(", ")}`);
  record.unmappedSessions = collectUnmapped(record.roster, armTClaudeConfigDir(p), p.work, unmappedDir(p));
  printUnmapped(record.unmappedSessions);
  writeJson(p.record, record);
  console.log(`recollect ${p.attemptId}: ${own.reduce((k, a) => k + a.claudeSessionIds.length, 0)} session(s) named by ${own.length} agent(s), ${record.unmappedSessions.length} unmapped`);
}

/** Every agent the host listed, with what its chat store says it ran on, read through copies kept in the attempt. */
async function readRoster(
  listed: { id: string; parentId: string | null; title: string; harnessId: string }[],
  coordinatorId: string,
  epicId: string,
  senderAgentId: string,
  p: AttemptPaths,
): Promise<RosterEntry[]> {
  const depths = depthsBelow(listed, coordinatorId);
  const db = chatDbPath(cfg, epicId);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rig-roster-"));
  try {
    const out: RosterEntry[] = [];
    for (const a of listed) {
      if (a.id === senderAgentId) continue;
      const chat = await readChat(cfg, epicId, a.id, p.dir);
      const settings = await readChatSettingsAt(db, a.id, scratch);
      out.push({
        agentId: a.id,
        parentId: a.parentId,
        depth: depths.get(a.id) ?? -1,
        title: a.title,
        harness: settings?.harnessId ?? (a.harnessId !== "" ? a.harnessId : null),
        configuredModel: settings?.model ?? null,
        configuredEffort: settings?.reasoningEffort ?? null,
        claudeSessionIds: rosterSessionIds(chat),
        nativeUsd: storeUsage([chat])?.usd ?? null,
        settingsFrom: settings === null ? "none" : "chatStore",
      });
    }
    return out.sort((x, y) => (x.depth === y.depth ? x.agentId.localeCompare(y.agentId) : x.depth - y.depth));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The config directory arm T's children actually write to. Traycer runs Claude Code
 * against the real one; a dry run is pointed at a stub inside the attempt so it
 * never reaches the live config.
 */
function armTClaudeConfigDir(p: AttemptPaths): string {
  if (dryRun) return path.join(p.dir, "claude-config-stub");
  return process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");
}

/**
 * One conversation, two turns. Arm C's build turn resumes the plan turn's session;
 * arm T's goes to the plan turn's coordinator. A dry run's arm C is the stand-in
 * claude, and the proxy's stand-in ledger is built from the sessions it wrote.
 */
async function runPhase(ctx: ArmContext, record: AttemptRecord): Promise<PhaseRecord> {
  if (ctx.arm === "T") return runTraycerPhase(ctx, record);
  const phaseRecord = await runClaude(ctx);
  if (dryRun) {
    dryLedgerFromSessions(
      cfg,
      ctx.paths,
      ctx.phase,
      [phaseRecord.transcriptPath, ...transcriptsUnder(subagentArchiveDir(ctx.paths, ctx.phase))],
      "C",
      ctx.n,
    );
  }
  // The resumed session's cost counter carries the plan turn too.
  const before = record.phases.A?.nativeUsage?.usd;
  const native = phaseRecord.nativeUsage;
  if (ctx.phase === "B" && native !== null && native.usd !== null && typeof before === "number") {
    phaseRecord.nativeUsage = { ...native, usd: native.usd - before, source: `${native.source}; less the plan turn's cost` };
  }
  return phaseRecord;
}

async function cmdPhase(arm: Arm, n: number, phase: Phase): Promise<void> {
  assertArmCredential(arm);
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);
  const key = apiKey(cfg);
  if (!dryRun && cfg.auth.mode === "apiKey" && (key === undefined || key === "")) {
    fail(`${cfg.apiKeyEnvVar} is unset; a live phase cannot run in API-key mode without it`);
  }
  if (!dryRun && cfg.auth.mode === "subscription" && key !== undefined && key !== "" && !cfg.auth.allowApiKey) {
    fail(
      `${cfg.apiKeyEnvVar} is set but auth.mode is "subscription". ` +
        "Unset it, or set auth.allowApiKey: true to run on a key deliberately.",
    );
  }

  if (phase === "B" && record.phases.A === undefined) fail(`${p.attemptId} has no plan turn yet; run phase-a first`);
  if (dryRun && arm === "C" && path.basename(cfg.claudeBinary ?? "claude") !== "stand-in-claude.mjs") {
    fail(`a dry run of arm C runs the stand-in, not ${cfg.claudeBinary ?? "claude"}; set claudeBinary to scripts/stand-in-claude.mjs`);
  }
  if (phase === "A") record.launchBuild = await assertPinnedBuild();

  const proxy = dryRun ? null : await startProxy(cfg, p, arm, n, phase);
  const resumeSessionId = phase === "B" && arm === "C" ? (record.phases.A?.sessionId ?? undefined) : undefined;
  const ctx: ArmContext = {
    cfg: phaseConfig(cfg, phase),
    paths: p,
    arm,
    n,
    phase,
    prompt: promptText(phase, cfg),
    policy: phasePolicy(cfg, phase),
    dryRun,
    proxyBaseUrl: proxy?.baseUrl ?? `http://${cfg.proxy.host}:${cfg.proxy.port}`,
    apiKey: key ?? "",
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
  };

  try {
    const phaseRecord = await runPhase(ctx, record);
    record.phases[phase] = phaseRecord;
    record.dryRun = record.dryRun || dryRun;

    if (phase === "A") {
      const manifest = readJson<SeedManifest>(p.seedManifest);
      const check = verifyManifest(manifest, p.work);
      record.manifestCheckAfterA = check;
      writeJson(p.postAManifest, await buildManifest(cfg, p.work));

      // The rubric is applied to what the plan turn left, copied before the build turn can touch it.
      const found = snapshotSources(arm, n, p, manifest);
      const snapshot = takeSnapshot(arm, p.snapshot, found.sources, found.unchangedNoteSurfaces);
      record.snapshot = snapshot;
      writeJson(p.snapshotRecord, snapshot);
      console.log(
        `  snapshot      ${snapshot.files.length} note file(s) -> ${p.snapshot}` +
          `${snapshot.wroteNothingDurable ? " (wrote nothing durable)" : ""}`,
      );
      console.log(
        `  hash check    ${check.ok ? "clean" : `VIOLATION: ${[...check.changed, ...check.missing].join(", ")}`}`,
      );
    }
    writeJson(p.record, record);
    console.log(
      `phase ${phase} ${arm}-${n}: exit ${phaseRecord.exitCode}, ${phaseRecord.wallClockMs} ms, ` +
        `${phaseRecord.scriptedReplies.length} scripted repl${phaseRecord.scriptedReplies.length === 1 ? "y" : "ies"}` +
        `${phaseRecord.timedOut ? ", TIMED OUT" : ""}`,
    );
  } finally {
    await proxy?.stop();
  }
}

function evaluatorPresent(): boolean {
  const dir = evaluatorDir(cfg);
  return (
    exists(path.join(dir, "package.json")) &&
    exists(path.join(dir, "src", "cli.ts")) &&
    exists(path.join(dir, "node_modules"))
  );
}

async function cmdEvaluate(arm: Arm, n: number): Promise<void> {
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);
  const command = [...cfg.evaluatorCommand, p.work, p.evaluatorOut, "--seed-repo", cfg.seedRepoPath, "--seed-tag", cfg.seedTag];
  const started = Date.now();
  fs.mkdirSync(p.evaluatorOut, { recursive: true });

  if (!evaluatorPresent()) {
    const dirName = path.basename(evaluatorDir(cfg));
    if (!dryRun) {
      fail(
        `the evaluator is not installed under ${dirName}/; run \`npm ci\` there. ` +
          "Re-run with --dry-run to record a stub verdict instead.",
      );
    }
    const stub: EvaluatorResult = {
      stub: true,
      note: `${dirName}/ was absent when this attempt ran; no verdict was produced`,
      completion: { renew: false, cancel: false, availability: false },
      decisions: {},
      existingTests: false,
    };
    writeJson(p.result, stub);
    record.evaluator = {
      ranAt: nowIso(),
      durationMs: Date.now() - started,
      command,
      exitCode: null,
      stub: true,
      resultPath: p.result,
    };
    writeJson(p.record, record);
    console.log(`evaluate ${arm}-${n}: STUB (${dirName}/ absent)`);
    return;
  }

  const head = command[0] as string;
  const res = await run(head, command.slice(1), { cwd: rigRoot, timeoutMs: 15 * 60_000 });
  record.evaluator = {
    ranAt: nowIso(),
    durationMs: res.durationMs,
    command,
    exitCode: res.code,
    stub: false,
    resultPath: p.result,
  };
  writeJson(p.record, record);
  if (res.code !== 0) console.error(res.stderr.trim());
  console.log(`evaluate ${arm}-${n}: exit ${res.code}, ${res.durationMs} ms (not counted as arm speed)`);
}

function cmdLedger(arm: Arm, n: number): void {
  const p = attemptPaths(cfg, arm, n);
  const priceFile = flagValue("prices");
  const table: PriceTable = priceFile !== undefined ? readJson<PriceTable>(priceFile) : cfg.prices;
  const cost = summarise(p.attemptId, readLedger(p.ledger), table);
  writeJson(p.cost, cost);
  console.log(JSON.stringify(cost, null, 2));
}

async function cmdReconcile(arm: Arm, n: number): Promise<void> {
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);
  const cost = exists(p.cost)
    ? readJson<CostReport>(p.cost)
    : summarise(p.attemptId, readLedger(p.ledger), cfg.prices);
  const result = reconcile(record, cost, cfg.reconcileTolerance, reconcileAdjustmentsV3(arm, attemptAgents(cfg, record, p), readLedger(p.ledger), cfg.prices));
  writeJson(p.reconcile, result);
  console.log(JSON.stringify(result, null, 2));
}

/** Takes the plan turn's snapshot for an attempt that has none, as long as the build turn has not run. */
async function cmdSnapshot(arm: Arm, n: number): Promise<void> {
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);
  const previous = record.snapshot ?? null;
  if (previous !== null && previous.files.length > 0) fail(`${p.attemptId} already has a snapshot`);
  const manifest = readJson<SeedManifest>(p.seedManifest);
  if (record.phases.B !== undefined) {
    fail(
      `${p.attemptId} has already run phase B; a snapshot taken now would record phase B's edits as phase A's`,
    );
  }
  const found = snapshotSources(arm, n, p, manifest);
  const fresh = takeSnapshot(arm, p.snapshot, found.sources, found.unchangedNoteSurfaces);
  record.snapshot = fresh;
  writeJson(p.snapshotRecord, fresh);
  writeJson(p.record, record);
  console.log(`snapshot ${p.attemptId}: ${fresh.files.length} file(s) -> ${p.snapshot}`);
}

/**
 * Every agent the attempt used and what each ran on, the per-agent model check,
 * attribution across every agent's sessions, each turn's effort and harness
 * overhead, and each session's calls and prompt tokens per turn.
 */
async function cmdMeasure(arm: Arm, n: number): Promise<void> {
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);
  const rows = readLedger(p.ledger);
  const agents = attemptAgents(cfg, record, p);
  const found = phaseSessionsOf(agents, arm);
  const attributions: Partial<Record<Phase, CallAttribution>> = {};
  for (const phase of ["A", "B"] as Phase[]) {
    if (record.phases[phase] !== undefined) attributions[phase] = attributeCalls(rows, phase, found, cfg.prices);
  }
  const background = (["A", "B"] as Phase[]).flatMap((ph) => attributions[ph]?.background ?? []);
  const measured = measureAgents(cfg, agents, rows, background);
  record.agents = measured.agents;
  record.agentCheck = measured.check;
  const launched = record.launchBuild?.pinnedVersion;
  const pinned = launched ?? (cfg.claudeBinary === undefined ? null : (await readPinnedBuild(cfg.claudeBinary)).pinnedVersion);
  record.buildCheck = tallyVersions(agents, pinned, launched !== undefined ? "launch" : "measure");
  record.sessionCalls = measured.sessionCalls;
  record.callAttribution = {};
  record.effort = {};
  record.harnessOverhead = {};
  for (const phase of ["A", "B"] as Phase[]) {
    const attribution = attributions[phase];
    if (attribution === undefined) continue;
    record.callAttribution[phase] = attribution;
    record.effort[phase] = turnEffort(agents, rows, phase, cfg.effort);
    const overhead = harnessOverhead(leaveOutForeign(rows, attribution, phase), phase);
    overhead.foreignCallsLeftOut = attribution.foreign.length;
    if (attribution.background !== undefined) overhead.backgroundCallsLeftOut = attribution.background.length;
    record.harnessOverhead[phase] = overhead;
  }
  writeJson(p.record, record);

  const check = measured.check;
  console.log(
    `measure ${arm}-${n}: ${measured.agents.length} agent(s), ` +
      `${check.mismatched.length === 0 ? "every one on the pinned model and effort" : `${check.mismatched.length} OFF the pin`}` +
      `${check.unverified.length > 0 ? `, ${check.unverified.length} unverified` : ""}`,
  );
  const builds = record.buildCheck;
  console.log(
    `  claude code   pinned ${builds.pinnedVersion ?? "unread"} (read at ${builds.pinnedFrom}); recorded ` +
      `${Object.entries(builds.total).map(([v, k]) => `${v} x${k}`).join(", ") || "none"}` +
      `${builds.offPin.length === 0 ? "" : `; ${builds.offPin.length} agent(s) OFF the pinned build`}`,
  );
  for (const a of measured.agents) {
    console.log(
      `  ${a.kind.padEnd(12)} ${a.agentId.slice(0, 12).padEnd(12)} depth ${a.depth}, ` +
        `${a.transcriptModels.join(",") || "no model recorded"}, effort ${a.efforts.join(",") || "—"}, ` +
        `calls A ${a.calls.A ?? 0} B ${a.calls.B ?? 0}${a.mismatches.length > 0 ? `; MISMATCH: ${a.mismatches.join("; ")}` : ""}`,
    );
  }
  printSessionFacts({ effort: record.effort, attribution: record.callAttribution });
}

interface SessionMeasures {
  effort: Partial<Record<Phase, PhaseEffort>>;
  attribution: Partial<Record<Phase, CallAttribution>>;
}

function printSessionFacts(facts: SessionMeasures): void {
  for (const phase of ["A", "B"] as Phase[]) {
    const e = facts.effort[phase];
    const a = facts.attribution[phase];
    if (e === undefined || a === undefined) continue;
    console.log(
      `  phase ${phase}       effort ${e.observed.join(", ") || "none recorded"}` +
        `${e.configured === null ? "" : ` (configured ${e.configured}${e.matchesConfig === false ? ", DIFFERS" : ""})`}` +
        `; ${a.available ? `${a.matched} of ${a.calls} call(s) matched, ${a.foreign.length} foreign` : `attribution unavailable: ${a.note ?? ""}`}` +
        `${a.background !== undefined && a.background.length > 0 ? `, ${a.background.length} background` : ""}` +
        `${a.noMessageId > 0 ? `, ${a.noMessageId} without a message id` : ""}`,
    );
    for (const b of a.background ?? []) {
      console.log(
        `    background  ${b.messageId} ${b.ts} ${b.model ?? "?"} ${b.usd === null ? "n/a" : `$${b.usd.toFixed(4)}`}` +
          ` session ${b.sessionId}${b.xApp !== null ? ` ${b.xApp}` : ""}${b.agentId !== null ? ` agent ${b.agentId}` : ""}`,
      );
    }
    for (const f of a.foreign) {
      console.log(
        `    foreign     ${f.messageId} ${f.ts} ${f.model ?? "?"} ${f.usd === null ? "n/a" : `$${f.usd.toFixed(4)}`}` +
          ` ${f.belongsTo}${f.sessionId !== null ? ` ${f.sessionId}` : ""}`,
      );
    }
  }
}

async function cmdAudit(arm: Arm, n: number): Promise<void> {
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);

  let epicA: string | null = null;
  if (arm === "T") {
    // One epic for both turns: the epic is the conversation's own surface.
    const { epicId } = epicFor(cfg, n);
    epicA = path.join(record.dryRun ? dryEpicsRoot(n) : cfg.traycer.epicsRoot, epicId);
  }
  const roots = carriedState(arm, p, {
    epicA,
    sharedNodeModules: sharedNodeModules(cfg),
    realClaudeConfigDir:
      arm === "T" ? (process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude")) : null,
    traycerSkillsRoot: arm === "T" ? traycerSkillsRoot(cfg) : null,
  });
  const result = auditTranscripts(
    p.attemptId,
    { A: roots, B: roots },
    auditTranscriptsV3(cfg, record, p, await agentChats(record, p)),
  );
  writeJson(p.audit, result);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Arm T: each agent's chat but the coordinator's, rebuilt from the store copy the
 * build turn kept, written beside the transcripts so the audit reads a file. The
 * coordinator's chat is already there, one file per turn.
 */
async function agentChats(record: AttemptRecord, p: AttemptPaths): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const agents = (record.roster ?? []).filter((a) => a.depth > 0);
  if (agents.length === 0) return out;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rig-chats-"));
  try {
    for (const a of agents) {
      const copy = path.join(p.dir, `chat-${a.agentId}.db`);
      if (!exists(copy)) continue;
      const chat = await readChatAt(copy, a.agentId, scratch);
      if (!chat.available) continue;
      const file = path.join(p.transcripts, "agents", `${a.agentId}.chat.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, toAuditTranscript(chat));
      out.set(a.agentId, file);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

async function cmdClassify(arm: Arm, n: number): Promise<void> {
  const p = attemptPaths(cfg, arm, n);
  const record = loadRecord(p);
  const result = exists(p.result) ? readJson<EvaluatorResult>(p.result) : null;
  record.classification = classify(record, result);
  writeJson(p.record, record);
  console.log(JSON.stringify(record.classification, null, 2));
}

async function cmdRun(arm: Arm, n: number): Promise<void> {
  await assertPinnedBuild();
  if (!exists(attemptPaths(cfg, arm, n).record)) await cmdNew(arm, n);
  await cmdPhase(arm, n, "A");
  await cmdPhase(arm, n, "B");
  await cmdEvaluate(arm, n);
  cmdLedger(arm, n);
  await cmdReconcile(arm, n);
  await cmdMeasure(arm, n);
  await cmdAudit(arm, n);
  await cmdClassify(arm, n);
}

async function cmdBatch(): Promise<void> {
  const k = Number(flagValue("k") ?? cfg.k);
  const arms = (flagValue("arms") ?? "C,T").split(",").map((a) => parseArm(a.trim()));
  const schedule: { arm: Arm; n: number }[] = [];
  // Never n = 0: that is the unscored live dry run, run by hand.
  for (let n = 1; n <= k; n++) for (const arm of arms) schedule.push({ arm, n });

  const schedulePath = path.join(cfg.benchRoot, "schedule.json");
  writeJson(schedulePath, { createdAt: nowIso(), dryRun, k, arms, schedule });
  console.log(`schedule: ${schedule.map((s) => `${s.arm}${s.n}`).join(", ")} -> ${schedulePath}`);

  for (const item of schedule) {
    console.log(`\n=== ${item.arm}-${item.n} ===`);
    await cmdRun(item.arm, item.n);
  }
}

function cmdReport(): void {
  const loaded = loadAttempts(cfg);
  const markdown = buildReport(cfg, loaded);
  const out = flagValue("out") ?? path.join(cfg.benchRoot, "report.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, markdown);
  console.log(markdown);
  console.error(`\nwritten to ${out}`);
}

async function cmdPrepare(): Promise<void> {
  const shared = sharedNodeModules(cfg);
  if (exists(shared)) {
    console.log(`${shared} already exists`);
    return;
  }
  const scratch = path.join(cfg.benchRoot, "shared", "install");
  fs.mkdirSync(scratch, { recursive: true });
  // From the tag, so the seed repository's own checkout is never what gets installed.
  await writeSeedManifests(cfg, scratch);
  const res = await run("npm", ["ci"], { cwd: scratch, timeoutMs: 10 * 60_000 });
  if (res.code !== 0) fail(`npm ci failed: ${res.stderr.trim()}`);
  fs.renameSync(path.join(scratch, "node_modules"), shared);
  console.log(`installed ${shared}`);
}

function printChecks(checks: Check[]): boolean {
  let ok = true;
  for (const c of checks) {
    const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", ready: "READY" }[c.status];
    if (c.status === "fail") ok = false;
    console.log(`  [${mark.padEnd(5)}] ${c.name} — ${c.detail}`);
  }
  return ok;
}

async function cmdPreflight(): Promise<void> {
  console.log("preflight — free checks");
  const ok = printChecks([...(await freeChecks(cfg)), ...equalSetupChecks(cfg)]);

  // Free verification of the ancestor guard: plant it, then ask the very function
  // `rig new` asks. No model call, so it is not gated behind --probes.
  if (flags.has("--canaries")) {
    const planted = plantCanary(cfg, "ancestor");
    if (planted.refused !== null) {
      fail(
        `refusing to overwrite an existing file: ${planted.refused}\n` +
          "move it aside by hand; the rig never deletes outside the bench root's runs/",
      );
    }
    console.log(`\npreflight — ancestor canary (no model call)`);
    console.log(`  planted ${planted.written}`);
    const seen = ancestorInstructionFiles(cfg.benchRoot);
    const caught = planted.written !== null && seen.includes(planted.written);
    // A number no real batch uses, so that if the guard ever failed to fire the
    // stray attempt could not collide with a scored one.
    const newRefuses = await run(path.join(rigRoot, "bin", "rig"), [
      "new",
      "C",
      "99",
      ...(flagValue("config") !== undefined ? ["--config", flagValue("config") as string] : []),
    ]).catch(() => null);
    printChecks([
      {
        name: "ancestor check sees the planted canary",
        status: caught ? "pass" : "fail",
        detail: caught ? `${planted.written} is above ${cfg.benchRoot}` : `not seen: ${seen.join(", ") || "none"}`,
      },
      {
        name: "`rig new` refuses while it is there",
        // The message must be the ancestor refusal specifically: any non-zero exit
        // would otherwise pass, including one from a broken invocation.
        status:
          newRefuses !== null &&
          newRefuses.code !== 0 &&
          newRefuses.stderr.includes("has instruction files above it")
            ? "pass"
            : "fail",
        detail:
          newRefuses === null
            ? "could not run `rig new`"
            : newRefuses.stderr.includes("has instruction files above it")
              ? (newRefuses.stderr.trim().split("\n")[0] ?? "refused")
              : `expected the ancestor refusal, got exit ${newRefuses.code}: ` +
                `${(newRefuses.stderr.trim().split("\n")[0] ?? newRefuses.stdout.trim().split("\n")[0] ?? "").slice(0, 120)}`,
      },
    ]);
    console.log("\nRemove it by hand — the rig never deletes outside the bench root's runs/:");
    console.log(`  rm ${planted.written}`);
    process.exit(caught ? 0 : 1);
  }

  if (!flags.has("--probes")) {
    console.log("\npreflight — paid probes (NOT RUN)");
    console.log(
      "  [READY] one-token probe per harness through the proxy, canary invisibility, ledger row with usage and request id",
    );
    console.log("  re-run with --probes once the spend is authorised.");
    process.exit(ok ? 0 : 1);
  }

  if (!ok) fail("free checks failed; not spending money on probes");

  // Only the real-config canary. The ancestor one would be read legitimately from
  // any parent of the working directory, so its echo proves nothing; `rig preflight
  // --canaries` checks that guard for free instead.
  const planted = plantCanary(cfg, "realConfig");
  if (planted.refused !== null) {
    fail(
      `refusing to overwrite an existing file: ${planted.refused}\n` +
        "move it aside by hand; the rig never deletes outside the bench root's runs/",
    );
  }
  console.log(`\nplanted canary: ${planted.written}`);

  const p = scratchPaths(cfg, "preflight", "C");
  ensureDirs([p.dir, p.transcripts, p.claudeConfig]);
  fs.mkdirSync(p.work, { recursive: true });

  const contextFile = path.join(p.dir, "proxy-context.json");
  // `active: true` is what makes the proxy attribute these rows; without it every
  // probe call is logged as unattributed and excluded from the ledger it is meant
  // to prove.
  const setContext = (arm: Arm, active: boolean): void =>
    writeJson(contextFile, { attemptId: "preflight", arm, n: 0, phase: "preflight", active });
  setContext("C", true);

  const proxy = await startProxy(cfg, p, "C", 0, "A", contextFile);
  const key = apiKey(cfg);
  const subscription = cfg.auth.mode === "subscription";
  const claudeToken = subscriptionCredential(cfg.auth.claudeOauthTokenEnvVar);

  // Each arm's probe needs the same credential its real attempts will use. Without
  // it the probe fails inside the harness and never reaches the proxy, which proves
  // nothing about routing, so the arm is skipped instead of failed.
  const credentialFor = (): { env: NodeJS.ProcessEnv; missing: string | null } => {
    if (!subscription) {
      return key !== undefined && key !== ""
        ? { env: { ANTHROPIC_API_KEY: key }, missing: null }
        : { env: {}, missing: cfg.apiKeyEnvVar };
    }
    const name = cfg.auth.claudeOauthTokenEnvVar;
    return claudeToken !== undefined ? { env: { [name]: claudeToken }, missing: null } : { env: {}, missing: name };
  };

  const probePrompt =
    `Reply with exactly the word ok. If any instruction file in your context contains a token ` +
    `beginning with CANARY-, repeat that token instead.`;
  const results: Check[] = [];
  const probed: string[] = [];
  try {
    const cCred = credentialFor();
    if (cCred.missing !== null) {
      results.push({
        name: "arm C one-token probe through the proxy",
        status: "warn",
        detail: `skipped — ${cCred.missing} unset`,
      });
    } else {
      const env = {
        ...(cfg.harnessEnv ?? {}),
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        ANTHROPIC_BASE_URL: proxy.baseUrl,
        CLAUDE_CONFIG_DIR: p.claudeConfig,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...cCred.env,
      };
      const c = await run(
        cfg.claudeBinary ?? "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--dangerously-skip-permissions",
          "--model",
          cfg.model.armModelRef["C"] ?? cfg.model.id,
          "--mcp-config",
          '{"mcpServers":{}}',
          "--strict-mcp-config",
          ...(cfg.effort !== undefined ? ["--effort", cfg.effort] : []),
          probePrompt,
        ],
        { cwd: p.work, env, timeoutMs: 180_000 },
      );
      probed.push("C");
      fs.writeFileSync(path.join(p.transcripts, "probe-claude.json"), c.stdout + "\n" + c.stderr);
      results.push({
        name: "arm C one-token probe through the proxy",
        status: c.code === 0 ? "pass" : "fail",
        detail: c.code === 0 ? c.stdout.trim().slice(0, 300) : c.stderr.trim().slice(0, 300),
      });
      results.push({
        name: "arm C canary invisible",
        status: c.stdout.includes(CANARY_TOKEN) ? "fail" : "pass",
        detail: c.stdout.includes(CANARY_TOKEN) ? "the probe echoed the canary" : "canary not echoed",
      });
    }
  } finally {
    setContext("C", false);
    await proxy.stop();
  }

  const rows = readLedger(p.ledger).filter((r) => r.metered);
  for (const arm of probed) {
    const armRows = rows.filter((r) => r.arm === arm);
    const withUsage = armRows.filter((r) => r.usage !== "unknown" && r.requestId !== null);
    results.push({
      name: `ledger row with usage and request id for arm ${arm}`,
      status: withUsage.length > 0 ? "pass" : "fail",
      detail: `${armRows.length} metered row(s), ${withUsage.length} with usage and a request id`,
    });
  }
  const models = [...new Set(rows.map((r) => r.model).filter((m): m is string => m !== null))];
  results.push({
    name: `pinned model id accepted by the probed harnesses (${probed.join(", ") || "none"})`,
    status: probed.length === 0 ? "warn" : models.length > 0 ? "pass" : "fail",
    detail:
      probed.length === 0
        ? "no arm was probed"
        : `resolved ids seen on the wire: ${models.join(", ") || "none"}`,
  });
  const auths = [...new Set(rows.map((r) => r.auth))];
  results.push({
    name: "one authentication path",
    status: auths.length === 1 && auths[0] === cfg.auth.expectedProxyAuthForm ? "pass" : "warn",
    detail: `expected ${cfg.auth.expectedProxyAuthForm}; auth header forms seen: ${auths.join(", ") || "none"}`,
  });

  console.log("\npreflight — paid probes");
  const probesOk = printChecks(results);

  const canaries = canaryPaths(cfg);
  console.log("\nRemove the canary by hand — the rig never deletes outside the bench root's runs/:");
  console.log(`  rm ${canaries.realClaudeMd}`);
  process.exit(probesOk ? 0 : 1);
}

function cmdOverridesCheck(): void {
  const o = readProviderOverrides(cfg);
  const expected = `http://${cfg.proxy.host}:${cfg.proxy.port}`;
  console.log(`provider overrides for ${cfg.traycer.providerId}`);
  console.log(`  file          ${o.path}`);
  console.log(`  keys present  ${o.keys.length > 0 ? o.keys.join(", ") : "(none)"}`);
  console.log(`  base url      ${o.baseUrl ?? "(unset)"}  expected ${expected}`);
  for (const e of o.harnessEnv) {
    console.log(`  ${e.key.padEnd(13)} ${e.actual ?? "(unset)"}  expected ${e.expected}${e.matches ? "" : "  MISMATCH"}`);
  }
  const subscription = cfg.auth.mode === "subscription";
  console.log(
    `  api key       ${o.apiKeySet ? "SET" : "(unset)"}` +
      (subscription ? `  expected unset in subscription mode` : ""),
  );
  if (o.note !== null) console.log(`  note          ${o.note}`);
  console.log("");
  if (subscription && o.apiKeySet && !cfg.auth.allowApiKey) {
    console.log("MISCONFIGURED — ANTHROPIC_API_KEY is set in the override.");
    console.log("In subscription mode every arm runs on the signed-in profile; remove that key");
    console.log("in the Traycer GUI. Arm T refuses to start while it is there.");
  } else if (o.routed) {
    console.log("ROUTED — arm T traffic reaches the rig proxy.");
    console.log("Every Traycer claude agent on this machine is routed while this is set.");
    console.log("Run `rig routing clear` once the arm-T attempt is done.");
  } else if (o.baseUrlMatches) {
    console.log("PARTLY ROUTED — the base URL is set but a configured key is not; arm T will refuse to start.");
    console.log("Run `rig routing set` to write every configured key.");
  } else {
    console.log("NOT ROUTED — arm T will refuse to start. Arm C is unaffected.");
  }
}

/**
 * Sets or clears arm T's routing: the base URL and the config's extra keys in the
 * provider override, nothing else. Setting it routes every Traycer claude agent on
 * the machine, so it is set only around an arm-T attempt.
 */
function cmdRouting(mode: string | undefined): void {
  if (mode !== "set" && mode !== "clear") fail("usage: rig routing set|clear");
  if (cfg.traycer.selectionGuidePath !== undefined) {
    cmdEqualSetup(mode);
    return;
  }
  const written = writeRouting(cfg, mode);
  console.log(
    `routing ${mode}: ${Object.entries(written.keys)
      .map(([k, v]) => (v === null ? `${k} removed` : `${k}=${v}`))
      .join(", ")} (${written.form} form) -> ${written.path}`,
  );
}

/**
 * v3: the routing window covers every equal-setup switch. `set` backs up the
 * selection guide and puts the bench guide in its place, then writes the override;
 * `clear` restores the guide byte for byte and removes every key the window wrote.
 */
function cmdEqualSetup(mode: "set" | "clear"): void {
  try {
    if (mode === "set") {
      const opened = openWindow(cfg);
      console.log(
        `routing set: ${Object.entries(opened.routing.keys).map(([k, v]) => `${k}=${v}`).join(", ")} ` +
          `(${opened.routing.form} form) -> ${opened.routing.path}`,
      );
      console.log(
        `  selection guide backed up (sha256 ${opened.record.originalSha256}, ${opened.record.originalBytes} bytes); ` +
          `bench guide written to ${opened.record.guidePath}`,
      );
      return;
    }
    const closed = closeWindow(cfg);
    console.log(
      `routing clear: ${Object.keys(closed.routing.keys).map((k) => `${k} removed`).join(", ")} ` +
        `(${closed.routing.form} form) -> ${closed.routing.path}`,
    );
    console.log(
      closed.restored === null
        ? "  selection guide: no window was open, nothing to restore"
        : `  selection guide restored to ${closed.restored.guidePath}, sha256 ${closed.restored.sha256} verified`,
    );
  } catch (err) {
    fail(`routing ${mode} refused: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function usage(): void {
  console.log(`rig — same-brain bench runner, protocol v3

  rig preflight [--probes]        free checks; --probes adds the paid one-token probe
  rig prepare                     install the shared node_modules from the seed lockfile
  rig new <arm> <n>               clone of the seed tag, isolated dirs, seed hash manifest
  rig phase-a <arm> <n>           run the plan turn, verify hashes, snapshot what it left
  rig phase-b <arm> <n>           run the build turn in the same conversation
  rig evaluate <arm> <n>          run the external evaluator, store result.json
  rig audit <arm> <n>             transcript read audit, store audit.json
  rig measure <arm> <n>           every agent and what it ran on, the per-agent pin check,
                                  call attribution, each turn's effort and harness overhead
  rig snapshot <arm> <n>          take the plan turn's snapshot if the attempt has none
  rig ledger <arm> <n>            price the proxy ledger, store cost.json
  rig reconcile <arm> <n>         native counters vs the ledger, store reconcile.json
  rig classify <arm> <n>          outcome classification
  rig run <arm> <n>               new + both turns + evaluate + ledger + reconcile + measure + audit + classify
  rig batch [--k N] [--arms C,T]  interleaved schedule, one attempt at a time
  rig report [--out FILE]         aggregate every attempt into report.md
  rig overrides-check             is arm T routed through the rig proxy right now?
  rig routing set|clear           write or remove arm T's routing keys in the provider overrides,
                                  and swap in the bench selection guide, or restore it
  rig recollect T <n>             re-read each agent's Claude sessions from the attempt's chat-store
                                  copies and copy in every session of its project folder

  --dry-run          stub the harness calls; no model traffic
  --scenario NAME    arm T dry runs: success | question | approval | no-reply | timeout | reply-question |
                     wrong-model | wrong-build | plan-violation | late-child
  --config FILE      alternative bench config
  --prices FILE      alternative price table for \`rig ledger\`
`);
}

const command = positional[0];
switch (command) {
  case "preflight":
    await cmdPreflight();
    break;
  case "prepare":
    await cmdPrepare();
    break;
  case "new":
    await cmdNew(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "phase-a":
    await cmdPhase(parseArm(positional[1]), parseN(positional[2]), "A");
    break;
  case "phase-b":
    await cmdPhase(parseArm(positional[1]), parseN(positional[2]), "B");
    break;
  case "evaluate":
    await cmdEvaluate(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "audit":
    await cmdAudit(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "measure":
    await cmdMeasure(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "snapshot":
    await cmdSnapshot(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "ledger":
    cmdLedger(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "reconcile":
    await cmdReconcile(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "classify":
    await cmdClassify(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "run":
    await cmdRun(parseArm(positional[1]), parseN(positional[2]));
    break;
  case "batch":
    await cmdBatch();
    break;
  case "report":
    cmdReport();
    break;
  case "overrides-check":
    cmdOverridesCheck();
    break;
  case "routing":
    cmdRouting(positional[1]);
    break;
  case "recollect":
    await cmdRecollect(parseArm(positional[1]), parseN(positional[2]));
    break;
  default:
    usage();
    process.exit(command === undefined ? 0 : 1);
}
