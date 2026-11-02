CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_member_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_log_at ON audit_log(at);

CREATE INDEX audit_log_entity ON audit_log(entity, entity_id);
