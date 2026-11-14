-- System owner (decision 014): an HR account that may also approve payroll runs and payroll
-- rule versions. Granted only by the owner's word through a controlled SQL change; no route
-- writes this table. The usual separation still applies: nobody approves what they prepared,
-- reviewed or created.
CREATE TABLE IF NOT EXISTS system_owners (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  granted_at TIMESTAMPTZ NOT NULL,
  granted_reason TEXT NOT NULL
);
