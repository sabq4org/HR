-- Annual leave entitlement (decision 015). The rule itself is an administrative_policies
-- version with policy_key 'annual-leave-entitlement' (create by HR, approve by the approver or
-- the system owner, never by its creator). These tables hold what the rule produced.
--
-- Accrual postings: one row per employee per "through" date, cumulative since the accrual
-- start. The ledger receives whole days only (leave_ledger.days is an integer); the fraction
-- stays here in thousandths of a day so a settlement pays the exact balance.
CREATE TABLE IF NOT EXISTS leave_accrual_postings (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  accrual_start TEXT NOT NULL,
  through_date TEXT NOT NULL,
  accrued_milli INTEGER NOT NULL CHECK(accrued_milli >= 0),
  posted_days INTEGER NOT NULL CHECK(posted_days >= 0),
  ledger_id INTEGER REFERENCES leave_ledger(id),
  rule_ids TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(employee_id, through_date)
);
CREATE TRIGGER IF NOT EXISTS leave_accrual_postings_no_update BEFORE UPDATE ON leave_accrual_postings BEGIN SELECT RAISE(ABORT, 'append-only leave accrual'); END;
CREATE TRIGGER IF NOT EXISTS leave_accrual_postings_no_delete BEFORE DELETE ON leave_accrual_postings BEGIN SELECT RAISE(ABORT, 'append-only leave accrual'); END;

-- Leave encashment on separation (labour law art. 111): HR prepares, finance reviews,
-- the approver or system owner approves. The calculation (wage components, rate, days) is
-- stored encrypted; amount and days are kept in clear for the state checks only.
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
  ledger_id INTEGER REFERENCES leave_ledger(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS leave_settlements_one_open ON leave_settlements(employee_id)
  WHERE state IN ('draft','pending_finance','pending_approver','approved');
CREATE TRIGGER IF NOT EXISTS leave_settlements_closed_no_update BEFORE UPDATE ON leave_settlements
WHEN OLD.state IN ('approved','rejected','cancelled')
BEGIN SELECT RAISE(ABORT, 'closed leave settlement is immutable'); END;
CREATE TRIGGER IF NOT EXISTS leave_settlements_no_delete BEFORE DELETE ON leave_settlements
BEGIN SELECT RAISE(ABORT, 'leave settlements are never deleted'); END;

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
CREATE TRIGGER IF NOT EXISTS leave_settlement_events_no_update BEFORE UPDATE ON leave_settlement_events BEGIN SELECT RAISE(ABORT, 'append-only settlement events'); END;
CREATE TRIGGER IF NOT EXISTS leave_settlement_events_no_delete BEFORE DELETE ON leave_settlement_events BEGIN SELECT RAISE(ABORT, 'append-only settlement events'); END;
