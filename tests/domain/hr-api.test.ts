import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { createDatabase, todayInRiyadh } from '../../server/database.js';

let server: Server;
let base = '';
let database: Awaited<ReturnType<typeof createDatabase>>;
beforeEach(async () => {
  database = await createDatabase();
  const app = createApp(database);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await database.close();
});

type Context = { cookie: string; origin: string };
async function login(id: string): Promise<Context> {
  const response = await fetch(`${base}/api/demo/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ employeeId: id }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { cookie, origin: base };
}
async function api(path: string, options: RequestInit = {}, context?: Context) {
  const headers = new Headers(options.headers);
  if (context?.cookie) headers.set('cookie', context.cookie);
  if (['POST', 'DELETE', 'PATCH', 'PUT'].includes(options.method ?? 'GET'))
    headers.set('origin', context?.origin ?? base);
  return fetch(`${base}${path}`, { ...options, headers });
}
async function customHost(host: string): Promise<number> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: address.port, path: '/api/health', headers: { host } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });
}
const post = (body: unknown, key = 'test-key'): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': key },
  body: JSON.stringify(body),
});
function futureSunday(offset = 7): string {
  const d = new Date(`${todayInRiyadh()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) + offset);
  return d.toISOString().slice(0, 10);
}
const plus = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
async function createLeave(
  context: Context,
  start = futureSunday(42),
  end = plus(futureSunday(42), 1),
  key = 'new-leave',
) {
  return api(
    '/api/leaves',
    post({ startDate: start, endDate: end, note: 'اختبار محلي' }, key),
    context,
  );
}

test('health is public but app is local-host only; unsafe requests require exact same origin', async () => {
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', mode: 'synthetic-local' });
  assert.equal(await customHost('example.com'), 403);
  assert.equal(
    (
      await fetch(`${base}/api/demo/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/demo/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/demo/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base.replace('http:', 'https:') },
        body: '{}',
      })
    ).status,
    403,
  );
  const api404 = await api('/api/not-a-route');
  assert.equal(api404.status, 404);
  assert.equal(api404.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(api404.headers.get('x-content-type-options'), 'nosniff');
});

test('JSON body limits are scoped to the documented document and import routes', async () => {
  const hr = await login('emp-noura');
  const largePayload = { filename: 'fixture.pdf', data: 'a'.repeat(90_000) };
  const documentResponse = await api(
    '/api/admin/employees/emp-sara/documents',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(largePayload),
    },
    hr,
  );
  assert.notEqual(documentResponse.status, 413);
  const previewResponse = await api(
    '/api/admin/imports/employees/preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(largePayload),
    },
    hr,
  );
  assert.notEqual(previewResponse.status, 413);
  const oversizedGeneral = await api(
    '/api/leaves',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'oversized-json' },
      body: JSON.stringify({
        startDate: futureSunday(),
        endDate: futureSunday(),
        note: 'a'.repeat(90_000),
      }),
    },
    await login('emp-sara'),
  );
  assert.equal(oversizedGeneral.status, 413);
});

test('migrations and synthetic reference records persist when the database is reopened', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sabq-hr-migration-'));
  const path = join(directory, 'test.sqlite');
  try {
    const first = await createDatabase(path);
    assert.deepEqual(
      (
        await first.read<{ version: number }>(
          'SELECT version FROM schema_migrations ORDER BY version',
        )
      ).map((r) => r.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12],
    );
    assert.equal(
      (await first.read<{ n: number }>('SELECT count(*) AS n FROM employment_periods'))[0].n,
      11,
    );
    const sample = (
      await first.read<{
        start_date: string;
        status: string;
        version: number;
        policy_version_id: string;
        work_schedule_id: string;
      }>(
        "SELECT start_date,status,version,policy_version_id,work_schedule_id FROM leave_requests WHERE id='leave-demo-lina'",
      )
    )[0];
    assert.ok(
      sample.start_date >= todayInRiyadh() && sample.start_date <= plus(todayInRiyadh(), 6),
    );
    assert.equal(sample.status, 'approved');
    assert.equal(sample.policy_version_id, 'policy-demo-annual-v1');
    assert.equal(sample.work_schedule_id, 'schedule-demo-emp-lina-v1');
    const testServer = createServer(createApp(first));
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const address = testServer.address();
    if (!address || typeof address === 'string') throw new Error('No persistence test listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const signed = await fetch(`${origin}/api/demo/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ employeeId: 'emp-sara' }),
    });
    const cookie = signed.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const canceled = await fetch(`${origin}/api/leaves/leave-demo-sara/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie,
        'idempotency-key': 'persist-cancel',
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(canceled.status, 200);
    const beforeState = {
      ledger: (
        await first.read<{ n: number }>(
          "SELECT count(*) AS n FROM leave_ledger WHERE employee_id='emp-sara'",
        )
      )[0].n,
      audit: (
        await first.read<{ n: number }>(
          "SELECT count(*) AS n FROM audit_events WHERE resource_id='leave-demo-sara'",
        )
      )[0].n,
      outbox: (
        await first.read<{ n: number }>(
          "SELECT count(*) AS n FROM outbox WHERE recipient_id='emp-omar'",
        )
      )[0].n,
    };
    await new Promise<void>((resolve, reject) =>
      testServer.close((e) => (e ? reject(e) : resolve())),
    );
    await first.close();
    const reopened = await createDatabase(path);
    const saraleave = (
      await reopened.read<{ status: string; version: number; start_date: string }>(
        "SELECT status,version,start_date FROM leave_requests WHERE id='leave-demo-sara'",
      )
    )[0];
    assert.equal(saraleave.status, 'cancelled');
    assert.equal(saraleave.version, 2);
    const lina = (
      await reopened.read<{ status: string; version: number; start_date: string }>(
        "SELECT status,version,start_date FROM leave_requests WHERE id='leave-demo-lina'",
      )
    )[0];
    assert.equal(lina.status, sample.status);
    assert.equal(lina.version, sample.version);
    assert.equal(lina.start_date, sample.start_date);
    assert.equal(
      (
        await reopened.read<{ n: number }>(
          "SELECT count(*) AS n FROM leave_ledger WHERE employee_id='emp-sara'",
        )
      )[0].n,
      beforeState.ledger,
    );
    assert.equal(
      (
        await reopened.read<{ n: number }>(
          "SELECT count(*) AS n FROM audit_events WHERE resource_id='leave-demo-sara'",
        )
      )[0].n,
      beforeState.audit,
    );
    assert.equal(
      (
        await reopened.read<{ n: number }>(
          "SELECT count(*) AS n FROM outbox WHERE recipient_id='emp-omar'",
        )
      )[0].n,
      beforeState.outbox,
    );
    assert.equal(
      (await reopened.read<{ n: number }>('SELECT count(*) AS n FROM schema_migrations'))[0].n,
      11,
    );
    await reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session is server-expiring, persona switching invalidates the old token, and API responses are not cacheable', async () => {
  const sara = await login('emp-sara');
  const switched = await fetch(`${base}/api/demo/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: sara.cookie },
    body: JSON.stringify({ employeeId: 'emp-omar' }),
  });
  const newCookie = switched.headers.get('set-cookie')?.split(';')[0];
  assert.ok(newCookie);
  assert.match(switched.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.match(switched.headers.get('set-cookie') ?? '', /SameSite=Strict/i);
  assert.equal((await api('/api/bootstrap', {}, sara)).status, 401);
  const current = await api('/api/bootstrap', {}, { cookie: newCookie!, origin: base });
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('cache-control'), 'no-store, max-age=0');

  const shortDb = await createDatabase();
  const shortServer = createServer(createApp(shortDb, { sessionTtlMs: 20 }));
  await new Promise<void>((resolve) => shortServer.listen(0, '127.0.0.1', resolve));
  const address = shortServer.address();
  if (!address || typeof address === 'string') throw new Error('No expiry test listener');
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const signed = await fetch(`${origin}/api/demo/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ employeeId: 'emp-sara' }),
    });
    const expiredCookie = signed.headers.get('set-cookie')?.split(';')[0];
    assert.ok(expiredCookie);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(
      (await fetch(`${origin}/api/bootstrap`, { headers: { cookie: expiredCookie } })).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      shortServer.close((e) => (e ? reject(e) : resolve())),
    );
    await shortDb.close();
  }
});

test('ledger and audit rows are append-only at the database layer', async () => {
  await assert.rejects(
    database.execute("UPDATE leave_ledger SET days=days WHERE kind='allocation'"),
    /append-only ledger/,
  );
  await assert.rejects(
    database.execute("DELETE FROM leave_ledger WHERE kind='allocation'"),
    /append-only ledger/,
  );
  await database.execute(
    "INSERT INTO audit_events(actor_id,actor_role,action,resource_id,created_at) VALUES('emp-sara','employee','test','leave-demo-sara',?)",
    [new Date().toISOString()],
  );
  await assert.rejects(
    database.execute("UPDATE audit_events SET action='changed' WHERE action='test'"),
    /append-only audit/,
  );
});

test('session is explicit; employee cannot enumerate or read unauthorized employee records', async () => {
  assert.equal((await api('/api/bootstrap')).status, 401);
  const sara = await login('emp-sara');
  const bootstrap = (await (await api('/api/bootstrap', {}, sara)).json()) as {
    employees: { id: string }[];
  };
  assert.deepEqual(
    bootstrap.employees.map((e) => e.id),
    ['emp-sara'],
  );
  assert.equal((await api('/api/employees/emp-omar', {}, sara)).status, 403);
  assert.equal((await api('/api/employees/emp-missing', {}, sara)).status, 404);
  assert.equal((await api('/api/demo/session', post({ employeeId: 'emp-fahad' }))).status, 400);
});

test('manager can view direct reports only and never sees their leave note', async () => {
  const omar = await login('emp-omar');
  const bootstrap = (await (await api('/api/bootstrap', {}, omar)).json()) as {
    employees: { id: string }[];
    leaves: { id: string; note: string }[];
  };
  assert.ok(bootstrap.employees.some((e) => e.id === 'emp-sara'));
  assert.ok(bootstrap.employees.some((e) => e.id === 'emp-noura'));
  assert.equal(bootstrap.leaves.find((l) => l.id === 'leave-demo-sara')?.note, '');
  assert.equal((await api('/api/employees/emp-noura', {}, omar)).status, 200);
});

test('manager decision response and idempotent replay redact employee leave notes', async () => {
  const sara = await login('emp-sara');
  const start = futureSunday(63);
  const input = { startDate: start, endDate: plus(start, 1), note: 'ملاحظة خاصة لا تظهر للمدير' };
  const created = await api('/api/leaves', post(input, 'note-create'), sara);
  assert.equal(created.status, 201);
  const leave = ((await created.json()) as { leave: { id: string; version: number } }).leave;
  const omar = await login('emp-omar');
  const decisionInput = { decision: 'approve', version: leave.version };
  const decision = await api(
    `/api/leaves/${leave.id}/decision`,
    post(decisionInput, 'note-decision'),
    omar,
  );
  const body = (await decision.json()) as { leave: { note: string } };
  assert.equal(body.leave.note, '');
  const replay = await api(
    `/api/leaves/${leave.id}/decision`,
    post(decisionInput, 'note-decision'),
    omar,
  );
  assert.equal(((await replay.json()) as { leave: { note: string } }).leave.note, '');
});

test('request creation is blocked if any independent approval stage is unconfigured', async () => {
  const start = futureSunday(70);
  const input = { startDate: start, endDate: plus(start, 1), note: 'مسار مطلوب' };
  for (const id of ['emp-omar', 'emp-noura']) {
    const persona = await login(id);
    const before = (await (await api('/api/bootstrap', {}, persona)).json()) as {
      leaves: { id: string }[];
    };
    const response = await api('/api/leaves', post(input, `route-${id}`), persona);
    assert.equal(response.status, 409);
    const error = ((await response.json()) as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'APPROVAL_ROUTE_UNCONFIGURED');
    assert.match(error.message, /مسار الاعتماد غير مكتمل/);
    const after = (await (await api('/api/bootstrap', {}, persona)).json()) as {
      leaves: { id: string }[];
    };
    assert.equal(after.leaves.length, before.leaves.length);
  }
});

test('bootstrap and submission fail clearly when persisted policy and schedule disagree', async () => {
  const sara = await login('emp-sara');
  await database.execute(
    "UPDATE policy_versions SET working_days_json='[0,1,2,3]' WHERE id='policy-demo-annual-v1'",
  );
  const bootstrap = await api('/api/bootstrap', {}, sara);
  assert.equal(bootstrap.status, 503);
  const start = futureSunday(77);
  const submitted = await createLeave(sara, start, plus(start, 1), 'bad-policy');
  assert.equal(submitted.status, 503);
  assert.equal(
    ((await submitted.json()) as { error: { code: string } }).error.code,
    'DEMO_POLICY_CONFIGURATION_INVALID',
  );
});

test('create idempotency replay reserves once and changed payload conflicts', async () => {
  const sara = await login('emp-sara');
  const start = futureSunday(42);
  const first = await createLeave(sara, start, plus(start, 1), 'same');
  assert.equal(first.status, 201);
  const a = (await first.json()) as { leave: { id: string; days: number } };
  const replay = await createLeave(sara, start, plus(start, 1), 'same');
  assert.equal(replay.status, 201);
  assert.equal(((await replay.json()) as { leave: { id: string } }).leave.id, a.leave.id);
  const conflict = await createLeave(sara, start, plus(start, 2), 'same');
  assert.equal(conflict.status, 409);
  const b = (await (await api('/api/bootstrap', {}, sara)).json()) as {
    balance: { reserved: number; available: number };
  };
  assert.equal(b.balance.reserved, 2 + a.leave.days);
  assert.equal(b.balance.available, 22 - a.leave.days);
});

test('overlapping pending requests conflict and simultaneous duplicate sends remain single', async () => {
  const sara = await login('emp-sara');
  const start = futureSunday(21);
  const input = { startDate: start, endDate: plus(start, 1), note: 'تجربة' };
  const [one, two] = await Promise.all([
    api('/api/leaves', post(input, 'race-one'), sara),
    api('/api/leaves', post(input, 'race-two'), sara),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [201, 409]);
  const duplicateStart = futureSunday(49);
  const duplicateInput = {
    startDate: duplicateStart,
    endDate: plus(duplicateStart, 1),
    note: 'تجربة',
  };
  const parallel = await Promise.all([
    api('/api/leaves', post(duplicateInput, 'race-same'), sara),
    api('/api/leaves', post(duplicateInput, 'race-same'), sara),
  ]);
  assert.deepEqual(
    parallel.map((r) => r.status),
    [201, 201],
  );
});

test('insufficient balance is rejected and no-workday or invalid dates are rejected', async () => {
  const sara = await login('emp-sara');
  const start = futureSunday(28);
  assert.equal((await createLeave(sara, start, plus(start, 33), 'too-long')).status, 409);
  const sunday = futureSunday(35);
  assert.equal((await createLeave(sara, plus(sunday, 5), plus(sunday, 6), 'weekend')).status, 400);
  assert.equal(
    (
      await api(
        '/api/leaves',
        post({ startDate: '2026-02-30', endDate: '2026-03-02', note: '' }, 'bad-date'),
        sara,
      )
    ).status,
    400,
  );
});

test('approval is manager then HR, prevents self approval, and rejects stale versions', async () => {
  const sara = await login('emp-sara');
  const created = await createLeave(sara, futureSunday(42), futureSunday(42 + 1), 'flow');
  const leave = ((await created.json()) as { leave: { id: string; version: number } }).leave;
  assert.equal(
    (
      await api(
        `/api/leaves/${leave.id}/decision`,
        post({ decision: 'approve', version: 1 }, 'self'),
        sara,
      )
    ).status,
    403,
  );
  const omar = await login('emp-omar');
  const manager = await api(
    `/api/leaves/${leave.id}/decision`,
    post({ decision: 'approve', version: 1 }, 'manager'),
    omar,
  );
  assert.equal(manager.status, 200);
  assert.equal(
    (
      await api(
        `/api/leaves/${leave.id}/decision`,
        post({ decision: 'approve', version: 1 }, 'stale'),
        await login('emp-noura'),
      )
    ).status,
    409,
  );
  const noura = await login('emp-noura');
  const hr = await api(
    `/api/leaves/${leave.id}/decision`,
    post({ decision: 'approve', version: 2 }, 'hr'),
    noura,
  );
  assert.equal(hr.status, 200);
  assert.equal(
    ((await hr.json()) as { leave: { status: string; version: number } }).leave.status,
    'approved',
  );
  const final = (await (await api('/api/bootstrap', {}, sara)).json()) as {
    balance: { reserved: number; used: number; available: number };
  };
  assert.equal(final.balance.reserved, 2);
  assert.equal(final.balance.used, 2);
  assert.equal(final.balance.available, 20);
});

test('HR cannot skip the manager step; request rejection releases reservation once', async () => {
  const noura = await login('emp-noura');
  assert.equal(
    (
      await api(
        '/api/leaves/leave-demo-sara/decision',
        post({ decision: 'approve', version: 1 }, 'skip'),
        noura,
      )
    ).status,
    403,
  );
  const omar = await login('emp-omar');
  const rejected = await api(
    '/api/leaves/leave-demo-sara/decision',
    post({ decision: 'reject', version: 1, reason: 'تغطية الفريق' }, 'reject'),
    omar,
  );
  assert.equal(rejected.status, 200);
  const sara = await login('emp-sara');
  const b = (await (await api('/api/bootstrap', {}, sara)).json()) as {
    balance: { reserved: number; available: number };
  };
  assert.equal(b.balance.reserved, 0);
  assert.equal(b.balance.available, 24);
  assert.equal(
    (
      await api(
        '/api/leaves/leave-demo-sara/decision',
        post({ decision: 'reject', version: 1, reason: 'تغطية الفريق' }, 'reject'),
        omar,
      )
    ).status,
    200,
  );
});

test('owner can cancel only pending requests and releases the hold', async () => {
  const sara = await login('emp-sara');
  const start = futureSunday(56);
  const created = await createLeave(sara, start, plus(start, 1), 'cancel-create');
  const leave = ((await created.json()) as { leave: { id: string; version: number; days: number } })
    .leave;
  const canceled = await api(
    `/api/leaves/${leave.id}/cancel`,
    post({ version: 1 }, 'cancel'),
    sara,
  );
  assert.equal(canceled.status, 200);
  const b = (await (await api('/api/bootstrap', {}, sara)).json()) as {
    balance: { reserved: number; available: number };
  };
  assert.equal(b.balance.reserved, 2);
  assert.equal(b.balance.available, 22);
  assert.equal(
    (await api(`/api/leaves/${leave.id}/cancel`, post({ version: 1 }, 'cancel'), sara)).status,
    200,
  );
});

test('decision and cancel reject competing stale versions; another employee cannot cancel', async () => {
  const sara = await login('emp-sara');
  const omar = await login('emp-omar');
  assert.equal(
    (await api('/api/leaves/leave-demo-sara/cancel', post({ version: 1 }, 'wrong-owner'), omar))
      .status,
    403,
  );
  const manager = await api(
    '/api/leaves/leave-demo-sara/decision',
    post({ decision: 'approve', version: 99 }, 'stale-seed'),
    omar,
  );
  assert.equal(manager.status, 409);
});
