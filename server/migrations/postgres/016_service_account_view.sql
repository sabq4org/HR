-- «محاسب سبق» service account (HR service key, phase 2).
-- Writes by the key need an actor row for the existing foreign keys
-- (employee_profile_history.actor_id, employee_profile_data.updated_by, payroll_runs.prepared_by).
-- The row is created lazily on the key's first write (server/service-api/service-account.ts),
-- never by this migration, and is suspended with no access role and no login account.
-- This migration only hides it from employee_access, which every directory, payroll, leave,
-- access and export query reads. No table is rebuilt and no constraint is dropped.
-- Same columns in the same order, so CREATE OR REPLACE is allowed and dependants keep working.
CREATE OR REPLACE VIEW employee_access AS
SELECT id, employee_number, name, initials, title, department, email, location,
       manager_id, join_date, COALESCE(access_role, role) AS role, color,
       employment_status AS status, access_role, record_version
FROM employees
WHERE id <> 'svc-sabq-accountant';
