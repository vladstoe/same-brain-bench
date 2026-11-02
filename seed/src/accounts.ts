import { MAX_OPEN_LOANS, OUTSTANDING_BALANCE_LIMIT_CENTS } from './config.js';
import type { Db } from './db.js';

export type MemberAccount = {
  member_id: number;
  open_loans: number;
  balance_cents: number;
  can_borrow: boolean;
  blocks: string[];
};

export function memberAccount(db: Db, memberId: number): MemberAccount {
  const openLoans = db
    .prepare('SELECT COUNT(*) FROM loans WHERE member_id = ? AND returned_at IS NULL')
    .pluck()
    .get(memberId) as number;

  const balanceCents = db
    .prepare(
      `SELECT COALESCE(SUM(fines.amount_cents), 0)
            - COALESCE((SELECT SUM(payments.amount_cents)
                        FROM payments JOIN fines AS paid ON paid.id = payments.fine_id
                        WHERE paid.member_id = ?), 0)
       FROM fines WHERE fines.member_id = ?`,
    )
    .pluck()
    .get(memberId, memberId) as number;

  const blocks: string[] = [];
  if (openLoans >= MAX_OPEN_LOANS) {
    blocks.push(`member has ${openLoans} open loans; the limit is ${MAX_OPEN_LOANS}`);
  }
  if (balanceCents >= OUTSTANDING_BALANCE_LIMIT_CENTS) {
    blocks.push(
      `member owes ${balanceCents} cents; borrowing stops at ${OUTSTANDING_BALANCE_LIMIT_CENTS}`,
    );
  }

  return {
    member_id: memberId,
    open_loans: openLoans,
    balance_cents: balanceCents,
    can_borrow: blocks.length === 0,
    blocks,
  };
}
