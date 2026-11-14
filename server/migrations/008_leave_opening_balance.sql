-- One explicitly sourced, approved opening leave balance per employee.
-- Kept separate from ordinary corrections so zero remains representable.
CREATE TABLE IF NOT EXISTS leave_balance_openings (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES administrative_requests(id),
  days INTEGER NOT NULL CHECK(days >= 0),
  effective_at TEXT NOT NULL,
  ledger_id INTEGER UNIQUE REFERENCES leave_ledger(id),
  source_ciphertext TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS leave_balance_openings_no_update BEFORE UPDATE ON leave_balance_openings BEGIN SELECT RAISE(ABORT, 'append-only leave opening balance'); END;
CREATE TRIGGER IF NOT EXISTS leave_balance_openings_no_delete BEFORE DELETE ON leave_balance_openings BEGIN SELECT RAISE(ABORT, 'append-only leave opening balance'); END;
ALTER TABLE leave_balance_adjustments ADD COLUMN ledger_id INTEGER REFERENCES leave_ledger(id);
ALTER TABLE leave_balance_adjustments ADD COLUMN source_ciphertext TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS leave_balance_adjustments_ledger ON leave_balance_adjustments(ledger_id);
