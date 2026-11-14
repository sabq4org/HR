// «محاسب سبق» may draft a payroll rules version (hr.policy.draft). Approval stays with a person.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase, type Db } from '../../server/database.js';
import { actOnPolicy, createPolicyDraft } from '../../server/administration/policies.js';
import { generateServiceKey, hashServiceKey } from '../../server/finance/service-keys.js';
import { policyActionBody } from '../../shared/policy-actions.js';
import {
  HR_FORBIDDEN_SCOPES,
  HR_READ_SCOPES,
  HR_WRITE_SCOPES,
  SERVICE_ACCOUNT,
  generateHrServiceKey,
  hashHrServiceKey,
  parseHrServiceKeyHashes,
  parseHrServiceScopes,
  type HrScope,
} from '../../server/service-api/keys.js';

process.env.HR_DATA_KEY ??= randomBytes(32).toString('base64url');
const ALL: HrScope[] = [...HR_READ_SCOPES, ...HR_WRITE_SCOPES];
const WITHOUT_DRAFT = ALL.filter((scope) => scope !== 'hr.policy.draft');

const PAYLOAD = {
  key: 'payroll',
  name: 'قواعد الرواتب والتأمينات الاجتماعية',
  effectiveFrom: '2026-10-01',
  source: 'مصدر اصطناعي لاختبار المسودة — لا يمثل نصًا نظاميًا.',
  values: {
    currency: 'SAR',
    calculation: 'profile-components',
    gosi: {
      wageComponents: ['basicSalary', 'housingAllowance'],
      maxWageMinor: 4_500_000,
      minWageMinor: 150_000,
      categories: {
        saudi_existing: { employeeBps: 975, employerBps: 1175 },
        saudi_new: { employeeBps: 1075, employerBps: 1275 },
        non_saudi: { employeeBps: 0, employerBps: 200 },
      },
    },
  },
};

async function serve(
  db: Db,
  key: string,
  scopes: readonly HrScope[],
  extra: { financeKey?: string } = {},
) {
  const server: Server = createServer(
    createApp(db, {
      dataMode: 'private',
      hrServiceKeyHashes: parseHrServiceKeyHashes(hashHrServiceKey(key)),
      hrServiceScopes: scopes,
      financeEmployeeId: extra.financeKey ? 'emp-noura' : undefined,
      financeApiKeyHashes: extra.financeKey ? [hashServiceKey(extra.financeKey)] : undefined,
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

test('the policies page sends the policy version when approving or retiring', () => {
  const body = policyActionBody({ version: 3 }, 'approve', 'اعتماد إصدار القواعد');
  assert.deepEqual(body, { action: 'approve', reason: 'اعتماد إصدار القواعد', version: 3 });
  assert.equal(policyActionBody({ version: 1 }, 'retire', 'إيقاف').version, 1);
});

test('hr.policy.approve, activate and retire can never be granted to a service key', () => {
  for (const scope of ['hr.policy.approve', 'hr.policy.activate', 'hr.policy.retire']) {
    assert.ok((HR_FORBIDDEN_SCOPES as readonly string[]).includes(scope));
    assert.throws(() => parseHrServiceScopes(`hr.policy.draft,${scope}`), /never be granted/);
  }
  assert.ok(parseHrServiceScopes('hr.policy.draft').includes('hr.policy.draft'));
});

async function scenario(db: Db) {
  await db.execute(
    "UPDATE administrative_policies SET state='retired' WHERE state='synthetic_approved'",
  );
  const key = generateHrServiceKey();
  const financeKey = generateServiceKey();
  const full = await serve(db, key, ALL, { financeKey });
  const noDraft = await serve(db, key, WITHOUT_DRAFT);
  try {
    const blocked = await noDraft.call('POST', '/api/service/hr/policies', PAYLOAD);
    assert.equal(blocked.status, 403, blocked.text);
    assert.equal(blocked.body.error.code, 'API_KEY_SCOPE');

    const finance = await full.call('POST', '/api/service/hr/policies', PAYLOAD, {
      auth: financeKey,
    });
    assert.equal(finance.status, 403, finance.text);
    assert.equal(finance.body.error.code, 'API_KEY_SCOPE');

    const anonymousGet = await full.call('GET', '/api/service/hr/policies', undefined, {
      auth: null,
      idem: null,
    });
    assert.equal(anonymousGet.status, 401, anonymousGet.text);
    const anonymousPost = await full.call('POST', '/api/service/hr/policies', PAYLOAD, {
      auth: null,
    });
    assert.ok([401, 403].includes(anonymousPost.status), anonymousPost.text);
    const badKey = await full.call('POST', '/api/service/hr/policies', PAYLOAD, {
      auth: 'sabqhr_0000000000000000000000000000000000000000000',
    });
    assert.equal(badKey.status, 401, badKey.text);
    assert.equal(badKey.body.error.code, 'INVALID_API_KEY');

    const unavailable = await full.call('POST', '/api/service/hr/payroll', {
      period: '2026-10',
      reason: 'مسودة أكتوبر بعد اعتماد القواعد (اصطناعي)',
    });
    assert.equal(unavailable.status, 400, unavailable.text);
    assert.equal(unavailable.body.error.code, 'policy_unavailable');

    const wrongKey = await full.call('POST', '/api/service/hr/policies', {
      ...PAYLOAD,
      key: 'annual-leave',
    });
    assert.equal(wrongKey.status, 400);
    assert.equal(wrongKey.body.error.code, 'INVALID_POLICY');

    const badGosi = await full.call('POST', '/api/service/hr/policies', {
      ...PAYLOAD,
      values: { currency: 'SAR', calculation: 'profile-components', gosi: { maxWageMinor: 1 } },
    });
    assert.equal(badGosi.status, 400, badGosi.text);
    assert.equal(badGosi.body.error.code, 'gosi_rule_invalid');

    const noIdem = await full.call('POST', '/api/service/hr/policies', PAYLOAD, { idem: null });
    assert.equal(noIdem.status, 400);
    assert.equal(noIdem.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const idem = randomUUID();
    const created = await full.call('POST', '/api/service/hr/policies', PAYLOAD, { idem });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.policy.state, 'draft');
    assert.equal(created.body.policy.createdBy, SERVICE_ACCOUNT.id);
    assert.equal(created.body.policy.key, 'payroll');
    assert.equal(created.body.policy.effectiveFrom, '2026-10-01');
    assert.equal(created.body.policy.values.gosi.categories.saudi_existing.employeeBps, 975);
    const policyId = created.body.policy.id as string;
    const version = created.body.policy.version as number;

    const replay = await full.call('POST', '/api/service/hr/policies', PAYLOAD, { idem });
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.body.policy.id, policyId);
    const conflict = await full.call(
      'POST',
      '/api/service/hr/policies',
      { ...PAYLOAD, name: 'اسم مختلف' },
      { idem },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

    const listed = await full.call('GET', '/api/service/hr/policies');
    assert.equal(listed.status, 200, listed.text);
    assert.ok(listed.body.policies.some((p: { id: string }) => p.id === policyId));
    const one = await full.call('GET', `/api/service/hr/policies/${policyId}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.policy.id, policyId);

    const listNoScope = await noDraft.call('GET', '/api/service/hr/policies');
    assert.equal(listNoScope.status, 403);

    for (const action of ['approve', 'retire', 'activate']) {
      const res = await full.call('POST', `/api/service/hr/policies/${policyId}/actions`, {
        action,
        version,
        reason: 'محاولة اعتماد بالمفتاح',
      });
      assert.equal(res.status, 403, `${action}: ${res.text}`);
      assert.equal(res.body.error.code, 'POLICY_ACTION_FORBIDDEN');
    }
    const stillDraft = (
      await db.read<{ state: string }>('SELECT state FROM administrative_policies WHERE id=?', [
        policyId,
      ])
    )[0];
    assert.equal(stillDraft?.state, 'draft');

    const events = await db.read<{ action: string; details_json: string }>(
      "SELECT action,details_json FROM administration_events WHERE resource_type='policy' AND resource_id=? ORDER BY created_at",
      [policyId],
    );
    assert.deepEqual(
      events.map((e) => e.action),
      ['service_policy_draft_created'],
    );
    const details = JSON.parse(events[0]!.details_json) as Record<string, unknown>;
    assert.equal(details.actorName, 'محاسب سبق');
    assert.equal(details.effectiveFrom, '2026-10-01');
    assert.equal(details.effectiveTo, null);
    assert.ok(!('values' in details));
    assert.ok(!('gosi' in details));
    const encoded = events[0]!.details_json;
    assert.ok(!encoded.includes('employeeBps'));
    assert.ok(!encoded.includes('4500000'));

    // A person cannot approve a version they created.
    const humanDraft = await createPolicyDraft(
      db,
      { id: 'emp-noura', role: 'hr' },
      { ...PAYLOAD, name: 'مسودة بشرية للاعتماد الذاتي' },
      { privateMode: true, idempotencyKey: randomUUID() },
    );
    await db.execute(
      'INSERT INTO system_owners(employee_id,granted_at,granted_reason) VALUES(?,?,?)',
      ['emp-noura', new Date().toISOString(), 'اختبار مالك النظام'],
    );
    await assert.rejects(
      () =>
        actOnPolicy(db, { id: 'emp-noura', role: 'hr', owner: true }, humanDraft.id, {
          action: 'approve',
          version: humanDraft.version,
          reason: 'اعتماد ذاتي مرفوض',
          idempotencyKey: randomUUID(),
        }),
      (error: unknown) => (error as { code?: string }).code === 'SELF_APPROVAL',
    );

    // A different HR system-owner approves the service-key draft. The UI body includes version.
    const approvalBody = policyActionBody({ version }, 'approve', 'اعتماد إصدار أكتوبر (اصطناعي)');
    assert.equal(approvalBody.version, version);
    const approved = await actOnPolicy(db, { id: 'emp-noura', role: 'hr', owner: true }, policyId, {
      ...approvalBody,
      idempotencyKey: randomUUID(),
    });
    assert.equal(approved.state, 'synthetic_approved');
    assert.equal(approved.approvedBy, 'emp-noura');
    assert.equal(approved.createdBy, SERVICE_ACCOUNT.id);

    const payroll = await full.call('POST', '/api/service/hr/payroll', {
      period: '2026-10',
      reason: 'مسودة أكتوبر بعد اعتماد القواعد (اصطناعي)',
    });
    assert.equal(payroll.status, 201, payroll.text);
    assert.notEqual(payroll.body.error?.code, 'policy_unavailable');
    assert.equal(payroll.body.run.state, 'draft');
    assert.equal(payroll.body.run.period, '2026-10');
  } finally {
    await full.close();
    await noDraft.close();
  }
  await db.close();
}

test('HR service drafts a payroll rule version on SQLite; a different owner approves it', async () => {
  await scenario(await createDatabase());
});

test(
  'HR service drafts a payroll rule version on PostgreSQL',
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
