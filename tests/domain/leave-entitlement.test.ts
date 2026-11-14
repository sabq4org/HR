// Annual leave entitlement and leave encashment (decision 015). Every figure in the rule below
// is a test fixture typed into a rule version, not a statutory value read from the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';
import { registerEntitlementRoutes } from '../../server/leave/entitlement.js';
import { getProfileValues } from '../../server/administration/service.js';
import { encryptSensitive } from '../../server/administration/security.js';
import { employeeFields } from '../../shared/catalog.js';
import {
  LEAVE_ENTITLEMENT_CALCULATION,
  LEAVE_ENTITLEMENT_POLICY_KEY,
  accrueLeave,
  completedServiceYears,
  encashmentAmount,
  parseLeaveEntitlementValues,
} from '../../shared/leave-entitlement.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

const ruleValues = {
  calculation: LEAVE_ENTITLEMENT_CALCULATION,
  baseDays: 21,
  seniorDays: 30,
  seniorAfterYears: 5,
  yearDays: 365,
  dailyRateDivisor: 30,
  wageComponents: ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'],
  excludeContractors: true,
  sourceKind: 'secondary',
};
const rule = (effectiveFrom = '2020-01-01') => ({
  id: 'r1',
  version: 1,
  effectiveFrom,
  effectiveTo: null,
  values: parseLeaveEntitlementValues(ruleValues).ok ? (ruleValues as never) : (null as never),
});

test('accrual arithmetic: 21 a year, 30 from the fifth anniversary, leap day and service years', () => {
  assert.equal(parseLeaveEntitlementValues({ ...ruleValues, seniorDays: 10 }).ok, false);
  assert.equal(parseLeaveEntitlementValues({ ...ruleValues, wageComponents: ['bonus'] }).ok, false);
  // A full 365-day year earns exactly 21 days.
  assert.equal(accrueLeave('2021-01-01', '2021-01-01', '2021-12-31', [rule()]).milli, 21_000);
  // Half a year (2023-01-01..2023-07-02 = 183 days) → 183×21/365 = 10.528…
  assert.equal(accrueLeave('2021-01-01', '2023-01-01', '2023-07-02', [rule()]).milli, 10_528);
  // Crossing the fifth anniversary on 2026-03-01: 59 days at 21, then 306 days at 30.
  const crossing = accrueLeave('2021-03-01', '2026-01-01', '2026-12-31', [rule()]);
  assert.deepEqual(
    crossing.segments.map((s) => [s.from, s.to, s.daysPerYear, s.calendarDays]),
    [
      ['2026-01-01', '2026-02-28', 21, 59],
      ['2026-03-01', '2026-12-31', 30, 306],
    ],
  );
  assert.equal(crossing.milli, Math.floor((59 * 21 * 1000 + 306 * 30 * 1000) / 365));
  // Days no approved rule covers earn nothing.
  const gap = accrueLeave('2021-01-01', '2025-12-01', '2026-01-10', [rule('2026-01-01')]);
  assert.equal(gap.segments[0]!.ruleId, null);
  assert.equal(gap.milli, Math.floor((10 * 30 * 1000) / 365)); // senior from 2026-01-01
  assert.equal(completedServiceYears('2020-02-29', '2025-02-28'), 4);
  assert.equal(completedServiceYears('2020-02-29', '2025-03-01'), 5);
  // 9,000 SAR monthly ÷ 30 = 300 SAR a day; 12.5 days → 3,750 SAR.
  assert.deepEqual(encashmentAmount(900_000, 30, 12_500), {
    dailyMinor: 30_000,
    amountMinor: 375_000,
  });
});

const identities: Record<string, { id: string; role: string; owner?: boolean }> = {
  hr: { id: 'emp-noura', role: 'hr' },
  hr2: { id: 'emp-khaled', role: 'hr' },
  owner: { id: 'emp-abdullah', role: 'hr', owner: true },
  finance: { id: 'emp-reem', role: 'finance' },
  employee: { id: 'emp-sara', role: 'employee' },
  manager: { id: 'emp-omar', role: 'manager' },
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

async function fixture(open: () => Promise<AsyncDb>) {
  const db = await open();
  const app = express();
  app.use(express.json());
  registerEntitlementRoutes(app, {
    db,
    requireActor: ((req: express.Request) => {
      const actor = identities[String(req.header('x-test-actor'))];
      if (!actor) throw Object.assign(new Error('unauthorized'), { status: 401, code: 'x' });
      return actor;
    }) as never,
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function api<T = any>(
    as: string,
    path: string,
    method = 'GET',
    body?: unknown,
    key = randomUUID(),
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-test-actor': as,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  // A clean ledger for the subject, an approved rule from 2024-01-01, and a staff profile.
  await db.execute(
    `INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,source,state,values_json,created_by,approved_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'leave-rule-test',
      LEAVE_ENTITLEMENT_POLICY_KEY,
      1,
      'قاعدة استحقاق اختبار',
      '2024-01-01',
      'قيم اختبار فقط',
      'synthetic_approved',
      JSON.stringify(ruleValues),
      'emp-noura',
      'emp-abdullah',
      '2026-11-14T00:00:00.000Z',
    ],
  );
  const subject = 'emp-maha';
  await db.execute('UPDATE employees SET join_date=? WHERE id=?', ['2020-06-01', subject]);
  await setProfile(db, subject, {
    payrollEmploymentType: 'staff',
    basicSalary: '6000',
    housingAllowance: '1500',
    transportAllowance: '500',
    otherAllowance: '',
  });
  return {
    db,
    api,
    subject,
    close: async () => {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      await db.close();
    },
  };
}

async function journey(open: () => Promise<AsyncDb>) {
  const f = await fixture(open);
  try {
    const { api, subject, db } = f;
    const before = await f.db.read<any>(
      'SELECT COALESCE(SUM(days),0) AS d FROM leave_ledger WHERE employee_id=?',
      [subject],
    );
    const baseline = Number(before[0].d);
    // Statement: accrual starts at the rule (2024-01-01) since the employee has no opening.
    const s1 = await api('hr', `/leave-entitlement/employees/${subject}?asOf=2025-06-30`);
    assert.equal(s1.status, 200);
    assert.equal(s1.body.statement.accrualStart, '2024-01-01');
    assert.equal(s1.body.statement.seniorFrom, '2025-06-01');
    assert.equal(s1.body.statement.serviceYears, 5);
    // A manager cannot read another employee's statement; the employee can read their own.
    assert.equal((await api('manager', `/leave-entitlement/employees/${subject}`)).status, 403);
    assert.equal((await api('employee', '/leave-entitlement/employees/emp-sara')).status, 200);

    // Only HR posts accrual, and the same date twice adds nothing.
    assert.equal(
      (await api('finance', '/leave-entitlement/accruals', 'POST', { throughDate: '2025-06-30' }))
        .status,
      403,
    );
    const post = await api('hr', '/leave-entitlement/accruals', 'POST', {
      throughDate: '2025-06-30',
    });
    assert.equal(post.status, 200);
    const mine = post.body.results.find((r: any) => r.employeeId === subject);
    const expectedWhole = Math.floor(s1.body.statement.accruedMilli / 1000);
    assert.equal(mine.addedDays, expectedWhole);
    const again = await api('hr', '/leave-entitlement/accruals', 'POST', {
      throughDate: '2025-06-30',
    });
    assert.equal(again.body.results.find((r: any) => r.employeeId === subject).addedDays, 0);
    const ledger = await db.read<any>(
      'SELECT COALESCE(SUM(days),0) AS d FROM leave_ledger WHERE employee_id=?',
      [subject],
    );
    assert.equal(Number(ledger[0].d) - baseline, expectedWhole);
    // Accrual rows are append-only.
    await assert.rejects(
      db.execute('DELETE FROM leave_accrual_postings WHERE employee_id=?', [subject]),
    );

    // Settlement: HR prepares, finance reviews, owner approves; nobody acts twice.
    const lastDay = '2025-08-31';
    const preview = await api(
      'hr',
      `/leave-settlements/preview?employeeId=${subject}&lastDay=${lastDay}`,
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const calc = preview.body.calculation;
    assert.equal(calc.monthlyWageMinor, 800_000);
    assert.equal(calc.dailyMinor, Math.round(800_000 / 30));
    const created = await api('hr', '/leave-settlements', 'POST', {
      employeeId: subject,
      lastDay,
      reasonType: 'resignation',
    });
    assert.equal(created.status, 201);
    const s = created.body.settlement;
    assert.equal(s.state, 'pending_finance');
    assert.equal(s.balanceMilli, calc.balanceMilli);
    assert.equal(s.amountMinor, Math.round((800_000 * calc.balanceMilli) / 30_000));
    // One open settlement per employee.
    assert.equal(
      (
        await api('hr', '/leave-settlements', 'POST', {
          employeeId: subject,
          lastDay,
          reasonType: 'resignation',
        })
      ).status,
      409,
    );
    // The preparer cannot review; the owner cannot skip finance.
    assert.equal(
      (
        await api('owner', `/leave-settlements/${s.id}/actions`, 'POST', {
          action: 'approve',
          version: 1,
        })
      ).status,
      403,
    );
    const reviewed = await api('finance', `/leave-settlements/${s.id}/actions`, 'POST', {
      action: 'approve',
      version: 1,
    });
    assert.equal(reviewed.body.settlement.state, 'pending_approver');
    // An HR account without the owner flag cannot approve; the stale version is refused.
    assert.equal(
      (
        await api('hr2', `/leave-settlements/${s.id}/actions`, 'POST', {
          action: 'approve',
          version: 2,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await api('owner', `/leave-settlements/${s.id}/actions`, 'POST', {
          action: 'approve',
          version: 1,
        })
      ).status,
      409,
    );
    const approved = await api('owner', `/leave-settlements/${s.id}/actions`, 'POST', {
      action: 'approve',
      version: 2,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.settlement.state, 'approved');
    // The ledger balance is consumed to zero; the approved record cannot be edited.
    const after = await db.read<any>(
      'SELECT kind,SUM(days) AS d FROM leave_ledger WHERE employee_id=? GROUP BY kind',
      [subject],
    );
    const sum = (k: string) => Number(after.find((r: any) => r.kind === k)?.d ?? 0);
    assert.equal(sum('allocation') - sum('reserve') - sum('release') + sum('consume'), 0);
    await assert.rejects(
      db.execute('UPDATE leave_settlements SET amount_minor=0 WHERE id=?', [s.id]),
    );
    await assert.rejects(db.execute('DELETE FROM leave_settlements WHERE id=?', [s.id]));
    // Finance sees the amount; the events trail records each step.
    const detail = await api('finance', `/leave-settlements/${s.id}`);
    assert.deepEqual(
      detail.body.settlement.events.map((e: any) => e.action),
      ['prepared', 'reviewed', 'approved'],
    );
    assert.equal(detail.body.settlement.calculation.ruleVersion, 1);
    // Contractors accrue nothing under a rule that excludes them.
    await setProfile(db, 'emp-sara', { payrollEmploymentType: 'contractor' });
    const contractor = await api('hr', '/leave-entitlement/employees/emp-sara?asOf=2025-06-30');
    assert.equal(contractor.body.statement.eligible, false);
    // A later version that includes contractors applies from its own date only.
    await db.execute(
      `INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,source,state,values_json,created_by,approved_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'leave-rule-test-v2',
        LEAVE_ENTITLEMENT_POLICY_KEY,
        2,
        'قاعدة استحقاق اختبار 2',
        '2025-07-01',
        'قيم اختبار فقط',
        'synthetic_approved',
        JSON.stringify({ ...ruleValues, excludeContractors: false }),
        'emp-noura',
        'emp-abdullah',
        '2026-11-14T00:00:00.000Z',
      ],
    );
    const included = await api('hr', '/leave-entitlement/employees/emp-sara?asOf=2025-07-30');
    assert.equal(included.body.statement.eligible, true);
    assert.equal(included.body.statement.accrualStart, '2025-07-01');
    // The idempotency cache never holds decrypted wage details.
    const cached = await db.read<any>(
      "SELECT response_json FROM idempotency WHERE action LIKE 'leave_settlement%'",
    );
    assert.ok(cached.length >= 3);
    for (const row of cached) assert.doesNotMatch(row.response_json, /Wage|components|amount/i);
  } finally {
    await f.close();
  }
}

test('entitlement journey on SQLite: accrual, settlement workflow, separation of duties', () =>
  journey(() => createDatabase()));

test(
  'entitlement journey on PostgreSQL',
  { skip: pgUrl ? false : 'HR_TEST_DATABASE_URL not set' },
  () =>
    journey(() =>
      createPostgresDatabase(pgUrl!, `hr_preview_${randomUUID().replaceAll('-', '')}`, {
        seed: true,
      }),
    ),
);
