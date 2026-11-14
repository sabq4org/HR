-- Double-entry ledger for the private finance workspace. Amounts are integer
-- halalas. Journal entries and lines are append-only: a correction is a new
-- reversing entry, never an UPDATE or DELETE. owner_id scopes every row.
CREATE TABLE IF NOT EXISTS finance_ledger_settings (
  owner_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  filing_frequency TEXT NOT NULL DEFAULT 'quarterly' CHECK(filing_frequency IN ('quarterly','monthly')),
  default_revenue_account TEXT NOT NULL DEFAULT '',
  default_cash_account TEXT NOT NULL DEFAULT '',
  vat_correction_limit INTEGER NOT NULL DEFAULT 0 CHECK(vat_correction_limit >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_accounts (
  owner_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
  normal_side TEXT NOT NULL CHECK(normal_side IN ('debit','credit')),
  parent_code TEXT,
  postable INTEGER NOT NULL DEFAULT 1 CHECK(postable IN (0,1)),
  is_cash INTEGER NOT NULL DEFAULT 0 CHECK(is_cash IN (0,1)),
  system_key TEXT,
  default_tax_code TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_system_key
  ON finance_accounts(owner_id, system_key) WHERE system_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS finance_journal_entries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  entry_no TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('manual','opening','invoice','credit_note','receipt','revenue','expense','payment','vat_close','vat_payment','reversal')),
  source_id TEXT NOT NULL,
  reversal_of TEXT,
  -- Date of the entry being reversed; lets the VAT return show late reversals as adjustments.
  original_date TEXT,
  description_ciphertext TEXT NOT NULL,
  total INTEGER NOT NULL CHECK(total > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, id),
  UNIQUE(owner_id, entry_no),
  -- One entry per source document and one reversal per entry.
  UNIQUE(owner_id, kind, source_id)
);
CREATE INDEX IF NOT EXISTS finance_journal_entries_owner_date ON finance_journal_entries(owner_id, entry_date);
CREATE TABLE IF NOT EXISTS finance_journal_lines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  tax_side TEXT CHECK(tax_side IN ('sales','purchases')),
  tax_code TEXT CHECK(tax_code IN ('S','ZD','ZE','E','O','IMP','RC','ND')),
  tax_role TEXT CHECK(tax_role IN ('base','output','input')),
  memo_ciphertext TEXT,
  CHECK(debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND debit + credit > 0),
  CHECK((tax_side IS NULL AND tax_code IS NULL AND tax_role IS NULL) OR (tax_side IS NOT NULL AND tax_code IS NOT NULL AND tax_role IS NOT NULL)),
  UNIQUE(owner_id, entry_id, line_no),
  FOREIGN KEY(owner_id, entry_id) REFERENCES finance_journal_entries(owner_id, id),
  FOREIGN KEY(owner_id, account_code) REFERENCES finance_accounts(owner_id, code)
);
CREATE INDEX IF NOT EXISTS finance_journal_lines_owner_account ON finance_journal_lines(owner_id, account_code);
CREATE INDEX IF NOT EXISTS finance_journal_lines_owner_entry ON finance_journal_lines(owner_id, entry_id);
CREATE TRIGGER IF NOT EXISTS finance_journal_entries_no_update BEFORE UPDATE ON finance_journal_entries
BEGIN SELECT RAISE(ABORT, 'journal entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS finance_journal_entries_no_delete BEFORE DELETE ON finance_journal_entries
BEGIN SELECT RAISE(ABORT, 'journal entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS finance_journal_lines_no_update BEFORE UPDATE ON finance_journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are append-only'); END;
CREATE TRIGGER IF NOT EXISTS finance_journal_lines_no_delete BEFORE DELETE ON finance_journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are append-only'); END;
CREATE TABLE IF NOT EXISTS finance_vendors (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  vendor_ciphertext TEXT NOT NULL,
  resident INTEGER NOT NULL DEFAULT 1 CHECK(resident IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, id)
);
-- Source documents behind automatic entries. A voucher is never edited after
-- posting; status only moves posted -> reversed together with a reversing entry.
CREATE TABLE IF NOT EXISTS finance_vouchers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('invoice','credit_note','receipt','revenue','expense','payment')),
  number TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  account_code TEXT,
  cash_account_code TEXT,
  party_id TEXT,
  related_id TEXT,
  tax_code TEXT,
  net INTEGER NOT NULL CHECK(net >= 0),
  vat INTEGER NOT NULL CHECK(vat >= 0),
  total INTEGER NOT NULL CHECK(total > 0),
  entry_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','reversed')),
  details_ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, id),
  UNIQUE(owner_id, number),
  FOREIGN KEY(owner_id, entry_id) REFERENCES finance_journal_entries(owner_id, id)
);
CREATE INDEX IF NOT EXISTS finance_vouchers_owner_kind_date ON finance_vouchers(owner_id, kind, doc_date);
CREATE INDEX IF NOT EXISTS finance_vouchers_owner_related ON finance_vouchers(owner_id, related_id);
-- An invoice is posted to the ledger at most once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS finance_vouchers_one_invoice_posting
  ON finance_vouchers(owner_id, related_id) WHERE kind = 'invoice' AND status = 'posted';
CREATE TABLE IF NOT EXISTS finance_budget_years (
  owner_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, year)
);
CREATE TABLE IF NOT EXISTS finance_budgets (
  owner_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  amount INTEGER NOT NULL CHECK(amount >= 0),
  PRIMARY KEY(owner_id, year, account_code, month),
  FOREIGN KEY(owner_id, account_code) REFERENCES finance_accounts(owner_id, code)
);
CREATE TABLE IF NOT EXISTS finance_period_locks (
  owner_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  locked INTEGER NOT NULL DEFAULT 1 CHECK(locked IN (0,1)),
  reason TEXT NOT NULL CHECK(reason IN ('manual','vat')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, year, month)
);
CREATE TABLE IF NOT EXISTS finance_vat_returns (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('closed','filed','paid')),
  boxes_json TEXT NOT NULL,
  correction INTEGER NOT NULL DEFAULT 0,
  correction_note_ciphertext TEXT,
  credit_brought_forward INTEGER NOT NULL DEFAULT 0 CHECK(credit_brought_forward >= 0),
  net_due INTEGER NOT NULL,
  closing_entry_id TEXT,
  payment_entry_id TEXT,
  filed_at TEXT,
  filing_reference_ciphertext TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  UNIQUE(owner_id, id),
  UNIQUE(owner_id, period_start)
);
