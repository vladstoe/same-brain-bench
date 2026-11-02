CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX reports_kind_generated_at ON reports(kind, generated_at);
