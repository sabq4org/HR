// Verified service periods and the end-of-service award (decision 016). Every figure in the rule
// below is a test fixture typed into a rule version, not a statutory value read from the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';
import { registerEndOfServiceRoutes } from '../../server/end-of-service/index.js';
import { createPolicyDraft } from '../../server/administration/policies.js';
import { getProfileValues } from '../../server/administration/service.js';
import { encryptSensitive } from '../../server/administration/security.js';
import { employeeFields } from '../../shared/catalog.js';
import {
  EOS_CALCULATION,
  EOS_POLICY_KEY,
  eosAward,
  parseEosValues,
  serviceDays,
  type EosRuleValues,
} from '../../shared/end-of-service.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

const ruleValues: EosRuleValues = {
  calculation: EOS_CALCULATION,
  firstTierYears: 5,
  firstTierMonthsMilli: 500,
  laterMonthsMilli: 1000,
  yearDays: 365,
  resignationTiers: [
    { fromYears: 2, numerator: 1, denominator: 3 },
    { fromYears: 5, numerator: 2, denominator: 3 },
    { fromYears: 10, numerator: 1, denominator: 1 },
  ],
  reasonTreatment: {
    resignation: 'resignation',
    resignation_art87: 'full',
    contract_end: 'full',
    employer: 'full',
    mutual: 'full',
    worker_art81: 'full',
    dismissal_art80: 'none',
    death_disability: 'full',
  },
  wageComponents: ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'],
  excludeContractors: true,
  sourceKind: 'secondary',
};

test('award arithmetic: tiers, resignation shares, fractions and overlaps', () => {
  assert.equal(parseEosValues(ruleValues).ok, true);
  assert.equal(parseEosValues({ ...ruleValues, wageComponents: ['housingAllowance'] }).ok, false);
  assert.equal(
    parseEosValues({
      ...ruleValues,
      resignationTiers: [
        { fromYears: 5, numerator: 2, denominator: 3 },
        { fromYears: 2, numerator: 1, denominator: 3 },
      ],
    }).ok,
    false,
  );
  const { mutual: _omit, ...partial } = ruleValues.reasonTreatment;
  assert.equal(parseEosValues({ ...ruleValues, reasonTreatment: partial }).ok, false);
  const wage = 800_000; // 8,000 SAR
  // Three years, full: 3 × ½ month = 12,000 SAR.
  assert.equal(eosAward(wage, 1095, 'full', ruleValues).amountMinor, 1_200_000);
  // Seven years: 5 × ½ + 2 × 1 = 4.5 months = 36,000 SAR.
  assert.equal(eosAward(wage, 2555, 'full', ruleValues).amountMinor, 3_600_000);
  // Resignation after three years: one third of 12,000.
  assert.equal(eosAward(wage, 1095, 'resignation', ruleValues).amountMinor, 400_000);
  // Resignation after seven years: two thirds of 36,000.
  assert.equal(eosAward(wage, 2555, 'resignation', ruleValues).amountMinor, 2_400_000);
  // Resignation after ten years: the full 7.5 months.
  assert.equal(eosAward(wage, 3650, 'resignation', ruleValues).amountMinor, 6_000_000);
  // Resignation below two years, and art. 80: nothing.
  assert.equal(eosAward(wage, 700, 'resignation', ruleValues).amountMinor, 0);
  assert.equal(eosAward(wage, 3650, 'none', ruleValues).amountMinor, 0);
  // Fraction of a year in proportion: 400 days × ½ month / 365 = 4,383.56 SAR.
  assert.equal(eosAward(wage, 400, 'full', ruleValues).amountMinor, 438_356);
  // Overlapping periods count once; an open period stops at the last day.
  assert.equal(
    serviceDays(
      [
        { startDate: '2020-01-01', endDate: '2020-12-31' },
        { startDate: '2020-06-01', endDate: null },
      ],
      '2021-12-31',
    ),
    731,
  );
});

const identities: Record<string, { id: string; role: string; owner?: boolean }> = {
  hr: { id: 'emp-noura', role: 'hr' },
  owner: { id: 'emp-abdullah', role: 'hr', owner: true },
  finance: { id: 'emp-reem', role: 'finance' },
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

async function journey(open: () => Promise<AsyncDb>) {
  const db = await open();
  const app = express();
  app.use(express.json());
  registerEndOfServiceRoutes(app, {
    db: db as never,
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
  async function api<T = any>(as: string, path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-test-actor': as,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  try {
    const subject = 'emp-maha';
    // Behave like private data: no synthetic period for the subject.
    await db.execute('DELETE FROM employment_periods WHERE employee_id=?', [subject]);
    await setProfile(db, subject, {
      payrollEmploymentType: 'staff',
      basicSalary: '6000',
      housingAllowance: '1500',
      transportAllowance: '500',
      otherAllowance: '',
    });
    const calc = {
      employeeId: subject,
      lastDay: '2026-06-30',
      reasonType: 'resignation',
    };
    const q = new URLSearchParams(calc).toString();

    // No approved rule yet: nothing is computed. The rule is drafted by HR and approved by
    // someone else, through the ordinary policy path.
    assert.equal((await api('hr', `/eos/preview?${q}`)).status, 409);
    await assert.rejects(
      createPolicyDraft(
        db,
        identities.hr as never,
        {
          key: EOS_POLICY_KEY,
          name: 'مكافأة نهاية الخدمة',
          effectiveFrom: '2020-01-01',
          source: 'قيم اختبار فقط',
          values: { ...ruleValues, yearDays: 1 },
        },
        { idempotencyKey: randomUUID() },
      ),
    );
    const draft = await createPolicyDraft(
      db,
      identities.hr as never,
      {
        key: EOS_POLICY_KEY,
        name: 'مكافأة نهاية الخدمة',
        effectiveFrom: '2020-01-01',
        source: 'قيم اختبار فقط',
        values: { ...ruleValues },
      },
      { privateMode: true, idempotencyKey: randomUUID() },
    );
    await db.execute(
      "UPDATE administrative_policies SET state='synthetic_approved',approved_by=? WHERE id=?",
      ['emp-abdullah', draft.id],
    );

    // No period: blocked. HR records one with its source; it is not counted until verified.
    assert.equal((await api('hr', `/eos/preview?${q}`)).body.error.code, 'NO_PERIODS');
    assert.equal(
      (
        await api('employee', '/eos/service-periods', 'POST', {
          employeeId: subject,
          startDate: '2020-07-01',
          source: 'x',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await api('hr', '/eos/service-periods', 'POST', {
          employeeId: subject,
          startDate: '2020-07-01',
        })
      ).body.error.code,
      'SOURCE_REQUIRED',
    );
    const created = await api('hr', '/eos/service-periods', 'POST', {
      employeeId: subject,
      startDate: '2020-07-02',
      source: 'العقد الموقع',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const periodId = created.body.period.id;
    assert.equal((await api('hr', `/eos/preview?${q}`)).body.error.code, 'PERIODS_UNVERIFIED');
    // Overlap refused; correction while pending keeps an event.
    assert.equal(
      (
        await api('hr', '/eos/service-periods', 'POST', {
          employeeId: subject,
          startDate: '2021-01-01',
          source: 'مصدر',
        })
      ).body.error.code,
      'PERIOD_OVERLAP',
    );
    assert.equal(
      (
        await api('hr', `/eos/service-periods/${periodId}/correct`, 'POST', {
          startDate: '2020-07-01',
          source: 'العقد الموقع وسجل قوى',
          reason: 'تصحيح تاريخ المباشرة',
        })
      ).status,
      200,
    );
    // Nobody verifies their own service.
    const own = await api('hr', '/eos/service-periods', 'POST', {
      employeeId: 'emp-noura',
      startDate: '2020-01-01',
      source: 'x',
    });
    assert.equal(own.body.error.code, 'SELF_SERVICE_RECORD');
    assert.equal(
      (await api('hr', `/eos/service-periods/${periodId}/verify`, 'POST', { reason: 'طوبق' }))
        .status,
      200,
    );
    // A verified period is locked.
    assert.equal(
      (
        await api('hr', `/eos/service-periods/${periodId}/correct`, 'POST', {
          startDate: '2020-01-01',
          source: 'x',
          reason: 'y',
        })
      ).body.error.code,
      'PERIOD_LOCKED',
    );
    const events = await api('hr', `/eos/service-periods/${subject}/events`);
    assert.deepEqual(
      events.body.events.map((e: any) => e.action),
      ['recorded', 'corrected', 'verified'],
    );

    // 2020-07-01..2026-06-30 = 2191 days; wage 8,000. Full: 5×½ + (2191−1825)/365 = 2.5 + 1.00274
    // months. Resignation after 6 years: two thirds.
    const preview = await api('hr', `/eos/preview?${q}`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const c = preview.body.calculation;
    assert.equal(c.award.serviceDays, 2191);
    assert.equal(c.monthlyWageMinor, 800_000);
    assert.equal(
      c.award.fullAwardMinor,
      Math.round((800_000 * (1825 * 500 + 366 * 1000)) / 365_000),
    );
    assert.equal(
      c.award.amountMinor,
      Math.round((800_000 * (1825 * 500 + 366 * 1000) * 2) / (365_000 * 3)),
    );
    // Excluded days need a reason.
    assert.equal(
      (await api('hr', `/eos/preview?${q}&excludedDays=30`)).body.error.code,
      'EXCLUSION_REASON_REQUIRED',
    );

    // Workflow: HR prepares, finance reviews, owner approves; nobody acts twice.
    const prepared = await api('hr', '/eos/settlements', 'POST', calc);
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    let s = prepared.body.settlement;
    assert.equal(s.state, 'pending_finance');
    assert.equal(
      (await api('hr', '/eos/settlements', 'POST', calc)).body.error.code,
      'SETTLEMENT_EXISTS',
    );
    assert.equal(
      (
        await api('owner', `/eos/settlements/${s.id}/actions`, 'POST', {
          action: 'approve',
          version: 1,
        })
      ).status,
      403,
    );
    s = (
      await api('finance', `/eos/settlements/${s.id}/actions`, 'POST', {
        action: 'approve',
        version: 1,
      })
    ).body.settlement;
    assert.equal(s.state, 'pending_approver');
    assert.equal(
      (
        await api('hr', `/eos/settlements/${s.id}/actions`, 'POST', {
          action: 'approve',
          version: 2,
        })
      ).status,
      403,
    );
    // A changed wage after preparation stops approval.
    await setProfile(db, subject, { basicSalary: '6500' });
    assert.equal(
      (
        await api('owner', `/eos/settlements/${s.id}/actions`, 'POST', {
          action: 'approve',
          version: 2,
        })
      ).body.error.code,
      'CALCULATION_CHANGED',
    );
    await setProfile(db, subject, { basicSalary: '6000' });
    s = (
      await api('owner', `/eos/settlements/${s.id}/actions`, 'POST', {
        action: 'approve',
        version: 2,
      })
    ).body.settlement;
    assert.equal(s.state, 'approved');
    // Closed settlements are immutable and never deleted.
    await assert.rejects(
      db.execute("UPDATE eos_settlements SET state='cancelled' WHERE id=?", [s.id]),
    );
    await assert.rejects(db.execute('DELETE FROM eos_settlements WHERE id=?', [s.id]));
    await assert.rejects(db.execute('DELETE FROM employment_period_events'));
    // The same service cannot be settled twice.
    assert.equal((await api('hr', `/eos/preview?${q}`)).body.error.code, 'ALREADY_SETTLED');
    // An employee sees nothing here.
    assert.equal((await api('employee', '/eos/settlements')).status, 403);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
}

test('end-of-service journey on SQLite', () => journey(() => createDatabase()));

test(
  'end-of-service journey on PostgreSQL',
  { skip: pgUrl ? false : 'HR_TEST_DATABASE_URL not set' },
  () =>
    journey(() =>
      createPostgresDatabase(pgUrl!, `hr_preview_${randomUUID().replaceAll('-', '')}`, {
        seed: true,
      }),
    ),
);
