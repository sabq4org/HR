-- Local finance preview. Customer and seller snapshots are encrypted by the
-- application; owner_id scopes every resource to its explicitly granted owner.
CREATE TABLE IF NOT EXISTS finance_settings (
  owner_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  seller_ciphertext TEXT NOT NULL,
  organization_ciphertext TEXT,
  revenue_account_id TEXT NOT NULL DEFAULT '',
  standard_tax_rate_id TEXT NOT NULL DEFAULT '',
  zero_tax_rate_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_customers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  customer_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  wafeq_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK(sync_status IN ('not_synced','synced','error')),
  sync_message TEXT,
  UNIQUE(owner_id,id)
);
CREATE INDEX IF NOT EXISTS finance_customers_owner_created ON finance_customers(owner_id,created_at);
CREATE TABLE IF NOT EXISTS finance_quotes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  number TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft','converted')),
  quote_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invoice_id TEXT,
  UNIQUE(owner_id,id),
  UNIQUE(owner_id,number),
  UNIQUE(owner_id,invoice_id),
  FOREIGN KEY(owner_id,customer_id) REFERENCES finance_customers(owner_id,id)
);
CREATE INDEX IF NOT EXISTS finance_quotes_owner_created ON finance_quotes(owner_id,created_at);
CREATE TABLE IF NOT EXISTS finance_invoices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  number TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  invoice_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,id),
  UNIQUE(owner_id,quote_id),
  UNIQUE(owner_id,number),
  FOREIGN KEY(owner_id,quote_id) REFERENCES finance_quotes(owner_id,id)
);
CREATE INDEX IF NOT EXISTS finance_invoices_owner_created ON finance_invoices(owner_id,created_at);
CREATE TABLE IF NOT EXISTS finance_provider_credentials (
  owner_id TEXT PRIMARY KEY,
  api_key_ciphertext TEXT NOT NULL,
  organization_ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_provider_operations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('customer','invoice')),
  resource_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  report_idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','in_flight','reconciliation_required','complete')),
  provider_id TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,resource_type,resource_id),
  UNIQUE(owner_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS finance_private_artifacts (
  owner_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK(artifact_type IN ('pdf')),
  content_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,invoice_id,artifact_type),
  FOREIGN KEY(owner_id,invoice_id) REFERENCES finance_invoices(owner_id,id)
);
