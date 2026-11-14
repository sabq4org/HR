-- Binds a database to the data-encryption key that wrote it, without storing the key.
-- fingerprint = HMAC-SHA256(key, fixed label); it cannot be reversed into the key.
-- Immutable: rotating the key needs an explicit re-encryption procedure, not an UPDATE.
CREATE TABLE IF NOT EXISTS data_key_binding (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  fingerprint TEXT NOT NULL,
  bound_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS data_key_binding_no_update BEFORE UPDATE ON data_key_binding BEGIN SELECT RAISE(ABORT, 'immutable data key binding'); END;
CREATE TRIGGER IF NOT EXISTS data_key_binding_no_delete BEFORE DELETE ON data_key_binding BEGIN SELECT RAISE(ABORT, 'immutable data key binding'); END;
