-- Durable employee accounts, hashed opaque sessions, MFA enrollment and audit.
CREATE TABLE IF NOT EXISTS employee_accounts (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  login_name TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  totp_secret_ciphertext TEXT,
  totp_last_step BIGINT NOT NULL DEFAULT -1,
  activation_token_hash TEXT,
  activation_expires_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS account_sessions_employee ON account_sessions(employee_id, expires_at);
CREATE TABLE IF NOT EXISTS account_recovery_codes (
  employee_id TEXT NOT NULL REFERENCES employees(id),
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  PRIMARY KEY(employee_id, code_hash)
);
CREATE TABLE IF NOT EXISTS account_login_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS account_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_role TEXT,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb
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
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS account_role_changes_pending ON account_role_changes(state, created_at);
CREATE OR REPLACE FUNCTION reject_account_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only account audit'; END; $$;
CREATE TRIGGER account_audit_no_update BEFORE UPDATE ON account_audit FOR EACH ROW EXECUTE FUNCTION reject_account_audit_mutation();
CREATE TRIGGER account_audit_no_delete BEFORE DELETE ON account_audit FOR EACH ROW EXECUTE FUNCTION reject_account_audit_mutation();
