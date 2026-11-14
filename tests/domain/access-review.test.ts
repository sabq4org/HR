import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generate } from 'otplib';
import { createApp } from '../../server/app.js';
import { createDatabase, todayInRiyadh } from '../../server/database.js';
import { bootstrapAccounts } from '../../server/bootstrap-accounts.js';

test('resetting another employee account requires fresh MFA, not only an existing HR session', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const initial = await bootstrapAccounts(db, [
    {
      name: 'HR Review',
      employeeNumber: 'REVIEW-HR',
      email: 'hr-review@example.test',
      title: 'HR',
      department: 'Test',
      location: 'Riyadh',
      joinDate: todayInRiyadh(),
      role: 'hr',
    },
    {
      name: 'Approver Review',
      employeeNumber: 'REVIEW-APP',
      email: 'approver-review@example.test',
      title: 'Approver',
      department: 'Test',
      location: 'Riyadh',
      joinDate: todayInRiyadh(),
      role: 'approver',
    },
  ]);
  await db.execute(
    `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,employment_status)
     VALUES('review-target','REVIEW-EMP','Employee Review','E R','Employee','Test','employee-review@example.test','Riyadh',NULL,?,'employee','#D8E8F3','active')`,
    [todayInRiyadh()],
  );
  const server = createServer(createApp(db, { authMode: 'accounts' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  async function call(path: string, cookie = '', body?: unknown) {
    const response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: response.status === 204 ? {} : await response.json() };
  }
  async function activate(loginName: string, token: string) {
    const setup = await call('/auth/activation/setup', '', { token });
    assert.equal(setup.response.status, 200);
    const completed = await call('/auth/activation/complete', '', {
      token,
      password: 'Synthetic-Review-Password-2026!',
      otp: await generate({ secret: setup.payload.secret }),
    });
    assert.equal(completed.response.status, 200);
    const login = await call('/auth/login', '', {
      loginName,
      password: 'Synthetic-Review-Password-2026!',
      otp: completed.payload.recoveryCodes[0],
    });
    assert.equal(login.response.status, 200);
    return login.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  try {
    const hrCookie = await activate(initial[0].loginName, initial[0].activationToken);
    assert.ok(hrCookie);
    const provisioned = await call('/accounts/review-target/provision', hrCookie, {
      loginName: 'employee-review@example.test',
    });
    assert.equal(provisioned.response.status, 201);
    const token = new URLSearchParams(provisioned.payload.activationUrl.split('#')[1]).get('token');
    assert.ok(token);
    const targetCookie = await activate('employee-review@example.test', token!);
    assert.ok(targetCookie);

    const reset = await call('/accounts/review-target/reset', hrCookie, {});
    assert.notEqual(
      reset.response.status,
      200,
      'a pre-existing HR session must not satisfy fresh MFA',
    );
    const target = (
      await db.read<{ enabled: number | boolean }>(
        'SELECT enabled FROM employee_accounts WHERE employee_id=?',
        ['review-target'],
      )
    )[0];
    assert.ok(
      target.enabled === true || target.enabled === 1,
      'failed step-up must leave the target account unchanged',
    );
    const session = await call('/auth/session', targetCookie);
    assert.equal((session.payload.me as { id: string } | null)?.id, 'review-target');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
  }
});
