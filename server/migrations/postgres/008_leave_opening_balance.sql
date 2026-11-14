CREATE TABLE IF NOT EXISTS leave_balance_openings (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES administrative_requests(id),
  days INTEGER NOT NULL CHECK(days >= 0),
  effective_at TEXT NOT NULL,
  ledger_id BIGINT UNIQUE REFERENCES leave_ledger(id),
  source_ciphertext TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL
);
DROP TRIGGER IF EXISTS leave_balance_openings_no_update ON leave_balance_openings;
CREATE TRIGGER leave_balance_openings_no_update BEFORE UPDATE OR DELETE ON leave_balance_openings FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
ALTER TABLE leave_balance_adjustments ADD COLUMN ledger_id BIGINT REFERENCES leave_ledger(id);
ALTER TABLE leave_balance_adjustments ADD COLUMN source_ciphertext TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS leave_balance_adjustments_ledger ON leave_balance_adjustments(ledger_id);
