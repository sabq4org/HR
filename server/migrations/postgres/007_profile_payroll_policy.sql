-- Synthetic payroll policy fixtures are created only by the synthetic seed path.
UPDATE administrative_policies SET state='retired'
WHERE id='payroll-policy-demo-v1' AND values_json LIKE '%synthetic-flat-demo%';
