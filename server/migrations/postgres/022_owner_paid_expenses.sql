-- Expenses the owner paid from his own card and the company later refunds (decision 022).
--
-- 1. Attachments: the scanned supplier invoice kept with a ledger voucher. The file is encrypted
--    with the data key and stored in this database; there are no public links. An attachment is
--    never overwritten: a wrong file is marked removed (kept for the audit trail).
CREATE TABLE IF NOT EXISTS finance_voucher_attachments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  voucher_id TEXT NOT NULL,
  file_name_ciphertext TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('application/pdf','image/png','image/jpeg')),
  size_bytes BIGINT NOT NULL CHECK(size_bytes > 0),
  checksum TEXT NOT NULL,
  content_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','removed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  removed_by TEXT,
  removed_at TEXT,
  UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, voucher_id) REFERENCES finance_vouchers(owner_id, id)
);
CREATE INDEX IF NOT EXISTS finance_voucher_attachments_voucher
  ON finance_voucher_attachments(owner_id, voucher_id, state);
CREATE OR REPLACE FUNCTION prevent_finance_attachment_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'attachments are kept; mark them removed';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS finance_voucher_attachments_no_delete ON finance_voucher_attachments;
CREATE TRIGGER finance_voucher_attachments_no_delete BEFORE DELETE ON finance_voucher_attachments FOR EACH ROW EXECUTE FUNCTION prevent_finance_attachment_delete();
CREATE OR REPLACE FUNCTION prevent_finance_attachment_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'attachment content is immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS finance_voucher_attachments_content_fixed ON finance_voucher_attachments;
CREATE TRIGGER finance_voucher_attachments_content_fixed BEFORE UPDATE OF content_ciphertext, checksum, size_bytes, mime_type, voucher_id, file_name_ciphertext ON finance_voucher_attachments FOR EACH ROW EXECUTE FUNCTION prevent_finance_attachment_change();

-- 2. Refund allocations: which owner-paid documents a refund voucher settles, and by how much.
--    Append-only. A reversed refund voucher stops counting; its rows stay as history.
CREATE TABLE IF NOT EXISTS finance_owner_allocations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  refund_voucher_id TEXT NOT NULL,
  claim_voucher_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK(amount > 0),
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, refund_voucher_id, claim_voucher_id),
  FOREIGN KEY(owner_id, refund_voucher_id) REFERENCES finance_vouchers(owner_id, id),
  FOREIGN KEY(owner_id, claim_voucher_id) REFERENCES finance_vouchers(owner_id, id)
);
CREATE INDEX IF NOT EXISTS finance_owner_allocations_claim ON finance_owner_allocations(owner_id, claim_voucher_id);
CREATE OR REPLACE FUNCTION prevent_finance_allocation_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'allocations are append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS finance_owner_allocations_no_update ON finance_owner_allocations;
CREATE TRIGGER finance_owner_allocations_no_update BEFORE UPDATE ON finance_owner_allocations FOR EACH ROW EXECUTE FUNCTION prevent_finance_allocation_change();
DROP TRIGGER IF EXISTS finance_owner_allocations_no_delete ON finance_owner_allocations;
CREATE TRIGGER finance_owner_allocations_no_delete BEFORE DELETE ON finance_owner_allocations FOR EACH ROW EXECUTE FUNCTION prevent_finance_allocation_change();

-- 3. The liability account "due to the owner" for ledgers set up before this migration, when its
--    suggested code is free. The application adds it on first use otherwise.
INSERT INTO finance_accounts(owner_id,code,name,type,normal_side,parent_code,postable,is_cash,system_key,default_tax_code,active,version,created_at,updated_at)
SELECT s.owner_id,'2160','مستحق للمالك – مصروفات سددها من ماله الخاص','liability','credit','21',1,0,'owner_payable',NULL,1,1,s.created_at,s.created_at
FROM finance_ledger_settings s
WHERE NOT EXISTS (SELECT 1 FROM finance_accounts a WHERE a.owner_id=s.owner_id AND (a.code='2160' OR a.system_key='owner_payable'))
  AND EXISTS (SELECT 1 FROM finance_accounts p WHERE p.owner_id=s.owner_id AND p.code='21');
