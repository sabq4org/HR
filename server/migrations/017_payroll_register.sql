-- Payroll register snapshot (the owner's payroll template): per run and employee, the job
-- title, employment type (staff under GOSI or contractor paid a lump sum), payment method
-- (direct payment or wage protection) and the employer's insurance
-- share computed by the approved rule version (GOSI section), with the category and
-- contributory wage it used. Taken when the run is created so a closed run prints the
-- same register later. The employer share is informational and never enters the net.
CREATE TABLE IF NOT EXISTS payroll_run_people (
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  title TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL CHECK(payment_method IN ('direct','wps','unspecified')),
  employment_type TEXT NOT NULL DEFAULT 'staff' CHECK(employment_type IN ('staff','contractor')),
  employer_contribution_minor INTEGER NOT NULL DEFAULT 0 CHECK(employer_contribution_minor>=0),
  insurance_category TEXT CHECK(insurance_category IS NULL OR insurance_category IN ('saudi_existing','saudi_new','non_saudi')),
  insurance_category_inferred INTEGER NOT NULL DEFAULT 0 CHECK(insurance_category_inferred IN (0,1)),
  insured_wage_minor INTEGER NOT NULL DEFAULT 0 CHECK(insured_wage_minor>=0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, employee_id)
);
CREATE TRIGGER IF NOT EXISTS payroll_run_people_closed_no_update BEFORE UPDATE ON payroll_run_people
WHEN (SELECT state FROM payroll_runs WHERE id=OLD.run_id)='closed'
BEGIN SELECT RAISE(ABORT, 'closed payroll register is immutable'); END;
CREATE TRIGGER IF NOT EXISTS payroll_run_people_closed_no_delete BEFORE DELETE ON payroll_run_people
WHEN (SELECT state FROM payroll_runs WHERE id=OLD.run_id)='closed'
BEGIN SELECT RAISE(ABORT, 'closed payroll register is immutable'); END;
