ALTER TABLE leave_requests ADD COLUMN calculation_snapshot_json TEXT;
ALTER TABLE leave_requests ADD COLUMN current_flag INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leave_requests ADD COLUMN parent_leave_id TEXT REFERENCES leave_requests(id);
ALTER TABLE leave_requests ADD COLUMN change_id TEXT;
ALTER TABLE leave_ledger ADD COLUMN operation_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS leave_ledger_operation_ref_uq ON leave_ledger(operation_ref) WHERE operation_ref IS NOT NULL;
ALTER TABLE policy_versions ADD COLUMN source_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE policy_versions ADD COLUMN approval_reference TEXT;
ALTER TABLE policy_versions ADD COLUMN holiday_dates_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE policy_versions ADD COLUMN approved_by TEXT;
ALTER TABLE policy_versions ADD COLUMN approved_at TEXT;
ALTER TABLE policy_versions ADD COLUMN created_by TEXT;
CREATE TABLE IF NOT EXISTS leave_policy_assignments (
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), policy_version_id TEXT NOT NULL REFERENCES policy_versions(id),
  effective_from TEXT NOT NULL, effective_to TEXT, opening_balance INTEGER NOT NULL CHECK(opening_balance >= 0),
  approval_reference TEXT NOT NULL, assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending','approved','rejected','cancelled')),
  approved_by TEXT, approved_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  UNIQUE(employee_id, policy_version_id, effective_from)
);
CREATE TABLE IF NOT EXISTS leave_change_requests (
  id TEXT PRIMARY KEY, leave_id TEXT NOT NULL REFERENCES leave_requests(id), employee_id TEXT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK(kind IN ('cancel','extend','early_return','amend')),
  status TEXT NOT NULL CHECK(status IN ('pending_manager','pending_hr','approved','rejected','cancelled')),
  version INTEGER NOT NULL DEFAULT 1, original_version INTEGER NOT NULL,
  original_snapshot_json TEXT NOT NULL, proposed_snapshot_json TEXT NOT NULL,
  proposed_start_date TEXT NOT NULL, proposed_end_date TEXT NOT NULL,
  reason TEXT NOT NULL, reserve_days INTEGER NOT NULL DEFAULT 0 CHECK(reserve_days >= 0),
  created_at TEXT NOT NULL, manager_decision_at TEXT, hr_decision_at TEXT, decision_reason TEXT,
  manager_decided_by TEXT, hr_decided_by TEXT,
  replacement_leave_id TEXT REFERENCES leave_requests(id)
);
CREATE INDEX IF NOT EXISTS leave_change_requests_leave_idx ON leave_change_requests(leave_id, created_at);
CREATE INDEX IF NOT EXISTS leave_change_pending_dates_idx ON leave_change_requests(employee_id, proposed_start_date, proposed_end_date, status);
CREATE UNIQUE INDEX IF NOT EXISTS leave_change_one_pending_per_leave_idx ON leave_change_requests(leave_id) WHERE status IN ('pending_manager','pending_hr');
