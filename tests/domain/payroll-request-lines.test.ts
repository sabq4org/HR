// Advance repayments and unpaid leave deducted in payroll from approved requests (decision 021).
// Synthetic personas, requests and figures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';
import { registerPayroll } from '../../server/payroll/index.js';
import { getProfileValues } from '../../server/administration/service.js';
import { encryptSensitive } from '../../server/administration/security.js';
import { employeeFields } from '../../shared/catalog.js';
import {
  LEAVE_ENTITLEMENT_CALCULATION,
  LEAVE_ENTITLEMENT_POLICY_KEY,
} from '../../shared/leave-entitlement.js';
import { buildPayrollRegister } from '../../shared/payroll-register.js';
import type { Role } from '../../shared/contracts.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

const identities: Record<string, { id: string; role: Role }> = {
  hr: { id: 'emp-noura', role: 'hr' },
  finance: { id: 'emp-reem', role: 'finance' },
  approver: { id: 'emp-abdullah', role: 'approver' },
};

async function setProfile(db: AsyncDb, employeeId: string, values: Record<string, unknown>) {
  const merged = { ...(await getProfileValues(db, employeeId)), ...values };
  const fields = new Map(employeeFields.map((f) => [f.key, f]));
  const sensitive: Record<string, unknown> = {};
  const ordinary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged))
    (fields.get(key)?.sensitive ? sensitive : ordinary)[key] = value;
  await db.execute(
    'UPDATE employee_profile_data SET public_values_json=?,encrypted_values_json=? WHERE employee_id=?',
    [
      JSON.stringify(ordinary),
      encryptSensitive(JSON.stringify(sensitive), `employee-profile:${employeeId}`),
      employeeId,
    ],
  );
}

async function addRequest(
  db: AsyncDb,
  kind: string,
  number: string,
  employeeId: string,
  values: Record<string, unknown>,
) {
  const id = randomUUID();
  const at = new Date().toISOString();
  await db.execute(
    `INSERT INTO administrative_requests(id,request_number,kind,employee_id,created_by,state,version,values_json,steps_json,step_index,created_at,updated_at)
     VALUES(?,?,?,?,?,'approved',3,?,'[]',0,?,?)`,
    [id, number, kind, employeeId, employeeId, JSON.stringify(values), at, at],
  );
  return id;
}

async function requestLinesJourney(open: () => Promise<AsyncDb>) {
  const db = await open();
  const app = express();
  app.use(express.json());
  registerPayroll(app, {
    db,
    requireActor: (req) => {
      const actor = identities[String(req.header('x-test-actor'))];
      if (!actor) throw Object.assign(new Error('unauthorized'), { status: 401, code: 'x' });
      return actor;
    },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}/api/admin/payroll`;
  const api = async (as: string, path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-test-actor': as,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const close = async (run: any) => {
    let r = await api('hr', `/${run.id}/actions`, 'POST', {
      action: 'submit',
      version: run.version,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api('finance', `/${run.id}/actions`, 'POST', {
      action: 'review',
      version: r.body.run.version,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api('approver', `/${run.id}/actions`, 'POST', {
      action: 'approve',
      version: r.body.run.version,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.run.state, 'closed');
    return r.body.run;
  };
  const derived = (run: any, employeeId: string) =>
    run.lines
      .filter(
        (l: any) =>
          l.employeeId === employeeId &&
          (l.component.startsWith('حسم سلفة ') || l.component === 'خصم إجازة بدون أجر'),
      )
      .map((l: any) => [l.component, l.kind, l.amountMinor]);
  try {
    await setProfile(db, 'emp-maha', {
      payrollEmploymentType: 'staff',
      basicSalary: '6000',
      housingAllowance: '1500',
      transportAllowance: '500',
      otherAllowance: '',
    });
    await setProfile(db, 'emp-sara', {
      payrollEmploymentType: 'staff',
      basicSalary: '9000',
      housingAllowance: '',
      transportAllowance: '',
      otherAllowance: '',
    });
    // 1,000 riyals over three months from January; the last installment takes the remainder.
    await addRequest(db, 'advance', 'ADV-T1', 'emp-maha', {
      amount: 1000,
      installments: 3,
      firstDeductionMonth: '2027-01',
      reason: 'سلفة اختبار',
    });
    // An advance planned to start later is not touched before its month.
    await addRequest(db, 'advance', 'ADV-T2', 'emp-sara', {
      amount: 50000,
      installments: 1,
      firstDeductionMonth: '2027-04',
      reason: 'سلفة أكبر من الراتب',
    });
    // Four unpaid days across January and February; an annual-type special leave is ignored.
    await addRequest(db, 'special_leave', 'SL-T1', 'emp-sara', {
      leaveType: 'unpaid',
      startDate: '2027-01-30',
      endDate: '2027-02-02',
    });
    await addRequest(db, 'special_leave', 'SL-T2', 'emp-maha', {
      leaveType: 'hajj',
      startDate: '2027-01-10',
      endDate: '2027-01-20',
    });

    // Without an approved entitlement rule the unpaid leave is not deducted, and HR is told.
    const noRule = await api('hr', '', 'POST', { period: '2027-01', reason: 'مسير يناير' });
    assert.equal(noRule.status, 200, JSON.stringify(noRule.body));
    assert.deepEqual(derived(noRule.body.run, 'emp-sara'), []);
    assert.ok(noRule.body.exclusions.some((e: any) => e.code === 'unpaid_leave_no_rule'));
    // The advance does not depend on the leave rule.
    assert.deepEqual(derived(noRule.body.run, 'emp-maha'), [
      ['حسم سلفة ADV-T1', 'deduction', 33_333],
    ]);
    let r = await api('hr', `/${noRule.body.run.id}/actions`, 'POST', {
      action: 'submit',
      version: noRule.body.run.version,
    });
    r = await api('finance', `/${noRule.body.run.id}/actions`, 'POST', {
      action: 'reject',
      version: r.body.run.version,
      reason: 'إعادة بعد اعتماد القاعدة',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    await db.execute(
      `INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,source,state,values_json,created_by,approved_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'leave-rule-advance-test',
        LEAVE_ENTITLEMENT_POLICY_KEY,
        1,
        'قاعدة استحقاق اختبار',
        '2024-01-01',
        'قيم اختبار فقط',
        'synthetic_approved',
        JSON.stringify({
          calculation: LEAVE_ENTITLEMENT_CALCULATION,
          baseDays: 21,
          seniorDays: 30,
          seniorAfterYears: 5,
          yearDays: 365,
          dailyRateDivisor: 30,
          wageComponents: [
            'basicSalary',
            'housingAllowance',
            'transportAllowance',
            'otherAllowance',
          ],
          excludeContractors: true,
          sourceKind: 'secondary',
        }),
        'emp-noura',
        'emp-abdullah',
        '2026-11-14T00:00:00.000Z',
      ],
    );

    // January: first installment; two unpaid days at 9,000 ÷ 30 = 300 a day. The rejected run
    // above does not count as a paid installment.
    const jan = await api('hr', '', 'POST', { period: '2027-01', reason: 'مسير يناير' });
    assert.equal(jan.status, 200, JSON.stringify(jan.body));
    assert.deepEqual(derived(jan.body.run, 'emp-maha'), [['حسم سلفة ADV-T1', 'deduction', 33_333]]);
    assert.deepEqual(derived(jan.body.run, 'emp-sara'), [
      ['خصم إجازة بدون أجر', 'deduction', 60_000],
    ]);
    const saraRow = buildPayrollRegister(jan.body.run)
      .groups.flatMap((g) => g.rows)
      .find((x) => x.employeeId === 'emp-sara')!;
    assert.ok(saraRow.deductionsMinor >= 60_000);

    // A hand edit cannot change or drop the derived lines: they are written again.
    const edited = await api('hr', `/${jan.body.run.id}`, 'PATCH', {
      version: jan.body.run.version,
      reason: 'محاولة تعديل الحسم',
      lines: jan.body.run.lines
        .filter((l: any) => l.component !== 'خصم إجازة بدون أجر')
        .map((l: any) => (l.component.startsWith('حسم سلفة ') ? { ...l, amountMinor: 1 } : l)),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(derived(edited.body.run, 'emp-maha'), [
      ['حسم سلفة ADV-T1', 'deduction', 33_333],
    ]);
    assert.deepEqual(derived(edited.body.run, 'emp-sara'), [
      ['خصم إجازة بدون أجر', 'deduction', 60_000],
    ]);
    const janClosed = await close(edited.body.run);

    // February (copied): second installment and the two February days.
    const feb = await api('hr', `/${janClosed.id}/copy`, 'POST', {
      period: '2027-02',
      reason: 'مسير فبراير',
    });
    assert.equal(feb.status, 200, JSON.stringify(feb.body));
    assert.deepEqual(derived(feb.body.run, 'emp-maha'), [['حسم سلفة ADV-T1', 'deduction', 33_333]]);
    assert.deepEqual(derived(feb.body.run, 'emp-sara'), [
      ['خصم إجازة بدون أجر', 'deduction', 60_000],
    ]);
    await close(feb.body.run);

    // March: the last installment takes the remainder, and the advance is fully repaid.
    const mar = await api('hr', '', 'POST', { period: '2027-03', reason: 'مسير مارس' });
    assert.equal(mar.status, 200, JSON.stringify(mar.body));
    assert.deepEqual(derived(mar.body.run, 'emp-maha'), [['حسم سلفة ADV-T1', 'deduction', 33_334]]);
    assert.deepEqual(derived(mar.body.run, 'emp-sara'), []);
    await close(mar.body.run);

    // April: Maha owes nothing; Sara's 50,000 advance cannot exceed her net, so the run deducts
    // what fits, leaves the rest owed and tells the preparer.
    const apr = await api('hr', '', 'POST', { period: '2027-04', reason: 'مسير أبريل' });
    assert.equal(apr.status, 200, JSON.stringify(apr.body));
    assert.deepEqual(derived(apr.body.run, 'emp-maha'), []);
    const saraApr = buildPayrollRegister(apr.body.run)
      .groups.flatMap((g) => g.rows)
      .find((x) => x.employeeId === 'emp-sara')!;
    assert.equal(saraApr.netMinor, 0);
    assert.ok(apr.body.exclusions.some((e: any) => e.code === 'advance_capped'));
    assert.ok(apr.body.exclusions.some((e: any) => e.code === 'advance_over_tenth'));
    await close(apr.body.run);

    // May: a whole 31-day month unpaid at wage ÷ 30 would exceed the pay; the deduction stops at
    // the net instead of blocking the run, and the preparer is told.
    await addRequest(db, 'special_leave', 'SL-T3', 'emp-maha', {
      leaveType: 'unpaid',
      startDate: '2027-05-01',
      endDate: '2027-05-31',
    });
    const may = await api('hr', '', 'POST', { period: '2027-05', reason: 'مسير مايو' });
    assert.equal(may.status, 200, JSON.stringify(may.body));
    const mahaMay = buildPayrollRegister(may.body.run)
      .groups.flatMap((g) => g.rows)
      .find((x) => x.employeeId === 'emp-maha')!;
    assert.equal(mahaMay.netMinor, 0);
    assert.ok(may.body.exclusions.some((e: any) => e.code === 'unpaid_leave_capped'));
    await close(may.body.run);

    // June: a new rule version from 15 June (divisor 31) prices its own days.
    await db.execute(
      `INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,source,state,values_json,created_by,approved_by,created_at)
       SELECT 'leave-rule-advance-test-v2',policy_key,2,name,'2027-06-15',source,state,
         REPLACE(values_json,'"dailyRateDivisor":30','"dailyRateDivisor":31'),created_by,approved_by,created_at
       FROM administrative_policies WHERE id='leave-rule-advance-test'`,
    );
    await addRequest(db, 'special_leave', 'SL-T4', 'emp-maha', {
      leaveType: 'unpaid',
      startDate: '2027-06-10',
      endDate: '2027-06-20',
    });
    const jun = await api('hr', '', 'POST', { period: '2027-06', reason: 'مسير يونيو' });
    assert.equal(jun.status, 200, JSON.stringify(jun.body));
    // 8,000: five days at 266.67 and six at 258.06.
    assert.deepEqual(derived(jun.body.run, 'emp-maha'), [
      ['خصم إجازة بدون أجر', 'deduction', 5 * 26_667 + 6 * 25_806],
    ]);

    // An advance approved after the draft was prepared is applied on submit, and the submit
    // response carries the notice.
    await addRequest(db, 'advance', 'ADV-T3', 'emp-maha', {
      amount: 3000,
      installments: 1,
      firstDeductionMonth: '2027-06',
    });
    const submitted = await api('hr', `/${jun.body.run.id}/actions`, 'POST', {
      action: 'submit',
      version: jun.body.run.version,
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.ok(
      submitted.body.run.lines.some(
        (l: any) => l.employeeId === 'emp-maha' && l.component === 'حسم سلفة ADV-T3',
      ),
    );
    assert.ok(submitted.body.exclusions.some((e: any) => e.code === 'advance_over_tenth'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await db.close();
  }
}

test('approved advances and unpaid leave are deducted in payroll (SQLite)', () =>
  requestLinesJourney(() => createDatabase()));

test(
  'approved advances and unpaid leave are deducted in payroll on PostgreSQL',
  { skip: pgUrl ? false : 'HR_TEST_DATABASE_URL not set' },
  () =>
    requestLinesJourney(() =>
      createPostgresDatabase(pgUrl!, `hr_preview_${randomUUID().replaceAll('-', '')}`, {
        seed: true,
      }),
    ),
);
