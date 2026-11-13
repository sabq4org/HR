-- Additive upgrade for local databases created during preview development.
ALTER TABLE administrative_requests ADD COLUMN issued_document_json TEXT;
ALTER TABLE outbox ADD COLUMN request_id TEXT REFERENCES administrative_requests(id);

CREATE TABLE IF NOT EXISTS administration_workspace_capacity (
  id TEXT PRIMARY KEY CHECK(id='workspace'),
  employee_count INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  document_bytes INTEGER NOT NULL
);
INSERT INTO administration_workspace_capacity(id,employee_count,document_count,document_bytes)
VALUES('workspace',(SELECT COUNT(*) FROM employees),(SELECT COUNT(*) FROM employee_documents),(SELECT COALESCE(SUM(size_bytes),0) FROM employee_documents))
ON CONFLICT(id) DO NOTHING;
CREATE TRIGGER IF NOT EXISTS administration_employee_capacity BEFORE INSERT ON employees
WHEN NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.id) BEGIN
  UPDATE administration_workspace_capacity SET employee_count=employee_count+1 WHERE id='workspace' AND employee_count<200;
  SELECT CASE WHEN changes()=0 THEN RAISE(ABORT,'WORKSPACE_EMPLOYEE_CAP') END;
END;
CREATE TRIGGER IF NOT EXISTS administration_document_capacity BEFORE INSERT ON employee_documents BEGIN
  UPDATE administration_workspace_capacity SET document_count=document_count+1,document_bytes=document_bytes+NEW.size_bytes
   WHERE id='workspace' AND document_count<30 AND document_bytes+NEW.size_bytes<=6291456;
  SELECT CASE WHEN changes()=0 THEN RAISE(ABORT,'WORKSPACE_DOCUMENT_CAP') END;
END;


CREATE UNIQUE INDEX IF NOT EXISTS payroll_one_primary_run_per_period
ON payroll_runs(period) WHERE correction_of IS NULL AND state <> 'rejected';
CREATE TRIGGER IF NOT EXISTS payroll_events_no_update BEFORE UPDATE ON payroll_events
BEGIN SELECT RAISE(ABORT, 'payroll events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS payroll_events_no_delete BEFORE DELETE ON payroll_events
BEGIN SELECT RAISE(ABORT, 'payroll events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS payroll_lines_closed_no_insert BEFORE INSERT ON payroll_lines
WHEN (SELECT state FROM payroll_runs WHERE id=NEW.run_id)='closed'
BEGIN SELECT RAISE(ABORT, 'closed payroll lines are immutable'); END;
