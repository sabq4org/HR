-- Additive upgrade for local databases created during preview development.
ALTER TABLE administrative_requests ADD COLUMN IF NOT EXISTS issued_document_json TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS request_id TEXT REFERENCES administrative_requests(id);

CREATE TABLE IF NOT EXISTS administration_workspace_capacity (
  id TEXT PRIMARY KEY CHECK(id='workspace'),
  employee_count INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  document_bytes INTEGER NOT NULL
);
INSERT INTO administration_workspace_capacity(id,employee_count,document_count,document_bytes)
VALUES('workspace',(SELECT COUNT(*) FROM employees),(SELECT COUNT(*) FROM employee_documents),(SELECT COALESCE(SUM(size_bytes),0) FROM employee_documents))
ON CONFLICT(id) DO NOTHING;
CREATE OR REPLACE FUNCTION enforce_administration_capacity() RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME='employees' THEN
    IF EXISTS(SELECT 1 FROM employees WHERE id=NEW.id) THEN RETURN NEW; END IF;
    UPDATE administration_workspace_capacity SET employee_count=employee_count+1 WHERE id='workspace' AND employee_count<200;
  ELSE
    UPDATE administration_workspace_capacity SET document_count=document_count+1,document_bytes=document_bytes+NEW.size_bytes
      WHERE id='workspace' AND document_count<30 AND document_bytes+NEW.size_bytes<=6291456;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_CAPACITY_EXCEEDED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS administration_employee_capacity ON employees;
CREATE TRIGGER administration_employee_capacity BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION enforce_administration_capacity();
DROP TRIGGER IF EXISTS administration_document_capacity ON employee_documents;
CREATE TRIGGER administration_document_capacity BEFORE INSERT ON employee_documents FOR EACH ROW EXECUTE FUNCTION enforce_administration_capacity();


CREATE UNIQUE INDEX IF NOT EXISTS payroll_one_primary_run_per_period
ON payroll_runs(period) WHERE correction_of IS NULL AND state <> 'rejected';
CREATE OR REPLACE FUNCTION prevent_payroll_event_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'payroll events are append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payroll_events_no_update ON payroll_events;
DROP TRIGGER IF EXISTS payroll_events_no_delete ON payroll_events;
CREATE TRIGGER payroll_events_no_update BEFORE UPDATE ON payroll_events FOR EACH ROW EXECUTE FUNCTION prevent_payroll_event_mutation();
CREATE TRIGGER payroll_events_no_delete BEFORE DELETE ON payroll_events FOR EACH ROW EXECUTE FUNCTION prevent_payroll_event_mutation();
CREATE OR REPLACE FUNCTION prevent_closed_payroll_insert() RETURNS trigger AS $$
BEGIN
  IF (SELECT state FROM payroll_runs WHERE id=NEW.run_id)='closed' THEN
    RAISE EXCEPTION 'closed payroll lines are immutable';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payroll_lines_closed_no_insert ON payroll_lines;
CREATE TRIGGER payroll_lines_closed_no_insert BEFORE INSERT ON payroll_lines FOR EACH ROW EXECUTE FUNCTION prevent_closed_payroll_insert();
