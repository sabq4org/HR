CREATE TABLE IF NOT EXISTS employment_periods (
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), start_date TEXT NOT NULL, end_date TEXT,
  relationship_type TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'synthetic-demo-only', created_at TEXT NOT NULL,
  UNIQUE(employee_id, start_date)
);
CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY, policy_key TEXT NOT NULL, version TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
  approval_status TEXT NOT NULL, source TEXT NOT NULL, allocated_days INTEGER NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(policy_key, version)
);
CREATE TABLE IF NOT EXISTS work_schedules (
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), version TEXT NOT NULL,
  timezone TEXT NOT NULL, working_days_json TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(employee_id, version)
);
ALTER TABLE leave_requests ADD COLUMN policy_version_id TEXT REFERENCES policy_versions(id);
ALTER TABLE leave_requests ADD COLUMN work_schedule_id TEXT REFERENCES work_schedules(id);
