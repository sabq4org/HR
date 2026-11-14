-- Annual leave entitlement (decision 015). See server/migrations/019_leave_entitlement.sql.
CREATE TABLE IF NOT EXISTS leave_accrual_postings (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  accrual_start TEXT NOT NULL,
  through_date TEXT NOT NULL,
  accrued_milli INTEGER NOT NULL CHECK(accrued_milli >= 0),
  posted_days INTEGER NOT NULL CHECK(posted_days >= 0),
  ledger_id BIGINT REFERENCES leave_ledger(id),
  rule_ids TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(employee_id, through_date)
);
DROP TRIGGER IF EXISTS leave_accrual_postings_no_update ON leave_accrual_postings;
CREATE TRIGGER leave_accrual_postings_no_update BEFORE UPDATE OR DELETE ON leave_accrual_postings FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TABLE IF NOT EXISTS leave_settlements (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  state TEXT NOT NULL CHECK(state IN ('draft','pending_finance','pending_approver','approved','rejected','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  last_day TEXT NOT NULL,
  reason_type TEXT NOT NULL CHECK(reason_type IN ('resignation','contract_end','employer','mutual','other')),
  calculation_ciphertext TEXT NOT NULL,
  balance_milli INTEGER NOT NULL CHECK(balance_milli >= 0),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  prepared_by TEXT NOT NULL REFERENCES employees(id),
  reviewed_by TEXT REFERENCES employees(id),
  approved_by TEXT REFERENCES employees(id),
  ledger_id BIGINT REFERENCES leave_ledger(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS leave_settlements_one_open ON leave_settlements(employee_id)
  WHERE state IN ('draft','pending_finance','pending_approver','approved');
CREATE OR REPLACE FUNCTION prevent_closed_leave_settlement_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'leave settlements are never deleted'; END IF;
  IF OLD.state IN ('approved','rejected','cancelled') THEN RAISE EXCEPTION 'closed leave settlement is immutable'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS leave_settlements_guard ON leave_settlements;
CREATE TRIGGER leave_settlements_guard BEFORE UPDATE OR DELETE ON leave_settlements FOR EACH ROW EXECUTE FUNCTION prevent_closed_leave_settlement_change();

CREATE TABLE IF NOT EXISTS leave_settlement_events (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES leave_settlements(id),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leave_settlement_events_settlement ON leave_settlement_events(settlement_id, created_at);
DROP TRIGGER IF EXISTS leave_settlement_events_no_update ON leave_settlement_events;
CREATE TRIGGER leave_settlement_events_no_update BEFORE UPDATE OR DELETE ON leave_settlement_events FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
