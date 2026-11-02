CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patron', 'clerk', 'librarian', 'admin'))
);
