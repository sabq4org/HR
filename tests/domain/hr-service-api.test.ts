// «محاسب سبق» HR service key (phase 1): scoped read access. Synthetic data only.
// Phase-2 writes are covered in hr-service-write.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase, type Db } from '../../server/database.js';
import { readEmployee, saveProfileValues } from '../../server/administration/service.js';
import { generateServiceKey, hashServiceKey } from '../../server/finance/service-keys.js';
import {
  HR_DEFERRED_SCOPES,
  HR_FORBIDDEN_SCOPES,
  HR_READ_SCOPES,
  HR_WRITE_SCOPES,
  SERVICE_ACCOUNT,
  generateHrServiceKey,
  hashHrServiceKey,
  inHrServiceScope,
  matchHrServiceKey,
  parseHrServiceKeyHashes,
  parseHrServiceScopes,
  serviceActorName,
  serviceMayRunPayrollAction,
  type HrReadScope,
} from '../../server/service-api/keys.js';
import { normalizeArabic } from '../../server/service-api/routes.js';

process.env.HR_DATA_KEY ??= randomBytes(32).toString('base64url');
const SYNTHETIC_IBAN = 'SA0380000000608010167519';
const SYNTHETIC_ID = '1000000001';

async function seedProfile(db: Db) {
  const sara = await readEmployee(db, 'emp-sara');
  assert.ok(sara);
  await db.transaction((tx) =>
    saveProfileValues(
      tx,
      { id: 'emp-omar', role: 'hr' },
      'emp-sara',
      {
        basicSalary: 12000,
        iban: SYNTHETIC_IBAN,
        nationalId: SYNTHETIC_ID,
        medicalProvider: 'تأمين اصطناعي',
      },
      'بيانات اختبار اصطناعية',
      '2026-01-01',
      sara.record_version,
    ),
  );
  const policy = (
    await db.read<{ id: string }>('SELECT id FROM administrative_policies LIMIT 1')
  )[0];
  await db.execute(
    "INSERT INTO payroll_runs(id,period,version,state,prepared_by,policy_id,correction_of,reason,created_at,updated_at,closed_at) VALUES(?,?,1,'draft',?,?,NULL,'synthetic test',?,?,NULL)",
    [
      'svc-run-1',
      '2026-07',
      'emp-omar',
      policy.id,
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z',
    ],
  );
  await db.execute(
    "INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,created_at) VALUES(?,?,'emp-sara','راتب','earning',1200000,'test','2026-07-25T00:00:00.000Z')",
    ['svc-line-1', 'svc-run-1'],
  );
}

async function serve(db: Db, options: Parameters<typeof createApp>[1]) {
  const server: Server = createServer(createApp(db, options));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (key: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'idempotency-key': randomUUID() };
    if (key !== null) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text };
  };
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('HR service keys are random, digest-only, and distinct from finance keys', () => {
  const key = generateHrServiceKey();
  assert.match(key, /^sabqhr_[A-Za-z0-9_-]{43}$/);
  const digests = parseHrServiceKeyHashes(hashHrServiceKey(key));
  assert.ok(matchHrServiceKey(key, digests));
  assert.equal(matchHrServiceKey(generateHrServiceKey(), digests), undefined);
  // A finance key never matches the HR verifier, even if its digest were configured.
  const finance = generateServiceKey();
  assert.equal(
    matchHrServiceKey(finance, parseHrServiceKeyHashes(hashServiceKey(finance))),
    undefined,
  );
  assert.throws(() => parseHrServiceKeyHashes('plaintext'));
  assert.equal(serviceActorName(SERVICE_ACCOUNT.id), 'محاسب سبق');
  assert.equal(serviceActorName('someone-else'), 'مستخدم');
});

test('scopes: phase-2 writes wired; leave.write deferred; approve/close never granted', () => {
  assert.deepEqual(parseHrServiceScopes(HR_READ_SCOPES.join(',')), [...HR_READ_SCOPES]);
  assert.deepEqual(parseHrServiceScopes(HR_WRITE_SCOPES.join(',')), [...HR_WRITE_SCOPES]);
  for (const scope of HR_DEFERRED_SCOPES)
    assert.throws(() => parseHrServiceScopes(scope), /not available yet/);
  for (const scope of HR_FORBIDDEN_SCOPES)
    assert.throws(() => parseHrServiceScopes(`hr.employees.read,${scope}`), /never be granted/);
  assert.throws(() => parseHrServiceScopes('hr.everything'), /Unknown/);
  const everything = [...HR_READ_SCOPES, ...HR_WRITE_SCOPES, ...HR_FORBIDDEN_SCOPES];
  assert.equal(serviceMayRunPayrollAction('approve', everything), false);
  assert.equal(serviceMayRunPayrollAction('close', everything), false);
  assert.equal(serviceMayRunPayrollAction('review', everything), false);
  assert.equal(serviceMayRunPayrollAction('reject', everything), false);
  assert.equal(serviceMayRunPayrollAction('submit', [...HR_READ_SCOPES]), false);
  assert.equal(serviceMayRunPayrollAction('submit', ['hr.payroll.submit']), true);
  assert.ok(inHrServiceScope('GET', '/api/service/hr/employees'));
  assert.ok(!inHrServiceScope('POST', '/api/service/hr/employees'));
  assert.ok(inHrServiceScope('PATCH', '/api/service/hr/employees/emp-sara'));
  assert.ok(!inHrServiceScope('PATCH', '/api/service/hr/employees/emp-sara/compensation'));
  assert.ok(!inHrServiceScope('DELETE', '/api/service/hr/employees/emp-sara'));
  assert.ok(inHrServiceScope('POST', '/api/service/hr/payroll'));
  assert.ok(inHrServiceScope('POST', '/api/service/hr/payroll/run-1/actions'));
  assert.ok(!inHrServiceScope('PATCH', '/api/service/hr/payroll/run-1'));
  assert.ok(!inHrServiceScope('POST', '/api/admin/payroll/run-1/actions'));
  assert.ok(!inHrServiceScope('GET', '/api/finance'));
  assert.ok(!inHrServiceScope('GET', '/api/admin/payroll'));
});

test('Arabic normalisation ignores diacritics, tatweel and letter variants', () => {
  assert.equal(normalizeArabic('سَارَة القحطاني'), normalizeArabic('ساره القحطانى'));
  assert.equal(normalizeArabic('أحمد'), normalizeArabic('احمد'));
  assert.equal(normalizeArabic('إبراهيـــم'), normalizeArabic('ابراهيم'));
  assert.equal(normalizeArabic('٠٠٣'), '003');
});

async function scenario(db: Db) {
  await seedProfile(db);
  const hrKey = generateHrServiceKey();
  const financeKey = generateServiceKey();
  const app = (scopes: readonly HrReadScope[]) =>
    serve(db, {
      dataMode: 'private',
      financeEmployeeId: 'emp-noura',
      financeApiKeyHashes: [hashServiceKey(financeKey)],
      hrServiceKeyHashes: parseHrServiceKeyHashes(hashHrServiceKey(hrKey)),
      hrServiceScopes: scopes,
    });

  // 1) Full read scopes (Ali's decision): every field, audited under «محاسب سبق».
  const full = await app(HR_READ_SCOPES);
  try {
    const search = await full.call(
      hrKey,
      'GET',
      `/api/service/hr/employees?q=${encodeURIComponent('ساره القحطانى')}`,
    );
    assert.equal(search.status, 200, search.text);
    assert.deepEqual(
      search.body.employees.map((e: any) => e.id),
      ['emp-sara'],
    );
    assert.equal(
      (await full.call(hrKey, 'GET', '/api/service/hr/employees?q=S-003')).body.employees[0].id,
      'emp-sara',
    );
    assert.equal((await full.call(hrKey, 'GET', '/api/service/hr/employees?q=ا')).status, 400);

    const profile = await full.call(hrKey, 'GET', '/api/service/hr/employees/emp-sara');
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.body.values.nationalId, SYNTHETIC_ID);
    assert.equal(profile.body.values.medicalProvider, 'تأمين اصطناعي');
    assert.equal(profile.body.values.iban, undefined, 'compensation stays on its own route');
    assert.equal(profile.body.values.basicSalary, undefined);

    const pay = await full.call(hrKey, 'GET', '/api/service/hr/employees/emp-sara/compensation');
    assert.equal(pay.status, 200, pay.text);
    assert.equal(pay.body.compensation.iban, SYNTHETIC_IBAN);
    assert.equal(Number(pay.body.compensation.basicSalary), 12000);
    assert.equal(pay.body.compensation.nationalId, undefined);

    const leave = await full.call(hrKey, 'GET', '/api/service/hr/employees/emp-sara/leave');
    assert.equal(leave.status, 200, leave.text);
    assert.ok('available' in leave.body.summary);
    assert.ok(Array.isArray(leave.body.requests));

    const runs = await full.call(hrKey, 'GET', '/api/service/hr/payroll?month=2026-07');
    assert.equal(runs.status, 200, runs.text);
    assert.equal(runs.body.runs.length, 1);
    assert.equal(runs.body.runs[0].totals.earningsMinor, 1200000);
    assert.equal(
      (await full.call(hrKey, 'GET', '/api/service/hr/payroll?month=2026-13')).status,
      400,
    );
    const run = await full.call(hrKey, 'GET', '/api/service/hr/payroll/svc-run-1');
    assert.equal(run.status, 200, run.text);
    assert.equal(run.body.lines[0].amountMinor, 1200000);
    assert.equal((await full.call(hrKey, 'GET', '/api/service/hr/payroll/missing')).status, 404);
    assert.equal((await full.call(hrKey, 'GET', '/api/service/hr/employees/missing')).status, 404);

    // Audit attribution: service account id and role, field names only, never values.
    const events = await db.read<any>(
      "SELECT * FROM administration_events WHERE resource_type='service_access' ORDER BY created_at,id",
    );
    const byAction = new Map(events.map((e) => [e.action, e]));
    for (const [action, resourceId] of [
      ['service_read_sensitive_profile', 'emp-sara'],
      ['service_read_compensation', 'emp-sara'],
      ['service_read_sensitive_leave', 'emp-sara'],
      ['service_read_payroll_list', '2026-07'],
      ['service_read_payroll_amounts', 'svc-run-1'],
    ]) {
      const event = byAction.get(action);
      assert.ok(event, action);
      assert.equal(event.resource_type, 'service_access', action);
      assert.equal(event.resource_id, resourceId, action);
      assert.equal(event.actor_id, SERVICE_ACCOUNT.id, action);
    }
    for (const event of events) {
      assert.equal(event.actor_id, SERVICE_ACCOUNT.id);
      assert.equal(event.actor_role, 'service');
      const details = JSON.parse(event.details_json);
      assert.equal(details.actorName, 'محاسب سبق');
      assert.equal(details.actorKind, 'service_key');
      assert.match(details.keyId, /^[0-9a-f]{12}$/);
      assert.ok(!event.details_json.includes(SYNTHETIC_IBAN));
      assert.ok(!event.details_json.includes(SYNTHETIC_ID));
      assert.ok(!event.details_json.includes('1200000'));
      assert.ok(!event.details_json.includes(hrKey));
    }
    assert.ok(
      JSON.parse(
        events.find((e) => e.action === 'service_read_compensation').details_json,
      ).fields.includes('iban'),
    );
    const listDetails = JSON.parse(
      events.find((e) => e.action === 'service_read_payroll_list').details_json,
    );
    assert.equal(listDetails.month, '2026-07');
    assert.equal(listDetails.count, 1);
    assert.deepEqual(listDetails.fields, ['deductionsMinor', 'earningsMinor', 'netMinor']);
    assert.equal(listDetails.earningsMinor, undefined);
    assert.equal(listDetails.totals, undefined);

    // The HR key reaches nothing else: no finance, no browser routes, no writes, no payroll actions.
    for (const [method, path] of [
      ['GET', '/api/finance'],
      ['GET', '/api/bootstrap'],
      ['GET', '/api/session'],
      ['GET', '/api/admin/employees/emp-sara'],
      ['GET', '/api/admin/payroll'],
      ['GET', '/api/admin/audit'],
      ['POST', '/api/admin/payroll/svc-run-1/actions'],
      ['PATCH', '/api/admin/employees/emp-sara'],
      ['POST', '/api/service/hr/employees'],
      ['PATCH', '/api/service/hr/employees/emp-sara'],
    ]) {
      const res = await full.call(
        hrKey,
        method,
        path,
        method === 'GET' ? undefined : { action: 'approve' },
      );
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.error.code, 'API_KEY_SCOPE', `${method} ${path}`);
    }
    // Health stays reachable; no key and a wrong key are refused on the service API.
    assert.equal((await full.call(hrKey, 'GET', '/api/health')).status, 200);
    assert.equal((await full.call(null, 'GET', '/api/service/hr/employees?q=سارة')).status, 401);
    const wrong = await full.call(
      generateHrServiceKey(),
      'GET',
      '/api/service/hr/employees?q=سارة',
    );
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_API_KEY');

    // The finance key is unchanged: finance works, the HR service API is out of its scope.
    assert.equal((await full.call(financeKey, 'GET', '/api/finance')).status, 200);
    const financeOnHr = await full.call(financeKey, 'GET', '/api/service/hr/employees?q=سارة');
    assert.equal(financeOnHr.status, 403);
    assert.equal(financeOnHr.body.error.code, 'API_KEY_SCOPE');
    assert.equal(
      (await full.call(financeKey, 'GET', '/api/admin/employees/emp-sara')).body.error.code,
      'API_KEY_SCOPE',
    );
  } finally {
    await full.close();
  }

  // 2) Directory only: masking and per-route scope refusals; no audit for non-sensitive reads.
  const before = (
    await db.read<any>("SELECT id FROM administration_events WHERE resource_type='service_access'")
  ).length;
  const narrow = await app(['hr.employees.read']);
  try {
    const profile = await narrow.call(hrKey, 'GET', '/api/service/hr/employees/emp-sara');
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.body.values.nationalId, undefined);
    assert.equal(profile.body.values.medicalProvider, undefined);
    assert.equal(profile.body.values.iban, undefined);
    assert.equal(profile.body.included.personalAndMedical, false);
    assert.ok(!profile.text.includes(SYNTHETIC_IBAN) && !profile.text.includes(SYNTHETIC_ID));
    for (const path of [
      '/api/service/hr/employees/emp-sara/compensation',
      '/api/service/hr/employees/emp-sara/leave',
      '/api/service/hr/payroll',
      '/api/service/hr/payroll/svc-run-1',
    ]) {
      const res = await narrow.call(hrKey, 'GET', path);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error.code, 'API_KEY_SCOPE', path);
    }
  } finally {
    await narrow.close();
  }
  // Payroll without compensation: run structure, no amounts.
  const payrollOnly = await app(['hr.payroll.read']);
  try {
    const listed = await payrollOnly.call(hrKey, 'GET', '/api/service/hr/payroll?month=2026-07');
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.runs.length, 1);
    assert.equal(listed.body.runs[0].totals, undefined);
    const run = await payrollOnly.call(hrKey, 'GET', '/api/service/hr/payroll/svc-run-1');
    assert.equal(run.status, 200, run.text);
    assert.equal(run.body.lines[0].amountMinor, undefined);
    assert.equal(run.body.run.totals, undefined);
    assert.equal(
      (await payrollOnly.call(hrKey, 'GET', '/api/service/hr/employees?q=سارة')).status,
      403,
    );
  } finally {
    await payrollOnly.close();
  }
  const after = (
    await db.read<any>("SELECT id FROM administration_events WHERE resource_type='service_access'")
  ).length;
  assert.equal(after, before, 'non-sensitive reads leave no service audit entry');
  await db.close();
}

test('HR service API: scopes, masking, search and audit on SQLite', async () => {
  await scenario(await createDatabase());
});

test(
  'HR service API: the same scenario on PostgreSQL',
  { skip: !process.env.HR_TEST_DATABASE_URL },
  async () => {
    await scenario(
      await createPostgresDatabase(
        process.env.HR_TEST_DATABASE_URL!,
        `hr_preview_${randomUUID().replaceAll('-', '')}`,
        { seed: true },
      ),
    );
  },
);

test('HR service keys are disabled outside private data or without scopes', async () => {
  const db = await createDatabase();
  const key = generateHrServiceKey();
  const digests = [hashHrServiceKey(key)];
  for (const options of [
    { hrServiceKeyHashes: digests, hrServiceScopes: [...HR_READ_SCOPES] },
    { dataMode: 'private' as const, hrServiceKeyHashes: digests, hrServiceScopes: [] },
    { dataMode: 'private' as const, hrServiceScopes: [...HR_READ_SCOPES] },
  ]) {
    const h = await serve(db, options);
    try {
      const res = await h.call(key, 'GET', '/api/service/hr/employees?q=سارة');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'API_KEY_DISABLED');
    } finally {
      await h.close();
    }
  }
  await db.close();
});
