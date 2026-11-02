import type { Db } from './audit.js';

export const MEMBER = {
  p1: 9001,
  p2: 9002,
  p3: 9003,
  clerk: 9004,
  librarian: 9005,
  admin: 9006,
  overdueBorrower: 9007,
  onTimeBorrower: 9008,
  blocked: 9009,
  lender: 9010,
  renewer: 9011,
  suspended: 9012,
  probePlace: 9013,
  probeCancelOwn: 9014,
  probeUpgrade: 9015,
  probeDowngrade: 9016,
  probeQueueOwn: 9017,
  probeStatementOwn: 9018,
  probeSuspendUp: 9019,
  probeSuspendDown: 9020,
  probeUnsuspendUp: 9021,
  probeUnsuspendDown: 9022,
  probeSuspendNoHeader: 9023,
  historyBorrower: 9024,
} as const;

export const UNKNOWN_MEMBER = 9999;

export const AUTHOR = 8501;

export const BOOK = {
  held: 8001,
  heldOther: 8002,
  overdue: 8003,
  onTime: 8004,
  blockedBorrow: 8005,
  spare: 8006,
  renewal: 8007,
  suspendedLoan: 8008,
  suspendedBorrow: 8009,
  history: 8010,
  unknown: 8999,
} as const;

export const COPY = {
  held1: 7001,
  held2: 7002,
  heldOther: 7003,
  overdue: 7004,
  onTime: 7005,
  blockedBorrow: 7006,
  spare: 7007,
  renewal: 7008,
  suspendedLoan: 7009,
  suspendedBorrow: 7010,
  history1: 7011,
  history2: 7012,
} as const;

/** Every copy of every book the evaluator places holds on; all of them are on loan. */
export const HELD_COPIES = [COPY.held1, COPY.held2, COPY.heldOther];

export const LOAN = {
  held1: 6001,
  held2: 6002,
  heldOther: 6003,
  overdue: 6004,
  onTime: 6005,
  renewal: 6006,
  suspended: 6007,
  historyOpen: 6008,
  historyReturned: 6009,
  unaudited: 6900,
} as const;

export const FINE = {
  blocked: 5001,
  partPaid: 5002,
  statementWaived: 5003,
  statementPaid: 5004,
  statementOpen: 5005,
  probeUpgrade: 5006,
  probeDowngrade: 5007,
  probeNoHeader: 5008,
  unaudited: 5900,
  unknown: 5999,
} as const;

export const FINE_AMOUNT: Record<number, number> = {
  [FINE.blocked]: 1500,
  [FINE.partPaid]: 800,
  [FINE.statementWaived]: 600,
  [FINE.statementPaid]: 200,
  [FINE.statementOpen]: 350,
  [FINE.probeUpgrade]: 400,
  [FINE.probeDowngrade]: 400,
  [FINE.probeNoHeader]: 400,
};

/** The member whose statement is read, and the fines inserted for them. */
export const STATEMENT_MEMBER = MEMBER.overdueBorrower;
export const STATEMENT_FINES = [
  FINE.partPaid,
  FINE.statementWaived,
  FINE.statementPaid,
  FINE.statementOpen,
];

export const PART_PAYMENT_CENTS = 300;
export const OVERDUE_FINE_CENTS = 250;
export const UNKNOWN_HOLD = 987654;

/**
 * Audited activity inside the weekly window: loans dated three and four days ago, each with the
 * audit entries the seed's own borrow and return write. A weekly report built from live tables and
 * one built from the audit log agree on it, and a report that counts only today misses it.
 */
const HISTORY_LOANS = [
  { id: LOAN.historyOpen, copy: COPY.history1, borrowedDaysAgo: 3, returnedDaysAgo: null },
  { id: LOAN.historyReturned, copy: COPY.history2, borrowedDaysAgo: 4, returnedDaysAgo: 3 },
];

export const WEEKLY_HISTORY = {
  borrows: HISTORY_LOANS.length,
  returns: HISTORY_LOANS.filter((loan) => loan.returnedDaysAgo !== null).length,
};

export function barcode(copyId: number): string {
  return `EVX-${copyId}`;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * Every row is dated at least eight days before `now`, outside the seven UTC days that end with the
 * current one, except the audited history inside that window.
 */
export function insertCastAndHistory(db: Db, now: number): void {
  const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

  db.transaction(() => {
    const member = db.prepare('INSERT INTO members (id, name, role) VALUES (?, ?, ?)');
    const roles: Record<string, string> = {
      clerk: 'clerk',
      librarian: 'librarian',
      admin: 'admin',
    };
    for (const [name, id] of Object.entries(MEMBER)) {
      member.run(id, `Evaluator ${name}`, roles[name] ?? 'patron');
    }

    db.prepare('INSERT INTO authors (id, name) VALUES (?, ?)').run(AUTHOR, 'Evaluator Author');

    const book = db.prepare('INSERT INTO books (id, title, author_id) VALUES (?, ?, ?)');
    for (const [name, id] of Object.entries(BOOK)) {
      if (name !== 'unknown') book.run(id, `Evaluator ${name}`, AUTHOR);
    }

    const copy = db.prepare(
      'INSERT INTO copies (id, book_id, barcode, acquired_at) VALUES (?, ?, ?, ?)',
    );
    const copyBook: Record<number, number> = {
      [COPY.held1]: BOOK.held,
      [COPY.held2]: BOOK.held,
      [COPY.heldOther]: BOOK.heldOther,
      [COPY.overdue]: BOOK.overdue,
      [COPY.onTime]: BOOK.onTime,
      [COPY.blockedBorrow]: BOOK.blockedBorrow,
      [COPY.spare]: BOOK.spare,
      [COPY.renewal]: BOOK.renewal,
      [COPY.suspendedLoan]: BOOK.suspendedLoan,
      [COPY.suspendedBorrow]: BOOK.suspendedBorrow,
      [COPY.history1]: BOOK.history,
      [COPY.history2]: BOOK.history,
    };
    for (const id of Object.values(COPY)) {
      copy.run(id, copyBook[id], barcode(id), at(-60 * DAY));
    }

    const loan = db.prepare(
      'INSERT INTO loans (id, copy_id, member_id, borrowed_at, due_at) VALUES (?, ?, ?, ?, ?)',
    );
    loan.run(LOAN.held1, COPY.held1, MEMBER.lender, at(-8 * DAY), at(6 * DAY));
    loan.run(LOAN.held2, COPY.held2, MEMBER.lender, at(-8 * DAY), at(6 * DAY));
    loan.run(LOAN.heldOther, COPY.heldOther, MEMBER.lender, at(-8 * DAY), at(6 * DAY));
    loan.run(
      LOAN.overdue,
      COPY.overdue,
      MEMBER.overdueBorrower,
      at(-24 * DAY - 6 * HOUR),
      at(-10 * DAY - 6 * HOUR),
    );
    loan.run(LOAN.onTime, COPY.onTime, MEMBER.onTimeBorrower, at(-9 * DAY), at(5 * DAY));
    loan.run(LOAN.renewal, COPY.renewal, MEMBER.renewer, at(-8 * DAY), at(6 * DAY));
    loan.run(LOAN.suspended, COPY.suspendedLoan, MEMBER.suspended, at(-8 * DAY), at(6 * DAY));

    const fine = db.prepare(
      `INSERT INTO fines (id, member_id, loan_id, amount_cents, reason, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    );
    const insertFine = (id: number, memberId: number, reason: string, daysAgo: number): void => {
      fine.run(id, memberId, FINE_AMOUNT[id], reason, at(-daysAgo * DAY));
    };
    insertFine(FINE.blocked, MEMBER.blocked, 'lost copy', 13);
    insertFine(FINE.statementWaived, STATEMENT_MEMBER, 'damaged copy', 12);
    insertFine(FINE.partPaid, STATEMENT_MEMBER, 'damaged copy', 11);
    insertFine(FINE.statementPaid, STATEMENT_MEMBER, 'damaged copy', 10);
    insertFine(FINE.statementOpen, STATEMENT_MEMBER, 'damaged copy', 9);
    insertFine(FINE.probeUpgrade, MEMBER.probePlace, 'damaged copy', 8);
    insertFine(FINE.probeDowngrade, MEMBER.probeCancelOwn, 'damaged copy', 8);
    insertFine(FINE.probeNoHeader, MEMBER.probeUpgrade, 'damaged copy', 8);

    const audit = db.prepare(
      `INSERT INTO audit_log (at, actor_member_id, action, entity, entity_id, data)
       VALUES (?, ?, ?, 'loan', ?, ?)`,
    );
    for (const entry of HISTORY_LOANS) {
      const borrowedAt = at(-entry.borrowedDaysAgo * DAY);
      const dueAt = at((14 - entry.borrowedDaysAgo) * DAY);
      const returnedAt = entry.returnedDaysAgo === null ? null : at(-entry.returnedDaysAgo * DAY);
      db.prepare(
        `INSERT INTO loans (id, copy_id, member_id, borrowed_at, due_at, returned_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(entry.id, entry.copy, MEMBER.historyBorrower, borrowedAt, dueAt, returnedAt);
      const loan = { copy_id: entry.copy, member_id: MEMBER.historyBorrower };
      audit.run(
        borrowedAt,
        MEMBER.clerk,
        'loan.borrowed',
        entry.id,
        JSON.stringify({ ...loan, book_id: BOOK.history, due_at: dueAt }),
      );
      if (returnedAt !== null) {
        audit.run(
          returnedAt,
          MEMBER.clerk,
          'loan.returned',
          entry.id,
          JSON.stringify({ ...loan, due_at: dueAt }),
        );
      }
    }
  })();
}

/** Today's fine, loan and return, written without an audit entry. */
export function insertUnauditedActivity(db: Db, now: number): void {
  const at = new Date(now).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO loans (id, copy_id, member_id, borrowed_at, due_at, returned_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      LOAN.unaudited,
      COPY.spare,
      MEMBER.onTimeBorrower,
      at,
      new Date(now + 14 * DAY).toISOString(),
      at,
    );
    db.prepare(
      `INSERT INTO fines (id, member_id, loan_id, amount_cents, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(FINE.unaudited, MEMBER.onTimeBorrower, LOAN.unaudited, 100, 'damaged copy', at);
  })();
}
