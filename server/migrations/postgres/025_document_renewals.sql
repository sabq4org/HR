-- Renewal follow-up cases (decision 025).
CREATE TABLE IF NOT EXISTS document_renewals (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES employee_documents(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  category TEXT NOT NULL,
  original_expiry TEXT NOT NULL,
  assigned_to TEXT NOT NULL REFERENCES employees(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','renewed','cancelled')),
  new_expiry TEXT,
  proof_document_id TEXT REFERENCES employee_documents(id),
  payment TEXT CHECK(payment IN ('none','owner') OR payment IS NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  fee_halalas INTEGER CHECK(fee_halalas IS NULL OR fee_halalas >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(proof_document_id)
);
CREATE INDEX IF NOT EXISTS document_renewals_employee_status
  ON document_renewals(employee_id,status,original_expiry);
CREATE INDEX IF NOT EXISTS document_renewals_assignee_status
  ON document_renewals(assigned_to,status,original_expiry);
CREATE UNIQUE INDEX IF NOT EXISTS document_renewals_cycle_uq
  ON document_renewals(document_id,original_expiry)
  WHERE status <> 'cancelled';
DROP TRIGGER IF EXISTS document_renewals_no_delete ON document_renewals;
CREATE TRIGGER document_renewals_no_delete
  BEFORE DELETE ON document_renewals FOR EACH ROW
  EXECUTE FUNCTION prevent_append_only_mutation();
