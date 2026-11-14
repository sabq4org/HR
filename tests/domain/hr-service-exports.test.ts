// «محاسب سبق» HR service key exports: the app's HR exports through /api/service/hr with the key's
// scope masking and an audit event per export. Synthetic data only. Chromium-backed checks skip
// when no Chromium is installed (CI installs it before npm test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase, type Db } from '../../server/database.js';
import { readEmployee, saveProfileValues } from '../../server/administration/service.js';
import { encryptSensitive } from '../../server/administration/security.js';
import { generateServiceKey, hashServiceKey } from '../../server/finance/service-keys.js';
import { chromiumExecutable, closeChromium } from '../../server/finance/chromium-pdf.js';
import {
  HR_READ_SCOPES,
  SERVICE_ACCOUNT,
  generateHrServiceKey,
  hashHrServiceKey,
  parseHrServiceKeyHashes,
  type HrScope,
} from '../../server/service-api/keys.js';
import { employeeReportHtml, scopeAllows } from '../../server/service-api/exports.js';

process.env.HR_DATA_KEY ??= randomBytes(32).toString('base64url');
const hasChromium = Boolean(chromiumExecutable());
const SYNTHETIC_IBAN = 'SA0380000000608010167519';
const SYNTHETIC_ID = '1000000001';
const SYNTHETIC_SALARY = 12345;
const SYNTHETIC_PROVIDER = 'تأمين اصطناعي';
const NOW = '2026-07-25T00:00:00.000Z';

async function seed(db: Db) {
  const sara = await readEmployee(db, 'emp-sara');
  assert.ok(sara);
  await db.transaction((tx) =>
    saveProfileValues(
      tx,
      { id: 'emp-omar', role: 'hr' },
      'emp-sara',
      {
        basicSalary: SYNTHETIC_SALARY,
        iban: SYNTHETIC_IBAN,
        nationalId: SYNTHETIC_ID,
        medicalProvider: SYNTHETIC_PROVIDER,
        medicalCoverageStatus: 'covered',
      },
      'بيانات اختبار اصطناعية',
      '2026-01-01',
      sara.record_version,
    ),
  );
  for (const [id, category, filename] of [
    ['svc-doc-open', 'qualification', 'synthetic-degree.pdf'],
    ['svc-doc-bank', 'bank_letter', 'synthetic-iban-letter.pdf'],
    ['svc-doc-id', 'identity', 'synthetic-id-copy.pdf'],
  ]) {
    const content = Buffer.from(`%PDF-1.4 synthetic ${id}`);
    await db.execute(
      'INSERT INTO employee_documents(id,employee_id,category,filename,mime_type,size_bytes,expires_at,uploaded_at,uploaded_by,checksum,encrypted_content,version,state) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,1,?)',
      [
        id,
        'emp-sara',
        category,
        filename,
        'application/pdf',
        content.length,
        NOW,
        'emp-omar',
        createHash('sha256').update(content).digest('hex'),
        encryptSensitive(content.toString('base64'), `employee-document:${id}`),
        'active',
      ],
    );
  }
  const issued = (title: string) => ({
    title,
    language: 'ar',
    reference: 'REF',
    issuedAt: NOW,
    recipient: 'لمن يهمه الأمر',
    paragraphs: ['نص اصطناعي للاختبار.'],
    facts: [{ label: 'الأساسي', value: String(SYNTHETIC_SALARY) }],
    approvedByName: 'معتمد تجريبي',
    version: 1,
  });
  for (const [id, number, kind] of [
    ['svc-req-letter', 'SVC-L-1', 'salary_letter'],
    ['svc-req-settlement', 'SVC-S-1', 'settlement'],
    // Never printable; a stray copy must still not be served.
    ['svc-req-grievance', 'SVC-G-1', 'grievance'],
  ]) {
    await db.execute(
      "INSERT INTO administrative_requests(id,request_number,kind,employee_id,created_by,state,version,values_json,issued_document_json,steps_json,step_index,created_at,updated_at) VALUES(?,?,?,'emp-sara','emp-sara','approved',1,'{}',?,'[]',0,?,?)",
      [
        id,
        number,
        kind,
        encryptSensitive(JSON.stringify(issued(`نسخة ${kind}`)), `issued-document:${id}`),
        NOW,
        NOW,
      ],
    );
  }
  const policy = (
    await db.read<{ id: string }>('SELECT id FROM administrative_policies LIMIT 1')
  )[0];
  for (const [id, period, state] of [
    ['svc-run-closed', '2026-06', 'closed'],
    ['svc-run-draft', '2026-07', 'draft'],
  ]) {
    await db.execute(
      "INSERT INTO payroll_runs(id,period,version,state,prepared_by,policy_id,correction_of,reason,created_at,updated_at,closed_at) VALUES(?,?,1,'draft',?,?,NULL,?,?,?,NULL)",
      [id, period, 'emp-omar', policy.id, 'synthetic test', NOW, NOW],
    );
    await db.execute(
      "INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,created_at) VALUES(?,?,'emp-sara','راتب','earning',1234500,'test',?)",
      [`${id}-line`, id, NOW],
    );
    // Lines of a closed run are immutable, so close after inserting them.
    if (state === 'closed')
      await db.execute("UPDATE payroll_runs SET state='closed',closed_at=? WHERE id=?", [NOW, id]);
  }
}

async function serve(db: Db, options: Parameters<typeof createApp>[1]) {
  const server: Server = createServer(createApp(db, options));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (key: string | null, path: string) => {
    const headers: Record<string, string> = {};
    if (key !== null) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${base}${path}`, { headers });
    const bytes = Buffer.from(await res.arrayBuffer());
    let json: any;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, bytes, body: json };
  };
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const auditFor = (db: Db, action: string) =>
  db.read<any>(
    'SELECT * FROM administration_events WHERE action=? ORDER BY created_at DESC,id DESC',
    [action],
  );

test('scope rule: financial needs compensation, personal and medical need sensitive', () => {
  assert.equal(scopeAllows(['hr.employees.read'], undefined), true);
  assert.equal(scopeAllows(['hr.employees.read'], 'financial'), false);
  assert.equal(scopeAllows(['hr.compensation.read'], 'financial'), true);
  assert.equal(scopeAllows(['hr.compensation.read'], 'personal'), false);
  assert.equal(scopeAllows(['hr.sensitive.read'], 'medical'), true);
});

async function scenario(db: Db) {
  await seed(db);
  // Report HTML masking (no Chromium needed): same paper as the in-app report.
  const html = async (scopes: readonly HrScope[]) =>
    (await employeeReportHtml(db, 'emp-sara', scopes, 'بيانات خاصة')).html;
  const full = await html(HR_READ_SCOPES);
  assert.match(full, /class="employee-report"/);
  assert.match(full, /الملـف الوظـيفي/);
  assert.match(full, /dir="rtl"/);
  assert.ok(full.includes(SYNTHETIC_IBAN), 'bank shown with compensation');
  assert.ok(full.includes('12,345'), 'salary shown with compensation');
  assert.ok(full.includes(SYNTHETIC_ID), 'national ID shown with sensitive');
  // The report carries the essential fields only: medical coverage status, not the provider.
  assert.ok(full.includes('حالة التغطية الطبية'), 'medical shown with sensitive');
  assert.ok(full.includes('الراتب والبنك') && full.includes('التأمينات والتغطية الطبية'));
  assert.ok(full.includes('synthetic-iban-letter.pdf') && full.includes('synthetic-id-copy.pdf'));
  assert.ok(full.includes('الإجازات'));
  const basic = await html(['hr.employees.read']);
  for (const hidden of [SYNTHETIC_IBAN, '12,345', SYNTHETIC_ID, 'حالة التغطية الطبية'])
    assert.ok(!basic.includes(hidden), `hidden without scopes: ${hidden}`);
  assert.ok(!basic.includes('الراتب والبنك'));
  assert.ok(!basic.includes('التغطية الطبية'));
  assert.ok(
    !basic.includes('synthetic-iban-letter.pdf') && !basic.includes('synthetic-id-copy.pdf'),
  );
  assert.ok(basic.includes('synthetic-degree.pdf'));
  assert.ok(basic.includes('البيانات الأساسية') && basic.includes('العمل والعقد'));
  assert.ok(!basic.includes('<h3>الإجازات</h3>'), 'leave needs hr.leave.read');
  const comp = await html(['hr.employees.read', 'hr.compensation.read']);
  assert.ok(comp.includes(SYNTHETIC_IBAN) && !comp.includes(SYNTHETIC_ID));
  const sens = await html(['hr.employees.read', 'hr.sensitive.read']);
  assert.ok(sens.includes(SYNTHETIC_ID) && !sens.includes(SYNTHETIC_IBAN));
  assert.ok(!sens.includes('12,345'));

  const hrKey = generateHrServiceKey();
  const financeKey = generateServiceKey();
  const app = (scopes: readonly HrScope[]) =>
    serve(db, {
      dataMode: 'private',
      financeEmployeeId: 'emp-noura',
      financeApiKeyHashes: [hashServiceKey(financeKey)],
      hrServiceKeyHashes: parseHrServiceKeyHashes(hashHrServiceKey(hrKey)),
      hrServiceScopes: scopes,
    });
  const all = await app(HR_READ_SCOPES);
  const narrow = await app(['hr.employees.read']);
  try {
    // Authentication: no key 401, finance key 403, on every export.
    for (const path of [
      '/api/service/hr/employees/emp-sara/report.pdf',
      '/api/service/hr/employees/emp-sara/documents',
      '/api/service/hr/payroll/svc-run-closed/export.csv',
      '/api/service/hr/reports/export.csv?type=employees',
    ]) {
      assert.equal((await all.call(null, path)).status, 401, path);
      const fin = await all.call(financeKey, path);
      assert.equal(fin.status, 403, path);
      assert.equal(fin.body.error.code, 'API_KEY_SCOPE', path);
    }

    // Employee report PDF.
    const report = await all.call(hrKey, '/api/service/hr/employees/emp-sara/report.pdf');
    if (hasChromium) {
      assert.equal(report.status, 200, report.bytes.toString('utf8').slice(0, 300));
      assert.equal(report.headers.get('content-type'), 'application/pdf');
      assert.equal(report.headers.get('x-pdf-renderer'), 'chromium');
      assert.equal(report.headers.get('cache-control'), 'private, no-store');
      assert.equal(report.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.ok(report.bytes.length > 5000);
      const [event] = await auditFor(db, 'service_export_profile_report');
      assert.ok(event);
      assert.equal(event.actor_id, SERVICE_ACCOUNT.id);
      assert.equal(event.resource_type, 'service_access');
      assert.equal(event.resource_id, 'emp-sara');
      const details = JSON.parse(event.details_json);
      assert.equal(details.actorName, 'محاسب سبق');
      assert.deepEqual(details.included, {
        compensation: true,
        personalAndMedical: true,
        leave: true,
      });
      assert.ok(details.sections.includes('الراتب') && details.sections.includes('التأمينات'));
      assert.ok(details.fields.includes('iban') && details.fields.includes('nationalId'));
      const raw = JSON.stringify(event);
      for (const value of [SYNTHETIC_IBAN, SYNTHETIC_ID, SYNTHETIC_PROVIDER, '12345'])
        assert.ok(!raw.includes(value), 'audit holds names only');
      const basicPdf = await narrow.call(hrKey, '/api/service/hr/employees/emp-sara/report.pdf');
      assert.equal(basicPdf.status, 200);
      const [basicEvent] = await auditFor(db, 'service_export_profile_report');
      const basicDetails = JSON.parse(basicEvent.details_json);
      assert.deepEqual(basicDetails.included, {
        compensation: false,
        personalAndMedical: false,
        leave: false,
      });
      assert.ok(!basicDetails.sections.includes('الراتب'));
      assert.deepEqual(basicDetails.fields, []);
    } else {
      assert.equal(report.status, 503);
      assert.equal(report.body.error.code, 'PDF_RENDERER_UNAVAILABLE');
    }
    assert.equal(
      (await all.call(hrKey, '/api/service/hr/employees/emp-missing/report.pdf')).status,
      404,
    );

    // Documents: list and download follow the category sensitivity.
    const docsAll = await all.call(hrKey, '/api/service/hr/employees/emp-sara/documents');
    assert.deepEqual(docsAll.body.documents.map((d: any) => d.id).sort(), [
      'svc-doc-bank',
      'svc-doc-id',
      'svc-doc-open',
    ]);
    const docsBasic = await narrow.call(hrKey, '/api/service/hr/employees/emp-sara/documents');
    assert.deepEqual(
      docsBasic.body.documents.map((d: any) => d.id),
      ['svc-doc-open'],
    );
    const dl = await all.call(
      hrKey,
      '/api/service/hr/employees/emp-sara/documents/svc-doc-bank/download',
    );
    assert.equal(dl.status, 200);
    assert.equal(dl.bytes.toString('utf8'), '%PDF-1.4 synthetic svc-doc-bank');
    assert.equal(
      (
        await narrow.call(
          hrKey,
          '/api/service/hr/employees/emp-sara/documents/svc-doc-bank/download',
        )
      ).status,
      404,
    );
    assert.equal(
      (await all.call(hrKey, '/api/service/hr/employees/emp-ali/documents/svc-doc-bank/download'))
        .status,
      404,
      'document must belong to the employee in the path',
    );
    const [dlEvent] = await auditFor(db, 'service_document_downloaded');
    assert.equal(dlEvent.resource_id, 'svc-doc-bank');
    assert.equal(JSON.parse(dlEvent.details_json).category, 'bank_letter');

    // Issued letters: printable kinds only, with the full read set.
    const letters = await all.call(hrKey, '/api/service/hr/employees/emp-sara/letters');
    assert.equal(letters.status, 200);
    assert.deepEqual(letters.body.letters.map((l: any) => l.kind).sort(), [
      'salary_letter',
      'settlement',
    ]);
    assert.equal(
      (await narrow.call(hrKey, '/api/service/hr/employees/emp-sara/letters')).status,
      403,
    );
    assert.equal(
      (
        await all.call(
          hrKey,
          '/api/service/hr/employees/emp-sara/letters/svc-req-grievance/letter.pdf',
        )
      ).status,
      404,
    );
    const letter = await all.call(
      hrKey,
      '/api/service/hr/employees/emp-sara/letters/svc-req-letter/letter.pdf',
    );
    if (hasChromium) {
      assert.equal(letter.status, 200);
      assert.equal(letter.headers.get('x-pdf-renderer'), 'chromium');
      assert.equal(letter.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.ok((await auditFor(db, 'service_export_issued_letter')).length >= 1);
    } else assert.equal(letter.status, 503);

    // Payroll CSV and payslip.
    const csv = await all.call(hrKey, '/api/service/hr/payroll/svc-run-closed/export.csv');
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers.get('content-type')), /text\/csv/);
    const text = csv.bytes.toString('utf8');
    assert.ok(text.startsWith('\uFEFF"الموظف"'));
    assert.ok(text.includes('"12345.00"'));
    assert.equal(
      (await narrow.call(hrKey, '/api/service/hr/payroll/svc-run-closed/export.csv')).status,
      403,
    );
    const [csvEvent] = await auditFor(db, 'service_export_payroll_csv');
    assert.equal(csvEvent.resource_id, 'svc-run-closed');
    assert.ok(!JSON.stringify(csvEvent).includes('12345'));
    assert.equal(
      (await all.call(hrKey, '/api/service/hr/payroll/svc-run-missing/export.csv')).status,
      404,
    );
    assert.equal(
      (await all.call(hrKey, '/api/service/hr/payroll/svc-run-draft/payslips/emp-sara/payslip.pdf'))
        .status,
      409,
      'payslips only for closed runs, as in the app',
    );
    assert.equal(
      (await all.call(hrKey, '/api/service/hr/payroll/svc-run-closed/payslips/emp-ali/payslip.pdf'))
        .status,
      404,
    );
    const slip = await all.call(
      hrKey,
      '/api/service/hr/payroll/svc-run-closed/payslips/emp-sara/payslip.pdf',
    );
    if (hasChromium) {
      assert.equal(slip.status, 200);
      assert.equal(slip.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.ok((await auditFor(db, 'service_export_payslip')).length >= 1);
    } else assert.equal(slip.status, 503);

    // Reports page CSVs and the import template.
    for (const type of ['employees', 'requests', 'attendance']) {
      const res = await narrow.call(hrKey, `/api/service/hr/reports/export.csv?type=${type}`);
      assert.equal(res.status, 200, type);
      assert.ok(res.bytes.toString('utf8').startsWith('\uFEFF'), type);
    }
    assert.ok(
      (await narrow.call(hrKey, '/api/service/hr/reports/export.csv?type=employees')).bytes
        .toString('utf8')
        .includes('S-003'),
    );
    assert.equal(
      (await narrow.call(hrKey, '/api/service/hr/reports/export.csv?type=audit')).status,
      400,
    );
    assert.equal((await auditFor(db, 'service_export_report_csv')).length >= 3, true);
    const xlsx = await narrow.call(hrKey, '/api/service/hr/imports/employees/template.xlsx');
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.bytes.subarray(0, 2).toString('latin1'), 'PK');
  } finally {
    await all.close();
    await narrow.close();
    await closeChromium();
  }
}

test('HR service exports: scopes, masking, audit on SQLite', async () => {
  await scenario(await createDatabase());
});

test(
  'HR service exports: the same scenario on PostgreSQL',
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
