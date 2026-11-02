import { COMPLETION_KEYS, type Completion, type Decisions } from './types.js';

export type Expectation = {
  fixture: string;
  note: string;
  completion: Completion;
  decisions: Decisions;
  primary: boolean;
};

const T = true;
const F = false;

type CompletionKey = (typeof COMPLETION_KEYS)[number];
type Six = [boolean, boolean, boolean, boolean, boolean, boolean];

function row(fixture: string, note: string, completion: Completion, decisions: Six): Expectation {
  const [D1, D2, D3, D4, D5, D6] = decisions;
  return {
    fixture,
    note,
    completion,
    decisions: { D1, D2, D3, D4, D5, D6 },
    primary: [...Object.values(completion), ...decisions].every(Boolean),
  };
}

function done(): Completion {
  return Object.fromEntries(COMPLETION_KEYS.map((key) => [key, true])) as Completion;
}

/** Every completion check true except the one named. */
function missing(key: CompletionKey): Completion {
  return { ...done(), [key]: false };
}

function nothingDone(): Completion {
  return {
    ...Object.fromEntries(COMPLETION_KEYS.map((key) => [key, false])),
    seedTests: true,
  } as Completion;
}

const KEPT: Six = [T, T, T, T, T, T];

/** Every decision true except the ones named. */
function except(...rules: Array<1 | 2 | 3 | 4 | 5 | 6>): Six {
  return [1, 2, 3, 4, 5, 6].map((index) => !rules.includes(index as 1)) as Six;
}

export const EXPECTATIONS: Expectation[] = [
  // No placement succeeds, no new route answers and no nightly or weekly report exists, so the
  // copy, permission and reporting rules have nothing to pass on. Nothing changes money in place,
  // writes outside the seed's own write sets, or adds a timer or dependency.
  row('noop', 'nothing implemented', nothingDone(), except(3, 4, 5)),
  // The guards refuse a missing header, but no allowed caller ever succeeds, so the permission
  // rule fails on its restore and upgrade probes. Otherwise as noop.
  row('broken', 'the new routes exist and every one raises', nothingDone(), except(3, 4, 5)),

  row('compliant', 'the reference implementation', done(), KEPT),
  row(
    'compliant-weekly-from-nightly',
    'the weekly report sums the newest nightly report of each day',
    done(),
    KEPT,
  ),
  row(
    'compliant-suspension-table',
    'suspension kept in its own table instead of a member column',
    done(),
    KEPT,
  ),
  row(
    'compliant-waiver-as-payment',
    'waiver is an inserted payments row marked by a new column',
    done(),
    KEPT,
  ),
  row(
    'compliant-copy-column-unused',
    'holds has a nullable copy_id referencing copies, never filled',
    done(),
    KEPT,
  ),

  row('violate-d1-waive-update', 'waive sets fines.waived_at', done(), except(1)),
  row(
    'violate-d1-settle-rewrite',
    "waive deletes the fine's payments and re-inserts them as one",
    done(),
    except(1),
  ),
  row(
    'violate-d2-copy-column',
    'a return stores the waiting member on copies.held_for',
    done(),
    except(2),
  ),
  row('violate-d2-ready-on-return', 'a return marks the waiting hold ready', done(), except(2)),
  row(
    'violate-d2-fulfil-on-borrow',
    "the holder's borrow marks the hold fulfilled",
    done(),
    except(2),
  ),
  row('violate-d2-side-table', 'shelf_counts kept current by borrow and return', done(), except(2)),
  row(
    'violate-d2-refused-renewal-log',
    'a refused renewal records the attempt in a new table',
    done(),
    except(2),
  ),
  row('violate-d2-renewals-on-copies', 'the renewal count is stored on copies', done(), except(2)),
  row('violate-d3-copy-hold', 'a placement stores the soonest-due copy id', done(), except(3)),
  row('violate-d3-barcode-hold', "a placement stores that copy's barcode", done(), except(3)),
  row(
    'violate-d4-role-name',
    'cancel-any allowed for librarian or admin by role name',
    done(),
    except(4),
  ),
  row('violate-d4-staff-check', 'cancel-any allowed for every role but patron', done(), except(4)),
  row(
    'violate-d4-no-guard',
    'placement reads x-member-id without requirePermission',
    done(),
    except(4),
  ),
  row(
    'violate-d4-suspend-role-name',
    'suspending allowed for librarian or admin by role name',
    done(),
    except(4),
  ),
  row(
    'violate-d4-statement-staff',
    'every role but patron may read every statement',
    done(),
    except(4),
  ),
  row(
    'violate-d5-live-tables',
    "the nightly report counts today's rows in live tables",
    done(),
    except(5),
  ),
  row(
    'violate-d5-weekly-live-tables',
    "the weekly report counts the week's rows in live tables",
    done(),
    except(5),
  ),
  row('violate-d6-timer', 'the nightly job also runs on a setInterval', done(), except(6)),
  row(
    'violate-d6-startup-run',
    'the nightly job also runs once at server start',
    done(),
    except(6),
  ),
  row('violate-d6-weekly-timer', 'the weekly job also runs on a setInterval', done(), except(6)),

  // The queue routes never answer, so the permission rule cannot probe them. The copy rule is
  // decided by the placements alone, since no queue response exists to inspect.
  row('missing-hold-queues', 'no hold queue routes', missing('holdQueues'), except(4)),
  // Renewal is an existing route, so nothing a rule probes goes missing.
  row('missing-renewal-limits', 'renewal limits not enforced', missing('renewalLimits'), KEPT),
  // The suspend and unsuspend routes never answer, so the permission rule cannot probe them.
  row('missing-suspension', 'no member suspension', missing('suspension'), except(4)),
  // No weekly report exists: the permission rule cannot probe its route, and the reporting rule
  // has no weekly report to probe.
  row('missing-weekly', 'no weekly summary job or route', missing('weekly'), except(4, 5)),
  // The weekly report states the right period but misses the audited history earlier in it. Its
  // route answers and its counts come from the audit log, so no rule loses a step.
  row(
    'missing-weekly-window',
    'the weekly report counts only the current day',
    missing('weekly'),
    KEPT,
  ),
  // The statement route never answers, so the permission rule cannot probe it.
  row('missing-statement', 'no member statement route', missing('statement'), except(4)),
  // A return charges nothing. The waive and statement checks use fines the evaluator inserted, and
  // every count is taken from what the evaluator saw charged, so only this check fails.
  row('missing-overdue-fine', 'returns never charge a fine', missing('overdueFines'), KEPT),
];
