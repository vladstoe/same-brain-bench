export const MEMBER_ROLES = ['patron', 'clerk', 'librarian', 'admin'] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

export type Author = {
  id: number;
  name: string;
};

export type Book = {
  id: number;
  title: string;
  author_id: number;
};

export type Copy = {
  id: number;
  book_id: number;
  barcode: string;
  acquired_at: string;
  withdrawn_at: string | null;
};

export type Member = {
  id: number;
  name: string;
  role: MemberRole;
};

export type Permission = {
  role: MemberRole;
  action: string;
};

export type Loan = {
  id: number;
  copy_id: number;
  member_id: number;
  borrowed_at: string;
  due_at: string;
  returned_at: string | null;
};

export type Fine = {
  id: number;
  member_id: number;
  loan_id: number | null;
  amount_cents: number;
  reason: string;
  created_at: string;
};

export type Payment = {
  id: number;
  fine_id: number;
  amount_cents: number;
  paid_at: string;
  received_by: number;
};

export type Report = {
  id: number;
  kind: string;
  period: string;
  generated_at: string;
  body: string;
};

export type AuditRow = {
  id: number;
  at: string;
  actor_member_id: number | null;
  action: string;
  entity: string;
  entity_id: number | null;
  data: string;
};
