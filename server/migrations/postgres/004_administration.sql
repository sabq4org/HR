-- Administration foundation. Sensitive field values and document contents are
-- AES-GCM ciphertext at the application layer; never store them as plaintext.
ALTER TABLE employees ADD COLUMN access_role TEXT;
ALTER TABLE employees ADD COLUMN employment_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE employees ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE VIEW employee_access AS
SELECT id, employee_number, name, initials, title, department, email, location,
       manager_id, join_date, COALESCE(access_role, role) AS role, color,
       employment_status AS status, access_role, record_version
FROM employees;

CREATE TABLE IF NOT EXISTS employee_profile_data (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  public_values_json TEXT NOT NULL DEFAULT '{}',
  encrypted_values_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_profile_history (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  field_key TEXT NOT NULL,
  old_value_ciphertext TEXT,
  new_value_ciphertext TEXT,
  effective_at TEXT NOT NULL,
  reason_ciphertext TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS employee_profile_history_employee ON employee_profile_history(employee_id, effective_at);
DROP TRIGGER IF EXISTS employee_profile_history_no_update ON employee_profile_history;
CREATE TRIGGER employee_profile_history_no_update BEFORE UPDATE OR DELETE ON employee_profile_history FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TABLE IF NOT EXISTS administrative_policies (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  source TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','synthetic_approved','retired')),
  values_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(policy_key, version)
);

CREATE TABLE IF NOT EXISTS administrative_requests (
  id TEXT PRIMARY KEY,
  request_number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  created_by TEXT NOT NULL REFERENCES employees(id),
  state TEXT NOT NULL CHECK(state IN ('draft','pending_manager','pending_hr','pending_finance','pending_approver','returned','approved','rejected','cancelled','closed')),
  version INTEGER NOT NULL DEFAULT 1,
  values_json TEXT NOT NULL DEFAULT '{}',
  issued_document_json TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  step_index INTEGER NOT NULL DEFAULT 0 CHECK(step_index >= 0),
  policy_id TEXT REFERENCES administrative_policies(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS administrative_requests_owner_created ON administrative_requests(employee_id, created_at);
CREATE INDEX IF NOT EXISTS administrative_requests_state_updated ON administrative_requests(state, updated_at);
ALTER TABLE outbox ADD COLUMN request_id TEXT REFERENCES administrative_requests(id);

CREATE TABLE IF NOT EXISTS employee_documents (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  category TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  expires_at TEXT,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES employees(id),
  checksum TEXT NOT NULL,
  encrypted_content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived'))
);
CREATE INDEX IF NOT EXISTS employee_documents_owner_expiry ON employee_documents(employee_id, state, expires_at);
CREATE INDEX IF NOT EXISTS employee_documents_expiry ON employee_documents(state, expires_at);

CREATE TABLE IF NOT EXISTS administration_workspace_capacity (
  id TEXT PRIMARY KEY CHECK(id='workspace'),
  employee_count INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  document_bytes INTEGER NOT NULL
);
INSERT INTO administration_workspace_capacity(id,employee_count,document_count,document_bytes)
VALUES('workspace',(SELECT COUNT(*) FROM employees),(SELECT COUNT(*) FROM employee_documents),(SELECT COALESCE(SUM(size_bytes),0) FROM employee_documents))
ON CONFLICT(id) DO NOTHING;
CREATE OR REPLACE FUNCTION enforce_administration_capacity() RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME='employees' THEN
    IF EXISTS(SELECT 1 FROM employees WHERE id=NEW.id) THEN RETURN NEW; END IF;
    UPDATE administration_workspace_capacity SET employee_count=employee_count+1 WHERE id='workspace' AND employee_count<200;
  ELSE
    UPDATE administration_workspace_capacity SET document_count=document_count+1,document_bytes=document_bytes+NEW.size_bytes
      WHERE id='workspace' AND document_count<30 AND document_bytes+NEW.size_bytes<=6291456;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_CAPACITY_EXCEEDED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS administration_employee_capacity ON employees;
CREATE TRIGGER administration_employee_capacity BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION enforce_administration_capacity();
DROP TRIGGER IF EXISTS administration_document_capacity ON employee_documents;
CREATE TRIGGER administration_document_capacity BEFORE INSERT ON employee_documents FOR EACH ROW EXECUTE FUNCTION enforce_administration_capacity();


CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK(minutes > 0),
  work_mode TEXT NOT NULL CHECK(work_mode IN ('office','remote','field')),
  encrypted_note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'submitted' CHECK(state IN ('submitted','approved','rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  reviewed_by TEXT REFERENCES employees(id),
  encrypted_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS attendance_records_review_queue ON attendance_records(state, work_date);

CREATE TABLE IF NOT EXISTS leave_balance_adjustments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES administrative_requests(id),
  days INTEGER NOT NULL CHECK(days != 0),
  effective_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL
);
DROP TRIGGER IF EXISTS leave_balance_adjustments_no_update ON leave_balance_adjustments;
CREATE TRIGGER leave_balance_adjustments_no_update BEFORE UPDATE OR DELETE ON leave_balance_adjustments FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TABLE IF NOT EXISTS administration_idempotency (
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, action, key)
);

CREATE TABLE IF NOT EXISTS administration_events (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  resource_version INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS administration_events_resource ON administration_events(resource_type, resource_id, created_at);
CREATE INDEX IF NOT EXISTS administration_events_actor ON administration_events(actor_id, created_at);
DROP TRIGGER IF EXISTS administration_events_no_update ON administration_events;
CREATE TRIGGER administration_events_no_update BEFORE UPDATE OR DELETE ON administration_events FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
