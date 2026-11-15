-- End-of-service award (decision 016). See server/migrations/021_end_of_service.sql.
ALTER TABLE employment_periods ADD COLUMN IF NOT EXISTS verified_by TEXT REFERENCES employees(id);
ALTER TABLE employment_periods ADD COLUMN IF NOT EXISTS verified_at TEXT;
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
DROP TRIGGER IF EXISTS employment_period_events_no_update ON employment_period_events;
CREATE TRIGGER employment_period_events_no_update BEFORE UPDATE OR DELETE ON employment_period_events FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TABLE IF NOT EXISTS eos_settlements (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  state TEXT NOT NULL CHECK(state IN ('pending_finance','pending_approver','approved','rejected','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  last_day TEXT NOT NULL,
  reason_type TEXT NOT NULL,
  calculation_ciphertext TEXT NOT NULL,
  service_days INTEGER NOT NULL CHECK(service_days >= 0),
  amount_minor BIGINT NOT NULL CHECK(amount_minor >= 0),
  prepared_by TEXT NOT NULL REFERENCES employees(id),
  reviewed_by TEXT REFERENCES employees(id),
  approved_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS eos_settlements_one_open ON eos_settlements(employee_id)
  WHERE state IN ('pending_finance','pending_approver');
CREATE OR REPLACE FUNCTION prevent_closed_eos_settlement_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'end-of-service settlements are never deleted'; END IF;
  IF OLD.state IN ('approved','rejected','cancelled') THEN RAISE EXCEPTION 'closed end-of-service settlement is immutable'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS eos_settlements_guard ON eos_settlements;
CREATE TRIGGER eos_settlements_guard BEFORE UPDATE OR DELETE ON eos_settlements FOR EACH ROW EXECUTE FUNCTION prevent_closed_eos_settlement_change();

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
DROP TRIGGER IF EXISTS eos_settlement_events_no_update ON eos_settlement_events;
CREATE TRIGGER eos_settlement_events_no_update BEFORE UPDATE OR DELETE ON eos_settlement_events FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
