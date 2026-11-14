// Art. 109 leave-wage advance in payroll (decision 015). Synthetic personas and figures only.
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
import { buildPayrollRegister, PAYROLL_COMPONENTS } from '../../shared/payroll-register.js';
import type { Role } from '../../shared/contracts.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

const identities: Record<string, { id: string; role: Role }> = {
  hr: { id: 'emp-noura', role: 'hr' },
  finance: { id: 'emp-reem', role: 'finance' },
  approver: { id: 'emp-abdullah', role: 'approver' },
};
const ADVANCE = PAYROLL_COMPONENTS.leaveAdvance;
const RECOVERY = PAYROLL_COMPONENTS.leaveAdvanceRecovery;

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

async function addLeave(
  db: AsyncDb,
  employeeId: string,
  start: string,
  end: string,
  extra: { status?: string; parent?: string } = {},
) {
  const id = randomUUID();
  await db.execute(
    'INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,note,status,version,created_at,current_flag,parent_leave_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      employeeId,
      start,
      end,
      5,
      'إجازة اختبار',
      extra.status ?? 'approved',
      1,
      new Date().toISOString(),
      1,
      extra.parent ?? null,
    ],
  );
  return id;
}

async function advanceJourney(open: () => Promise<AsyncDb>) {
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
  const leaveLines = (run: any, employeeId: string) =>
    run.lines.filter((l: any) => l.employeeId === employeeId && l.sourceLeaveId);
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
    // Ten days across February and March; five days in February that will be cancelled.
    const maha = await addLeave(db, 'emp-maha', '2027-02-25', '2027-03-06');
    const sara = await addLeave(db, 'emp-sara', '2027-02-10', '2027-02-14');

    // Without an approved entitlement rule nothing is advanced, and the preparer is told.
    const noRule = await api('hr', '', 'POST', { period: '2027-01', reason: 'مسير يناير' });
    assert.equal(noRule.status, 200, JSON.stringify(noRule.body));
    assert.equal(leaveLines(noRule.body.run, 'emp-maha').length, 0);
    assert.ok(noRule.body.exclusions.some((e: any) => e.code === 'leave_advance_no_rule'));
    // Rejected so the period can be prepared again once the rule exists.
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

    // January: both leaves start in February, so January pays their wage in advance.
    const jan = await api('hr', '', 'POST', { period: '2027-01', reason: 'مسير يناير' });
    assert.equal(jan.status, 200, JSON.stringify(jan.body));
    const [mahaAdvance] = leaveLines(jan.body.run, 'emp-maha');
    assert.equal(mahaAdvance.component, ADVANCE);
    assert.equal(mahaAdvance.kind, 'earning');
    assert.equal(mahaAdvance.amountMinor, 10 * 26_667); // 8,000 ÷ 30 = 266.67 a day
    assert.equal(mahaAdvance.sourceLeaveId, maha);
    assert.equal(leaveLines(jan.body.run, 'emp-sara')[0].amountMinor, 5 * 30_000);
    const register = buildPayrollRegister(jan.body.run);
    const mahaRow = register.groups
      .flatMap((g) => g.rows)
      .find((x) => x.employeeId === 'emp-maha')!;
    assert.equal(mahaRow.leaveAdvanceMinor, 266_670);
    assert.equal(mahaRow.bonusMinor, 0);

    // A hand edit cannot change or remove the advance: it is written again from the leave.
    const edited = await api('hr', `/${jan.body.run.id}`, 'PATCH', {
      version: jan.body.run.version,
      reason: 'محاولة تعديل الأجر المقدم',
      lines: jan.body.run.lines
        .filter((l: any) => !(l.employeeId === 'emp-sara' && l.sourceLeaveId))
        .map((l: any) => (l.sourceLeaveId ? { ...l, amountMinor: 1 } : l)),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(leaveLines(edited.body.run, 'emp-maha')[0].amountMinor, 266_670);
    assert.equal(leaveLines(edited.body.run, 'emp-sara')[0].amountMinor, 150_000);
    const janClosed = await close(edited.body.run);

    // Sara's leave is cancelled after the advance (an approved cancel change).
    await db.execute('UPDATE leave_requests SET current_flag=0 WHERE id=?', [sara]);
    await addLeave(db, 'emp-sara', '2027-02-10', '2027-02-14', {
      status: 'cancelled',
      parent: sara,
    });

    // February (copied from January): the advance is not copied; February recovers the four
    // February days of Maha's leave and all of Sara's cancelled advance.
    const feb = await api('hr', `/${janClosed.id}/copy`, 'POST', {
      period: '2027-02',
      reason: 'مسير فبراير',
    });
    assert.equal(feb.status, 200, JSON.stringify(feb.body));
    const febMaha = leaveLines(feb.body.run, 'emp-maha');
    assert.deepEqual(
      febMaha.map((l: any) => [l.component, l.kind, l.amountMinor]),
      [[RECOVERY, 'deduction', 4 * 26_667]],
    );
    assert.deepEqual(
      leaveLines(feb.body.run, 'emp-sara').map((l: any) => [l.component, l.amountMinor]),
      [[RECOVERY, 150_000]],
    );
    await close(feb.body.run);

    // March: the leave ended on 6 March, so the remainder is recovered and the total matches.
    const mar = await api('hr', '', 'POST', { period: '2027-03', reason: 'مسير مارس' });
    assert.equal(mar.status, 200, JSON.stringify(mar.body));
    const marMaha = leaveLines(mar.body.run, 'emp-maha');
    assert.equal(marMaha.length, 1);
    assert.equal(marMaha[0].amountMinor, 266_670 - 4 * 26_667);
    assert.equal(leaveLines(mar.body.run, 'emp-sara').length, 0);
    await close(mar.body.run);

    // April: nothing left to recover or advance.
    const apr = await api('hr', '', 'POST', { period: '2027-04', reason: 'مسير أبريل' });
    assert.equal(apr.status, 200);
    assert.equal(apr.body.run.lines.filter((l: any) => l.sourceLeaveId).length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await db.close();
  }
}

test('leave wage is advanced in the prior run and recovered in the leave months (SQLite)', () =>
  advanceJourney(() => createDatabase()));

test(
  'leave wage advance and recovery on PostgreSQL',
  { skip: pgUrl ? false : 'HR_TEST_DATABASE_URL not set' },
  () =>
    advanceJourney(() =>
      createPostgresDatabase(pgUrl!, `hr_preview_${randomUUID().replaceAll('-', '')}`, {
        seed: true,
      }),
    ),
);
