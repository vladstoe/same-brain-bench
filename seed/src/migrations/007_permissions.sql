CREATE TABLE permissions (
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  UNIQUE (role, action)
);

INSERT INTO permissions (role, action) VALUES
  ('patron', 'authors.read'),
  ('patron', 'books.read'),
  ('patron', 'copies.read');

INSERT INTO permissions (role, action)
SELECT 'clerk', action FROM permissions WHERE role = 'patron';

INSERT INTO permissions (role, action) VALUES
  ('clerk', 'members.read'),
  ('clerk', 'loans.read'),
  ('clerk', 'loans.write'),
  ('clerk', 'fines.read'),
  ('clerk', 'payments.read'),
  ('clerk', 'payments.write');

INSERT INTO permissions (role, action)
SELECT 'librarian', action FROM permissions WHERE role = 'clerk';

INSERT INTO permissions (role, action) VALUES
  ('librarian', 'authors.write'),
  ('librarian', 'books.write'),
  ('librarian', 'copies.write'),
  ('librarian', 'members.write'),
  ('librarian', 'fines.write'),
  ('librarian', 'reports.read');

INSERT INTO permissions (role, action)
SELECT 'admin', action FROM permissions WHERE role = 'librarian';

INSERT INTO permissions (role, action) VALUES
  ('admin', 'audit.read'),
  ('admin', 'jobs.read'),
  ('admin', 'jobs.run'),
  ('admin', 'permissions.read');
