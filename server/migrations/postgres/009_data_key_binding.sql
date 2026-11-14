-- Binds a database to the data-encryption key that wrote it, without storing the key.
-- fingerprint = HMAC-SHA256(key, fixed label); it cannot be reversed into the key.
-- Immutable: rotating the key needs an explicit re-encryption procedure, not an UPDATE.
CREATE TABLE IF NOT EXISTS data_key_binding (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  fingerprint TEXT NOT NULL,
  bound_at TEXT NOT NULL
);
DROP TRIGGER IF EXISTS data_key_binding_immutable ON data_key_binding;
CREATE TRIGGER data_key_binding_immutable BEFORE UPDATE OR DELETE ON data_key_binding FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
