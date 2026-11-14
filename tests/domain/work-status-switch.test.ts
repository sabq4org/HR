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
  async function call(role: Persona, path: string, body: unknown, key: string = randomUUID()) {
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
      method: 'POST',
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

test('HR switches an employee off and back on with history and audit', async () => {
  const h = await harness();
  try {
    const before = await h.row(personas.employee);
    assert.equal(before.employment_status, 'active');
    const off = await h.call('hr', path(personas.employee), {
      onDuty: false,
      expectedStatus: 'active',
    });
    assert.equal(off.status, 200, await off.clone().text());
    assert.deepEqual((await off.json()).employee, { id: personas.employee, status: 'terminated' });
    const afterOff = await h.row(personas.employee);
    assert.equal(afterOff.employment_status, 'terminated');
    assert.equal(afterOff.record_version, before.record_version + 1);
    // The employment period stays open: the switch records no separation date.
    const periods = await h.db.read<{ end_date: string | null }>(
      'SELECT end_date FROM employment_periods WHERE employee_id=?',
      [personas.employee],
    );
    assert.ok(periods.every((period) => period.end_date === null));

    const on = await h.call('hr', path(personas.employee), {
      onDuty: true,
      expectedStatus: 'terminated',
    });
    assert.equal(on.status, 200, await on.clone().text());
    assert.equal((await h.row(personas.employee)).employment_status, 'active');

    const events = await h.events(personas.employee);
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.actor_id === personas.hr));
    assert.deepEqual(JSON.parse(events[0].details_json), {
      from: 'active',
      to: 'terminated',
      source: 'team-directory',
    });
    const history = await h.db.read<{ field_key: string }>(
      "SELECT field_key FROM employee_profile_history WHERE employee_id=? AND field_key='employmentStatus'",
      [personas.employee],
    );
    assert.equal(history.length, 2);
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
    assert.equal(first.status, 200);
    const version = (await h.row(personas.employee)).record_version;
    const replay = await h.call('hr', path(personas.employee), body, key);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).employee.status, 'terminated');
    assert.equal((await h.row(personas.employee)).record_version, version);
    assert.equal((await h.events(personas.employee)).length, 1);
    const reused = await h.call(
      'hr',
      path(personas.employee),
      { onDuty: true, expectedStatus: 'terminated' },
      key,
    );
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).error.code, 'IDEMPOTENCY_CONFLICT');
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
      assert.equal(off.status, 200, await off.clone().text());
      assert.equal(await status(), 'terminated');
      assert.equal(
        (await post(personas.hr, { onDuty: false, expectedStatus: 'active' })).status,
        409,
      );
      const on = await post(personas.hr, { onDuty: true, expectedStatus: 'terminated' });
      assert.equal(on.status, 200, await on.clone().text());
      assert.equal(await status(), 'active');
      const events = await db.read(
        "SELECT id FROM administration_events WHERE resource_id=? AND action='employee_work_status_changed'",
        [personas.employee],
      );
      assert.equal(events.length, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);
