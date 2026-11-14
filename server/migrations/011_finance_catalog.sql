-- Saved quote lines (description, price, tax) reused across quotes. Rows are
-- archived with active=0, never deleted, so audit events keep their subject.
CREATE TABLE IF NOT EXISTS finance_catalog_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  description TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  tax_rate_bps INTEGER NOT NULL CHECK(tax_rate_bps IN (0,1500)),
  tax_reason TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,id)
);
CREATE INDEX IF NOT EXISTS finance_catalog_owner_created ON finance_catalog_items(owner_id,created_at);
