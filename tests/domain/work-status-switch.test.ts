import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import express from 'express';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase } from '../../server/database.js';
import { registerAdministration } from '../../server/administration/routes.js';
import type { Actor } from '../../server/administration/service.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

// Synthetic personas only.
const personas = { employee: 'emp-sara', manager: 'emp-omar', hr: 'emp-noura' } as const;
type Persona = keyof typeof personas;

async function harness() {
  const db = await createDatabase();
  const server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<Persona, string>();
  async function call(
    role: Persona,
    path: string,
    body: unknown,
    key: string = randomUUID(),
    method = 'POST',
  ) {
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
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
  }
  const row = async (id: string) =>
    (
      await db.read<{ employment_status: string; record_version: number }>(
        'SELECT employment_status,record_version FROM employees WHERE id=?',
        [id],
      )
    )[0];
  const events = (id: string) =>
    db.read<{ action: string; details_json: string; actor_id: string }>(
      "SELECT action,details_json,actor_id FROM administration_events WHERE resource_id=? AND action='employee_work_status_changed' ORDER BY created_at",
      [id],
    );
  return {
    db,
    call,
    row,
    events,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}
const path = (id: string) => `/admin/employees/${id}/work-status`;

test('the team-directory switch cannot terminate an employee; dated workflow remains authoritative', async () => {
  const h = await harness();
  try {
    const before = await h.row(personas.employee);
    assert.equal(before.employment_status, 'active');
    const off = await h.call('hr', path(personas.employee), {
      onDuty: false,
      expectedStatus: 'active',
    });
    assert.equal(off.status, 409, await off.clone().text());
    assert.equal((await off.json()).error.code, 'SEPARATION_REQUIRED');
    const afterOff = await h.row(personas.employee);
    assert.equal(afterOff.employment_status, 'active');
    assert.equal(afterOff.record_version, before.record_version);
    assert.equal((await h.events(personas.employee)).length, 0);
    const periods = await h.db.read<{ end_date: string | null }>(
      'SELECT end_date FROM employment_periods WHERE employee_id=?',
      [personas.employee],
    );
    assert.ok(periods.every((period) => period.end_date === null));

    const on = await h.call('hr', path(personas.employee), {
      onDuty: true,
      expectedStatus: 'active',
    });
    assert.equal(on.status, 409, await on.clone().text());
    assert.equal((await on.json()).error.code, 'STATUS_UNCHANGED');
    assert.equal((await h.row(personas.employee)).employment_status, 'active');
  } finally {
    await h.close();
  }
});

test('only HR may switch, never on their own file, and other roles change nothing', async () => {
  const h = await harness();
  try {
    for (const role of ['employee', 'manager'] as const) {
      const denied = await h.call(role, path(personas.employee), {
        onDuty: false,
        expectedStatus: 'active',
      });
      assert.equal(denied.status, 403, `${role}: ${await denied.clone().text()}`);
    }
    const self = await h.call('hr', path(personas.hr), { onDuty: false, expectedStatus: 'active' });
    assert.equal(self.status, 403);
    assert.equal((await h.row(personas.employee)).employment_status, 'active');
    assert.equal((await h.row(personas.hr)).employment_status, 'active');
    assert.equal((await h.events(personas.employee)).length, 0);
  } finally {
    await h.close();
  }
});

test('stale cards, repeats and invalid bodies do not write twice', async () => {
  const h = await harness();
  try {
    const invalid = await h.call('hr', path(personas.employee), { expectedStatus: 'active' });
    assert.equal(invalid.status, 400);
    const stale = await h.call('hr', path(personas.employee), {
      onDuty: false,
      expectedStatus: 'on_leave',
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'STALE_VERSION');
    const unchanged = await h.call('hr', path(personas.employee), {
      onDuty: true,
      expectedStatus: 'active',
    });
    assert.equal(unchanged.status, 409);
    assert.equal((await unchanged.json()).error.code, 'STATUS_UNCHANGED');

    const key = randomUUID();
    const body = { onDuty: false, expectedStatus: 'active' };
    const first = await h.call('hr', path(personas.employee), body, key);
    assert.equal(first.status, 409);
    assert.equal((await first.json()).error.code, 'SEPARATION_REQUIRED');
    const version = (await h.row(personas.employee)).record_version;
    const replay = await h.call('hr', path(personas.employee), body, key);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, 'SEPARATION_REQUIRED');
    assert.equal((await h.row(personas.employee)).record_version, version);
    assert.equal((await h.events(personas.employee)).length, 0);
    const reused = await h.call(
      'hr',
      path(personas.employee),
      { onDuty: true, expectedStatus: 'terminated' },
      key,
    );
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).error.code, 'STALE_VERSION');
  } finally {
    await h.close();
  }
});

test('a dated separation cannot be reversed by the switch; rehire is required', async () => {
  const h = await harness();
  try {
    await h.db.transaction(async (tx) => {
      await tx.execute("UPDATE employees SET employment_status='terminated' WHERE id=?", [
        personas.employee,
      ]);
      await tx.execute(
        "UPDATE employment_periods SET end_date='2026-01-31' WHERE employee_id=? AND end_date IS NULL",
        [personas.employee],
      );
    });
    const on = await h.call('hr', path(personas.employee), {
      onDuty: true,
      expectedStatus: 'terminated',
    });
    assert.equal(on.status, 409);
    assert.equal((await on.json()).error.code, 'REHIRE_REQUIRED');
    assert.equal((await h.row(personas.employee)).employment_status, 'terminated');
  } finally {
    await h.close();
  }
});

test('profile edits cannot bypass dated separation or closed-period rehire', async () => {
  const h = await harness();
  try {
    const before = await h.row(personas.employee);
    const terminate = await h.call(
      'hr',
      `/admin/employees/${personas.employee}`,
      {
        version: before.record_version,
        values: { employmentStatus: 'terminated' },
        reason: 'محاولة إنهاء مباشرة اصطناعية',
      },
      randomUUID(),
      'PATCH',
    );
    assert.equal(terminate.status, 409, await terminate.clone().text());
    assert.equal((await terminate.json()).error.code, 'SEPARATION_REQUIRED');
    assert.deepEqual(await h.row(personas.employee), before);

    await h.db.transaction(async (tx) => {
      await tx.execute("UPDATE employees SET employment_status='terminated' WHERE id=?", [
        personas.employee,
      ]);
      await tx.execute(
        "UPDATE employment_periods SET end_date='2026-01-31' WHERE employee_id=? AND end_date IS NULL",
        [personas.employee],
      );
    });
    const closed = await h.row(personas.employee);
    const reactivate = await h.call(
      'hr',
      `/admin/employees/${personas.employee}`,
      {
        version: closed.record_version,
        values: { employmentStatus: 'active' },
        reason: 'محاولة إعادة تفعيل فترة مغلقة اصطناعية',
      },
      randomUUID(),
      'PATCH',
    );
    assert.equal(reactivate.status, 409, await reactivate.clone().text());
    assert.equal((await reactivate.json()).error.code, 'REHIRE_REQUIRED');
    assert.equal((await h.row(personas.employee)).employment_status, 'terminated');
  } finally {
    await h.close();
  }
});

test('quick on-duty correction remains available for a legacy terminated row with an open period', async () => {
  const h = await harness();
  try {
    await h.db.execute("UPDATE employees SET employment_status='terminated' WHERE id=?", [
      personas.employee,
    ]);
    const on = await h.call('hr', path(personas.employee), {
      onDuty: true,
      expectedStatus: 'terminated',
    });
    assert.equal(on.status, 200, await on.clone().text());
    assert.equal((await h.row(personas.employee)).employment_status, 'active');
  } finally {
    await h.close();
  }
});

test(
  'PostgreSQL: the switch writes status, history and audit atomically',
  { skip: !pgUrl },
  async () => {
    const db = await createPostgresDatabase(
      pgUrl!,
      `hr_preview_${randomBytes(16).toString('hex')}`,
    );
    const app = express();
    app.use(express.json());
    registerAdministration(app, {
      db,
      requireActor: async (req) => {
        const id = req.header('x-actor') ?? '';
        const role = (
          await db.read<{ role: Actor['role'] }>('SELECT role FROM employee_access WHERE id=?', [
            id,
          ])
        )[0]?.role;
        if (!role) throw new Error('test actor not found');
        return { id, role };
      },
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const post = (actorId: string, body: unknown) =>
        fetch(`http://127.0.0.1:${address.port}/api${path(personas.employee)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actor': actorId,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify(body),
        });
      const status = async () =>
        (
          await db.read<{ employment_status: string }>(
            'SELECT employment_status FROM employees WHERE id=?',
            [personas.employee],
          )
        )[0].employment_status;
      assert.equal(
        (await post(personas.manager, { onDuty: false, expectedStatus: 'active' })).status,
        403,
      );
      const off = await post(personas.hr, { onDuty: false, expectedStatus: 'active' });
      assert.equal(off.status, 409, await off.clone().text());
      assert.equal((await off.json()).error.code, 'SEPARATION_REQUIRED');
      assert.equal(await status(), 'active');
      assert.equal(
        (await post(personas.hr, { onDuty: false, expectedStatus: 'active' })).status,
        409,
      );
      const on = await post(personas.hr, { onDuty: true, expectedStatus: 'active' });
      assert.equal(on.status, 409, await on.clone().text());
      assert.equal((await on.json()).error.code, 'STATUS_UNCHANGED');
      assert.equal(await status(), 'active');
      const events = await db.read(
        "SELECT id FROM administration_events WHERE resource_id=? AND action='employee_work_status_changed'",
        [personas.employee],
      );
      assert.equal(events.length, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);
