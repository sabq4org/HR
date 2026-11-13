-- Keep the intermediate local flat-salary policy as history. New preview runs
-- explicitly reference the profile-component calculator's own policy version.
INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,source,state,values_json,created_by,approved_by,created_at)
VALUES('payroll-policy-demo-v2','payroll-demo',2,'قواعد رواتب تجريبية من مكونات الملف','2026-01-01',
       'مكونات ملف اصطناعي فقط؛ لا نسب نظامية أو تأمينات أو تحويل مصرفي.', 'synthetic_approved',
       '{"currency":"SAR","calculation":"synthetic-profile-components"}',
       'emp-noura','emp-abdullah','2026-11-14T00:00:00.000Z')
ON CONFLICT(id) DO NOTHING;
UPDATE administrative_policies SET state='retired'
WHERE id='payroll-policy-demo-v1' AND values_json LIKE '%synthetic-flat-demo%';
