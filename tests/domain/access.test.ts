import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { generate, verify } from 'otplib';
import { createApp } from '../../server/app.js';
import { resetEmployeeAccountForOperator } from '../../server/access/index.js';
import { bootstrapAccounts } from '../../server/bootstrap-accounts.js';
import {
  createDatabase,
  createPostgresDatabase,
  todayInRiyadh,
  type Db,
} from '../../server/database.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

test('otplib RFC 6238 vector remains interoperable with authenticator defaults', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // Base32 for RFC secret 12345678901234567890.
  const token = await generate({ secret, epoch: 59, digits: 8 });
  assert.equal(token, '94287082');
  const verified = await verify({ secret, token, epoch: 59, digits: 8 });
  assert.equal(verified.valid, true);
});

type TestDb = { name: string; db: Db };
async function databases(): Promise<TestDb[]> {
  const values: TestDb[] = [
    { name: 'SQLite', db: await createDatabase(':memory:', { seed: false }) },
  ];
  if (pgUrl) {
    values.push({
      name: 'PostgreSQL',
      db: await createPostgresDatabase(pgUrl, `hr_preview_${randomBytes(16).toString('hex')}`, {
        seed: false,
      }),
    });
  }
  return values;
}

async function makeHarness(db: Db) {
  const today = todayInRiyadh();
  const invitations = await bootstrapAccounts(db, [
    {
      name: 'مسؤول اختبار',
      employeeNumber: 'ACCESS-HR',
      email: 'access-hr@example.test',
      title: 'HR',
      department: 'اختبار',
      location: 'الرياض',
      joinDate: today,
      role: 'hr',
    },
    {
      name: 'معتمد اختبار',
      employeeNumber: 'ACCESS-APPROVER',
      email: 'access-approver@example.test',
      title: 'معتمد',
      department: 'اختبار',
      location: 'الرياض',
      joinDate: today,
      role: 'approver',
    },
  ]);
  const server = createServer(createApp(db, { authMode: 'accounts' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  async function call(
    path: string,
    options: { cookie?: string; body?: unknown; method?: string } = {},
  ) {
    const response = await fetch(`${origin}/api${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        origin,
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = response.status === 204 ? null : await response.json();
    return {
      status: response.status,
      body,
      cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  }
  async function activate(invitation: (typeof invitations)[number]) {
    const setup = await call('/auth/activation/setup', {
      body: { token: invitation.activationToken },
    });
    assert.equal(setup.status, 200);
    const password = 'Synthetic-Access-Password-2026!';
    const activationOtp = await generate({
      secret: setup.body.secret,
      epoch: Math.floor(Date.now() / 30_000) * 30 - 1,
    });
    const activated = await call('/auth/activation/complete', {
      body: { token: invitation.activationToken, password, otp: activationOtp },
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    return {
      ...invitation,
      password,
      secret: setup.body.secret as string,
      activationOtp,
      recoveryCodes: activated.body.recoveryCodes as string[],
    };
  }
  return { server, call, activate, invitations };
}

for (const dialect of ['SQLite', 'PostgreSQL']) {
  test(
    `${dialect} durable sessions, MFA replay protection, recovery use, rate limits and last-approver lockout`,
    { skip: dialect === 'PostgreSQL' && !pgUrl },
    async () => {
      const db =
        dialect === 'SQLite'
          ? await createDatabase(':memory:', { seed: false })
          : await createPostgresDatabase(pgUrl!, `hr_preview_${randomBytes(16).toString('hex')}`, {
              seed: false,
            });
      const harness = await makeHarness(db);
      try {
        const hr = await harness.activate(harness.invitations[0]);
        const approver = await harness.activate(harness.invitations[1]);

        const replayedTotp = await harness.call('/auth/login', {
          body: { loginName: hr.loginName, password: hr.password, otp: hr.activationOtp },
        });
        assert.equal(replayedTotp.status, 401, 'the TOTP used during enrollment cannot be reused');

        const login = await harness.call('/auth/login', {
          body: { loginName: hr.loginName, password: hr.password, otp: hr.recoveryCodes[0] },
        });
        assert.equal(login.status, 200);
        assert.ok(login.cookie);
        const rawSessionToken = login.cookie.split('=').slice(1).join('=');
        const stored = (
          await db.read<{ token_hash: string; employee_id: string }>(
            'SELECT token_hash,employee_id FROM account_sessions WHERE employee_id=?',
            [hr.employeeId],
          )
        )[0];
        assert.equal(stored.token_hash, createHash('sha256').update(rawSessionToken).digest('hex'));
        assert.ok(!stored.token_hash.includes(rawSessionToken));

        const session = await harness.call('/auth/session', { cookie: login.cookie });
        assert.equal(session.body.me.role, 'hr');
        await db.execute("UPDATE employees SET access_role='finance' WHERE id=?", [hr.employeeId]);
        const refreshedSession = await harness.call('/auth/session', { cookie: login.cookie });
        assert.equal(
          refreshedSession.body.me.role,
          'finance',
          'role is resolved from the current employee record',
        );
        await db.execute("UPDATE employees SET access_role='hr' WHERE id=?", [hr.employeeId]);

        const reusedRecovery = await harness.call('/auth/login', {
          body: { loginName: hr.loginName, password: hr.password, otp: hr.recoveryCodes[0] },
        });
        assert.equal(reusedRecovery.status, 401, 'a recovery code is single-use');

        const genericUnknown = await harness.call('/auth/login', {
          body: { loginName: 'nobody@example.test', password: 'Wrong-Pass-2026!', otp: '000000' },
        });
        const genericKnown = await harness.call('/auth/login', {
          body: { loginName: hr.loginName, password: 'Wrong-Pass-2026!', otp: '000000' },
        });
        assert.deepEqual(genericUnknown.body.error, genericKnown.body.error);
        for (let i = 0; i < 10; i += 1) {
          const failed = await harness.call('/auth/login', {
            body: {
              loginName: 'limited@example.test',
              password: 'Wrong-Pass-2026!',
              otp: '000000',
            },
          });
          assert.equal(failed.status, 401);
          assert.deepEqual(failed.body.error, genericUnknown.body.error);
        }
        const blocked = await harness.call('/auth/login', {
          body: { loginName: 'limited@example.test', password: 'Wrong-Pass-2026!', otp: '000000' },
        });
        assert.equal(blocked.status, 401);
        assert.deepEqual(blocked.body.error, genericUnknown.body.error);
        const limits = await db.read<{ attempts: number; blocked_until: string | null }>(
          'SELECT attempts,blocked_until FROM account_login_limits WHERE blocked_until IS NOT NULL',
        );
        assert.ok(limits.some((row) => Number(row.attempts) >= 10 && row.blocked_until));

        const disableLastApprover = () =>
          harness.call(`/accounts/${approver.employeeId}/disable`, {
            cookie: login.cookie,
            body: {},
          });
        const concurrent = await Promise.all([disableLastApprover(), disableLastApprover()]);
        assert.deepEqual(
          concurrent.map((result) => result.status),
          [409, 409],
        );
        const approverAccount = (
          await db.read<{ enabled: boolean | number }>(
            'SELECT enabled FROM employee_accounts WHERE employee_id=?',
            [approver.employeeId],
          )
        )[0];
        assert.equal(approverAccount.enabled === true || approverAccount.enabled === 1, true);

        const auditRows = await db.read<{ action: string }>(
          "SELECT action FROM account_audit WHERE employee_id=? AND action LIKE 'account.login%'",
          [hr.employeeId],
        );
        assert.ok(auditRows.some((row) => row.action === 'account.login.recovery'));

        const operatorReset = await db.transaction((tx) =>
          resetEmployeeAccountForOperator(tx, {
            employeeId: hr.employeeId,
            reason: 'Recovery test with approved local operator procedure',
          }),
        );
        assert.ok(operatorReset.activationToken.length >= 40);
        assert.equal((await harness.call('/auth/session', { cookie: login.cookie })).body.me, null);
        const operatorAudit = (
          await db.read<{ details_json: string | Record<string, string> }>(
            "SELECT details_json FROM account_audit WHERE employee_id=? AND action='account.operator-recovery'",
            [hr.employeeId],
          )
        )[0];
        const details =
          typeof operatorAudit.details_json === 'string'
            ? JSON.parse(operatorAudit.details_json)
            : operatorAudit.details_json;
        assert.equal(details.reason, 'Recovery test with approved local operator procedure');
      } finally {
        await new Promise<void>((resolve, reject) =>
          harness.server.close((error) => (error ? reject(error) : resolve())),
        );
        await db.close();
      }
    },
  );
}
