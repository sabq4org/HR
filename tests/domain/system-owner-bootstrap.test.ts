// The policies page reads `me` from /api/bootstrap. The system owner must carry systemOwner there,
// or «اعتماد» never renders on rule drafts. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase } from '../../server/database.js';
import { createPolicyDraft } from '../../server/administration/policies.js';
import { SERVICE_ACCOUNT } from '../../server/service-api/keys.js';
import { policyActionBody } from '../../shared/policy-actions.js';

const PAYLOAD = {
  key: 'payroll',
  name: 'قواعد الرواتب (اصطناعي)',
  effectiveFrom: '2026-10-01',
  source: 'مصدر اصطناعي للاختبار فقط.',
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

test('system owner sees systemOwner in /api/bootstrap and approves a service draft; others cannot', async () => {
  const db = await createDatabase();
  const server: Server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (employeeId: string) => {
    const r = await fetch(`${base}/api/demo/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ employeeId }),
    });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie')!.split(';')[0]!;
  };
  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        origin: base,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    // Non-owner HR: no flag.
    const noura = await login('emp-noura');
    let boot = await call(noura, 'GET', '/api/bootstrap');
    assert.equal(boot.status, 200);
    assert.equal(boot.body.me.systemOwner, undefined);

    await db.execute(
      'INSERT INTO system_owners(employee_id,granted_at,granted_reason) VALUES(?,?,?)',
      ['emp-noura', new Date().toISOString(), 'synthetic test'],
    );
    boot = await call(noura, 'GET', '/api/bootstrap');
    assert.equal(boot.body.me.systemOwner, true, 'bootstrap must flag the system owner');
    const session = await call(noura, 'GET', '/api/session');
    assert.equal(session.body.me.systemOwner, true);

    // Approver role keeps its own path; no owner flag.
    const abdullah = await login('emp-abdullah');
    assert.equal((await call(abdullah, 'GET', '/api/bootstrap')).body.me.systemOwner, undefined);

    // A draft created by «محاسب سبق» is approvable by the owner through the UI route.
    const svcDraft = await createPolicyDraft(db, SERVICE_ACCOUNT as any, PAYLOAD, {
      idempotencyKey: randomUUID(),
    });
    assert.equal(svcDraft.state, 'draft');

    // A non-owner, non-approver account cannot approve it.
    const sara = await login('emp-sara');
    const denied = await call(
      sara,
      'POST',
      `/api/admin/policies/${svcDraft.id}/actions`,
      policyActionBody(svcDraft, 'approve', 'محاولة غير مخولة'),
    );
    assert.equal(denied.status, 403);

    const ok = await call(
      noura,
      'POST',
      `/api/admin/policies/${svcDraft.id}/actions`,
      policyActionBody(svcDraft, 'approve', 'اعتماد مالك النظام (اصطناعي)'),
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.policy.state, 'synthetic_approved');
    assert.equal(ok.body.policy.approvedBy, 'emp-noura');

    // The owner still cannot approve a draft they created.
    const own = await call(noura, 'POST', '/api/admin/policies', {
      ...PAYLOAD,
      name: 'مسودة المالك نفسه',
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const self = await call(
      noura,
      'POST',
      `/api/admin/policies/${own.body.policy.id}/actions`,
      policyActionBody(own.body.policy, 'approve', 'اعتماد ذاتي'),
    );
    assert.equal(self.status, 403);
    assert.equal(self.body.error?.code ?? self.body.code, 'SELF_APPROVAL');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
