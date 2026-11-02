CREATE TABLE loans (
  id INTEGER PRIMARY KEY,
  copy_id INTEGER NOT NULL REFERENCES copies(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  borrowed_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  returned_at TEXT
);

CREATE INDEX loans_member_id ON loans(member_id);

CREATE UNIQUE INDEX loans_open_copy ON loans(copy_id) WHERE returned_at IS NULL;
