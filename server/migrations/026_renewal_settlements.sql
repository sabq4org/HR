-- Finance reconciliation for owner-paid document renewals (decision 025).
-- A settlement is a reference to an existing voucher, never a new journal entry. Corrections
-- close the old link and append a new active link so the audit trail remains intact.
CREATE TABLE IF NOT EXISTS finance_renewal_settlements (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  renewal_id TEXT NOT NULL,
  voucher_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','corrected')),
  reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  corrected_at TEXT,
  UNIQUE(owner_id, id),
  FOREIGN KEY(renewal_id) REFERENCES document_renewals(id),
  FOREIGN KEY(owner_id, voucher_id) REFERENCES finance_vouchers(owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_renewal_settlements_one_active_case
  ON finance_renewal_settlements(renewal_id) WHERE state='active';
CREATE UNIQUE INDEX IF NOT EXISTS finance_renewal_settlements_one_active_voucher
  ON finance_renewal_settlements(owner_id, voucher_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS finance_renewal_settlements_owner_state
  ON finance_renewal_settlements(owner_id, state, renewal_id);
