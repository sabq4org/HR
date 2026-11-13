import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, todayInRiyadh } from '../../server/database.js';

const personaRoles = {
  'emp-noura': 'hr',
  'emp-omar': 'manager',
  'emp-sara': 'employee',
  'emp-reem': 'finance',
  'emp-abdullah': 'approver',
  'emp-hind': 'auditor',
} as const;

async function fixture() {
  const db = await createDatabase();
  const server: Server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No regression-test listener');
  const base = `http://127.0.0.1:${address.port}`;
  type Context = { cookie: string; id: string };
  async function login(id: keyof typeof personaRoles): Promise<Context> {
    const response = await fetch(`${base}/api/demo/session`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId: id }),
    });
    assert.equal(response.status, 200);
    return { id, cookie: response.headers.get('set-cookie')!.split(';')[0] };
  }
  async function api(path: string, ctx: Context, method = 'GET', body?: unknown, key?: string) {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        cookie: ctx.cookie,
        ...(method !== 'GET' ? { origin: base } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return {
    db,
    server,
    base,
    login,
    api,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await db.close();
    },
  };
}

test('session exposes and accepts only the six configured synthetic personas', async () => {
  const f = await fixture();
  try {
    const session = await fetch(`${f.base}/api/session`);
    const body = (await session.json()) as { personas: { id: string; role: string }[] };
    assert.deepEqual(Object.fromEntries(body.personas.map((p) => [p.id, p.role])), personaRoles);
    for (const [id, role] of Object.entries(personaRoles) as [
      keyof typeof personaRoles,
      string,
    ][]) {
      const signedIn = await f.login(id);
      const bootstrap = await f.api('/api/bootstrap', signedIn);
      assert.equal(bootstrap.status, 200);
      assert.equal(((await bootstrap.json()) as { me: { role: string } }).me.role, role);
    }
  } finally {
    await f.close();
  }
});

test('employee documents stay owner-scoped and auditors receive redacted metadata without file bytes', async () => {
  const f = await fixture();
  try {
    const hr = await f.login('emp-noura');
    const bytes = Buffer.from('%PDF-1.4\nSynthetic test only\n%%EOF', 'ascii');
    const uploaded = await f.api(
      '/api/admin/employees/emp-sara/documents',
      hr,
      'POST',
      {
        category: 'identity',
        filename: 'Sara-identity.pdf',
        mimeType: 'application/pdf',
        contentBase64: bytes.toString('base64'),
      },
      'security-document-upload',
    );
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const docId = ((await uploaded.json()) as { document: { id: string } }).document.id;

    const auditor = await f.login('emp-hind');
    const list = await f.api('/api/admin/documents', auditor);
    assert.equal(list.status, 200);
    const item = (
      (await list.json()) as { documents: { id: string; employeeId: string; filename: string }[] }
    ).documents.find((doc) => doc.id === docId);
    assert.ok(item);
    assert.equal(item.employeeId, '');
    assert.doesNotMatch(item.filename, /Sara|identity/i);
    const binary = await f.api(`/api/admin/documents/${docId}/download`, auditor);
    assert.equal(binary.status, 404);

    await f.db.execute("UPDATE employees SET access_role='employee' WHERE id='emp-noura'");
    const unrelated = await f.login('emp-noura');
    assert.equal((await f.api(`/api/admin/documents/${docId}/download`, unrelated)).status, 404);
  } finally {
    await f.close();
  }
});

test('role changes are rechecked before replaying an employee-create command', async () => {
  const f = await fixture();
  try {
    const hr = await f.login('emp-noura');
    const payload = {
      values: {
        name: 'موظف تجريبي',
        employeeNumber: 'SEC-REPLAY-1',
        email: 'sec-replay@example.test',
        department: 'التحرير',
        title: 'محرر تجريبي',
        joinDate: todayInRiyadh(),
        location: 'الرياض',
        managerId: 'emp-omar',
        employmentStatus: 'active',
      },
    };
    const created = await f.api('/api/admin/employees', hr, 'POST', payload, 'security-replay-1');
    assert.equal(created.status, 201);
    await f.db.execute("UPDATE employees SET access_role='employee' WHERE id='emp-noura'");
    const replay = await f.api('/api/admin/employees', hr, 'POST', payload, 'security-replay-1');
    assert.equal(replay.status, 403);
    assert.equal(
      (
        await f.db.read<{ n: number }>(
          "SELECT count(*) AS n FROM employees WHERE employee_number='SEC-REPLAY-1'",
        )
      )[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});

test('closed payroll payment replay is blocked after the finance actor loses that role', async () => {
  const f = await fixture();
  try {
    const hr = await f.login('emp-noura');
    const finance = await f.login('emp-reem');
    const approver = await f.login('emp-abdullah');
    const created = await f.api(
      '/api/admin/payroll',
      hr,
      'POST',
      {
        period: '2026-11',
        policyId: 'payroll-policy-demo-v1',
        reason: 'اختبار مالي اصطناعي',
      },
      'security-payroll-create',
    );
    assert.equal(created.status, 200, await created.clone().text());
    const run = (
      (await created.json()) as {
        run: {
          id: string;
          version: number;
          lines: { employeeId: string; kind: string; amountMinor: number }[];
        };
      }
    ).run;
    const saraNetMinor = run.lines
      .filter((line) => line.employeeId === 'emp-sara')
      .reduce(
        (total, line) => total + (line.kind === 'earning' ? line.amountMinor : -line.amountMinor),
        0,
      );
    assert.ok(saraNetMinor > 0);
    const submit = await f.api(
      `/api/admin/payroll/${run.id}/actions`,
      hr,
      'POST',
      {
        version: 1,
        action: 'submit',
      },
      'security-payroll-submit',
    );
    assert.equal(submit.status, 200);
    const review = await f.api(
      `/api/admin/payroll/${run.id}/actions`,
      finance,
      'POST',
      {
        version: 2,
        action: 'review',
      },
      'security-payroll-review',
    );
    assert.equal(review.status, 200);
    const approval = await f.api(
      `/api/admin/payroll/${run.id}/actions`,
      approver,
      'POST',
      {
        version: 3,
        action: 'approve',
      },
      'security-payroll-approve',
    );
    assert.equal(approval.status, 200);

    const paymentBody = {
      version: 4,
      employeeId: 'emp-sara',
      state: 'paid',
      paidMinor: saraNetMinor,
      reference: 'synthetic-test-reference',
    };
    const payment = await f.api(
      `/api/admin/payroll/${run.id}/payments`,
      finance,
      'POST',
      paymentBody,
      'security-payment-1',
    );
    assert.equal(payment.status, 200);
    const replay = await f.api(
      `/api/admin/payroll/${run.id}/payments`,
      finance,
      'POST',
      paymentBody,
      'security-payment-1',
    );
    assert.equal(replay.status, 200);
    await f.db.execute("UPDATE employees SET access_role='employee' WHERE id='emp-reem'");
    const unauthorizedReplay = await f.api(
      `/api/admin/payroll/${run.id}/payments`,
      finance,
      'POST',
      paymentBody,
      'security-payment-1',
    );
    assert.equal(unauthorizedReplay.status, 403);
    assert.equal(
      (
        await f.db.read<{ state: string }>(
          'SELECT state FROM payroll_payments WHERE run_id=? AND employee_id=?',
          [run.id, 'emp-sara'],
        )
      )[0].state,
      'paid',
    );
  } finally {
    await f.close();
  }
});

test('attendance rejects impossible calendar dates', async () => {
  const f = await fixture();
  try {
    const hr = await f.login('emp-noura');
    const response = await f.api(
      '/api/admin/attendance',
      hr,
      'POST',
      {
        employeeId: 'emp-sara',
        date: '2027-02-31',
        checkIn: '09:00',
        checkOut: '17:00',
        workMode: 'office',
        note: 'synthetic test',
      },
      'security-invalid-date',
    );
    assert.equal(response.status, 400);
    assert.equal(
      (
        await f.db.read<{ n: number }>(
          "SELECT count(*) AS n FROM attendance_records WHERE work_date='2027-02-31'",
        )
      )[0].n,
      0,
    );
  } finally {
    await f.close();
  }
});
