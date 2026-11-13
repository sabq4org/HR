CREATE UNIQUE INDEX IF NOT EXISTS employment_period_one_open_idx
  ON employment_periods(employee_id) WHERE end_date IS NULL;
ALTER TABLE policy_versions ADD COLUMN working_days_json TEXT NOT NULL DEFAULT '[0,1,2,3,4]';
