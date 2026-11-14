// Private local mode (real data on the owner's machine) and employee photos.
// All data here is synthetic. Context: docs/decisions/005-private-local-mode.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest, type Server } from 'node:http';
import ExcelJS from 'exceljs';
import { createApp } from '../../server/app.js';
import { createDatabase, type Db } from '../../server/database.js';
import { mapSabqWorkbook, parseDate } from '../../server/imports/sabq-workbook.js';
import {
  attachPhoto,
  ensureLocalAdmin,
  grantRole,
  importMappedWorkbook,
  listAccess,
  listIncomplete,
  setManager,
} from '../../server/private/local-admin.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function serve(db: Db, options: Parameters<typeof createApp>[1] = {}) {
  const server: Server = createServer(createApp(db, options));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<string, string>();
  async function login(id: string) {
    return fetch(`${origin}/api/demo/session`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId: id }),
    });
  }
  async function get(as: string, path: string) {
    if (!cookies.has(as)) {
      const res = await login(as);
      assert.equal(res.status, 200, await res.clone().text());
      cookies.set(as, res.headers.get('set-cookie')!.split(';')[0]);
    }
    return fetch(`${origin}/api${path}`, { headers: { origin, cookie: cookies.get(as)! } });
  }
  return {
    origin,
    login,
    get,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function syntheticWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('الموظفين');
  ws.addRow([
    'اسم الموظف',
    'البريد الإلكتروني',
    'تاريخ التعيين',
    'على رأس العمل',
    'القسم',
    'الصورة',
    'عمود غير معروف',
  ]);
  ws.addRow(['موظف تجريبي أ', 'A@Example.test', '2020-01-15', 'نعم', 'التحرير', '', 'x']);
  ws.addRow(['موظف تجريبي ب', 'b@example.test', '15/03/2021', 'نعم', '', '', '']);
  ws.addRow(['موظف تجريبي ج', 'c@example.test', '2019-07-01', 'لا', '', '', '']);
  ws.addRow(['موظف تجريبي د', 'd@example.test', '', '', '', '', '']);
  ws.addRow(['موظف تجريبي هـ', 'e@example.test', '٢٠٢٢/٠٢/٠١', 'نعم', '', '', '']);
  ws.addRow(['موظف تجريبي و', '', '2023-05-05', 'نعم', '', '', '']);
  ws.addRow(['', '', '', '', '', '', '']);
  const imageId = wb.addImage({ buffer: PNG as unknown as ExcelJS.Buffer, extension: 'png' });
  ws.addImage(imageId, { tl: { col: 5, row: 1 }, ext: { width: 20, height: 20 } }); // F2
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function importedDatabase() {
  const db = await createDatabase(':memory:', { seed: false });
  const mapped = await mapSabqWorkbook(await syntheticWorkbook());
  const summary = await importMappedWorkbook(db, mapped);
  return { db, mapped, summary };
}
const idOf = async (db: Db, email: string) =>
  (await db.read<{ id: string }>('SELECT id FROM employees WHERE email=?', [email]))[0].id;

test('workbook mapping reads Arabic headers, dates, status and the anchored photo', async () => {
  const mapped = await mapSabqWorkbook(await syntheticWorkbook());
  assert.equal(mapped.rows.length, 6, 'blank line skipped');
  assert.equal(mapped.photosFound, 1);
  assert.deepEqual(mapped.ignoredColumns, ['عمود غير معروف']);
  const [a, b, c, d, e] = mapped.rows;
  assert.equal(a.values.email, 'a@example.test');
  assert.equal(a.values.department, 'التحرير');
  assert.equal(a.photo?.mime, 'image/png');
  assert.equal(b.values.joinDate, '2021-03-15');
  assert.ok(b.issues.includes('placeholder:department'));
  assert.equal(c.values.employmentStatus, 'terminated');
  assert.ok(d.issues.includes('missing:joinDate'));
  assert.ok(d.issues.includes('status_unknown_defaulted_active'));
  assert.equal(e.values.joinDate, '2022-02-01');
  assert.equal(parseDate('31/02/2020'), null);
});

test('import creates people once, keeps photos encrypted, and skips incomplete rows', async () => {
  const { db, mapped, summary } = await importedDatabase();
  try {
    assert.equal(summary.imported, 4);
    assert.equal(summary.photos, 1);
    assert.deepEqual(summary.skipped, [
      { rowNumber: 5, reason: 'missing_join_date' },
      { rowNumber: 7, reason: 'missing_email' },
    ]);
    const again = await importMappedWorkbook(db, mapped);
    assert.equal(again.imported, 0, 'a re-run never duplicates people');
    assert.ok(again.skipped.every((s) => s.reason === 'EMAIL_EXISTS' || s.rowNumber >= 5));
    const docs = await db.read<{ encrypted_content: string }>(
      "SELECT encrypted_content FROM employee_documents WHERE category='photo'",
    );
    assert.equal(docs.length, 1);
    assert.ok(!docs[0].encrypted_content.includes(PNG.toString('base64')));
    const numbers = (await listAccess(db)).map((r) => r.employee_number).sort();
    assert.deepEqual(numbers, ['SBQ-0001', 'SBQ-0002', 'SBQ-0003', 'SBQ-0004']);
  } finally {
    await db.close();
  }
});

test('dry run validates everything and saves nothing', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  try {
    const mapped = await mapSabqWorkbook(await syntheticWorkbook());
    const summary = await importMappedWorkbook(db, mapped, { dryRun: true });
    assert.equal(summary.imported, 4);
    assert.equal((await listAccess(db)).length, 0);
  } finally {
    await db.close();
  }
});

test('role grants and manager links are guarded and audited', async () => {
  const { db } = await importedDatabase();
  try {
    await assert.rejects(grantRole(db, 'a@example.test', 'owner'), /Role must be one of/);
    await assert.rejects(grantRole(db, 'c@example.test', 'hr'), /inactive/);
    await assert.rejects(setManager(db, 'a@example.test', 'b@example.test'), /manager role/);
    await grantRole(db, 'b@example.test', 'manager');
    await assert.rejects(setManager(db, 'b@example.test', 'b@example.test'), /themselves/);
    await setManager(db, 'a@example.test', 'b@example.test');
    const events = await db.read<{ action: string }>(
      "SELECT action FROM administration_events WHERE action IN ('access_role_granted','manager_assigned')",
    );
    assert.deepEqual(events.map((e) => e.action).sort(), [
      'access_role_granted',
      'manager_assigned',
    ]);
  } finally {
    await db.close();
  }
});

test('private mode signs in only granted accounts and scopes photos to self, HR and manager', async () => {
  const { db } = await importedDatabase();
  const a = await idOf(db, 'a@example.test');
  const b = await idOf(db, 'b@example.test');
  const e = await idOf(db, 'e@example.test');
  await grantRole(db, 'b@example.test', 'manager');
  await grantRole(db, 'e@example.test', 'hr');
  await setManager(db, 'a@example.test', 'b@example.test');
  const h = await serve(db, { dataMode: 'private' });
  try {
    const session = await (
      await fetch(`${h.origin}/api/session`, { headers: { origin: h.origin } })
    ).json();
    assert.equal(session.mode, 'private-local');
    assert.deepEqual(session.personas.map((p: { id: string }) => p.id).sort(), [b, e].sort());
    assert.equal((await h.login(a)).status, 400, 'an ungranted employee cannot sign in');
    assert.equal((await h.login('emp-noura')).status, 400);
    assert.equal((await h.login('system-local-admin')).status, 400);

    const team = await (await h.get(b, '/bootstrap')).json();
    const listed = team.employees.find((x: { id: string }) => x.id === a);
    assert.ok(listed?.photoId, 'the manager sees the photo id of a direct report');
    const photo = await h.get(b, `/employees/${a}/photo`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.equal(photo.headers.get('cache-control'), 'private, no-store');
    assert.ok(Buffer.from(await photo.arrayBuffer()).equals(PNG));
    assert.equal((await h.get(e, `/employees/${a}/photo`)).status, 200, 'HR sees photos');
    assert.equal((await h.get(b, `/employees/${e}/photo`)).status, 404, 'not a direct report');
    assert.equal((await h.get(e, `/employees/${b}/photo`)).status, 404, 'no photo uploaded');
  } finally {
    await h.close();
    await db.close();
  }
});

test('private finance access follows the exact grant and revokes an existing session', async () => {
  const { db } = await importedDatabase();
  const owner = await idOf(db, 'a@example.test');
  const other = await idOf(db, 'b@example.test');
  await grantRole(db, 'a@example.test', 'hr');
  await grantRole(db, 'b@example.test', 'hr');
  const h = await serve(db, { dataMode: 'private', financeEmployeeId: owner });
  try {
    assert.equal((await (await h.get(owner, '/bootstrap')).json()).financeAccess, true);
    assert.equal((await h.get(owner, '/finance/settings')).status, 200);
    assert.equal((await (await h.get(other, '/bootstrap')).json()).financeAccess, false);
    assert.equal((await h.get(other, '/finance/settings')).status, 403);
    await db.execute('UPDATE employees SET access_role=NULL WHERE id=?', [owner]);
    assert.equal((await h.get(owner, '/finance/settings')).status, 401);
    assert.equal((await h.get(owner, '/bootstrap')).status, 401);
  } finally {
    await h.close();
    await db.close();
  }
});

test('synthetic mode keeps photo scope: finance cannot fetch a colleague photo', async () => {
  const db = await createDatabase();
  await ensureLocalAdmin(db);
  await attachPhoto(db, 'emp-sara', 'image/png', PNG);
  const h = await serve(db);
  try {
    assert.equal((await h.get('emp-sara', '/employees/emp-sara/photo')).status, 200);
    assert.equal((await h.get('emp-omar', '/employees/emp-sara/photo')).status, 200);
    assert.equal((await h.get('emp-reem', '/employees/emp-sara/photo')).status, 404);
    const me = (await (await h.get('emp-sara', '/bootstrap')).json()).me;
    assert.ok(me.photoId);
  } finally {
    await h.close();
    await db.close();
  }
});

test('a private database refuses synthetic data and a public origin needs a password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-private-test-'));
  try {
    const path = join(dir, 'demo.sqlite');
    await (await createDatabase(path)).close();
    await assert.rejects(createDatabase(path, { seed: false }), /synthetic demo database/);
    const db = await createDatabase(':memory:', { seed: false });
    assert.deepEqual(
      await db.read<{ id: string }>('SELECT id FROM administrative_policies'),
      [],
      'private migrations must not insert synthetic payroll policies',
    );
    for (const table of [
      'employees',
      'policy_versions',
      'work_schedules',
      'employment_periods',
      'leave_requests',
      'leave_ledger',
      'administrative_requests',
      'payroll_runs',
    ]) {
      assert.equal(
        (await db.read<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n,
        0,
        `private schema should have no synthetic rows in ${table}`,
      );
    }
    assert.throws(
      () => createApp(db, { dataMode: 'private', publicOrigin: 'https://example.test' }),
      /requires an access password/,
    );
    await db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('include-incomplete imports placeholder people once and lists them for HR follow-up', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  try {
    const mapped = await mapSabqWorkbook(await syntheticWorkbook());
    const summary = await importMappedWorkbook(db, mapped, {
      includeIncomplete: true,
      today: '2026-11-14',
    });
    assert.equal(summary.imported, 6);
    assert.deepEqual(summary.skipped, []);
    const again = await importMappedWorkbook(db, mapped, { includeIncomplete: true });
    assert.equal(again.imported, 0, 'placeholder people are not duplicated on re-run');
    const incomplete = await listIncomplete(db);
    assert.deepEqual(
      incomplete.map((r) => r.fields),
      [['joinDate'], ['email']],
    );
    assert.equal(
      (
        await db.read<{ email: string }>("SELECT email FROM employees WHERE name='موظف تجريبي و'")
      )[0].email,
      'sbq-0006@pending.invalid',
    );
    const row = (
      await db.read<{ email: string; join_date: string }>(
        "SELECT email,join_date FROM employees WHERE email='d@example.test'",
      )
    )[0];
    assert.equal(row.join_date, '2026-11-14');
  } finally {
    await db.close();
  }
});

test('private hosted mode: password gate before any data, lockout, secure cookie', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  assert.throws(
    () => createApp(db, { dataMode: 'private', publicOrigin: 'https://hr.example.test' }),
    /access password/,
  );
  assert.throws(
    () =>
      createApp(db, {
        dataMode: 'private',
        publicOrigin: 'https://hr.example.test',
        accessPassword: 'short',
      }),
    /at least 12/,
  );
  const origin = 'https://hr.example.test';
  const app = createApp(db, {
    dataMode: 'private',
    publicOrigin: origin,
    accessPassword: 'correct-horse-battery',
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
    new Promise<{ status: number; body: string; setCookie?: string[] }>((resolve, reject) => {
      const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: `/api${path}`,
          method: init.method ?? 'GET',
          headers: {
            host: 'hr.example.test',
            origin,
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...(init.cookie ? { cookie: init.cookie } : {}),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode!, body, setCookie: res.headers['set-cookie'] }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  try {
    assert.equal((await call('/health')).status, 200);
    assert.equal(JSON.parse((await call('/health')).body).mode, 'private-hosted');
    for (const path of ['/session', '/bootstrap', '/employees/x/photo', '/admin/overview']) {
      const res = await call(path);
      assert.equal(res.status, 401, path);
      assert.equal(JSON.parse(res.body).error.code, 'ACCESS_REQUIRED');
    }
    assert.equal(
      (await call('/demo/session', { method: 'POST', body: { employeeId: 'x' } })).status,
      401,
    );
    const wrong = await call('/access', { method: 'POST', body: { password: 'nope' } });
    assert.equal(wrong.status, 401);
    const ok = await call('/access', {
      method: 'POST',
      body: { password: 'correct-horse-battery' },
    });
    assert.equal(ok.status, 200);
    const cookie = ok.setCookie!.find((c) => c.startsWith('__Host-sabq_hr_access='))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    const session = await call('/session', { cookie: cookie.split(';')[0] });
    assert.equal(session.status, 200);
    assert.equal(JSON.parse(session.body).mode, 'private-hosted');
    for (let i = 0; i < 9; i++)
      await call('/access', { method: 'POST', body: { password: `wrong-${i}` } });
    const locked = await call('/access', {
      method: 'POST',
      body: { password: 'correct-horse-battery' },
    });
    assert.equal(locked.status, 429, 'ten failures lock the gate, even for the right password');
    const out = await call('/access', { method: 'DELETE', cookie: cookie.split(';')[0] });
    assert.equal(out.status, 204);
    assert.equal((await call('/session', { cookie: cookie.split(';')[0] })).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
