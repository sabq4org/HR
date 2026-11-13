import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/app.js';
import { createDatabase, todayInRiyadh } from '../../server/database.js';

const personas = {
  employee: 'emp-sara',
  manager: 'emp-omar',
  hr: 'emp-noura',
  approver: 'emp-abdullah',
} as const;
type Persona = keyof typeof personas;
function futureDate(days = 5) {
  const date = new Date(`${todayInRiyadh()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
async function harness() {
  const db = await createDatabase();
  const server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<Persona, string>();
  async function call(role: Persona, path: string, method = 'GET', body?: unknown) {
    if (!cookies.has(role)) {
      const login = await fetch(`${origin}/api/demo/session`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ employeeId: personas[role] }),
      });
      assert.equal(login.status, 200, await login.clone().text());
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
async function approve(h: Awaited<ReturnType<typeof harness>>, role: Persona, request: any) {
  return h.call(role, `/admin/requests/${request.id}/actions`, 'POST', {
    version: request.version,
    action: 'approve',
    reason: 'اعتماد اصطناعي مستقل',
  });
}

test('profile edits reject future effective dates without changing the file', async () => {
  const h = await harness();
  try {
    const before = (
      await h.db.read<any>('SELECT title,record_version FROM employees WHERE id=?', [
        personas.employee,
      ])
    )[0];
    const response = await h.call('hr', `/admin/employees/${personas.employee}`, 'PATCH', {
      version: before.record_version,
      values: { title: 'مسمى مستقبلي' },
      reason: 'تعديل مؤجل اصطناعي',
      effectiveAt: futureDate(),
    });
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).error.code, 'FUTURE_EFFECTIVE_DATE');
    const after = (
      await h.db.read<any>('SELECT title,record_version FROM employees WHERE id=?', [
        personas.employee,
      ])
    )[0];
    assert.equal(after.title, before.title);
    assert.equal(after.record_version, before.record_version);
  } finally {
    await h.close();
  }
});

test('future transfer approval stays pending and leaves the employee unchanged', async () => {
  const h = await harness();
  try {
    const before = (
      await h.db.read<any>('SELECT department,title,record_version FROM employees WHERE id=?', [
        personas.employee,
      ])
    )[0];
    const created = await h.call('manager', '/admin/requests', 'POST', {
      kind: 'transfer',
      employeeId: personas.employee,
      submit: true,
      values: {
        department: 'إدارة مستقبلية',
        title: 'مسمى مستقبلي',
        managerId: personas.manager,
        effectiveDate: futureDate(),
        reason: 'نقل مؤجل',
      },
    });
    assert.equal(created.status, 201, await created.clone().text());
    let request = (await created.json()).request;
    const hr = await approve(h, 'hr', request);
    assert.equal(hr.status, 200, await hr.clone().text());
    request = (await hr.json()).request;
    const final = await approve(h, 'approver', request);
    assert.equal(final.status, 409, await final.clone().text());
    assert.equal((await final.json()).error.code, 'FUTURE_EFFECTIVE_DATE');
    const stored = (
      await h.db.read<any>('SELECT state FROM administrative_requests WHERE id=?', [request.id])
    )[0];
    const after = (
      await h.db.read<any>('SELECT department,title,record_version FROM employees WHERE id=?', [
        personas.employee,
      ])
    )[0];
    assert.equal(stored.state, 'pending_approver');
    assert.deepEqual(after, before);
  } finally {
    await h.close();
  }
});

test('future separation approval stays pending and does not terminate employment', async () => {
  const h = await harness();
  try {
    const before = (
      await h.db.read<any>('SELECT employment_status,record_version FROM employees WHERE id=?', [
        personas.employee,
      ])
    )[0];
    const created = await h.call('employee', '/admin/requests', 'POST', {
      kind: 'separation',
      employeeId: personas.employee,
      submit: true,
      values: {
        reasonType: 'resignation',
        noticeDate: todayInRiyadh(),
        lastDay: futureDate(),
        handover: 'خطة تسليم مستقبلية',
        reason: 'طلب إنهاء مؤجل',
      },
    });
    assert.equal(created.status, 201, await created.clone().text());
    let request = (await created.json()).request;
    const hr = await approve(h, 'hr', request);
    assert.equal(hr.status, 200, await hr.clone().text());
    request = (await hr.json()).request;
    const final = await approve(h, 'approver', request);
    assert.equal(final.status, 409, await final.clone().text());
    assert.equal((await final.json()).error.code, 'FUTURE_EFFECTIVE_DATE');
    const stored = (
      await h.db.read<any>('SELECT state FROM administrative_requests WHERE id=?', [request.id])
    )[0];
    const after = (
      await h.db.read<any>('SELECT employment_status,record_version FROM employees WHERE id=?', [
        personas.employee,
      ])
    )[0];
    assert.equal(stored.state, 'pending_approver');
    assert.deepEqual(after, before);
  } finally {
    await h.close();
  }
});

test('rehire requires a closed earlier period and never activates a future employment', async () => {
  const h = await harness();
  try {
    const yesterday = new Date(`${todayInRiyadh()}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const before = (
      await h.db.read<any>('SELECT record_version FROM employees WHERE id=?', [personas.employee])
    )[0];
    const body = {
      version: before.record_version,
      startDate: todayInRiyadh(),
      relationshipType: 'fixed',
      reason: 'إعادة تعيين اصطناعية',
    };
    const active = await h.call('hr', `/admin/employees/${personas.employee}/rehire`, 'POST', body);
    assert.equal(active.status, 409);
    await h.db.transaction(async (tx) => {
      await tx.execute("UPDATE employees SET employment_status='terminated' WHERE id=?", [
        personas.employee,
      ]);
      await tx.execute(
        'UPDATE employment_periods SET end_date=? WHERE employee_id=? AND end_date IS NULL',
        [yesterday.toISOString().slice(0, 10), personas.employee],
      );
    });
    const future = await h.call('hr', `/admin/employees/${personas.employee}/rehire`, 'POST', {
      ...body,
      startDate: futureDate(),
    });
    assert.equal(future.status, 409);
    assert.equal((await future.json()).error.code, 'FUTURE_EFFECTIVE_DATE');
    assert.equal(
      (
        await h.db.read<any>('SELECT employment_status FROM employees WHERE id=?', [
          personas.employee,
        ])
      )[0].employment_status,
      'terminated',
    );
    const overlap = await h.call('hr', `/admin/employees/${personas.employee}/rehire`, 'POST', {
      ...body,
      startDate: yesterday.toISOString().slice(0, 10),
    });
    assert.equal(overlap.status, 409);
    const hired = await h.call('hr', `/admin/employees/${personas.employee}/rehire`, 'POST', body);
    assert.equal(hired.status, 201, await hired.clone().text());
    const periods = await h.db.read<any>(
      'SELECT end_date FROM employment_periods WHERE employee_id=?',
      [personas.employee],
    );
    assert.equal(periods.length, 2);
    assert.equal(periods.filter((period) => period.end_date === null).length, 1);
    assert.equal(
      (
        await h.db.read<any>('SELECT employment_status FROM employees WHERE id=?', [
          personas.employee,
        ])
      )[0].employment_status,
      'active',
    );
  } finally {
    await h.close();
  }
});
