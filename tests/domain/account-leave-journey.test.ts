import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { createDatabase, todayInRiyadh } from '../../server/database.js';
import { createApp } from '../../server/app.js';
import { bootstrapAccounts } from '../../server/bootstrap-accounts.js';

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

test('real account API journey: random identities, independent roles/policy/balance approvals, annual leave and replacement', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const today = todayInRiyadh();
  const initial = await bootstrapAccounts(db, [
    {
      name: 'مسؤول اصطناعي',
      employeeNumber: 'J-HR',
      email: 'hr@example.test',
      title: 'HR',
      department: 'اختبار',
      location: 'الرياض',
      joinDate: today,
      role: 'hr',
    },
    {
      name: 'معتمد اصطناعي',
      employeeNumber: 'J-APP',
      email: 'approver@example.test',
      title: 'معتمد',
      department: 'اختبار',
      location: 'الرياض',
      joinDate: today,
      role: 'approver',
    },
  ]);
  const server = createServer(createApp(db, { authMode: 'accounts' }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  async function call(path: string, cookie = '', body?: unknown, key = randomUUID()) {
    const response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = response.status === 204 ? {} : await response.json();
    return {
      status: response.status,
      body: payload,
      cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  }
  function success(reply: { status: number; body: any }, expected = 200) {
    assert.equal(
      reply.status,
      expected,
      reply.body?.error ? JSON.stringify(reply.body.error) : 'Unexpected API status',
    );
    return reply.body;
  }
  const secrets = new Map<string, string>();
  async function activate(loginName: string, token: string) {
    const setup = success(await call('/auth/activation/setup', '', { token }));
    const password = 'Synthetic-Account-Password-2026!';
    secrets.set(loginName, setup.secret);
    const activated = success(
      await call('/auth/activation/complete', '', {
        token,
        password,
        otp: await generate({ secret: setup.secret, epoch: Date.now() / 1000 - 30 }),
      }),
    );
    const logged = await call('/auth/login', '', {
      loginName,
      password,
      otp: activated.recoveryCodes[0],
    });
    success(logged);
    assert.ok(logged.cookie);
    return logged.cookie;
  }
  try {
    const hr = await activate(initial[0].loginName, initial[0].activationToken);
    const approver = await activate(initial[1].loginName, initial[1].activationToken);
    const bootstrap = success(await call('/bootstrap', hr));
    assert.equal(bootstrap.policyConfigured, false);
    assert.equal(bootstrap.balance.available, 0);
    assert.deepEqual(bootstrap.personas, []);
    assert.equal(
      (await call('/demo/session', '', { employeeId: initial[0].employeeId })).status,
      404,
    );
    const createEmployee = async (
      name: string,
      number: string,
      email: string,
      managerId?: string,
    ) =>
      success(
        await call('/admin/employees', hr, {
          values: {
            name,
            employeeNumber: number,
            email,
            title: 'موظف اختبار',
            department: 'اختبار',
            location: 'الرياض',
            joinDate: today,
            ...(managerId ? { managerId } : {}),
          },
        }),
        201,
      ).file.employee.id as string;
    const managerId = await createEmployee('مدير اصطناعي', 'J-MAN', 'manager@example.test');
    const managerInvitation = success(
      await call(`/accounts/${managerId}/provision`, hr, { loginName: 'manager@example.test' }),
      201,
    );
    success(await call(`/accounts/${managerId}/role-change`, hr, { role: 'manager' }), 201);
    const roleChanges = success(await call('/accounts/role-changes', approver)).changes;
    const roleChange = roleChanges.find((change: any) => change.employeeId === managerId);
    assert.ok(roleChange);
    success(
      await call(`/accounts/role-changes/${roleChange.id}/decision`, approver, {
        decision: 'approve',
        otp: await generate({ secret: secrets.get('approver@example.test')! }),
      }),
      204,
    );
    const manager = await activate(
      'manager@example.test',
      new URLSearchParams(managerInvitation.activationUrl.split('#')[1]).get('token')!,
    );
    const employeeId = await createEmployee(
      'موظف اصطناعي',
      'J-EMP',
      'employee@example.test',
      managerId,
    );
    const employeeInvitation = success(
      await call(`/accounts/${employeeId}/provision`, hr, { loginName: 'employee@example.test' }),
      201,
    );
    const employee = await activate(
      'employee@example.test',
      new URLSearchParams(employeeInvitation.activationUrl.split('#')[1]).get('token')!,
    );
    assert.equal((await call(`/admin/employees/${initial[0].employeeId}`, employee)).status, 403);
    assert.equal((await call('/operations/status', employee)).status, 403);
    const policy = success(
      await call('/leave-policies', hr, {
        version: 'synthetic-journey-1',
        effectiveFrom: today,
        effectiveTo: addDays(today, 90),
        allocatedDays: 20,
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        holidayDates: [],
        source: 'مصدر اصطناعي للاختبار فقط',
        sourceReference: 'test-reference',
      }),
      201,
    ).policy;
    assert.equal(
      (await call(`/leave-policies/${policy.id}/approve`, hr, { approvalReference: 'self' }))
        .status,
      403,
    );
    success(
      await call(`/leave-policies/${policy.id}/approve`, approver, {
        approvalReference: 'synthetic-reviewed',
      }),
    );
    success(
      await call(`/leave-policies/${policy.id}/assign`, hr, {
        employeeId,
        effectiveFrom: today,
        effectiveTo: addDays(today, 90),
        openingBalance: 20,
        approvalReference: 'synthetic-opening-review',
      }),
      201,
    );
    assert.equal(
      success(await call('/bootstrap', employee)).balance.available,
      0,
      'assignment proposal must not grant entitlement',
    );
    const assignment = success(await call('/leave-policy-assignments', approver)).assignments.find(
      (item: any) => item.employee_id === employeeId,
    );
    assert.ok(assignment);
    const assignmentKey = randomUUID();
    success(
      await call(
        `/leave-policy-assignments/${assignment.id}/approve`,
        approver,
        { approvalReference: 'synthetic-opening-approved' },
        assignmentKey,
      ),
    );
    success(
      await call(
        `/leave-policy-assignments/${assignment.id}/approve`,
        approver,
        { approvalReference: 'synthetic-opening-approved' },
        assignmentKey,
      ),
    );
    assert.equal(success(await call('/bootstrap', employee)).balance.available, 20);
    const start = addDays(today, 7);
    const leave = success(
      await call('/leaves', employee, {
        startDate: start,
        endDate: addDays(start, 1),
        note: 'طلب اصطناعي',
      }),
      201,
    ).leave;
    const reviewed = success(
      await call(`/leaves/${leave.id}/decision`, manager, {
        decision: 'approve',
        version: leave.version,
      }),
    ).leave;
    const approved = success(
      await call(`/leaves/${leave.id}/decision`, hr, {
        decision: 'approve',
        version: reviewed.version,
      }),
    ).leave;
    const changed = success(
      await call(`/leaves/${leave.id}/changes`, employee, {
        kind: 'extend',
        version: approved.version,
        startDate: start,
        endDate: addDays(start, 3),
        reason: 'تمديد اصطناعي',
      }),
      201,
    ).change;
    assert.equal(success(await call('/bootstrap', employee)).balance.reserved, 2);
    const changeReviewed = success(
      await call(`/leave-changes/${changed.id}/decision`, manager, {
        decision: 'approve',
        version: changed.version,
      }),
    ).change;
    const finalKey = randomUUID();
    success(
      await call(
        `/leave-changes/${changed.id}/decision`,
        hr,
        { decision: 'approve', version: changeReviewed.version },
        finalKey,
      ),
    );
    success(
      await call(
        `/leave-changes/${changed.id}/decision`,
        hr,
        { decision: 'approve', version: changeReviewed.version },
        finalKey,
      ),
    );
    const final = success(await call('/bootstrap', employee));
    assert.equal(final.balance.reserved, 0);
    assert.equal(final.balance.used, 4);
    assert.equal(final.balance.available, 16);
    assert.equal(
      final.leaves.filter((item: any) => item.current !== false && item.status === 'approved')
        .length,
      1,
    );
    const original = (
      await db.read<{ end_date: string; days: number }>(
        'SELECT end_date,days FROM leave_requests WHERE id=?',
        [leave.id],
      )
    )[0];
    assert.equal(original.end_date, addDays(start, 1));
    assert.equal(original.days, 2);
    assert.equal((await call('/admin/payroll', hr)).status, 409);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
  }
});
