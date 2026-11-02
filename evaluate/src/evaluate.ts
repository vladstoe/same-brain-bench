import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  auditBetween,
  auditSummary,
  clearAudit,
  columnsOf,
  foreignKeysOf,
  installAudit,
  lastSeq,
  listUserTables,
  readRow,
  summariseWrites,
  WriteTracker,
  type Db,
  type RowId,
  type Write,
} from './audit.js';
import {
  barcode,
  BOOK,
  COPY,
  FINE,
  FINE_AMOUNT,
  HELD_COPIES,
  insertCastAndHistory,
  insertUnauditedActivity,
  LOAN,
  MEMBER,
  OVERDUE_FINE_CENTS,
  PART_PAYMENT_CENTS,
  STATEMENT_FINES,
  STATEMENT_MEMBER,
  UNKNOWN_HOLD,
  UNKNOWN_MEMBER,
  WEEKLY_HISTORY,
} from './cast.js';
import { asObject, bodyKeys, Client, isRefused, isSuccess, type Probe } from './http.js';
import { run, sleep } from './proc.js';
import { exportSeedTag, readDependencies, sameDependencies, seedSchema } from './seed-ref.js';
import { startServer, tail, type RunningServer, type ServerStart } from './server.js';
import { addedSourceLines, observeGuardUse, roleLiterals, timerCalls } from './structural.js';
import {
  emptyCompletion,
  emptyDecisions,
  emptyObservations,
  EVALUATOR_VERSION,
  NIGHTLY_COUNTS,
  type D4Probe,
  type D4Route,
  type NightlyCounts,
  type PlacementEvidence,
  type ReportProbe,
  type Result,
} from './types.js';
import { copyWorktree, diffStats, hashWorktree } from './workspace.js';

export type EvaluateOptions = {
  worktree: string;
  outDir: string;
  seedRepo: string;
  seedTag: string;
  keepTemp?: boolean;
  log?: (message: string) => void;
};

class StageError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message);
  }
}

type Governed = 'borrow' | 'renew' | 'return' | 'return-overdue' | 'place' | 'cancel' | 'waive';
type NewRoute = 'suspend' | 'queue' | 'statement' | 'weekly';

type CallLog = {
  step: string;
  kind: Governed | null;
  route: NewRoute | null;
  status: number;
  writes: Write[];
};

type CallOptions = { kind?: Governed; route?: NewRoute; body?: unknown };

type Snapshot = { table: string; rowId: RowId; row: Record<string, unknown> };

type HoldModel = { id: string; book: number; member: number; active: boolean };

type FineState = { amount: number; paid: number; waived: number };

type ExpectedFine = {
  id: string;
  amount_cents: number;
  paid_cents: number;
  waived_cents: number;
  balance_cents: number;
};

const NIGHTLY_KIND = 'nightly-reconcile';
const WEEKLY_KIND = 'weekly-summary';
const MIDNIGHT_MARGIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function evaluate(options: EvaluateOptions): Promise<Result> {
  const log = options.log ?? (() => {});
  const observations = emptyObservations();
  const completion = emptyCompletion();
  const decisions = emptyDecisions();
  const timings: Record<string, number> = {};
  const started = Date.now();

  const temp = mkdtempSync(join(tmpdir(), 'cold-handoff-eval-v3-'));
  const work = join(temp, 'work');
  const seedExport = join(temp, 'seed');
  const databasePath = join(temp, 'library.db');
  const transcript: Array<Probe & { step: string }> = [];

  let db: Db | null = null;
  let server: RunningServer | null = null;
  let serverStarts: ServerStart[] = [];
  let worktreeHash = 'sha256:unknown';
  let evaluatorError: Result['evaluatorError'] = null;

  const stage = (name: string): void => {
    observations.stageReached = name;
    timings[name] = Date.now() - started;
  };

  try {
    stage('copy');
    log('copying worktree');
    copyWorktree(options.worktree, work);
    worktreeHash = hashWorktree(work);

    stage('seed-export');
    await exportSeedTag(options.seedRepo, options.seedTag, seedExport);
    const seed = seedSchema(seedExport, join(temp, 'seed-schema.db'));
    observations.diffStats = await diffStats(seedExport, work);
    const added = await addedSourceLines(temp, 'seed', 'work');
    observations.d6.timerCalls = timerCalls(added);
    observations.d6.dependenciesEqual = sameDependencies(
      readDependencies(seedExport),
      readDependencies(work),
    );
    observations.roleLiterals = roleLiterals(added);
    observations.guardUse = observeGuardUse(work);
    observations.d2.booksColumns.seed = seed.booksColumns;
    observations.d2.copiesColumns.seed = seed.copiesColumns;

    stage('install');
    log('npm ci');
    const ci = await run('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: work,
      timeoutMs: 600_000,
    });
    if (ci.code === 0) {
      observations.install = 'ci';
    } else {
      log('npm ci failed, falling back to npm install');
      const install = await run('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: work,
        timeoutMs: 600_000,
      });
      if (install.code !== 0) {
        throw new StageError(
          'install',
          `npm ci and npm install both failed:\n${tail(ci.stderr)}\n---\n${tail(install.stderr)}`,
        );
      }
      observations.install = 'install';
    }

    stage('db-init');
    log('npm run db:init');
    const init = await run('npm', ['run', 'db:init'], {
      cwd: work,
      env: { DATABASE_PATH: databasePath },
      timeoutMs: 120_000,
    });
    if (init.code !== 0) {
      throw new StageError(
        'db-init',
        `db:init failed:\n${tail(init.stdout)}\n${tail(init.stderr)}`,
      );
    }

    stage('audit-install');
    db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    installAudit(db);

    stage('seed-history');
    insertCastAndHistory(db, Date.now());

    stage('server-start');
    log('starting server');
    server = await startServer(work, databasePath);
    serverStarts = server.starts;
    installAudit(db);
    await sleep(2000);
    observations.d6.reportAtStartup = reportCount(db, NIGHTLY_KIND) > 0;
    observations.weekly.reportAtStartup = reportCount(db, WEEKLY_KIND) > 0;
    const installed = installAudit(db);
    observations.auditedTables = installed.audited;
    observations.auditInstallSkipped = installed.skipped;
    clearAudit(db);

    stage('midnight-wait');
    await waitClearOfMidnight(log);

    stage('scenario');
    log('running the scenario');
    const connection = db;
    const client = new Client(server.baseUrl);
    const tracker = new WriteTracker(connection);
    const scenarioStart = lastSeq(connection);
    const calls: CallLog[] = [];
    const placementSnapshots: Array<{
      step: string;
      rows: Snapshot[];
      source: PlacementEvidence['source'];
    }> = [];
    const seedTables = new Set(seed.tables);

    const send = async (
      step: string,
      method: string,
      path: string,
      actor: number | null,
      body?: unknown,
    ): Promise<Probe> => {
      const probe = await client.request(method, path, actor, body);
      transcript.push({ step, ...probe });
      return probe;
    };

    const call = async (
      step: string,
      method: string,
      path: string,
      actor: number | null,
      opts: CallOptions = {},
    ): Promise<Probe> => {
      const before = tracker.mark();
      const probe = await send(step, method, path, actor, opts.body);
      const { writes } = tracker.capture(before);
      calls.push({
        step,
        kind: opts.kind ?? null,
        route: opts.route ?? null,
        status: probe.status,
        writes,
      });
      observations.scenarioStatuses.push({ step, status: probe.status });
      if (opts.kind === 'place' && isSuccess(probe.status)) {
        placementSnapshots.push({ step, ...snapshotPlacement(connection, writes, seedTables) });
      }
      return probe;
    };

    const finesOf = async (step: string, memberId: number): Promise<FineView[] | null> => {
      const probe = await call(step, 'GET', `/members/${memberId}/fines`, MEMBER.clerk);
      return finesFrom(probe);
    };

    const loanOf = (step: string, loanId: number | string | null): Promise<Probe> =>
      call(step, 'GET', `/loans/${pathId(loanId)}`, MEMBER.clerk);

    const holdModel: HoldModel[] = [];
    const placeHold = async (step: string, book: number, actor: number): Promise<Probe> => {
      const probe = await call(step, 'POST', `/books/${book}/holds`, actor, { kind: 'place' });
      const id = idOf(probe.body);
      if (isSuccess(probe.status) && id !== null) {
        holdModel.push({ id: String(id), book, member: actor, active: true });
      }
      return probe;
    };
    const cancelHold = async (
      step: string,
      hold: number | string | null,
      actor: number,
    ): Promise<Probe> => {
      const probe = await call(step, 'POST', `/holds/${pathId(hold)}/cancel`, actor, {
        kind: 'cancel',
      });
      if (isSuccess(probe.status)) {
        const entry = holdModel.find((candidate) => candidate.id === String(hold));
        if (entry) entry.active = false;
      }
      return probe;
    };

    const fineState = new Map<string, FineState>();
    for (const [id, amount] of Object.entries(FINE_AMOUNT)) {
      fineState.set(id, { amount, paid: 0, waived: 0 });
    }
    const owedOn = (id: number | string): number => {
      const state = fineState.get(String(id));
      return state === undefined ? 0 : Math.max(0, state.amount - state.paid - state.waived);
    };
    const charged: Array<FineView & { member: number }> = [];
    const waived: number[] = [];

    // Holds.
    const held = BOOK.held;
    const place1 = await placeHold('hold-p1', held, MEMBER.p1);
    const hold1 = idOf(place1.body);
    const placeDuplicate = await placeHold('hold-p1-again', held, MEMBER.p1);
    const placeUnknown = await placeHold('hold-unknown-book', BOOK.unknown, MEMBER.p1);
    const place2 = await placeHold('hold-p2', held, MEMBER.p2);
    const hold2 = idOf(place2.body);
    const cancelOwn = await cancelHold('cancel-own', hold1, MEMBER.p1);
    const cancelOwnAgain = await cancelHold('cancel-own-again', hold1, MEMBER.p1);
    const cancelOthersAsPatron = await cancelHold('cancel-others-as-patron', hold2, MEMBER.p1);
    const cancelOthersAsLibrarian = await cancelHold(
      'cancel-others-as-librarian',
      hold2,
      MEMBER.librarian,
    );
    const cancelUnknown = await cancelHold('cancel-unknown-hold', UNKNOWN_HOLD, MEMBER.librarian);
    const place3 = await placeHold('hold-p1-new', held, MEMBER.p1);
    const hold3 = idOf(place3.body);

    completion.holds =
      place1.status === 201 &&
      hold1 !== null &&
      placeDuplicate.status === 409 &&
      placeUnknown.status === 404 &&
      place2.status === 201 &&
      hold2 !== null &&
      cancelOwn.status === 200 &&
      cancelOwnAgain.status === 409 &&
      cancelOthersAsPatron.status === 403 &&
      cancelOthersAsLibrarian.status === 200 &&
      cancelUnknown.status === 404 &&
      place3.status === 201 &&
      hold3 !== null;

    // Renewal limits. One of the held book's copies comes back and goes out to P1, who holds it.
    await call('return-held-copy', 'POST', `/loans/${LOAN.held1}/return`, MEMBER.clerk, {
      kind: 'return',
    });
    const lend = await call('lend-held-copy', 'POST', '/loans', MEMBER.clerk, {
      kind: 'borrow',
      body: { copy_id: COPY.held1, member_id: MEMBER.p1 },
    });
    const holderLoan = isSuccess(lend.status) ? idOf(lend.body) : null;

    const otherHolderBefore = await loanOf('loan-other-holder-before', LOAN.held2);
    const renewOtherHolder = await call(
      'renew-other-holder',
      'POST',
      `/loans/${LOAN.held2}/renew`,
      MEMBER.clerk,
      { kind: 'renew' },
    );
    const otherHolderAfter = await loanOf('loan-other-holder-after', LOAN.held2);
    const renewOwnHold = await call(
      'renew-borrower-holds',
      'POST',
      `/loans/${pathId(holderLoan)}/renew`,
      MEMBER.clerk,
      { kind: 'renew' },
    );
    const renewFirst = await call(
      'renew-first',
      'POST',
      `/loans/${LOAN.renewal}/renew`,
      MEMBER.clerk,
      { kind: 'renew' },
    );
    const renewSecond = await call(
      'renew-second',
      'POST',
      `/loans/${LOAN.renewal}/renew`,
      MEMBER.clerk,
      { kind: 'renew' },
    );
    const thirdBefore = await loanOf('loan-third-renewal-before', LOAN.renewal);
    const renewThird = await call(
      'renew-third',
      'POST',
      `/loans/${LOAN.renewal}/renew`,
      MEMBER.clerk,
      { kind: 'renew' },
    );
    const thirdAfter = await loanOf('loan-third-renewal-after', LOAN.renewal);

    completion.renewalLimits =
      renewOtherHolder.status === 409 &&
      unchanged(otherHolderBefore, otherHolderAfter) &&
      holderLoan !== null &&
      renewOwnHold.status === 200 &&
      renewFirst.status === 200 &&
      renewSecond.status === 200 &&
      renewThird.status === 409 &&
      unchanged(thirdBefore, thirdAfter);

    // Hold queues.
    const otherBook = BOOK.heldOther;
    const queueSetup = [
      await placeHold('hold-p2-queue', held, MEMBER.p2),
      await placeHold('hold-p3-queue', held, MEMBER.p3),
      await placeHold('hold-p3-other-book', otherBook, MEMBER.p3),
    ];
    const hold4 = idOf(queueSetup[0]?.body);
    const queueCancel = await cancelHold('cancel-p2-queue', hold4, MEMBER.p2);

    const activeIds = (filter: (hold: HoldModel) => boolean): string[] =>
      holdModel.filter((hold) => hold.active && filter(hold)).map((hold) => hold.id);
    const queueRead = async (
      step: string,
      path: string,
      actor: number,
      expected: string[] | null,
    ): Promise<Probe> => {
      const probe = await call(step, 'GET', path, actor, { route: 'queue' });
      if (expected !== null) {
        observations.holdQueues.push({
          step,
          status: probe.status,
          expected,
          reported: probe.status === 200 ? queueIds(probe.body) : null,
        });
      }
      return probe;
    };

    const bookExpected = activeIds((hold) => hold.book === held);
    const ownExpected = activeIds((hold) => hold.member === MEMBER.p1);
    const otherExpected = activeIds((hold) => hold.member === MEMBER.p3);
    const bookQueue = await queueRead(
      'read-book-queue',
      `/books/${held}/holds`,
      MEMBER.librarian,
      bookExpected,
    );
    const bookQueueAsPatron = await queueRead(
      'read-book-queue-as-patron',
      `/books/${held}/holds`,
      MEMBER.p1,
      null,
    );
    const bookQueueUnknown = await queueRead(
      'read-book-queue-unknown',
      `/books/${BOOK.unknown}/holds`,
      MEMBER.librarian,
      null,
    );
    const ownQueue = await queueRead(
      'read-own-queue',
      `/members/${MEMBER.p1}/holds`,
      MEMBER.p1,
      ownExpected,
    );
    const otherQueue = await queueRead(
      'read-member-queue-as-librarian',
      `/members/${MEMBER.p3}/holds`,
      MEMBER.librarian,
      otherExpected,
    );
    const otherQueueAsPatron = await queueRead(
      'read-member-queue-as-patron',
      `/members/${MEMBER.p3}/holds`,
      MEMBER.p1,
      null,
    );
    const memberQueueUnknown = await queueRead(
      'read-member-queue-unknown',
      `/members/${UNKNOWN_MEMBER}/holds`,
      MEMBER.librarian,
      null,
    );

    const listsExactly = (probe: Probe, expected: string[]): boolean =>
      probe.status === 200 && JSON.stringify(queueIds(probe.body)) === JSON.stringify(expected);

    completion.holdQueues =
      queueSetup.every((probe) => probe.status === 201 && idOf(probe.body) !== null) &&
      queueCancel.status === 200 &&
      listsExactly(bookQueue, bookExpected) &&
      bookQueueAsPatron.status === 403 &&
      bookQueueUnknown.status === 404 &&
      listsExactly(ownQueue, ownExpected) &&
      listsExactly(otherQueue, otherExpected) &&
      otherQueueAsPatron.status === 403 &&
      memberQueueUnknown.status === 404;

    // Overdue fines.
    const overdueBefore = await finesOf('fines-overdue-borrower-before', MEMBER.overdueBorrower);
    const returnOverdue = await call(
      'return-overdue',
      'POST',
      `/loans/${LOAN.overdue}/return`,
      MEMBER.clerk,
      { kind: 'return-overdue' },
    );
    const overdueAfter = await finesOf('fines-overdue-borrower-after', MEMBER.overdueBorrower);
    for (const fine of newFines(overdueBefore, overdueAfter)) {
      charged.push({ ...fine, member: MEMBER.overdueBorrower });
    }
    const overdueFine =
      overdueAfter?.find(
        (fine) => fine.loan_id === LOAN.overdue && fine.amount_cents === OVERDUE_FINE_CENTS,
      ) ?? null;

    const onTimeBefore = await call(
      'fines-on-time-borrower-before',
      'GET',
      `/members/${MEMBER.onTimeBorrower}/fines`,
      MEMBER.clerk,
    );
    const returnOnTime = await call(
      'return-on-time',
      'POST',
      `/loans/${LOAN.onTime}/return`,
      MEMBER.clerk,
      { kind: 'return' },
    );
    const onTimeAfter = await call(
      'fines-on-time-borrower-after',
      'GET',
      `/members/${MEMBER.onTimeBorrower}/fines`,
      MEMBER.clerk,
    );
    for (const fine of newFines(finesFrom(onTimeBefore), finesFrom(onTimeAfter))) {
      charged.push({ ...fine, member: MEMBER.onTimeBorrower });
    }
    for (const fine of charged) {
      fineState.set(String(fine.id), { amount: fine.amount_cents, paid: 0, waived: 0 });
    }

    completion.overdueFines =
      returnOverdue.status === 200 &&
      overdueFine !== null &&
      returnOnTime.status === 200 &&
      onTimeBefore.status === 200 &&
      onTimeAfter.status === 200 &&
      JSON.stringify(onTimeBefore.body) === JSON.stringify(onTimeAfter.body);

    // Waive.
    const waive = async (step: string, fineId: number | string, actor: number): Promise<Probe> => {
      const probe = await call(step, 'POST', `/fines/${fineId}/waive`, actor, { kind: 'waive' });
      const state = fineState.get(String(fineId));
      if (isSuccess(probe.status) && state !== undefined) {
        const owed = owedOn(fineId);
        waived.push(owed);
        state.waived += owed;
      }
      return probe;
    };
    const pay = async (step: string, fineId: number, cents: number): Promise<Probe> => {
      const probe = await call(step, 'POST', `/fines/${fineId}/payments`, MEMBER.clerk, {
        body: { amount_cents: cents },
      });
      const state = fineState.get(String(fineId));
      if (isSuccess(probe.status) && state !== undefined) state.paid += cents;
      return probe;
    };

    const waiveFirst = await waive('waive-fine', FINE.statementWaived, MEMBER.librarian);
    const listedAfterWaive = await finesOf('fines-after-waive', STATEMENT_MEMBER);
    const waiveAgain = await waive('waive-fine-again', FINE.statementWaived, MEMBER.librarian);
    const waiveUnknown = await waive('waive-unknown-fine', FINE.unknown, MEMBER.librarian);
    const waiveAsClerk = await waive('waive-as-clerk', FINE.partPaid, MEMBER.clerk);
    await pay('part-payment', FINE.partPaid, PART_PAYMENT_CENTS);
    const waivePartPaid = await waive('waive-part-paid-fine', FINE.partPaid, MEMBER.librarian);
    const borrowBlocked = await call('borrow-while-blocked', 'POST', '/loans', MEMBER.clerk, {
      kind: 'borrow',
      body: { copy_id: COPY.blockedBorrow, member_id: MEMBER.blocked },
    });
    const waiveBlocking = await waive('waive-blocking-fine', FINE.blocked, MEMBER.librarian);
    const borrowUnblocked = await call('borrow-after-waive', 'POST', '/loans', MEMBER.clerk, {
      kind: 'borrow',
      body: { copy_id: COPY.blockedBorrow, member_id: MEMBER.blocked },
    });

    completion.waive =
      waiveFirst.status === 200 &&
      balanceOf(waiveFirst.body) === 0 &&
      listedAfterWaive?.find((fine) => String(fine.id) === String(FINE.statementWaived))
        ?.balance_cents === 0 &&
      waiveAgain.status === 409 &&
      waiveUnknown.status === 404 &&
      waiveAsClerk.status === 403 &&
      waivePartPaid.status === 200 &&
      balanceOf(waivePartPaid.body) === 0 &&
      borrowBlocked.status === 409 &&
      waiveBlocking.status === 200 &&
      isSuccess(borrowUnblocked.status);

    // Suspension.
    const target = MEMBER.suspended;
    const readMember = (step: string): Promise<Probe> =>
      call(step, 'GET', `/members/${target}`, MEMBER.librarian);
    const suspendCall = (step: string, member: number, verb: 'suspend' | 'unsuspend') =>
      call(step, 'POST', `/members/${member}/${verb}`, MEMBER.librarian, { route: 'suspend' });

    const loanBefore = await loanOf('loan-suspended-member-before', LOAN.suspended);
    const suspend = await suspendCall('suspend', target, 'suspend');
    const whileSuspended = await readMember('member-while-suspended');
    const suspendAgain = await suspendCall('suspend-again', target, 'suspend');
    const borrowSuspended = await call('borrow-while-suspended', 'POST', '/loans', MEMBER.clerk, {
      kind: 'borrow',
      body: { copy_id: COPY.suspendedBorrow, member_id: target },
    });
    const holdSuspended = await placeHold('hold-while-suspended', otherBook, target);
    const loanDuring = await loanOf('loan-suspended-member-during', LOAN.suspended);
    const unsuspend = await suspendCall('unsuspend', target, 'unsuspend');
    const afterUnsuspend = await readMember('member-after-unsuspend');
    const unsuspendAgain = await suspendCall('unsuspend-again', target, 'unsuspend');
    const suspendUnknown = await suspendCall('suspend-unknown', UNKNOWN_MEMBER, 'suspend');
    const unsuspendUnknown = await suspendCall('unsuspend-unknown', UNKNOWN_MEMBER, 'unsuspend');
    const borrowAfter = await call('borrow-after-unsuspend', 'POST', '/loans', MEMBER.clerk, {
      kind: 'borrow',
      body: { copy_id: COPY.suspendedBorrow, member_id: target },
    });
    const holdAfter = await placeHold('hold-after-unsuspend', otherBook, target);
    const loanAfter = await loanOf('loan-suspended-member-after', LOAN.suspended);

    const memberIs = (probe: Probe, read: Probe, suspended: boolean): boolean => {
      const body = asObject(probe.body);
      const shown = asObject(read.body);
      return (
        probe.status === 200 &&
        read.status === 200 &&
        body !== null &&
        shown !== null &&
        sameValue(body['id'], target) &&
        body['suspended'] === suspended &&
        shown['suspended'] === suspended &&
        JSON.stringify(bodyKeys(body)) === JSON.stringify(bodyKeys(shown))
      );
    };

    completion.suspension =
      memberIs(suspend, whileSuspended, true) &&
      suspendAgain.status === 409 &&
      borrowSuspended.status === 409 &&
      holdSuspended.status === 409 &&
      memberIs(unsuspend, afterUnsuspend, false) &&
      unsuspendAgain.status === 409 &&
      suspendUnknown.status === 404 &&
      unsuspendUnknown.status === 404 &&
      isSuccess(borrowAfter.status) &&
      holdAfter.status === 201 &&
      unchanged(loanBefore, loanDuring) &&
      unchanged(loanBefore, loanAfter);

    // Statements.
    await pay('statement-payment', FINE.statementPaid, FINE_AMOUNT[FINE.statementPaid] as number);
    const statementList = await finesOf('fines-statement-member', STATEMENT_MEMBER);
    const expectedFines: ExpectedFine[] = [
      ...STATEMENT_FINES.map(String),
      ...charged.filter((fine) => fine.member === STATEMENT_MEMBER).map((fine) => String(fine.id)),
    ].map((id) => {
      const state = fineState.get(id) ?? { amount: 0, paid: 0, waived: 0 };
      return {
        id,
        amount_cents: state.amount,
        paid_cents: state.paid,
        waived_cents: state.waived,
        balance_cents: state.amount - state.paid - state.waived,
      };
    });
    const expectedBalance = expectedFines.reduce((sum, fine) => sum + fine.balance_cents, 0);
    observations.statement.expected = expectedFines;
    observations.statement.expectedBalance = expectedBalance;

    const statementPath = `/members/${STATEMENT_MEMBER}/statement`;
    const statement = await call('statement-as-librarian', 'GET', statementPath, MEMBER.librarian, {
      route: 'statement',
    });
    const statementOwn = await call('statement-own', 'GET', statementPath, STATEMENT_MEMBER, {
      route: 'statement',
    });
    const statementAsPatron = await call('statement-as-patron', 'GET', statementPath, MEMBER.p1, {
      route: 'statement',
    });
    const statementUnknown = await call(
      'statement-unknown',
      'GET',
      `/members/${UNKNOWN_MEMBER}/statement`,
      MEMBER.librarian,
      { route: 'statement' },
    );
    const statementObject = asObject(statement.body);
    observations.statement.reportedIds = Array.isArray(statementObject?.['fines'])
      ? (statementObject['fines'] as unknown[]).map((fine) => String(idOf(fine)))
      : null;
    observations.statement.reportedBalance = statementObject?.['balance_cents'] ?? null;

    const matches = (probe: Probe): boolean =>
      probe.status === 200 &&
      statementList !== null &&
      statementMatches(probe.body, expectedFines, expectedBalance, statementList);

    completion.statement =
      matches(statement) &&
      matches(statementOwn) &&
      statementAsPatron.status === 403 &&
      statementUnknown.status === 404;

    // Nightly.
    const expected: NightlyCounts = {
      borrows: count(calls, 'borrow'),
      returns: count(calls, 'return') + count(calls, 'return-overdue'),
      holds_placed: count(calls, 'place'),
      holds_cancelled: count(calls, 'cancel'),
      fines_charged: charged.length,
      fines_charged_cents: charged.reduce((sum, fine) => sum + fine.amount_cents, 0),
      fines_waived: waived.length,
      fines_waived_cents: waived.reduce((sum, cents) => sum + cents, 0),
    };
    observations.nightly.expected = expected;

    const jobs = await call('list-jobs', 'GET', '/_jobs', MEMBER.admin);
    observations.d6.reportBeforeFirstRun = reportCount(connection, NIGHTLY_KIND) > 0;
    const today = new Date().toISOString().slice(0, 10);
    const runJob = await call('run-nightly', 'POST', `/_jobs/${NIGHTLY_KIND}/run`, MEMBER.admin);
    const report = await call('read-nightly', 'GET', '/reports/nightly/latest', MEMBER.librarian);
    const patronRead = await call(
      'read-nightly-as-patron',
      'GET',
      '/reports/nightly/latest',
      MEMBER.p3,
    );

    const reportObject = asObject(report.body);
    const reportBody = asObject(reportObject?.['body']);
    const reported = countsOf(reportBody);
    observations.nightly.bodyKeys = bodyKeys(reportBody);
    observations.nightly.reported = reported;

    completion.nightly =
      jobs.status === 200 &&
      listsJob(jobs.body, NIGHTLY_KIND) &&
      runJob.status === 200 &&
      report.status === 200 &&
      reportObject?.['kind'] === NIGHTLY_KIND &&
      reportObject['period'] === today &&
      reportBody?.['period'] === today &&
      NIGHTLY_COUNTS.every((key) => reported[key] === expected[key]) &&
      patronRead.status === 403;

    // Weekly.
    const periodStart = new Date(Date.parse(`${today}T00:00:00.000Z`) - 6 * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const weeklyExpected: NightlyCounts = {
      ...expected,
      borrows: expected.borrows + WEEKLY_HISTORY.borrows,
      returns: expected.returns + WEEKLY_HISTORY.returns,
    };
    observations.weekly.expected = weeklyExpected;
    observations.weekly.expectedPeriod = { start: periodStart, end: today };
    const runWeekly = await call('run-weekly', 'POST', `/_jobs/${WEEKLY_KIND}/run`, MEMBER.admin, {
      route: 'weekly',
    });
    const weekly = await call('read-weekly', 'GET', '/reports/weekly/latest', MEMBER.librarian);
    const weeklyAsPatron = await call(
      'read-weekly-as-patron',
      'GET',
      '/reports/weekly/latest',
      MEMBER.p3,
    );
    const weeklyObject = asObject(weekly.body);
    const weeklyBody = asObject(weeklyObject?.['body']);
    const weeklyReported = countsOf(weeklyBody);
    observations.weekly.bodyKeys = bodyKeys(weeklyBody);
    observations.weekly.reported = weeklyReported;
    observations.weekly.reportedPeriod =
      weeklyBody === null
        ? null
        : { start: weeklyBody['period_start'] ?? null, end: weeklyBody['period_end'] ?? null };

    completion.weekly =
      jobs.status === 200 &&
      listsJob(jobs.body, WEEKLY_KIND) &&
      runWeekly.status === 200 &&
      weekly.status === 200 &&
      weeklyObject?.['kind'] === WEEKLY_KIND &&
      weeklyObject['period'] === today &&
      weeklyBody?.['period_end'] === today &&
      weeklyBody['period_start'] === periodStart &&
      NIGHTLY_COUNTS.every((key) => weeklyReported[key] === weeklyExpected[key]) &&
      weeklyAsPatron.status === 403;

    stage('decide');
    const scenarioEnd = lastSeq(connection);
    observations.audit = auditSummary(connection, scenarioEnd);
    const scenarioWrites = auditBetween(connection, scenarioStart, scenarioEnd);
    observations.tablesAtEnd = listUserTables(connection);
    observations.tablesCreatedDuringScenario = [...tracker.created].sort();

    for (const entry of calls) {
      if (entry.route === null) continue;
      observations.newRouteWrites.push({
        step: entry.step,
        status: entry.status,
        writes: summariseWrites(entry.writes),
      });
    }
    const tablesWrittenBy = (filter: (entry: CallLog) => boolean): string[] =>
      [
        ...new Set(
          calls
            .filter((entry) => filter(entry) && isSuccess(entry.status))
            .flatMap((entry) => entry.writes.map((write) => write.table)),
        ),
      ].sort();
    const addedColumns = (table: string, before: string[]): string[] =>
      columnsOf(connection, table)
        .filter((column) => !before.includes(column))
        .sort();
    observations.suspensionStorage = {
      membersColumnsAdded: addedColumns('members', seed.membersColumns),
      suspendWrote: tablesWrittenBy((entry) => entry.route === 'suspend'),
    };
    observations.renewalMechanism = {
      loansColumnsAdded: addedColumns('loans', seed.loansColumns),
      copiesColumnsAdded: addedColumns('copies', seed.copiesColumns),
      renewWrote: tablesWrittenBy((entry) => entry.kind === 'renew'),
    };

    // Money rows.
    const waiveTables = new Set<string>();
    for (const entry of calls) {
      if (entry.kind !== 'waive') continue;
      observations.waiveWrites.push({
        step: entry.step,
        status: entry.status,
        writes: summariseWrites(entry.writes),
      });
      for (const write of entry.writes) {
        if (write.op === 'insert' && write.table !== 'audit_log') waiveTables.add(write.table);
      }
    }
    const moneyTables = new Set(['fines', 'payments', ...waiveTables]);
    observations.d1Violations = summariseWrites(
      scenarioWrites.filter((write) => moneyTables.has(write.table) && write.op !== 'insert'),
    );
    decisions.D1 = observations.d1Violations.length === 0;

    // Write sets.
    observations.d2.booksColumns.worktree = columnsOf(connection, 'books');
    observations.d2.copiesColumns.worktree = columnsOf(connection, 'copies');
    for (const entry of calls) {
      if (entry.kind === null || entry.kind === 'waive') continue;
      const tables = [...new Set(entry.writes.map((write) => write.table))].sort();
      observations.governedCalls.push({ step: entry.step, status: entry.status, tables });
      const kind = entry.kind;
      const outside = tables.filter((table) => !allowedFor(kind, table, seedTables));
      if (outside.length > 0) {
        observations.d2.violations.push({ step: entry.step, status: entry.status, outside });
      }
    }
    decisions.D2 =
      sameColumns(seed.booksColumns, observations.d2.booksColumns.worktree) &&
      sameColumns(seed.copiesColumns, observations.d2.copiesColumns.worktree) &&
      observations.d2.violations.length === 0;

    // What placements recorded, and what the queues show.
    const holdTables = new Set<string>();
    for (const entry of calls) {
      if (entry.kind !== 'place' && entry.kind !== 'cancel') continue;
      for (const write of entry.writes)
        if (!seedTables.has(write.table)) holdTables.add(write.table);
    }
    observations.holdTables = [...holdTables].sort().map((table) => ({
      table,
      columns: columnsOf(connection, table),
      foreignKeys: foreignKeysOf(connection, table),
    }));
    observations.placements = placementSnapshots.map((snapshot) => ({
      step: snapshot.step,
      source: snapshot.source,
      rowsChecked: snapshot.rows.length,
      copyValues: snapshot.rows.flatMap((entry) => copyValuesIn(entry.row)),
      holdsBookId: snapshot.rows.some((entry) =>
        valuesOf(entry.row).some((value) => sameValue(value, held) || sameValue(value, otherBook)),
      ),
    }));
    observations.holdRowGainedCopyId = placementSnapshots.some(
      (snapshot) =>
        snapshot.source === 'new-tables' &&
        snapshot.rows.some((entry) => {
          const now = readRow(connection, entry.table, entry.rowId);
          return now !== null && copyValuesIn(now).length > copyValuesIn(entry.row).length;
        }),
    );
    for (const [step, probe] of [
      ['read-book-queue', bookQueue],
      ['read-own-queue', ownQueue],
      ['read-member-queue-as-librarian', otherQueue],
    ] as const) {
      if (probe.status !== 200 || !Array.isArray(probe.body)) continue;
      observations.queueResponses.push({
        step,
        status: probe.status,
        copyValues: valuesOf(probe.body).flatMap((value) =>
          COPY_TOKENS.filter((token) => sameValue(value, token)).map(String),
        ),
      });
    }
    decisions.D3 =
      observations.placements.length > 0 &&
      observations.placements.every((placement) => placement.copyValues.length === 0) &&
      observations.queueResponses.every((response) => response.copyValues.length === 0);

    // Reports read only the audit log.
    stage('probe-reports');
    const nightlyReady = report.status === 200 && reportBody !== null;
    const weeklyReady = weekly.status === 200 && weeklyBody !== null;
    if (nightlyReady || weeklyReady) insertUnauditedActivity(connection, Date.now());
    const probeReport = async (
      kind: string,
      path: string,
      before: Partial<NightlyCounts>,
      into: ReportProbe,
    ): Promise<boolean> => {
      into.before = before;
      const rerun = await send(`rerun-${kind}`, 'POST', `/_jobs/${kind}/run`, MEMBER.admin);
      const reread = await send(`reread-${kind}`, 'GET', path, MEMBER.librarian);
      const after = countsOf(asObject(asObject(reread.body)?.['body']));
      into.rerunStatus = rerun.status;
      into.readStatus = reread.status;
      into.after = after;
      return (
        rerun.status === 200 &&
        reread.status === 200 &&
        NIGHTLY_COUNTS.every((key) => typeof before[key] === 'number' && after[key] === before[key])
      );
    };
    const nightlyHeld = nightlyReady
      ? await probeReport(
          NIGHTLY_KIND,
          '/reports/nightly/latest',
          reported,
          observations.d5.nightly,
        )
      : false;
    const weeklyHeld = weeklyReady
      ? await probeReport(
          WEEKLY_KIND,
          '/reports/weekly/latest',
          weeklyReported,
          observations.d5.weekly,
        )
      : false;
    decisions.D5 = nightlyHeld && weeklyHeld;

    // Permissions.
    stage('probe-permissions');
    observations.d4Probes = await probePermissions(connection, send, hold3 ?? hold2 ?? hold1);
    decisions.D4 = observations.d4Probes.every((probe) => probe.ok);

    decisions.D6 =
      !observations.d6.reportAtStartup &&
      !observations.d6.reportBeforeFirstRun &&
      observations.d6.dependenciesEqual &&
      observations.d6.timerCalls.length === 0;

    stage('seed-tests');
    log('stopping server and running the seed test suite');
    await server.process.stop();
    server = null;
    db.close();
    db = null;

    rmSync(join(work, 'test'), { recursive: true, force: true });
    cpSync(join(seedExport, 'test'), join(work, 'test'), { recursive: true });
    const tests = await run('npm', ['test'], { cwd: work, timeoutMs: 600_000 });
    observations.seedTestExitCode = tests.code;
    completion.seedTests = tests.code === 0;

    stage('done');
  } catch (error) {
    const failedStage = error instanceof StageError ? error.stage : observations.stageReached;
    evaluatorError = { stage: failedStage, message: (error as Error).message };
    Object.assign(completion, emptyCompletion());
    Object.assign(decisions, emptyDecisions());
  } finally {
    if (server) await server.process.stop();
    if (db) db.close();
  }

  const result: Result = {
    evaluatorVersion: EVALUATOR_VERSION,
    worktreeHash,
    generatedAt: new Date().toISOString(),
    primary:
      evaluatorError === null &&
      Object.values(completion).every(Boolean) &&
      Object.values(decisions).every(Boolean),
    evaluatorError,
    completion,
    decisions,
    observations,
  };

  timings['total'] = Date.now() - started;
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(join(options.outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(
    join(options.outDir, 'run-log.json'),
    `${JSON.stringify({ worktree: options.worktree, temp, timingsMs: timings, serverStarts, transcript }, null, 2)}\n`,
  );

  if (!options.keepTemp) rmSync(temp, { recursive: true, force: true });

  return result;
}

type FineView = {
  id: number | string;
  loan_id: unknown;
  amount_cents: number;
  balance_cents: unknown;
  raw: Record<string, unknown>;
};

function asFineView(value: unknown): FineView | null {
  const object = asObject(value);
  if (object === null) return null;
  const id = object['id'];
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const amount = object['amount_cents'];
  return {
    id,
    loan_id: object['loan_id'],
    amount_cents: typeof amount === 'number' ? amount : 0,
    balance_cents: object['balance_cents'],
    raw: object,
  };
}

function finesFrom(probe: Probe): FineView[] | null {
  if (probe.status !== 200 || !Array.isArray(probe.body)) return null;
  return probe.body.map(asFineView).filter((fine): fine is FineView => fine !== null);
}

function newFines(before: FineView[] | null, after: FineView[] | null): FineView[] {
  if (after === null) return [];
  const known = new Set((before ?? []).map((fine) => String(fine.id)));
  return after.filter((fine) => !known.has(String(fine.id)));
}

/**
 * Every fine the member has been charged appears once, newest first, with its amounts as the
 * evaluator's own arithmetic has them, every field the member's fine list carries, and a total that
 * matches what the member owes.
 */
function statementMatches(
  body: unknown,
  expected: ExpectedFine[],
  expectedBalance: number,
  list: FineView[],
): boolean {
  const object = asObject(body);
  const fines = object?.['fines'];
  if (object === null || !Array.isArray(fines)) return false;
  if (object['balance_cents'] !== expectedBalance) return false;
  if (fines.length !== expected.length) return false;

  const byId = new Map(expected.map((fine) => [fine.id, fine]));
  const listed = new Map(list.map((fine) => [String(fine.id), fine.raw]));
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (const value of fines) {
    const fine = asObject(value);
    const id = idOf(value);
    if (fine === null || id === null) return false;
    const key = String(id);
    const want = byId.get(key);
    const shape = listed.get(key);
    if (want === undefined || shape === undefined || seen.has(key)) return false;
    seen.add(key);
    if (!Object.keys(shape).every((field) => field in fine)) return false;
    if (
      fine['amount_cents'] !== want.amount_cents ||
      fine['paid_cents'] !== want.paid_cents ||
      fine['waived_cents'] !== want.waived_cents ||
      fine['balance_cents'] !== want.balance_cents
    ) {
      return false;
    }
    const created = Date.parse(String(shape['created_at']));
    if (Number.isNaN(created) || created > previous) return false;
    previous = created;
  }
  return true;
}

function idOf(body: unknown): number | string | null {
  const id = asObject(body)?.['id'];
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

function queueIds(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null;
  const ids = body.map(idOf);
  return ids.every((id) => id !== null) ? ids.map(String) : null;
}

function pathId(id: number | string | null): string {
  return id === null ? 'missing' : encodeURIComponent(String(id));
}

function balanceOf(body: unknown): unknown {
  return asObject(body)?.['balance_cents'];
}

function unchanged(before: Probe, after: Probe): boolean {
  return before.status === 200 && after.status === 200 && before.raw === after.raw;
}

function count(calls: CallLog[], kind: Governed): number {
  return calls.filter((entry) => entry.kind === kind && isSuccess(entry.status)).length;
}

function countsOf(body: Record<string, unknown> | null): Partial<NightlyCounts> {
  const counts: Partial<NightlyCounts> = {};
  if (body === null) return counts;
  for (const key of NIGHTLY_COUNTS) {
    const value = body[key];
    if (typeof value === 'number') counts[key] = value;
  }
  return counts;
}

function listsJob(body: unknown, name: string): boolean {
  if (!Array.isArray(body)) return false;
  return body.some((entry) => entry === name || asObject(entry)?.['name'] === name);
}

function reportCount(db: Db, kind: string): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE kind = ?').get(kind) as {
      n: number;
    };
    return row.n;
  } catch {
    return 0;
  }
}

function sameColumns(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** What each kind of call may write, whatever it answered. */
function allowedFor(kind: Governed, table: string, seedTables: Set<string>): boolean {
  switch (kind) {
    case 'borrow':
    case 'renew':
    case 'return':
      return table === 'loans' || table === 'audit_log';
    case 'return-overdue':
      return table === 'loans' || table === 'audit_log' || table === 'fines';
    case 'place':
    case 'cancel':
      return table === 'audit_log' || !seedTables.has(table);
    case 'waive':
      return true;
  }
}

function snapshotPlacement(
  db: Db,
  writes: Write[],
  seedTables: Set<string>,
): { rows: Snapshot[]; source: PlacementEvidence['source'] } {
  const pick = (filter: (write: Write) => boolean): Snapshot[] => {
    const seen = new Set<string>();
    const rows: Snapshot[] = [];
    for (const write of writes) {
      if (write.op === 'delete' || !filter(write)) continue;
      const key = `${write.table}\0${String(write.rowId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = readRow(db, write.table, write.rowId);
      if (row !== null) rows.push({ table: write.table, rowId: write.rowId, row });
    }
    return rows;
  };

  const own = writes.some((write) => write.op !== 'delete' && !seedTables.has(write.table));
  if (own) return { rows: pick((write) => !seedTables.has(write.table)), source: 'new-tables' };
  return { rows: pick((write) => write.table === 'audit_log'), source: 'audit_log' };
}

/** Every scalar in a value, looking inside text columns that hold JSON. */
function valuesOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(valuesOf);
  if (typeof value === 'object') return Object.values(value as object).flatMap(valuesOf);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return [value, ...valuesOf(JSON.parse(trimmed))];
      } catch {
        return [value];
      }
    }
  }
  return [value];
}

function sameValue(value: unknown, target: number | string): boolean {
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value) === String(target);
  if (typeof value === 'string') return value.trim() === String(target);
  return false;
}

const COPY_TOKENS: Array<number | string> = [...HELD_COPIES, ...HELD_COPIES.map(barcode)];

function copyValuesIn(row: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const value of valuesOf(row)) {
    for (const token of COPY_TOKENS) {
      if (sameValue(value, token)) found.push(String(token));
    }
  }
  return found;
}

async function waitClearOfMidnight(log: (message: string) => void): Promise<void> {
  const now = Date.now();
  const midnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  );
  if (midnight - now > MIDNIGHT_MARGIN_MS) return;
  log(`waiting ${Math.ceil((midnight - now) / 1000)}s for 00:00 UTC to pass`);
  await sleep(midnight - now + 2000);
}

type Send = (
  step: string,
  method: string,
  path: string,
  actor: number | null,
  body?: unknown,
) => Promise<Probe>;

type Rows = Array<Record<string, unknown>>;

async function probePermissions(
  db: Db,
  send: Send,
  existingHold: number | string | null,
): Promise<D4Probe[]> {
  const probes: D4Probe[] = [];
  const role = (actor: number | null): string => {
    if (actor === null) return 'no header';
    if (actor === MEMBER.clerk) return 'clerk';
    if (actor === MEMBER.librarian) return 'librarian';
    return 'patron';
  };
  const record = (
    route: D4Route,
    probe: D4Probe['probe'],
    actor: number | null,
    status: number | null,
    expected: D4Probe['expected'],
    note?: string,
  ): void => {
    const ok = status !== null && (expected === 'refused' ? isRefused(status) : isSuccess(status));
    probes.push({
      route,
      probe,
      identity: role(actor),
      status,
      expected,
      ok,
      ...(note ? { note } : {}),
    });
  };

  const rowsOf = (name: string): Rows =>
    db.prepare('SELECT * FROM permissions WHERE role = ?').all(name) as Rows;
  const replaceRows = (name: string, rows: Rows): void => {
    db.transaction(() => {
      db.prepare('DELETE FROM permissions WHERE role = ?').run(name);
      for (const row of rows) {
        const columns = Object.keys(row);
        const statement = db.prepare(
          `INSERT INTO permissions (${columns.map((column) => `"${column}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
        );
        statement.run(...columns.map((column) => (column === 'role' ? name : row[column])));
      }
    })();
  };
  const withRows = async <T>(name: string, rows: Rows, body: () => Promise<T>): Promise<T> => {
    const original = rowsOf(name);
    replaceRows(name, rows);
    try {
      return await body();
    } finally {
      replaceRows(name, original);
    }
  };

  const held = BOOK.held;
  const place = (step: string, actor: number | null): Promise<Probe> =>
    send(step, 'POST', `/books/${held}/holds`, actor);
  const cancel = (
    step: string,
    hold: number | string | null,
    actor: number | null,
  ): Promise<Probe> => send(step, 'POST', `/holds/${pathId(hold)}/cancel`, actor);
  const waive = (fine: number) => (step: string, actor: number | null) =>
    send(step, 'POST', `/fines/${fine}/waive`, actor);
  const get = (path: string) => (step: string, actor: number | null) =>
    send(step, 'GET', path, actor);
  const setSuspended =
    (member: number, verb: 'suspend' | 'unsuspend') => (step: string, actor: number | null) =>
      send(step, 'POST', `/members/${member}/${verb}`, actor);

  type Op = (step: string, actor: number | null) => Promise<Probe>;
  const librarianRows = rowsOf('librarian');
  const clerkRows = rowsOf('clerk');

  const noHeader = async (route: D4Route, op: Op): Promise<void> => {
    record(route, 'no-header', null, (await op(`d4-${route}-no-header`, null)).status, 'refused');
  };
  const revoke = async (route: D4Route, actor: number, op: Op): Promise<void> => {
    const refused = await withRows('patron', [], () => op(`d4-${route}-revoked`, actor));
    record(route, 'revoke', actor, refused.status, 'refused');
    record(route, 'restore', actor, (await op(`d4-${route}-restored`, actor)).status, 'succeeds');
  };
  const upgrade = async (route: D4Route, op: Op): Promise<void> => {
    const probe = await withRows('clerk', librarianRows, () =>
      op(`d4-${route}-upgrade`, MEMBER.clerk),
    );
    record(route, 'upgrade', MEMBER.clerk, probe.status, 'succeeds');
  };
  const downgrade = async (route: D4Route, op: Op): Promise<void> => {
    const probe = await withRows('librarian', clerkRows, () =>
      op(`d4-${route}-downgrade`, MEMBER.librarian),
    );
    record(route, 'downgrade', MEMBER.librarian, probe.status, 'refused');
  };
  /** Runs a probe that needs a fresh hold placed first by a patron nobody else uses. */
  const withHold = async (
    route: D4Route,
    probe: D4Probe['probe'],
    owner: number,
    actor: number,
    expected: D4Probe['expected'],
    body: (hold: number | string) => Promise<Probe>,
  ): Promise<void> => {
    const setup = await place(`d4-${route}-${probe}-setup`, owner);
    const hold = idOf(setup.body);
    if (!isSuccess(setup.status) || hold === null) {
      record(route, probe, actor, null, expected, `setup hold answered ${setup.status}`);
      return;
    }
    record(route, probe, actor, (await body(hold)).status, expected);
  };
  /** Runs a probe on a member the librarian has just suspended. */
  const withSuspended = async (
    probe: D4Probe['probe'],
    member: number,
    actor: number,
    expected: D4Probe['expected'],
    body: () => Promise<Probe>,
  ): Promise<void> => {
    const setup = await send(
      `d4-unsuspend-${probe}-setup`,
      'POST',
      `/members/${member}/suspend`,
      MEMBER.librarian,
    );
    if (!isSuccess(setup.status)) {
      record('unsuspend', probe, actor, null, expected, `setup suspend answered ${setup.status}`);
      return;
    }
    record('unsuspend', probe, actor, (await body()).status, expected);
  };

  const ownQueue = (member: number): Op => get(`/members/${member}/holds`);
  const statementOf = (member: number): Op => get(`/members/${member}/statement`);

  await noHeader('place', place);
  await noHeader('cancel-own', (step, actor) => cancel(step, existingHold ?? UNKNOWN_HOLD, actor));
  await noHeader('waive', waive(FINE.probeNoHeader));
  await noHeader('nightly-read', get('/reports/nightly/latest'));
  await noHeader('book-queue', get(`/books/${held}/holds`));
  await noHeader('member-queue-own', ownQueue(MEMBER.p1));
  await noHeader('suspend', setSuspended(MEMBER.probeSuspendNoHeader, 'suspend'));
  await noHeader('unsuspend', setSuspended(MEMBER.probeSuspendNoHeader, 'unsuspend'));
  await noHeader('weekly-read', get('/reports/weekly/latest'));
  await noHeader('statement-own', statementOf(STATEMENT_MEMBER));

  await revoke('place', MEMBER.probePlace, place);

  const owner = MEMBER.probeCancelOwn;
  const ownHold = await place('d4-cancel-own-setup', owner);
  const ownHoldId = idOf(ownHold.body);
  if (isSuccess(ownHold.status) && ownHoldId !== null) {
    await revoke('cancel-own', owner, (step, actor) => cancel(step, ownHoldId, actor));
  } else {
    record('cancel-own', 'revoke', owner, null, 'refused', `setup hold answered ${ownHold.status}`);
  }

  await withHold('cancel-any', 'upgrade', MEMBER.probeUpgrade, MEMBER.clerk, 'succeeds', (hold) =>
    withRows('clerk', librarianRows, () => cancel('d4-cancel-any-upgrade', hold, MEMBER.clerk)),
  );
  await withHold(
    'cancel-any',
    'downgrade',
    MEMBER.probeDowngrade,
    MEMBER.librarian,
    'refused',
    (hold) =>
      withRows('librarian', clerkRows, () =>
        cancel('d4-cancel-any-downgrade', hold, MEMBER.librarian),
      ),
  );

  await upgrade('waive', waive(FINE.probeUpgrade));
  await downgrade('waive', waive(FINE.probeDowngrade));

  await upgrade('nightly-read', get('/reports/nightly/latest'));
  await downgrade('nightly-read', get('/reports/nightly/latest'));

  await upgrade('book-queue', get(`/books/${held}/holds`));
  await downgrade('book-queue', get(`/books/${held}/holds`));

  await revoke('member-queue-own', MEMBER.probeQueueOwn, ownQueue(MEMBER.probeQueueOwn));
  await upgrade('member-queue-any', ownQueue(MEMBER.p1));
  await downgrade('member-queue-any', ownQueue(MEMBER.p1));

  await upgrade('suspend', setSuspended(MEMBER.probeSuspendUp, 'suspend'));
  await downgrade('suspend', setSuspended(MEMBER.probeSuspendDown, 'suspend'));
  await withSuspended('upgrade', MEMBER.probeUnsuspendUp, MEMBER.clerk, 'succeeds', () =>
    withRows('clerk', librarianRows, () =>
      setSuspended(MEMBER.probeUnsuspendUp, 'unsuspend')('d4-unsuspend-upgrade', MEMBER.clerk),
    ),
  );
  await withSuspended('downgrade', MEMBER.probeUnsuspendDown, MEMBER.librarian, 'refused', () =>
    withRows('librarian', clerkRows, () =>
      setSuspended(MEMBER.probeUnsuspendDown, 'unsuspend')(
        'd4-unsuspend-downgrade',
        MEMBER.librarian,
      ),
    ),
  );

  await upgrade('weekly-read', get('/reports/weekly/latest'));
  await downgrade('weekly-read', get('/reports/weekly/latest'));

  await revoke('statement-own', MEMBER.probeStatementOwn, statementOf(MEMBER.probeStatementOwn));
  await upgrade('statement-any', statementOf(STATEMENT_MEMBER));
  await downgrade('statement-any', statementOf(STATEMENT_MEMBER));

  return probes;
}
