-- Durable employee accounts, hashed opaque sessions, MFA enrollment and audit.
CREATE TABLE IF NOT EXISTS employee_accounts (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  login_name TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  totp_secret_ciphertext TEXT,
  totp_last_step INTEGER NOT NULL DEFAULT -1,
  activation_token_hash TEXT,
  activation_expires_at TEXT,
  activated_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS account_sessions_employee ON account_sessions(employee_id, expires_at);

CREATE TABLE IF NOT EXISTS account_recovery_codes (
  employee_id TEXT NOT NULL REFERENCES employees(id),
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY(employee_id, code_hash)
);

CREATE TABLE IF NOT EXISTS account_login_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT
);

CREATE TABLE IF NOT EXISTS account_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_role TEXT,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS account_audit_employee ON account_audit(employee_id, created_at);
CREATE TABLE IF NOT EXISTS account_role_changes (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  requested_role TEXT NOT NULL CHECK(requested_role IN ('employee','manager','hr','finance','approver','auditor')),
  requested_by TEXT NOT NULL REFERENCES employees(id),
  state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
  decided_by TEXT REFERENCES employees(id),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS account_role_changes_pending ON account_role_changes(state, created_at);
CREATE TRIGGER IF NOT EXISTS account_audit_no_update BEFORE UPDATE ON account_audit BEGIN SELECT RAISE(ABORT, 'append-only account audit'); END;
CREATE TRIGGER IF NOT EXISTS account_audit_no_delete BEFORE DELETE ON account_audit BEGIN SELECT RAISE(ABORT, 'append-only account audit'); END;
