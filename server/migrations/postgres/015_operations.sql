CREATE TABLE IF NOT EXISTS operations_reminder_dedupe (
  dedupe_key TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL,
  threshold_key TEXT NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_reminder_resource
  ON operations_reminder_dedupe(resource_type, resource_id, created_at);

CREATE TABLE IF NOT EXISTS operations_job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  reminders_created INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT
);
CREATE INDEX IF NOT EXISTS operations_job_runs_recent
  ON operations_job_runs(job_name, started_at);
