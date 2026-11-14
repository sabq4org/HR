// Regression tests for the 2026-11-14 code-review findings.
// Each test reproduces a confirmed gap and must keep failing if the fix is removed.
// Context: docs/decisions/004-security-hardening.md and CHANGELOG.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { createApp } from '../../server/app.js';
import { createDatabase, todayInRiyadh } from '../../server/database.js';
import { createHostedDemoApp } from '../../server/hosted-demo.js';
import { registerPayroll } from '../../server/payroll/index.js';
import type { Role } from '../../shared/contracts.js';

const actors = {
  employee: 'emp-sara',
  manager: 'emp-omar',
  hr: 'emp-noura',
  finance: 'emp-reem',
  approver: 'emp-abdullah',
  auditor: 'emp-hind',
} as const;
type ActorRole = keyof typeof actors;
const today = todayInRiyadh();

async function appHarness() {
  const db = await createDatabase();
  const server: Server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<ActorRole, string>();
  async function call(role: ActorRole, path: string, method = 'GET', body?: unknown) {
    if (!cookies.has(role)) {
      const login = await fetch(`${origin}/api/demo/session`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ employeeId: actors[role] }),
      });
      assert.equal(login.status, 200);
      cookies.set(role, login.headers.get('set-cookie')!.split(';')[0]);
    }
    return fetch(`${origin}/api${path}`, {
      method,
      headers: {
        origin,
        cookie: cookies.get(role)!,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return {
    db,
    call,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

test('confidential grievance content is hidden from the manager and auditor, visible to assigned steps', async () => {
  const h = await appHarness();
  try {
    const created = await h.call('employee', '/admin/requests', 'POST', {
      kind: 'grievance',
      employeeId: actors.employee,
      values: {
        decisionReference: 'DEMO-DECISION',
        requestedResolution: 'نص سري: مراجعة قرار المدير',
        reason: 'نص سري يذكر المدير المباشر',
      },
      submit: true,
    });
    assert.equal(created.status, 201, await created.clone().text());
    const id = (await created.json()).request.id as string;

    for (const role of ['manager', 'auditor'] as const) {
      const res = await h.call(role, `/admin/requests/${id}`);
      if (res.status === 200) {
        const values = (await res.json()).request.values;
        assert.deepEqual(Object.keys(values), [], `${role} must not read grievance values`);
      } else assert.equal(res.status, 404);
      const file = await h.call(role, `/admin/employees/${actors.employee}`);
      assert.equal(file.status, 200);
      const listed = (await file.json()).file.requests.find((r: { id: string }) => r.id === id);
      if (listed) assert.deepEqual(Object.keys(listed.values), [], `${role} file view leaks`);
    }
    const hr = (await (await h.call('hr', `/admin/requests/${id}`)).json()).request;
    assert.equal(hr.values.reason, 'نص سري يذكر المدير المباشر');
    const approved = await h.call('hr', `/admin/requests/${id}/actions`, 'POST', {
      version: hr.version,
      action: 'approve',
      reason: 'إحالة للمعتمد',
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const approver = (await (await h.call('approver', `/admin/requests/${id}`)).json()).request;
    assert.equal(approver.values.requestedResolution, 'نص سري: مراجعة قرار المدير');
  } finally {
    await h.close();
  }
});

test('assigned approver sees the amount of a financial request it decides; others do not', async () => {
  const h = await appHarness();
  try {
    const created = await h.call('manager', '/admin/requests', 'POST', {
      kind: 'reward',
      employeeId: actors.employee,
      values: { amount: 999.99, effectiveDate: today, achievement: 'إنجاز', reason: 'سبب' },
      submit: true,
    });
    assert.equal(created.status, 201, await created.clone().text());
    let request = (await created.json()).request;
    const step = await h.call('hr', `/admin/requests/${request.id}/actions`, 'POST', {
      version: request.version,
      action: 'approve',
      reason: 'موافقة',
    });
    assert.equal(step.status, 200);
    request = (await step.json()).request;
    const seen = (await (await h.call('approver', `/admin/requests/${request.id}`)).json()).request;
    assert.equal(seen.state, 'pending_approver');
    assert.equal(seen.canAct, true);
    assert.equal(seen.values.amount, 999.99, 'approver must see the amount it approves');
    const audit = await h.call('auditor', `/admin/requests/${request.id}`);
    if (audit.status === 200) assert.equal((await audit.json()).request.values.amount, undefined);
  } finally {
    await h.close();
  }
});

test('HR cannot approve an attendance record it entered; the manager still can', async () => {
  const h = await appHarness();
  try {
    const body = {
      employeeId: actors.employee,
      date: today,
      checkIn: '08:00',
      checkOut: '20:00',
      workMode: 'office',
      note: 'إدخال اصطناعي من الموارد البشرية',
    };
    const created = await h.call('hr', '/admin/attendance', 'POST', body);
    assert.equal(created.status, 201, await created.clone().text());
    const record = (await created.json()).record;
    const self = await h.call('hr', `/admin/attendance/${record.id}/decision`, 'POST', {
      version: record.version,
      decision: 'approve',
    });
    assert.equal(self.status, 403);
    assert.equal((await self.json()).error.code, 'SELF_APPROVAL');
    const manager = await h.call('manager', `/admin/attendance/${record.id}/decision`, 'POST', {
      version: record.version,
      decision: 'approve',
    });
    assert.equal(manager.status, 200, await manager.clone().text());
  } finally {
    await h.close();
  }
});

const payrollIdentities: Record<string, { id: string; role: Role }> = {
  hr: { id: 'emp-noura', role: 'hr' },
  finance: { id: 'emp-reem', role: 'finance' },
  approver: { id: 'emp-abdullah', role: 'approver' },
};
async function payrollHarness() {
  const db = await createDatabase();
  const app = express();
  app.use(express.json());
  registerPayroll(app, {
    db,
    requireActor: (req) => {
      const actor = payrollIdentities[String(req.header('x-test-actor'))];
      if (!actor)
        throw Object.assign(new Error('unauthorized'), { status: 401, code: 'unauthorized' });
      return actor;
    },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/admin/payroll`;
  async function api(as: string, path = '', method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-test-actor': as,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  return {
    api,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}
const extraLine = (employeeId: string) => ({
  employeeId,
  component: 'سطر اختبار',
  kind: 'earning',
  amountMinor: 100000,
  source: 'Synthetic fixture',
});
async function newRun(f: Awaited<ReturnType<typeof payrollHarness>>, period: string) {
  const created = await f.api('hr', '', 'POST', {
    period,
    policyId: 'payroll-policy-demo-v1',
    reason: 'اختبار فصل المهام',
  });
  assert.equal(created.status, 200);
  return created.body.run;
}

test('payroll preparer cannot add a line for their own pay', async () => {
  const f = await payrollHarness();
  try {
    const run = await newRun(f, '2026-08');
    const edited = await f.api('hr', `/${run.id}`, 'PATCH', {
      version: run.version,
      lines: [...run.lines, extraLine('emp-noura')],
      reason: 'محاولة إضافة راتب المعد',
    });
    assert.equal(edited.status, 403);
    assert.equal(edited.body.error.code, 'preparer_cannot_include_self');
    const unknown = await f.api('hr', `/${run.id}`, 'PATCH', {
      version: run.version,
      lines: [...run.lines, extraLine('emp-does-not-exist')],
      reason: 'موظف غير موجود',
    });
    assert.equal(unknown.status, 400);
  } finally {
    await f.close();
  }
});

test('finance cannot review a run that contains its own salary', async () => {
  const f = await payrollHarness();
  try {
    const run = await newRun(f, '2026-09');
    const edited = await f.api('hr', `/${run.id}`, 'PATCH', {
      version: run.version,
      lines: [...run.lines, extraLine('emp-reem')],
      reason: 'إضافة سطر المراجع المالي',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const submitted = await f.api('hr', `/${run.id}/actions`, 'POST', {
      version: edited.body.run.version,
      action: 'submit',
    });
    assert.equal(submitted.status, 200);
    const reviewed = await f.api('finance', `/${run.id}/actions`, 'POST', {
      version: submitted.body.run.version,
      action: 'review',
    });
    assert.equal(reviewed.status, 403);
    assert.equal(reviewed.body.error.code, 'subject_cannot_review');
  } finally {
    await f.close();
  }
});

test('approver can reject a payroll run at its step', async () => {
  const f = await payrollHarness();
  try {
    const run = await newRun(f, '2026-10');
    const submitted = await f.api('hr', `/${run.id}/actions`, 'POST', {
      version: run.version,
      action: 'submit',
    });
    const reviewed = await f.api('finance', `/${run.id}/actions`, 'POST', {
      version: submitted.body.run.version,
      action: 'review',
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    const rejected = await f.api('approver', `/${run.id}/actions`, 'POST', {
      version: reviewed.body.run.version,
      action: 'reject',
      reason: 'رفض اصطناعي للتحقق',
    });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.run.state, 'rejected');
  } finally {
    await f.close();
  }
});

const ORIGIN = 'https://hr-production-90b34ef5.up.railway.app';
const HOST = 'hr-production-90b34ef5.up.railway.app';
function get(
  port: number,
  path: string,
  cookie?: string,
): Promise<{ status: number; set?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { host: HOST, ...(cookie ? { cookie } : {}) },
      },
      (res) => {
        res.resume();
        const raw = res.headers['set-cookie'];
        const set = (Array.isArray(raw) ? raw : raw ? [raw] : [])
          .find((c) => c.startsWith('__Host-sabq_hr_workspace='))
          ?.split(';')[0];
        res.on('end', () => resolve({ status: res.statusCode ?? 0, set }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('hosted preview reclaims untouched workspaces so a cookieless flood cannot lock visitors out', async () => {
  const hosted = await createHostedDemoApp({
    publicOrigin: ORIGIN,
    maxWorkspaces: 3,
    untouchedGraceMs: 0,
  });
  const server = createServer(hosted.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await get(port, '/api/session')).status, 200);
    const visitor = await get(port, '/api/session');
    assert.equal(visitor.status, 200, 'flood of untouched workspaces must not exhaust capacity');
    assert.ok(visitor.set);
    assert.equal((await get(port, '/api/bootstrap', visitor.set)).status, 401);
    // Fill the rest with used workspaces: once every workspace is in use, capacity is real.
    const used: string[] = [visitor.set!];
    for (let i = 0; i < 2; i++) {
      const w = await get(port, '/api/session');
      assert.equal(w.status, 200);
      assert.equal((await get(port, '/api/session', w.set)).status, 200);
      used.push(w.set!);
    }
    assert.equal((await get(port, '/api/session', visitor.set)).status, 200);
    assert.equal((await get(port, '/api/session')).status, 503);
    for (const c of used) assert.equal((await get(port, '/api/session', c)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await hosted.close();
  }
});
