// «محاسب سبق» HR service key (phase 2): profile edits, payroll drafts and submit, and the hard
// refusal of review/reject/approve/close. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Request } from 'express';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase, type Db } from '../../server/database.js';
import { readEmployee } from '../../server/administration/service.js';
import { createPayrollCommands } from '../../server/payroll/index.js';
import {
  HR_READ_SCOPES,
  HR_WRITE_SCOPES,
  SERVICE_ACCOUNT,
  generateHrServiceKey,
  hashHrServiceKey,
  parseHrServiceKeyHashes,
  type HrScope,
} from '../../server/service-api/keys.js';
import { SERVICE_SALARY_SOURCE } from '../../server/service-api/routes.js';
import { SERVICE_ACCOUNT_EMPLOYEE_NUMBER } from '../../server/service-api/service-account.js';

process.env.HR_DATA_KEY ??= randomBytes(32).toString('base64url');
const ALL: HrScope[] = [...HR_READ_SCOPES, ...HR_WRITE_SCOPES];
const PAST = '2026-11-01';

async function serve(db: Db, key: string, scopes: readonly HrScope[]) {
  const server: Server = createServer(
    createApp(db, {
      dataMode: 'private',
      hrServiceKeyHashes: parseHrServiceKeyHashes(hashHrServiceKey(key)),
      hrServiceScopes: scopes,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    opts: { idem?: string | null; auth?: string | null } = {},
  ) => {
    const headers: Record<string, string> = {};
    const idem = opts.idem === undefined ? randomUUID() : opts.idem;
    if (idem !== null) headers['idempotency-key'] = idem;
    const auth = opts.auth === undefined ? key : opts.auth;
    if (auth !== null) headers.authorization = `Bearer ${auth}`;
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

/** A session-side actor running the same payroll commands the admin routes use. */
function humanCall(db: Db, id: string, role: 'finance' | 'approver', runId: string, body: object) {
  const commands = createPayrollCommands(db);
  const key = randomUUID();
  const req = {
    body,
    params: { id: runId },
    get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? key : undefined),
  } as unknown as Request;
  return commands.runAction(req, { id, role });
}

const version = async (db: Db, id: string) => (await readEmployee(db, id))!.record_version;

async function scenario(db: Db) {
  const key = generateHrServiceKey();
  const full = await serve(db, key, ALL);
  const readOnly = await serve(db, key, HR_READ_SCOPES);
  try {
    // ---- Profile edit: salary components with reason, effective date and version lock.
    const v1 = await version(db, 'emp-sara');
    const payload = {
      version: v1,
      reason: 'بتوجيه من المعتمد: تسجيل مكونات الراتب (اختبار اصطناعي)',
      effectiveAt: PAST,
      values: { basicSalary: 18000, housingAllowance: 4500, transportAllowance: 1500 },
    };
    const idem = randomUUID();
    const edit = await full.call('PATCH', '/api/service/hr/employees/emp-sara', payload, { idem });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(edit.body.version, v1 + 1);
    assert.equal(edit.body.replayed, false);
    assert.deepEqual(edit.body.fields, [
      'basicSalary',
      'housingAllowance',
      'salaryEffectiveDate',
      'salarySource',
      'transportAllowance',
    ]);
    assert.ok(!edit.text.includes('18000'), 'write response never echoes values');

    // Same Idempotency-Key + same payload replays; a different payload under it conflicts.
    const again = await full.call('PATCH', '/api/service/hr/employees/emp-sara', payload, { idem });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.replayed, true);
    assert.equal(await version(db, 'emp-sara'), v1 + 1);
    const conflict = await full.call(
      'PATCH',
      '/api/service/hr/employees/emp-sara',
      { ...payload, values: { basicSalary: 1 } },
      { idem },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

    // Stale version (optimistic lock) is refused and changes nothing.
    const stale = await full.call('PATCH', '/api/service/hr/employees/emp-sara', {
      ...payload,
      values: { basicSalary: 1 },
    });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.error.code, 'STALE_VERSION');

    // Values readable back through the read API with the stamped date and source.
    const pay = await full.call('GET', '/api/service/hr/employees/emp-sara/compensation');
    assert.equal(pay.status, 200, pay.text);
    assert.equal(Number(pay.body.compensation.basicSalary), 18000);
    assert.equal(Number(pay.body.compensation.housingAllowance), 4500);
    assert.equal(pay.body.compensation.salaryEffectiveDate, PAST);
    assert.equal(pay.body.compensation.salarySource, SERVICE_SALARY_SOURCE);

    // Input refusals.
    const v2 = await version(db, 'emp-sara');
    const bad = async (body: unknown, opts = {}) =>
      full.call('PATCH', '/api/service/hr/employees/emp-sara', body, opts);
    const base = { version: v2, reason: 'سبب اصطناعي', effectiveAt: PAST };
    for (const [body, status, code, opts] of [
      [{ ...base, values: { managerId: 'emp-omar' } }, 403, 'FIELD_NOT_ALLOWED_FOR_SERVICE', {}],
      [
        { ...base, values: { employmentStatus: 'terminated' } },
        403,
        'FIELD_NOT_ALLOWED_FOR_SERVICE',
        {},
      ],
      [
        { ...base, values: { bankVerificationStatus: 'verified' } },
        403,
        'FIELD_NOT_ALLOWED_FOR_SERVICE',
        {},
      ],
      [{ ...base, values: { notAField: 1 } }, 400, 'UNKNOWN_FIELDS', {}],
      [{ ...base, values: {} }, 400, 'INVALID_VALUES', {}],
      [{ ...base, reason: '', values: { otherAllowance: 100 } }, 400, 'REASON_REQUIRED', {}],
      [
        { ...base, effectiveAt: undefined, values: { otherAllowance: 100 } },
        400,
        'EFFECTIVE_DATE_REQUIRED',
        {},
      ],
      [
        { ...base, effectiveAt: '2999-01-01', values: { otherAllowance: 100 } },
        409,
        'FUTURE_EFFECTIVE_DATE',
        {},
      ],
      [
        { ...base, values: { otherAllowance: 100 } },
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        { idem: null },
      ],
    ] as const) {
      const res = await bad(body, opts);
      assert.equal(res.status, status, `${code}: ${res.text}`);
      assert.equal(res.body.error.code, code);
    }
    assert.equal(await version(db, 'emp-sara'), v2, 'refused edits change nothing');
    const missing = await full.call('PATCH', '/api/service/hr/employees/missing', {
      ...base,
      values: { otherAllowance: 100 },
    });
    assert.equal(missing.status, 404);

    // Missing scope: a read-only key cannot write. No key at all is refused too.
    const noScope = await readOnly.call('PATCH', '/api/service/hr/employees/emp-sara', {
      ...base,
      values: { otherAllowance: 100 },
    });
    assert.equal(noScope.status, 403);
    assert.equal(noScope.body.error.code, 'API_KEY_SCOPE');
    const noKey = await full.call(
      'PATCH',
      '/api/service/hr/employees/emp-sara',
      { ...base, values: { otherAllowance: 100 } },
      { auth: null },
    );
    assert.ok([401, 403].includes(noKey.status), noKey.text);
    assert.equal(await version(db, 'emp-sara'), v2);

    // Audit: field history, per-field events and the profile event all name the service account.
    const history = await db.read<any>(
      "SELECT actor_id,field_key FROM employee_profile_history WHERE employee_id='emp-sara' AND actor_id=?",
      [SERVICE_ACCOUNT.id],
    );
    assert.deepEqual(history.map((h) => h.field_key).sort(), edit.body.fields);
    const events = await db.read<any>(
      "SELECT * FROM administration_events WHERE actor_id=? AND resource_type='employee' AND resource_id='emp-sara'",
      [SERVICE_ACCOUNT.id],
    );
    assert.equal(events.filter((e) => e.action === 'field_updated').length, 5);
    const profileEvent = events.find((e) => e.action === 'profile_updated');
    assert.ok(profileEvent);
    assert.equal(profileEvent.actor_role, 'service');
    const details = JSON.parse(profileEvent.details_json);
    assert.equal(details.actorName, 'محاسب سبق');
    assert.equal(details.actorKind, 'service_key');
    assert.match(details.keyId, /^[0-9a-f]{12}$/);
    assert.ok(!profileEvent.details_json.includes('18000'));
    assert.ok(
      profileEvent.reason && !profileEvent.reason.includes('بتوجيه'),
      'reason is encrypted',
    );

    // The service row: present for the FKs, suspended, no role, no login, hidden everywhere.
    const row = (await db.read<any>('SELECT * FROM employees WHERE id=?', [SERVICE_ACCOUNT.id]))[0];
    assert.equal(row.employee_number, SERVICE_ACCOUNT_EMPLOYEE_NUMBER);
    assert.equal(row.employment_status, 'suspended');
    assert.equal(row.access_role, null);
    assert.equal(
      (await db.read('SELECT 1 FROM employee_access WHERE id=?', [SERVICE_ACCOUNT.id])).length,
      0,
    );
    assert.equal(
      (await db.read('SELECT 1 FROM employee_accounts WHERE employee_id=?', [SERVICE_ACCOUNT.id]))
        .length,
      0,
    );
    assert.equal(await readEmployee(db, SERVICE_ACCOUNT.id), undefined);
    const search = await full.call(
      'GET',
      `/api/service/hr/employees?q=${encodeURIComponent('محاسب سبق')}`,
    );
    assert.equal(search.body.total, 0);
    const self = await full.call('PATCH', `/api/service/hr/employees/${SERVICE_ACCOUNT.id}`, {
      ...base,
      version: 1,
      values: { otherAllowance: 100 },
    });
    assert.equal(self.status, 404, 'the key cannot edit its own row');

    // ---- Payroll: draft, submit, and the hard refusals.
    const noWrite = await readOnly.call('POST', '/api/service/hr/payroll', {
      period: '2026-10',
      reason: 'مسودة اصطناعية',
    });
    assert.equal(noWrite.status, 403);
    assert.equal(noWrite.body.error.code, 'API_KEY_SCOPE');
    const correction = await full.call('POST', '/api/service/hr/payroll', {
      period: '2026-10',
      reason: 'تصحيح',
      correctionOf: 'x',
    });
    assert.equal(correction.status, 400);
    assert.equal(correction.body.error.code, 'SERVICE_CORRECTION_UNSUPPORTED');
    const noIdem = await full.call(
      'POST',
      '/api/service/hr/payroll',
      { period: '2026-10', reason: 'مسودة اصطناعية' },
      { idem: null },
    );
    assert.equal(noIdem.status, 400);

    const createIdem = randomUUID();
    const draftBody = { period: '2026-10', reason: 'مسودة أكتوبر بتوجيه المعتمد (اصطناعي)' };
    const draft = await full.call('POST', '/api/service/hr/payroll', draftBody, {
      idem: createIdem,
    });
    assert.equal(draft.status, 201, draft.text);
    assert.equal(draft.body.run.state, 'draft');
    assert.equal(draft.body.run.preparedBy, SERVICE_ACCOUNT.id);
    assert.ok(draft.body.run.employeeCount >= 1);
    assert.ok(draft.body.run.totals.earningsMinor >= 2400000);
    const replay = await full.call('POST', '/api/service/hr/payroll', draftBody, {
      idem: createIdem,
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.run.id, draft.body.run.id, 'retry returns the same draft');
    const dup = await full.call('POST', '/api/service/hr/payroll', draftBody);
    assert.equal(dup.status, 409, 'one primary run per period still holds');
    const runId = draft.body.run.id;
    const runPath = `/api/service/hr/payroll/${runId}/actions`;

    // Approve / close / review / reject: 403 for the key whatever its scopes, state untouched.
    for (const action of ['approve', 'close', 'review', 'reject', 'pay', undefined]) {
      const res = await full.call('POST', runPath, { action, version: 1, reason: 'محاولة' });
      assert.equal(res.status, 403, `${action}: ${res.text}`);
      assert.equal(res.body.error.code, 'PAYROLL_ACTION_FORBIDDEN');
    }
    // The session payroll routes stay out of the key's reach entirely.
    const adminApprove = await full.call('POST', `/api/admin/payroll/${runId}/actions`, {
      action: 'approve',
      version: 1,
    });
    assert.equal(adminApprove.status, 403);
    assert.equal(adminApprove.body.error.code, 'API_KEY_SCOPE');

    const submitNoScope = await serve(db, key, ['hr.payroll.read', 'hr.payroll.write']);
    try {
      const res = await submitNoScope.call('POST', runPath, { action: 'submit', version: 1 });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'API_KEY_SCOPE');
      // No compensation scope: draft answers carry no amounts.
      const runs = await submitNoScope.call('GET', `/api/service/hr/payroll/${runId}`);
      assert.equal(runs.body.run.totals, undefined);
    } finally {
      await submitNoScope.close();
    }
    const staleSubmit = await full.call('POST', runPath, { action: 'submit', version: 7 });
    assert.equal(staleSubmit.status, 409);
    assert.equal(staleSubmit.body.error.code, 'version_conflict');
    // A draft prepared by a person cannot be submitted by the key.
    const policy = (
      await db.read<any>("SELECT id FROM administrative_policies WHERE id='payroll-policy-demo-v2'")
    )[0];
    await db.execute(
      "INSERT INTO payroll_runs(id,period,version,state,prepared_by,policy_id,correction_of,reason,created_at,updated_at,closed_at) VALUES('hr-run-1','2026-09',1,'draft','emp-omar',?,NULL,'synthetic',?,?,NULL)",
      [policy.id, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z'],
    );
    const foreign = await full.call('POST', '/api/service/hr/payroll/hr-run-1/actions', {
      action: 'submit',
      version: 1,
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, 'transition_forbidden');

    const submitted = await full.call('POST', runPath, { action: 'submit', version: 1 });
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(submitted.body.run.state, 'pending_finance');
    const afterSubmit = await full.call('POST', runPath, { action: 'approve', version: 2 });
    assert.equal(afterSubmit.status, 403);
    assert.equal(afterSubmit.body.error.code, 'PAYROLL_ACTION_FORBIDDEN');

    // Payroll audit: payroll_events and administration_events both carry the service account.
    const payrollEvents = await db.read<any>(
      'SELECT actor_id,actor_role,action FROM payroll_events WHERE run_id=? ORDER BY version',
      [runId],
    );
    assert.deepEqual(
      payrollEvents.map((e) => [e.actor_id, e.actor_role, e.action]),
      [
        [SERVICE_ACCOUNT.id, 'service', 'created'],
        [SERVICE_ACCOUNT.id, 'service', 'submit'],
      ],
    );
    const adminEvents = await db.read<any>(
      "SELECT action,details_json FROM administration_events WHERE resource_type='payroll_run' AND resource_id=? ORDER BY resource_version",
      [runId],
    );
    assert.deepEqual(
      adminEvents.map((e) => e.action),
      ['service_payroll_draft_created', 'service_payroll_submitted'],
    );
    for (const e of adminEvents) assert.equal(JSON.parse(e.details_json).actorName, 'محاسب سبق');

    // People finish the run: finance reviews, the approver approves (closes). Timeline names
    // «محاسب سبق» as preparer even though its row is hidden from employee_access.
    const reviewed = await humanCall(db, 'emp-reem', 'finance', runId, {
      action: 'review',
      version: 2,
    });
    assert.equal((reviewed as any).run.state, 'pending_approver');
    const approved = await humanCall(db, 'emp-abdullah', 'approver', runId, {
      action: 'approve',
      version: 3,
    });
    const closed = (approved as any).run;
    assert.equal(closed.state, 'closed');
    assert.equal(closed.preparedBy, SERVICE_ACCOUNT.id);
    assert.equal(closed.approvedBy, 'emp-abdullah');
    assert.equal(closed.timeline[0].actorName, 'محاسب سبق');
  } finally {
    await full.close();
    await readOnly.close();
  }
  await db.close();
}

test('HR service writes: profile, payroll draft/submit, refusals and audit on SQLite', async () => {
  await scenario(await createDatabase());
});

test(
  'HR service writes: the same scenario on PostgreSQL',
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
