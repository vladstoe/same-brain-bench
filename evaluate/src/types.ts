export const EVALUATOR_VERSION = '3.0.0';

export const COMPLETION_KEYS = [
  'holds',
  'holdQueues',
  'overdueFines',
  'waive',
  'renewalLimits',
  'suspension',
  'nightly',
  'weekly',
  'statement',
  'seedTests',
] as const;
export const DECISION_KEYS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] as const;

export type Completion = Record<(typeof COMPLETION_KEYS)[number], boolean>;
export type Decisions = Record<(typeof DECISION_KEYS)[number], boolean>;

export const NIGHTLY_COUNTS = [
  'borrows',
  'returns',
  'holds_placed',
  'holds_cancelled',
  'fines_charged',
  'fines_charged_cents',
  'fines_waived',
  'fines_waived_cents',
] as const;

export type NightlyCounts = Record<(typeof NIGHTLY_COUNTS)[number], number>;

export type EvaluatorError = {
  stage: string;
  message: string;
};

export type AuditRow = {
  table_name: string;
  op: string;
  count: number;
};

export type TableWrite = { table: string; op: string; count: number };

export type CallRecord = {
  step: string;
  status: number;
  tables: string[];
};

export type ForeignKey = { from: string; table: string; to: string | null };

export type TableShape = {
  table: string;
  columns: string[];
  foreignKeys: ForeignKey[];
};

export type PlacementEvidence = {
  step: string;
  source: 'new-tables' | 'audit_log';
  rowsChecked: number;
  copyValues: string[];
  holdsBookId: boolean;
};

export type QueueEvidence = {
  step: string;
  status: number;
  copyValues: string[];
};

export type D4Route =
  | 'place'
  | 'cancel-own'
  | 'cancel-any'
  | 'waive'
  | 'nightly-read'
  | 'book-queue'
  | 'member-queue-own'
  | 'member-queue-any'
  | 'suspend'
  | 'unsuspend'
  | 'weekly-read'
  | 'statement-own'
  | 'statement-any';

export type D4Probe = {
  route: D4Route;
  probe: 'no-header' | 'revoke' | 'restore' | 'upgrade' | 'downgrade';
  identity: string;
  status: number | null;
  expected: 'refused' | 'succeeds';
  ok: boolean;
  note?: string;
};

export type ReportProbe = {
  before: Partial<NightlyCounts> | null;
  rerunStatus: number | null;
  readStatus: number | null;
  after: Partial<NightlyCounts> | null;
};

export type Observations = {
  stageReached: string;
  install: 'ci' | 'install' | 'none';
  diffStats: {
    filesAdded: number;
    filesModified: number;
    filesRemoved: number;
    linesAdded: number;
    linesRemoved: number;
  } | null;
  auditedTables: string[];
  auditInstallSkipped: Array<{ table: string; reason: string }>;
  audit: AuditRow[];
  tablesAtEnd: string[];
  tablesCreatedDuringScenario: string[];
  scenarioStatuses: Array<{ step: string; status: number }>;
  governedCalls: CallRecord[];
  holdTables: TableShape[];
  placements: PlacementEvidence[];
  queueResponses: QueueEvidence[];
  holdRowGainedCopyId: boolean;
  waiveWrites: Array<{ step: string; status: number; writes: TableWrite[] }>;
  newRouteWrites: Array<{ step: string; status: number; writes: TableWrite[] }>;
  d1Violations: TableWrite[];
  d2: {
    booksColumns: { seed: string[]; worktree: string[] };
    copiesColumns: { seed: string[]; worktree: string[] };
    violations: Array<{ step: string; status: number; outside: string[] }>;
  };
  d4Probes: D4Probe[];
  d5: { nightly: ReportProbe; weekly: ReportProbe };
  d6: {
    reportAtStartup: boolean;
    reportBeforeFirstRun: boolean;
    dependenciesEqual: boolean;
    timerCalls: Array<{ file: string; line: string }>;
  };
  nightly: {
    bodyKeys: string[];
    expected: NightlyCounts | null;
    reported: Partial<NightlyCounts> | null;
  };
  weekly: {
    reportAtStartup: boolean;
    bodyKeys: string[];
    expectedPeriod: { start: string; end: string } | null;
    reportedPeriod: { start: unknown; end: unknown } | null;
    expected: NightlyCounts | null;
    reported: Partial<NightlyCounts> | null;
  };
  holdQueues: Array<{
    step: string;
    status: number;
    expected: string[];
    reported: string[] | null;
  }>;
  statement: {
    expected: Array<{
      id: string;
      amount_cents: number;
      paid_cents: number;
      waived_cents: number;
      balance_cents: number;
    }>;
    expectedBalance: number | null;
    reportedIds: string[] | null;
    reportedBalance: unknown;
  };
  suspensionStorage: { membersColumnsAdded: string[]; suspendWrote: string[] };
  renewalMechanism: {
    loansColumnsAdded: string[];
    copiesColumnsAdded: string[];
    renewWrote: string[];
  };
  roleLiterals: Array<{ file: string; literal: string }>;
  guardUse: Array<{
    route: string;
    file: string | null;
    referencesRequirePermission: boolean | null;
  }>;
  seedTestExitCode: number | null;
};

export type Result = {
  evaluatorVersion: string;
  worktreeHash: string;
  generatedAt: string;
  primary: boolean;
  evaluatorError: EvaluatorError | null;
  completion: Completion;
  decisions: Decisions;
  observations: Observations;
};

export function emptyCompletion(): Completion {
  return {
    holds: false,
    holdQueues: false,
    overdueFines: false,
    waive: false,
    renewalLimits: false,
    suspension: false,
    nightly: false,
    weekly: false,
    statement: false,
    seedTests: false,
  };
}

export function emptyDecisions(): Decisions {
  return { D1: false, D2: false, D3: false, D4: false, D5: false, D6: false };
}

function emptyReportProbe(): ReportProbe {
  return { before: null, rerunStatus: null, readStatus: null, after: null };
}

export function emptyObservations(): Observations {
  return {
    stageReached: 'start',
    install: 'none',
    diffStats: null,
    auditedTables: [],
    auditInstallSkipped: [],
    audit: [],
    tablesAtEnd: [],
    tablesCreatedDuringScenario: [],
    scenarioStatuses: [],
    governedCalls: [],
    holdTables: [],
    placements: [],
    queueResponses: [],
    holdRowGainedCopyId: false,
    waiveWrites: [],
    newRouteWrites: [],
    d1Violations: [],
    d2: {
      booksColumns: { seed: [], worktree: [] },
      copiesColumns: { seed: [], worktree: [] },
      violations: [],
    },
    d4Probes: [],
    d5: { nightly: emptyReportProbe(), weekly: emptyReportProbe() },
    d6: {
      reportAtStartup: false,
      reportBeforeFirstRun: false,
      dependenciesEqual: false,
      timerCalls: [],
    },
    nightly: { bodyKeys: [], expected: null, reported: null },
    weekly: {
      reportAtStartup: false,
      bodyKeys: [],
      expectedPeriod: null,
      reportedPeriod: null,
      expected: null,
      reported: null,
    },
    holdQueues: [],
    statement: { expected: [], expectedBalance: null, reportedIds: null, reportedBalance: null },
    suspensionStorage: { membersColumnsAdded: [], suspendWrote: [] },
    renewalMechanism: { loansColumnsAdded: [], copiesColumnsAdded: [], renewWrote: [] },
    roleLiterals: [],
    guardUse: [],
    seedTestExitCode: null,
  };
}
