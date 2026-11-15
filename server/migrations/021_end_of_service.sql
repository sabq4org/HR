-- End-of-service award (decision 016). The rule is an administrative_policies version with
-- policy_key 'end-of-service-award'. These tables hold verified service and the settlements.
--
-- Service periods: HR records the source it checked; a verified period is never edited again
-- (separation only closes an open end date). Every change is an append-only event.
ALTER TABLE employment_periods ADD COLUMN verified_by TEXT REFERENCES employees(id);
ALTER TABLE employment_periods ADD COLUMN verified_at TEXT;
CREATE TABLE IF NOT EXISTS employment_period_events (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES employment_periods(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  action TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  source TEXT NOT NULL,
  reason TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS employment_period_events_employee ON employment_period_events(employee_id, created_at);
CREATE TRIGGER IF NOT EXISTS employment_period_events_no_update BEFORE UPDATE ON employment_period_events BEGIN SELECT RAISE(ABORT, 'append-only period events'); END;
CREATE TRIGGER IF NOT EXISTS employment_period_events_no_delete BEFORE DELETE ON employment_period_events BEGIN SELECT RAISE(ABORT, 'append-only period events'); END;

-- Settlements: HR prepares, finance reviews, the approver or system owner approves. The
-- calculation is stored encrypted; the amount stays in clear for state checks only. Nothing is
-- paid from the system.
CREATE TABLE IF NOT EXISTS eos_settlements (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  state TEXT NOT NULL CHECK(state IN ('pending_finance','pending_approver','approved','rejected','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  last_day TEXT NOT NULL,
  reason_type TEXT NOT NULL,
  calculation_ciphertext TEXT NOT NULL,
  service_days INTEGER NOT NULL CHECK(service_days >= 0),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  prepared_by TEXT NOT NULL REFERENCES employees(id),
  reviewed_by TEXT REFERENCES employees(id),
  approved_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS eos_settlements_one_open ON eos_settlements(employee_id)
  WHERE state IN ('pending_finance','pending_approver');
CREATE TRIGGER IF NOT EXISTS eos_settlements_closed_no_update BEFORE UPDATE ON eos_settlements
WHEN OLD.state IN ('approved','rejected','cancelled')
BEGIN SELECT RAISE(ABORT, 'closed end-of-service settlement is immutable'); END;
CREATE TRIGGER IF NOT EXISTS eos_settlements_no_delete BEFORE DELETE ON eos_settlements
BEGIN SELECT RAISE(ABORT, 'end-of-service settlements are never deleted'); END;

CREATE TABLE IF NOT EXISTS eos_settlement_events (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES eos_settlements(id),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS eos_settlement_events_settlement ON eos_settlement_events(settlement_id, created_at);
CREATE TRIGGER IF NOT EXISTS eos_settlement_events_no_update BEFORE UPDATE ON eos_settlement_events BEGIN SELECT RAISE(ABORT, 'append-only settlement events'); END;
CREATE TRIGGER IF NOT EXISTS eos_settlement_events_no_delete BEFORE DELETE ON eos_settlement_events BEGIN SELECT RAISE(ABORT, 'append-only settlement events'); END;
