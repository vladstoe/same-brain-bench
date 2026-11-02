export type Arm = "C" | "T";
export type Phase = "A" | "B";

export interface PriceTable {
  model: string;
  currency: string;
  unit: string;
  source: string;
  verifiedOn: string | null;
  placeholder?: boolean;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
}

export interface AuthConfig {
  mode: "subscription" | "apiKey";
  allowApiKey: boolean;
  expectedProxyAuthForm: "bearer" | "x-api-key";
  claudeOauthTokenEnvVar: string;
  note?: string;
}

/** One epic per attempt, and the sender agent in it. */
export interface TraycerEpic {
  epic?: string | null;
  sender?: string | null;
}

export interface TraycerConfig {
  cliPath: string;
  epicsRoot: string;
  providerOverridesPath: string;
  providerId: string;
  harness: string;
  maxScriptedReplies: number;
  pollIntervalMs: number;
  artifactSettleMs: number;
  skillPrefixPhaseA: string;
  ticketBreakdownMessage: string;
  smoke: TraycerEpic;
  attempts: Record<string, TraycerEpic>;
  /** Stop and archive each phase's child and sender once the phase settles. Absent means leave them. */
  retireAgents?: boolean;
  /**
   * Keys only arm T's provider override gets, set and cleared with the routing.
   * Absent means none, as before.
   */
  overrideEnv?: Record<string, string>;
  /**
   * The host's agent selection guide. When set, `rig routing set` backs it up and puts
   * the one-line bench guide in its place, and `rig routing clear` restores it.
   */
  selectionGuidePath?: string;
}

/** One turn's limits, per arm, when they differ from the top-level ones. */
export interface PhaseLimits {
  timeoutMs: number;
  maxScriptedReplies: { C: number; T: number };
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface PromptPaths {
  phaseA: string;
  phaseB: string;
  approvalPolicy: string;
}

export interface BenchConfig {
  /** Protocol label, carried into the report so a record names the rules it ran under. */
  protocol?: string;
  prompts: PromptPaths;
  k: number;
  benchRoot: string;
  seedRepoPath: string;
  seedTag: string;
  /** Relative to the rig root. Absent means "evaluate". */
  evaluatorDir?: string;
  evaluatorVersion: string;
  evaluatorCommand: string[];
  apiKeyEnvVar: string;
  auth: AuthConfig;
  phaseTimeoutMs: number;
  maxScriptedReplies: number;
  reconcileTolerance: number;
  /**
   * Reasoning effort, the same for arms C and T. Absent means the rig passes none and
   * each harness uses its own default, which is not the same level in the two arms.
   */
  effort?: EffortLevel;
  /**
   * Match each phase's ledger rows by message id to the phase's own Claude sessions,
   * and leave the rows that match none out of the context-gathering window. Absent
   * means every attributed row counts, as before.
   */
  attributeCalls?: boolean;
  /**
   * Environment keys Claude Code gets in both arms, from one value so the arms cannot
   * drift apart: arm C in its spawn environment, arm T through the provider override
   * that `rig routing set` writes beside ANTHROPIC_BASE_URL. Absent means none.
   */
  harnessEnv?: Record<string, string>;
  /**
   * What phase A sends when the detector finds an approval request. "question" sends
   * the question line instead of the approval line. Absent means each kind gets its
   * own line, in both phases.
   */
  phaseAReply?: "question";
  /** Per-turn timeout and scripted-reply caps. Absent means the top-level ones, for both phases. */
  phaseLimits?: Partial<Record<Phase, PhaseLimits>>;
  claudeBinary?: string;
  model: {
    id: string;
    verified: boolean;
    note?: string;
    armModelRef: Record<string, string>;
  };
  proxy: { host: string; port: number; upstream: string };
  prices: PriceTable;
  traycer: TraycerConfig;
}

export interface Buckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface NormalisedUsage extends Buckets {
  cacheWriteTierAssumed: boolean;
  raw: unknown;
}

export interface LedgerRow {
  ts: string;
  attemptId: string;
  arm: string;
  n: number | null;
  phase: string;
  metered: boolean;
  method: string;
  path: string;
  status: number | null;
  stream: boolean;
  requestId: string | null;
  messageId: string | null;
  model: string | null;
  clientMarker: string;
  retryCount: number | null;
  auth: "x-api-key" | "bearer" | "none";
  /**
   * "unattributed" means the call arrived while no phase was active. Arm T's
   * routing is per-provider, so any Traycer agent on the machine reaches the
   * proxy; these rows are listed but never counted.
   */
  attribution: "attributed" | "unattributed";
  usage: NormalisedUsage | "unknown";
  durationMs: number;
  transportError?: string;
  /** Why a metered row carries no usage, when the reason is known. */
  note?: string;
  /** Claude Code's `X-Claude-Code-Session-Id`; absent on rows recorded before the proxy read it. */
  sessionId?: string | null;
  /** Claude Code's `x-app`: `cli`, or `cli-bg` for its own background requests. */
  xApp?: string | null;
  /** Claude Code's `x-claude-code-agent-id`, which it sends on some requests only. */
  agentId?: string | null;
}

export interface PhaseCost {
  buckets: Buckets;
  calls: number;
  unknownCalls: number;
  usd: number | null;
}

export interface CostReport {
  attemptId: string;
  priced: boolean;
  priceTable: PriceTable;
  unpricedReason: string | null;
  totals: PhaseCost;
  perPhase: Record<string, PhaseCost>;
  retryGroups: { clientMarker: string; rows: number }[];
  unattributed: { calls: number; buckets: Buckets; rows: string[] };
}

export type ScriptedReplyKind = "approval" | "question";

export interface ScriptedReply {
  kind: ScriptedReplyKind;
  sentAt: string;
  triggeringText: string;
  replyText: string;
}

export interface PhaseRecord {
  phase: Phase;
  arm: Arm;
  dryRun: boolean;
  launchedAt: string;
  settledAt: string;
  wallClockMs: number;
  exitCode: number | null;
  timedOut: boolean;
  sessionId: string | null;
  resolvedModelId: string | null;
  turns: number | null;
  nativeUsage: NativeUsage | null;
  nativeParseNote: string | null;
  scriptedReplies: ScriptedReply[];
  unansweredQuestion: boolean;
  harnessCommand: string[];
  transcriptPath: string;
  stderrPath: string;
  infrastructureSignal: InfrastructureSignal | null;
  traycer?: TraycerPhaseDetail;
}

export interface TraycerPhaseDetail {
  epicId: string;
  senderAgentId: string;
  childAgentId: string | null;
  responseIds: string[];
  completedBy: "reply" | "finishedWithoutReply" | "timeout" | "unansweredQuestion";
  idleClassifications: {
    at: string;
    verdict: "question" | "approval" | "finishedWithoutReply";
    transcriptSpan: string;
  }[];
  /** Names only, from turn.started. Absent on a turn means the signed-in profile was used. */
  envCredentialVars: (string | null)[];
  authChannelOk: boolean;
  cascadeStopped: boolean;
  skillLoads: string[];
  /** The Claude Code sessions the child's chat store names as its own, when calls are attributed. */
  claudeSessionIds?: string[];
  /** The phase's agents stopped and archived as the phase settled, when the config asks for it. */
  retired?: RetiredAgents;
  /** v3: the build turn went to the coordinator the plan turn created, rather than a new agent. */
  reusedCoordinator?: boolean;
  /** v3: agents under the coordinator still working when the turn settled. */
  activeAtSettle?: string[];
  /** v3's build turn, one per message sent: the reply, and how many polls the subtree then held the turn open. */
  settles?: {
    kind: "reply" | "idle";
    sentAt: string;
    firstReplyAt: string | null;
    settledAt: string;
    polls: number;
    pollsHeldOpenAfterReply: number;
  }[];
}

/** One stop or archive call, as the Traycer CLI answered it. */
export interface RetireStep {
  /** v3 adds the coordinator's descendants, retired deepest first. */
  agent: "child" | "sender" | "descendant";
  agentId: string;
  action: "stop" | "archive";
  /** The agent the CLI acted as: Traycer refuses to let an agent stop itself. */
  actingAs: string;
  at: string;
  ok: boolean;
  tries: number;
  detail: string | null;
  /** v3: how far below the coordinator the agent sits; the coordinator is 0. */
  depth?: number;
}

export interface RetiredAgents {
  startedAt: string;
  endedAt: string;
  steps: RetireStep[];
  /** Every stop and archive the CLI accepted. */
  allOk: boolean;
}

export interface NativeUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  usd: number | null;
  source: string;
}

export interface InfrastructureSignal {
  kind: "rate_limit" | "auth";
  evidence: string;
  modelTurnCompletedAfter: boolean;
}

export interface ManifestCheck {
  checkedAt: string;
  ok: boolean;
  changed: string[];
  missing: string[];
}

export interface AuditRecord {
  attemptId: string;
  checkedAt: string;
  allowedRoots: string[];
  /** `source` names the agent, or the subagent and its parent, whose transcript made the read (v3). */
  offendingPaths: { phase: Phase; tool: string; path: string; evidence: string; source?: string }[];
  clean: boolean;
}

export type FailureCause =
  | "completion"
  | "decision"
  | "timeout"
  | "planViolation"
  | "unansweredQuestion"
  | "authChannelMismatch";

export interface Classification {
  outcome: "success" | "failure" | "infrastructureExcluded";
  failureCause: FailureCause | null;
  exclusionCause: string | null;
  reason: string;
}

export interface EvaluatorResult {
  completion?: Record<string, boolean>;
  decisions?: Record<string, boolean>;
  existingTests?: boolean;
  [k: string]: unknown;
}

/** Every note surface as the plan turn left it; the rubric reads this copy. */
export interface SnapshotRecord {
  takenAt: string;
  arm: Arm;
  target: string;
  files: { relPath: string; sha256: string; bytes: number; origin: string }[];
  /** True when phase A left no durable note of any kind. */
  wroteNothingDurable: boolean;
  /** Note surfaces that exist but are byte-identical to the seed's, so phase A wrote nothing there. */
  unchangedNoteSurfaces?: string[];
  note: string | null;
}

export interface SeedCloneCheck {
  head: string;
  refs: string[];
  remotes: string[];
  statusClean: boolean;
}

/** Prompt tokens are input plus cache read plus both cache writes. */
export interface HarnessOverhead {
  calls: number;
  unknownCalls: number;
  firstCallPromptTokens: number | null;
  meanPromptTokens: number | null;
  /** Calls attributed to no session of the phase's own agent, left out of both figures. */
  foreignCallsLeftOut?: number;
  /** v3: the attempt's own background calls, which are no turn, left out of both figures. */
  backgroundCallsLeftOut?: number;
}

/** The reasoning effort a phase ran at, read from its own session records. */
export interface PhaseEffort {
  configured: EffortLevel | null;
  /** Every distinct `effort` on the phase's own assistant records. */
  observed: string[];
  records: number;
  /** Null when nothing was configured or no record carried an effort. */
  matchesConfig: boolean | null;
}

/** A ledger row whose message id no session of the phase's own agent carries. */
export interface ForeignCall {
  messageId: string;
  ts: string;
  model: string | null;
  usd: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  /**
   * `otherSession`: another Claude session in the same store carries it, such as a
   * phase-A agent the host resumed. `noSession`: no session the rig can see does.
   */
  belongsTo: "otherSession" | "noSession";
  sessionId: string | null;
}

/**
 * A ledger row no transcript carries whose session header names one of the
 * attempt's own sessions: Claude Code's own side request, such as a prompt
 * suggestion after a turn. It is the attempt's cost but none of its turns.
 */
export interface BackgroundCall {
  messageId: string;
  ts: string;
  model: string | null;
  usd: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  sessionId: string;
  xApp: string | null;
  /** The attempt's agent that owns the session, or the one the agent header names; null when neither is known. */
  agentId: string | null;
}

/** Each of a phase's ledger rows matched by message id to the session that made it. */
export interface CallAttribution {
  /** False when the phase's own session could not be found; nothing is then called foreign. */
  available: boolean;
  note: string | null;
  ownSessionIds: string[];
  /** Where the own session ids came from. */
  ownSessionsFrom: "transcript" | "phaseRecord" | "chatStore" | "none";
  sessions: { sessionId: string; file: string; own: boolean; messageIds: number }[];
  calls: number;
  matched: number;
  /** Rows the proxy recorded no message id for, so they can be matched to nothing and stay counted. */
  noMessageId: number;
  foreign: ForeignCall[];
  /** Present only where the ledger rows carry the session header. */
  background?: BackgroundCall[];
}

export interface AttemptRecord {
  attemptId: string;
  arm: Arm;
  n: number;
  dryRun: boolean;
  createdAt: string;
  benchRoot: string;
  worktree: string;
  seedRepo: string;
  seedTag: string;
  seedCommit: string;
  pinnedModelId: string;
  promptHashes: Record<string, string>;
  seedManifestHash: string;
  phases: Partial<Record<Phase, PhaseRecord>>;
  manifestCheckAfterA: ManifestCheck | null;
  snapshot?: SnapshotRecord | null;
  /** The attempt's own clone, as checked before anything ran in it. */
  seedClone?: SeedCloneCheck | null;
  harnessOverhead?: Partial<Record<Phase, HarnessOverhead>> | null;
  effort?: Partial<Record<Phase, PhaseEffort>> | null;
  callAttribution?: Partial<Record<Phase, CallAttribution>> | null;
  /** v3. Absent on every earlier record. */
  protocol?: string;
  /** v3, arm T: every agent in the attempt's epic but the sender, read once the build turn settled. */
  roster?: RosterEntry[] | null;
  /** v3, arm T: every session in the attempt's Claude project folder that no agent of the roster names. */
  unmappedSessions?: UnmappedSession[] | null;
  /** v3: every agent and subagent the attempt used, with what each ran on and cost. */
  agents?: AgentMeasure[] | null;
  /** v3: whether every agent ran on the pinned model and effort. */
  agentCheck?: AgentCheck | null;
  /** v3: the pinned binary's build and Traycer's current pack, as read when the plan turn launched. */
  launchBuild?: LaunchBuild | null;
  /** v3: every Claude Code version on the attempt's session records, against the pinned one. */
  buildCheck?: BuildCheck | null;
  /** v3: each own session's calls and prompt tokens, per turn. */
  sessionCalls?: SessionCalls[] | null;
  /** v3, arm T: the epic's artifacts as the attempt left them. */
  artifacts?: ArtifactStatus[] | null;
  evaluator: {
    ranAt: string;
    durationMs: number;
    command: string[];
    exitCode: number | null;
    stub: boolean;
    resultPath: string;
  } | null;
  classification: Classification | null;
}

/** v3, arm T. One agent of the attempt's epic, as the host recorded it. */
export interface RosterEntry {
  agentId: string;
  parentId: string | null;
  /** The coordinator is 0, its children 1, and so on; an agent outside its subtree is -1. */
  depth: number;
  title: string;
  harness: string | null;
  configuredModel: string | null;
  configuredEffort: string | null;
  claudeSessionIds: string[];
  /** The host's own final cumulative costUsd for the agent's chat, when it recorded one. */
  nativeUsd: number | null;
  settingsFrom: "chatStore" | "stub" | "none";
}

/**
 * v3, arm T. A session file in the attempt's project folder no agent names. Every
 * session there is the attempt's own, so one with calls is measured and checked as an
 * agent of kind `unmapped`; one with no user or assistant record made no call and is
 * only listed.
 */
export interface UnmappedSession {
  sessionId: string;
  /** The copy kept in the attempt. */
  file: string;
  userRecords: number;
  assistantRecords: number;
  bookkeeping: boolean;
  subagentFiles: number;
}

/** v3. One agent or subagent of the attempt, and the evidence for what it ran on. */
export interface AgentMeasure {
  agentId: string;
  kind: "coordinator" | "child" | "session" | "subagent" | "unmapped";
  parentId: string | null;
  depth: number;
  title: string | null;
  harness: string | null;
  configuredModel: string | null;
  configuredEffort: string | null;
  sessionIds: string[];
  files: string[];
  /** Every distinct `message.model` on the agent's own assistant records. */
  transcriptModels: string[];
  /** Every distinct `effort` on the agent's own assistant records. */
  efforts: string[];
  /** Every distinct model of the ledger calls matched to the agent's records. */
  ledgerModels: string[];
  calls: Partial<Record<Phase, number>>;
  /** Background calls included. */
  usd: number | null;
  /** The background calls the agent owns, counted in `usd` and in no other figure. */
  backgroundCalls?: number;
  backgroundUsd?: number | null;
  /** Why the agent is off the pinned model or effort; empty when it is on them. */
  mismatches: string[];
  /** False when nothing about the agent's model could be read at all. */
  verified: boolean;
}

export interface AgentCheck {
  pinnedModel: string;
  pinnedModelRef: string;
  pinnedEffort: string | null;
  agents: number;
  mismatched: { agentId: string; reasons: string[] }[];
  unverified: string[];
}

export interface LaunchBuild {
  binary: string;
  pinnedVersion: string;
  currentPack: string;
  checkedAt: string;
}

/** v3. Version counts are over records that carry a top-level `version`; records of other kinds carry none. */
export interface BuildCheck {
  pinnedVersion: string | null;
  pinnedFrom: "launch" | "measure";
  agents: {
    agentId: string;
    kind: AgentMeasure["kind"];
    versions: Record<string, number>;
    /** Session or subagent files with no record that carries a version. */
    unversionedFiles: string[];
    /** Files with no user or assistant record at all: they made no call, so carry no build to check. */
    bookkeepingFiles?: string[];
  }[];
  total: Record<string, number>;
  offPin: { agentId: string; reasons: string[] }[];
}

/** v3. One own session's calls in one turn. Prompt tokens are input plus cache read plus both cache writes. */
export interface SessionCalls {
  agentId: string;
  sessionId: string;
  file: string;
  phase: Phase;
  calls: number;
  unknownCalls: number;
  firstCallPromptTokens: number | null;
  meanPromptTokens: number | null;
  usd: number | null;
}

export interface ArtifactStatus {
  relPath: string;
  kind: string | null;
  title: string | null;
  status: number | null;
}
