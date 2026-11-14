// Payroll register (owner's template layout) and the GOSI section of a payroll rule version.
// Every rate below is a test fixture typed into a rule version, not a statutory value.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createDatabase, type AsyncDb } from '../../server/database.js';
import { registerPayroll } from '../../server/payroll/index.js';
import { getProfileValues } from '../../server/administration/service.js';
import { encryptSensitive } from '../../server/administration/security.js';
import { employeeFields } from '../../shared/catalog.js';
import {
  buildPayrollRegister,
  registerTable,
  REGISTER_COLUMNS,
} from '../../shared/payroll-register.js';
import {
  gosiContribution,
  parseGosiRule,
  resolveGosiCategory,
  shareOf,
} from '../../shared/gosi.js';
import type { Role } from '../../shared/contracts.js';

const fixtureRule = {
  wageComponents: ['basicSalary', 'housingAllowance'],
  maxWageMinor: 4_500_000,
  minWageMinor: 0,
  categories: {
    saudi_existing: { employeeBps: 975, employerBps: 1175 },
    saudi_new: { employeeBps: 1075, employerBps: 1275 },
    non_saudi: { employeeBps: 0, employerBps: 200 },
  },
};

test('GOSI rule: shape validation, categories, cap and half-up rounding', () => {
  assert.equal(parseGosiRule({}), null);
  assert.throws(() => parseGosiRule({ gosi: { ...fixtureRule, maxWageMinor: 0 } }));
  assert.throws(() =>
    parseGosiRule({
      gosi: { ...fixtureRule, categories: { ...fixtureRule.categories, non_saudi: {} } },
    }),
  );
  assert.throws(() => parseGosiRule({ gosi: { ...fixtureRule, wageComponents: ['bonus'] } }));
  const rule = parseGosiRule({ gosi: fixtureRule })!;
  assert.deepEqual(resolveGosiCategory({ nationality: 'سعودي', insuranceCategory: 'existing' }), {
    category: 'saudi_existing',
    inferred: true,
  });
  assert.deepEqual(
    resolveGosiCategory({ insuranceNationalityGroup: 'saudi', insuranceCategory: 'new' }),
    { category: 'saudi_new', inferred: false },
  );
  assert.deepEqual(resolveGosiCategory({ nationality: 'سعودية' }), {
    category: null,
    problem: 'category_unreviewed',
  });
  assert.deepEqual(resolveGosiCategory({ nationality: 'كويتي' }), {
    category: null,
    problem: 'gcc_manual',
  });
  assert.deepEqual(resolveGosiCategory({}), { category: null, problem: 'nationality_missing' });
  assert.deepEqual(resolveGosiCategory({ nationality: 'مصري' }), {
    category: 'non_saudi',
    inferred: true,
  });
  // Explicit group wins over nationality text.
  assert.equal(
    resolveGosiCategory({ nationality: 'سعودي', insuranceNationalityGroup: 'non_saudi' }).category,
    'non_saudi',
  );
  assert.deepEqual(
    gosiContribution(rule, 'saudi_existing', { basicSalary: 1_000_000, housingAllowance: 250_000 }),
    { wageMinor: 1_250_000, employeeMinor: 121_875, employerMinor: 146_875 },
  );
  // Ceiling: allowances above the cap are not contributory.
  assert.equal(
    gosiContribution(rule, 'saudi_new', { basicSalary: 6_000_000, housingAllowance: 0 }).wageMinor,
    4_500_000,
  );
  assert.equal(shareOf(1_005, 50), 5); // 5.025 → 5
  assert.equal(shareOf(1_010, 50), 5); // 5.05 → 5 (half-up on halalas: 5.05 rounds at 0.5 halala)
  assert.equal(shareOf(3, 5000), 2); // 1.5 → 2
});

test('register: template columns, payment-method groups, totals and correction prefix', () => {
  const lines = [
    ['a', 'أحمد', 'الراتب الأساسي', 'earning', 500_000],
    ['a', 'أحمد', 'بدل السكن', 'earning', 125_000],
    ['a', 'أحمد', 'تأمين الموظف', 'deduction', 60_938],
    ['a', 'أحمد', 'مكافأة معتمدة', 'earning', 10_000],
    ['b', 'باسم', 'الراتب الأساسي', 'earning', 300_000],
    ['b', 'باسم', 'بدل النقل', 'earning', 50_000],
    ['b', 'باسم', 'فرق: خصم غياب', 'deduction', 20_000],
  ].map(([employeeId, employeeName, component, kind, amountMinor], i) => ({
    id: String(i),
    employeeId: employeeId as string,
    employeeName: employeeName as string,
    component: component as string,
    kind: kind as 'earning' | 'deduction',
    amountMinor: amountMinor as number,
    source: 'test',
  }));
  const person = (employeeId: string, paymentMethod: 'direct' | 'wps') => ({
    employeeId,
    employeeName: '',
    title: 'محرر',
    paymentMethod,
    employerContributionMinor: 1_000,
    insuranceCategory: null,
    insuranceCategoryInferred: false,
    insuredWageMinor: 0,
    employmentType: 'staff' as const,
  });
  const register = buildPayrollRegister({
    lines,
    people: [person('a', 'wps'), person('b', 'direct')],
    payments: [
      { employeeId: 'a', state: 'paid', paidMinor: 574_062, reference: '', recordedAt: '' },
    ],
  });
  assert.deepEqual(
    register.groups.map((g) => [g.method, g.rows.map((r) => r.employeeId)]),
    [
      ['direct', ['b']],
      ['wps', ['a']],
    ],
  );
  const a = register.groups[1]!.rows[0]!;
  assert.equal(a.bonusMinor, 10_000);
  assert.equal(a.grossMinor, 635_000);
  assert.equal(a.insuranceMinor, 60_938);
  assert.equal(a.netMinor, 574_062);
  assert.equal(a.paymentState, 'paid');
  const b = register.groups[0]!.rows[0]!;
  assert.equal(b.deductionsMinor, 20_000);
  assert.equal(b.transportMinor, 50_000);
  assert.equal(register.totals.netMinor, a.netMinor + b.netMinor);
  assert.equal(register.employerContributionMinor, 2_000);
  assert.deepEqual(register.unpaid, { count: 1, amountMinor: b.netMinor });
  const table = registerTable(register);
  assert.deepEqual(table.header.slice(3, 3 + REGISTER_COLUMNS.length), [
    'الراتب الأساسي',
    'بدل السكن',
    'بدل النقل',
    'بدلات أخرى',
    'المكافأة',
    'إجمالي الراتب',
    'تأمين الموظف',
    'الخصومات',
    'إجمالي الخصومات',
    'صافي الراتب',
  ]);
  assert.equal(table.rows.at(-1)![1], 'الإجمالي');
});

const identities: Record<string, { id: string; role: Role }> = {
  hr: { id: 'emp-noura', role: 'hr' },
  finance: { id: 'emp-reem', role: 'finance' },
  approver: { id: 'emp-abdullah', role: 'approver' },
  auditor: { id: 'emp-hind', role: 'auditor' },
  employee: { id: 'emp-sara', role: 'employee' },
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
async function fixture() {
  const db = await createDatabase();
  const app = express();
  app.use(express.json());
  registerPayroll(app, {
    db,
    requireActor: (req) => {
      const actor = identities[String(req.header('x-test-actor'))];
      if (!actor)
        throw Object.assign(new Error('unauthorized'), { status: 401, code: 'unauthorized' });
      return actor;
    },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  const base = `http://127.0.0.1:${address.port}/api/admin/payroll`;
  async function raw(as: string, path = '', method = 'GET', body?: unknown) {
    return fetch(base + path, {
      method,
      headers: {
        'x-test-actor': as,
        ...(body
          ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function api<T>(as: string, path = '', method = 'GET', body?: unknown) {
    const response = await raw(as, path, method, body);
    return { status: response.status, body: (await response.json()) as T };
  }
  async function addPolicy(id: string, values: unknown) {
    await db.execute(
      `INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,source,state,values_json,created_by,approved_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        'payroll',
        id.endsWith('bad') ? 2 : 1,
        'قواعد اختبار',
        '2026-01-01',
        'قيم اختبار فقط',
        'synthetic_approved',
        JSON.stringify(values),
        'emp-noura',
        'emp-abdullah',
        '2026-11-14T00:00:00.000Z',
      ],
    );
  }
  return {
    db,
    api,
    raw,
    addPolicy,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await db.close();
    },
  };
}

test('payroll run applies the approved GOSI rule per category and snapshots the register', async () => {
  const f = await fixture();
  try {
    await f.addPolicy('payroll-test-gosi', {
      currency: 'SAR',
      calculation: 'profile-components',
      gosi: fixtureRule,
    });
    await f.addPolicy('payroll-test-bad', {
      currency: 'SAR',
      calculation: 'profile-components',
      gosi: { ...fixtureRule, maxWageMinor: -1 },
    });
    await setProfile(f.db, 'emp-sara', {
      nationality: 'سعودي',
      insuranceCategory: 'existing',
      payrollPaymentMethod: 'wps',
      basicSalary: '10000',
      housingAllowance: '2500',
      transportAllowance: '',
    });
    await setProfile(f.db, 'emp-omar', {
      nationality: 'مصري',
      payrollPaymentMethod: 'direct',
      basicSalary: '60000',
      housingAllowance: '0',
    });
    await setProfile(f.db, 'emp-hind', { nationality: 'سعودي', insuranceCategory: 'unreviewed' });

    const listed = await f.api<{ policies: any[] }>('hr', '/policies?period=2026-09');
    const listedTest = listed.body.policies.find((p) => p.id === 'payroll-test-gosi');
    assert.equal(listedTest.gosi.categories.saudi_existing.employeeBps, 975);
    assert.equal(listed.body.policies.find((p) => p.id === 'payroll-test-bad').gosiInvalid, true);
    assert.equal((await f.api('employee', '/policies')).status, 403);

    const bad = await f.api<any>('hr', '', 'POST', {
      period: '2026-09',
      policyId: 'payroll-test-bad',
      reason: 'قاعدة غير صالحة',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'gosi_rule_invalid');

    const made = await f.api<any>('hr', '', 'POST', {
      period: '2026-09',
      policyId: 'payroll-test-gosi',
      reason: 'مسير اختبار التأمينات',
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const run = made.body.run;
    assert.equal(run.policyName, 'قواعد اختبار · الإصدار 1');
    assert.ok(made.body.excludedCount >= 1);
    assert.ok(made.body.exclusions.some((e: any) => e.code === 'category_unreviewed'));
    assert.ok(!run.lines.some((l: any) => l.employeeId === 'emp-hind'));
    const insurance = (id: string) =>
      run.lines.find((l: any) => l.employeeId === id && l.component === 'تأمين الموظف');
    assert.equal(insurance('emp-sara').amountMinor, 121_875);
    assert.equal(insurance('emp-sara').kind, 'deduction');
    assert.equal(insurance('emp-omar'), undefined);
    const sara = run.people.find((p: any) => p.employeeId === 'emp-sara');
    assert.deepEqual(
      [
        sara.paymentMethod,
        sara.insuranceCategory,
        sara.insuredWageMinor,
        sara.employerContributionMinor,
      ],
      ['wps', 'saudi_existing', 1_250_000, 146_875],
    );
    const omar = run.people.find((p: any) => p.employeeId === 'emp-omar');
    assert.equal(omar.insuranceCategoryInferred, true);
    assert.equal(omar.insuredWageMinor, 4_500_000);
    assert.equal(omar.employerContributionMinor, 90_000);
    const register = buildPayrollRegister(run);
    assert.equal(register.totals.netMinor, run.totals.netMinor);
    assert.ok(
      register.groups
        .find((g) => g.method === 'wps')!
        .rows.some((r) => r.employeeId === 'emp-sara'),
    );

    // Auditor: pseudonyms are stable per employee so the register still groups rows.
    const audited = (await f.api<any>('auditor', `/${run.id}`)).body.run;
    const auditedRegister = buildPayrollRegister(audited);
    assert.equal(auditedRegister.employeeCount, register.employeeCount);
    assert.ok(audited.people.every((p: any) => p.employeeId === '' && p.title === ''));

    const csv = await (await f.raw('finance', `/${run.id}/export`)).text();
    assert.ok(csv.startsWith('"م","اسم الموظف","المسمى الوظيفي","الراتب الأساسي"'));
    const xlsx = await f.raw('finance', `/${run.id}/register.xlsx`);
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-type') ?? '', /spreadsheetml/);
    assert.ok((await xlsx.arrayBuffer()).byteLength > 1000);
    assert.equal((await f.raw('employee', `/${run.id}/register.xlsx`)).status, 404);

    // Close the run, then the register snapshot is immutable.
    let current = run;
    for (const [as, action] of [
      ['hr', 'submit'],
      ['finance', 'review'],
      ['approver', 'approve'],
    ] as const) {
      const step = await f.api<any>(as, `/${current.id}/actions`, 'POST', {
        action,
        version: current.version,
      });
      assert.equal(step.status, 200, JSON.stringify(step.body));
      current = step.body.run;
    }
    assert.equal(current.state, 'closed');
    // Payments stay visible to auditors through the stable pseudonym.
    const saraNet = buildPayrollRegister(current)
      .groups.flatMap((g) => g.rows)
      .find((r) => r.employeeId === 'emp-sara')!.netMinor;
    const paid = await f.api<any>('finance', `/${run.id}/payments`, 'POST', {
      version: current.version,
      employeeId: 'emp-sara',
      state: 'paid',
      paidMinor: saraNet,
      reference: 'تحويل اختبار',
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const auditedClosed = buildPayrollRegister(
      (await f.api<any>('auditor', `/${run.id}`)).body.run,
    );
    assert.equal(auditedClosed.paid.count, 1);
    assert.equal(auditedClosed.paid.amountMinor, saraNet);
    await assert.rejects(
      f.db.execute('UPDATE payroll_run_people SET payment_method=? WHERE run_id=?', [
        'direct',
        run.id,
      ]),
    );
    await assert.rejects(f.db.execute('DELETE FROM payroll_run_people WHERE run_id=?', [run.id]));
    // Copy to the next month: same lines, insurance recomputed, request-sourced lines dropped,
    // people who left are not copied and contractors keep their lump sum without insurance.
    await setProfile(f.db, 'emp-hind', {
      payrollEmploymentType: 'contractor',
      contractorMonthlyAmount: '3000',
    });
    await f.db.execute("UPDATE employees SET employment_status='terminated' WHERE id='emp-omar'");
    const copied = await f.api<any>('hr', `/${run.id}/copy`, 'POST', {
      period: '2026-10',
      policyId: 'payroll-test-gosi',
      reason: 'نسخ مسير الشهر السابق',
    });
    assert.equal(copied.status, 200, JSON.stringify(copied.body));
    const next = copied.body.run;
    assert.equal(next.period, '2026-10');
    assert.equal(next.state, 'draft');
    assert.ok(!next.lines.some((l: any) => l.employeeId === 'emp-omar'));
    assert.ok(copied.body.exclusions.some((e: any) => e.code === 'copy_left'));
    assert.ok(copied.body.exclusions.some((e: any) => e.code === 'copy_added'));
    const hind = next.lines.filter((l: any) => l.employeeId === 'emp-hind');
    assert.deepEqual(
      hind.map((l: any) => [l.component, l.kind, l.amountMinor]),
      [['مبلغ مقطوع', 'earning', 300_000]],
    );
    const hindPerson = next.people.find((p: any) => p.employeeId === 'emp-hind');
    assert.deepEqual(
      [hindPerson.employmentType, hindPerson.employerContributionMinor],
      ['contractor', 0],
    );
    const nextSara = next.lines.find(
      (l: any) => l.employeeId === 'emp-sara' && l.component === 'تأمين الموظف',
    );
    assert.equal(nextSara.amountMinor, 121_875);
    // Editing the basic salary recomputes insurance; a hand-typed insurance amount is replaced.
    const edited = await f.api<any>('hr', `/${next.id}`, 'PATCH', {
      version: next.version,
      reason: 'زيادة راتب',
      lines: next.lines.map((l: any) =>
        l.employeeId === 'emp-sara' && l.component === 'الراتب الأساسي'
          ? { ...l, amountMinor: 1_100_000 }
          : l.employeeId === 'emp-sara' && l.component === 'تأمين الموظف'
            ? { ...l, amountMinor: 1 }
            : l,
      ),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const editedSara = edited.body.run.lines.find(
      (l: any) => l.employeeId === 'emp-sara' && l.component === 'تأمين الموظف',
    );
    assert.equal(editedSara.amountMinor, 131_625); // (11000 + 2500) × 9.75%
    assert.equal(
      edited.body.run.people.find((p: any) => p.employeeId === 'emp-sara')
        .employerContributionMinor,
      158_625,
    );
    assert.equal(
      (
        await f.api<any>('hr', `/${run.id}/copy`, 'POST', {
          period: '2026-10',
          reason: 'نسخة ثانية',
        })
      ).body.error.code,
      'period_already_exists',
    );
    assert.equal(
      (
        await f.api<any>('finance', `/${run.id}/copy`, 'POST', {
          period: '2026-11',
          reason: 'ليس للمالية',
        })
      ).status,
      403,
    );

    // A correction run copies the register attributes and starts with zero employer share.
    const correction = await f.api<any>('hr', '', 'POST', {
      period: '2026-09',
      correctionOf: run.id,
      reason: 'تصحيح اختبار',
    });
    assert.equal(correction.status, 200, JSON.stringify(correction.body));
    const copiedPerson = correction.body.run.people.find((p: any) => p.employeeId === 'emp-sara');
    assert.equal(copiedPerson.paymentMethod, 'wps');
    assert.equal(copiedPerson.employerContributionMinor, 0);
  } finally {
    await f.close();
  }
});

test('without an approved payroll rule version, creating a run explains what is missing', async () => {
  const f = await fixture();
  try {
    await f.db.execute(
      "UPDATE administrative_policies SET state='retired' WHERE policy_key='payroll-demo'",
    );
    const made = await f.api<any>('hr', '', 'POST', { period: '2026-10', reason: 'بلا قواعد' });
    assert.equal(made.status, 400);
    assert.equal(made.body.error.code, 'policy_unavailable');
    assert.match(made.body.error.message, /يعتمده المعتمد المستقل/);
    assert.deepEqual((await f.api<any>('hr', '/policies?period=2026-10')).body.policies, []);
  } finally {
    await f.close();
  }
});

test('an employee added to a draft by hand gets a register snapshot and the insurance rule', async () => {
  const f = await fixture();
  try {
    await f.addPolicy('payroll-test-gosi', {
      currency: 'SAR',
      calculation: 'profile-components',
      gosi: fixtureRule,
    });
    await setProfile(f.db, 'emp-sara', {
      nationality: 'سعودي',
      insuranceCategory: 'unreviewed',
      basicSalary: '10000',
      housingAllowance: '2500',
    });
    const made = await f.api<any>('hr', '', 'POST', {
      period: '2026-08',
      policyId: 'payroll-test-gosi',
      reason: 'مسير إضافة يدوية',
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    let run = made.body.run;
    assert.ok(!run.lines.some((l: any) => l.employeeId === 'emp-sara'));
    const withSara = (version: number) =>
      f.api<any>('hr', `/${run.id}`, 'PATCH', {
        version,
        reason: 'إضافة موظفة',
        lines: [
          ...run.lines,
          {
            employeeId: 'emp-sara',
            component: 'الراتب الأساسي',
            kind: 'earning',
            amountMinor: 1_000_000,
          },
        ],
      });
    const refused = await withSara(run.version);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'category_unreviewed');
    await setProfile(f.db, 'emp-sara', { insuranceCategory: 'new' });
    const saved = await withSara(run.version);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    run = saved.body.run;
    const insurance = run.lines.find(
      (l: any) => l.employeeId === 'emp-sara' && l.component === 'تأمين الموظف',
    );
    assert.equal(insurance.amountMinor, 107_500); // 10000 × 10.75% (no housing line added)
    const person = run.people.find((p: any) => p.employeeId === 'emp-sara');
    assert.deepEqual(
      [person.insuranceCategory, person.employerContributionMinor],
      ['saudi_new', 127_500],
    );
  } finally {
    await f.close();
  }
});
