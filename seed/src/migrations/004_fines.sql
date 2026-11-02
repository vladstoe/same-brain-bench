CREATE TABLE fines (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  loan_id INTEGER REFERENCES loans(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX fines_member_id ON fines(member_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  fine_id INTEGER NOT NULL REFERENCES fines(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_at TEXT NOT NULL,
  received_by INTEGER NOT NULL REFERENCES members(id)
);

CREATE INDEX payments_fine_id ON payments(fine_id);
