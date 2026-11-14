-- Synthetic payroll run ledger and command replay, isolated from administration commands.
CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('draft','pending_finance','pending_approver','closed','rejected')),
  prepared_by TEXT NOT NULL REFERENCES employees(id),
  reviewed_by TEXT REFERENCES employees(id),
  approved_by TEXT REFERENCES employees(id),
  policy_id TEXT NOT NULL REFERENCES administrative_policies(id),
  correction_of TEXT REFERENCES payroll_runs(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS payroll_runs_state_period ON payroll_runs(state, period);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_one_primary_run_per_period
ON payroll_runs(period) WHERE correction_of IS NULL AND state <> 'rejected';
CREATE TABLE IF NOT EXISTS payroll_lines (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  component TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('earning','deduction')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
  source TEXT NOT NULL,
  source_request_id TEXT REFERENCES administrative_requests(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payroll_lines_run_employee ON payroll_lines(run_id, employee_id);
CREATE TABLE IF NOT EXISTS payroll_payments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  state TEXT NOT NULL CHECK(state IN ('pending','paid','failed','partial')),
  paid_minor INTEGER NOT NULL CHECK(paid_minor>=0),
  encrypted_reference TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES employees(id),
  UNIQUE(run_id,employee_id)
);
CREATE TRIGGER IF NOT EXISTS payroll_lines_closed_no_update BEFORE UPDATE ON payroll_lines
WHEN (SELECT state FROM payroll_runs WHERE id=OLD.run_id)='closed'
BEGIN SELECT RAISE(ABORT, 'closed payroll lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payroll_lines_closed_no_delete BEFORE DELETE ON payroll_lines
WHEN (SELECT state FROM payroll_runs WHERE id=OLD.run_id)='closed'
BEGIN SELECT RAISE(ABORT, 'closed payroll lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payroll_run_closed_no_update BEFORE UPDATE ON payroll_runs
WHEN OLD.state='closed'
BEGIN SELECT RAISE(ABORT, 'closed payroll run is immutable'); END;
CREATE TRIGGER IF NOT EXISTS payroll_run_closed_no_delete BEFORE DELETE ON payroll_runs
WHEN OLD.state='closed'
BEGIN SELECT RAISE(ABORT, 'closed payroll run is immutable'); END;

CREATE TABLE IF NOT EXISTS payroll_commands (
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  command_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, action, command_key)
);

CREATE TABLE IF NOT EXISTS payroll_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payroll_events_run ON payroll_events(run_id, created_at);
CREATE TRIGGER IF NOT EXISTS payroll_events_no_update BEFORE UPDATE ON payroll_events
BEGIN SELECT RAISE(ABORT, 'payroll events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS payroll_events_no_delete BEFORE DELETE ON payroll_events
BEGIN SELECT RAISE(ABORT, 'payroll events are append-only'); END;
