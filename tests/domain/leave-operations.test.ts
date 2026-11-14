import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase, todayInRiyadh } from '../../server/database.js';
import { currentPolicy } from '../../server/leave/routes.js';

let database: Awaited<ReturnType<typeof createDatabase>>;
let server: Server;
let base = '';
beforeEach(async () => {
  if (process.env.HR_ACCEPTANCE_POSTGRES === 'true' && existsSync('.env.pg-test'))
    process.loadEnvFile('.env.pg-test');
  database =
    process.env.HR_ACCEPTANCE_POSTGRES === 'true'
      ? await createPostgresDatabase(
          process.env.HR_TEST_DATABASE_URL ?? '',
          `hr_preview_${randomUUID().replaceAll('-', '')}`,
        )
      : await createDatabase();
  server = createServer(createApp(database));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await database.close();
});
type Session = { cookie: string; origin: string };
async function login(employeeId: string): Promise<Session> {
  const response = await fetch(`${base}/api/demo/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ employeeId }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { cookie, origin: base };
}
async function call(path: string, session: Session, body?: unknown, key = 'leave-operation-key') {
  return fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: session.cookie,
      origin: base,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function addDays(date: string, count: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
function nextSunday(offset = 70) {
  const d = new Date(`${todayInRiyadh()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) + offset);
  return d.toISOString().slice(0, 10);
}
async function createLeave(employee: Session, start: string, end: string, key: string) {
  const response = await call(
    '/leaves',
    employee,
    { startDate: start, endDate: end, note: 'سبب تغطية اصطناعي' },
    key,
  );
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return (JSON.parse(body) as any).leave;
}
async function approveOriginal(leave: any, manager: Session, hr: Session) {
  const managed = await call(
    `/leaves/${leave.id}/decision`,
    manager,
    { decision: 'approve', version: leave.version },
    `manager-${leave.id}`,
  );
  const managedBody = await managed.text();
  assert.equal(managed.status, 200, managedBody);
  const current = (JSON.parse(managedBody) as any).leave;
  const approved = await call(
    `/leaves/${leave.id}/decision`,
    hr,
    { decision: 'approve', version: current.version },
    `hr-${leave.id}`,
  );
  const approvedBody = await approved.text();
  assert.equal(approved.status, 200, approvedBody);
  return (JSON.parse(approvedBody) as any).leave;
}

test('approved extension keeps the original immutable, reserves once, and writes a linked replacement after independent approval', async () => {
  const employee = await login('emp-sara');
  const manager = await login('emp-omar');
  const hr = await login('emp-noura');
  const before = ((await (await call('/bootstrap', employee)).json()) as any).balance;
  const start = nextSunday();
  const original = await createLeave(employee, start, addDays(start, 1), 'leave-extension-create');
  const approved = await approveOriginal(original, manager, hr);
  const payload = {
    kind: 'extend',
    version: approved.version,
    startDate: start,
    endDate: addDays(start, 3),
    reason: 'تمديد تغطية تحريرية اصطناعي',
  };
  const submitted = await call(
    `/leaves/${approved.id}/changes`,
    employee,
    payload,
    'change-extension-submit',
  );
  assert.equal(submitted.status, 201, await submitted.clone().text());
  const change = ((await submitted.json()) as any).change;
  assert.equal(change.reserveDays, 2);
  const pendingBalance = ((await (await call('/bootstrap', employee)).json()) as any).balance;
  assert.equal(pendingBalance.reserved, before.reserved + 2);
  const pendingOverlap = await call(
    '/leaves',
    employee,
    {
      startDate: addDays(start, 2),
      endDate: addDays(start, 2),
      note: 'لا يجوز تداخل طلب جديد مع تمديد معلّق',
    },
    'base-overlap-pending-change',
  );
  assert.equal(pendingOverlap.status, 409);
  assert.equal(((await pendingOverlap.json()) as any).error.code, 'LEAVE_OVERLAP');
  const first = await call(
    `/leave-changes/${change.id}/decision`,
    manager,
    { decision: 'approve', version: change.version },
    'extension-manager',
  );
  assert.equal(first.status, 200, await first.clone().text());
  const managerResult = ((await first.json()) as any).change;
  const replay = await call(
    `/leave-changes/${change.id}/decision`,
    manager,
    { decision: 'approve', version: change.version },
    'extension-manager',
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(((await replay.json()) as any).change, managerResult);
  const finalized = await call(
    `/leave-changes/${change.id}/decision`,
    hr,
    { decision: 'approve', version: managerResult.version },
    'extension-hr',
  );
  assert.equal(finalized.status, 200, await finalized.clone().text());
  const result = ((await finalized.json()) as any).change;
  assert.equal(result.status, 'approved');
  assert.ok(result.replacementLeaveId);
  const bootstrap = (await (await call('/bootstrap', employee)).json()) as any;
  const old = bootstrap.leaves.find((l: any) => l.id === approved.id);
  const replacement = bootstrap.leaves.find((l: any) => l.id === result.replacementLeaveId);
  assert.equal(old.status, 'approved');
  assert.equal(old.current, false);
  assert.equal(old.days, 2);
  assert.equal(replacement.parentLeaveId, approved.id);
  assert.equal(replacement.days, 4);
  assert.equal(replacement.current, true);
  assert.equal(bootstrap.balance.used, before.used + 4);
  assert.equal(bootstrap.balance.reserved, before.reserved);
  assert.equal(old.changeHistory[0].original.days, 2);
  assert.equal(old.changeHistory[0].proposed.days, 4);
});

test('rejected or cancelled change releases its added reservation once; duplicate approval does not consume twice', async () => {
  const employee = await login('emp-sara');
  const manager = await login('emp-omar');
  const hr = await login('emp-noura');
  const before = ((await (await call('/bootstrap', employee)).json()) as any).balance;
  const start = nextSunday(84);
  const original = await createLeave(
    employee,
    start,
    addDays(start, 1),
    'leave-change-release-create',
  );
  const approved = await approveOriginal(original, manager, hr);
  const submitted = await call(
    `/leaves/${approved.id}/changes`,
    employee,
    {
      kind: 'extend',
      version: approved.version,
      startDate: start,
      endDate: addDays(start, 3),
      reason: 'تغيير اصطناعي للرفض',
    },
    'change-reject-submit',
  );
  assert.equal(submitted.status, 201, await submitted.clone().text());
  const change = ((await submitted.json()) as any).change;
  const managerDecision = await call(
    `/leave-changes/${change.id}/decision`,
    manager,
    { decision: 'approve', version: change.version },
    'change-reject-manager',
  );
  const c = ((await managerDecision.json()) as any).change;
  const rejected = await call(
    `/leave-changes/${change.id}/decision`,
    hr,
    { decision: 'reject', version: c.version, reason: 'لم يعتمد اختبار المراجعة' },
    'change-reject-hr',
  );
  assert.equal(rejected.status, 200);
  const after = (await (await call('/bootstrap', employee)).json()) as any;
  assert.equal(after.balance.reserved, before.reserved);
  assert.equal(after.balance.used, before.used + 2);
  const retry = await call(
    `/leave-changes/${change.id}/decision`,
    hr,
    { decision: 'reject', version: c.version, reason: 'لم يعتمد اختبار المراجعة' },
    'change-reject-hr',
  );
  assert.equal(retry.status, 200);
  const retryBalance = ((await (await call('/bootstrap', employee)).json()) as any).balance;
  assert.deepEqual(retryBalance, after.balance);
});

test('overlap conflict during final change approval rolls back replacement, history state, and every ledger movement', async () => {
  const employee = await login('emp-sara');
  const manager = await login('emp-omar');
  const hr = await login('emp-noura');
  const start = nextSunday(105);
  const original = await createLeave(employee, start, addDays(start, 1), 'leave-rollback-create');
  const approved = await approveOriginal(original, manager, hr);
  const submitted = await call(
    `/leaves/${approved.id}/changes`,
    employee,
    {
      kind: 'extend',
      version: approved.version,
      startDate: start,
      endDate: addDays(start, 3),
      reason: 'تمديد للاختبار العكسي',
    },
    'rollback-change-submit',
  );
  assert.equal(submitted.status, 201);
  const change = ((await submitted.json()) as any).change;
  const managerResult = await call(
    `/leave-changes/${change.id}/decision`,
    manager,
    { decision: 'approve', version: change.version },
    'rollback-change-manager',
  );
  const c = ((await managerResult.json()) as any).change;
  await database.execute(
    `INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,note,status,created_at,policy_version_id,work_schedule_id)
    VALUES(?,?,?,?,?,'تعارض اصطناعي','approved',?,?,?)`,
    [
      'leave-rollback-conflict',
      'emp-sara',
      addDays(start, 2),
      addDays(start, 2),
      1,
      new Date().toISOString(),
      approved.policyVersionId ?? 'policy-demo-annual-v1',
      'schedule-demo-emp-sara-v1',
    ],
  );
  const before = ((await (await call('/bootstrap', employee)).json()) as any).balance;
  const final = await call(
    `/leave-changes/${change.id}/decision`,
    hr,
    { decision: 'approve', version: c.version },
    'rollback-change-hr',
  );
  assert.equal(final.status, 409);
  assert.equal(((await final.json()) as any).error.code, 'LEAVE_OVERLAP');
  const after = (await (await call('/bootstrap', employee)).json()) as any;
  assert.deepEqual(after.balance, before);
  const originalAfter = after.leaves.find((l: any) => l.id === approved.id);
  assert.equal(originalAfter.current, true);
  const persisted = (
    await database.read<any>(
      'SELECT status,replacement_leave_id FROM leave_change_requests WHERE id=?',
      [change.id],
    )
  )[0];
  assert.equal(persisted.status, 'pending_hr');
  assert.equal(persisted.replacement_leave_id, null);
  const entries = await database.read<any>(
    'SELECT operation_ref FROM leave_ledger WHERE operation_ref LIKE ?',
    [`leave-change:${change.id}:%`],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation_ref, `leave-change:${change.id}:reserve`);
});

test('accounts-mode policy lookup fails closed when no approved assignment covers the requested date', async () => {
  await assert.rejects(
    currentPolicy(database, 'emp-sara', nextSunday(100), 'accounts'),
    (error: any) => error.code === 'LEAVE_POLICY_REQUIRED' && error.status === 409,
  );
});

test('decision retries recheck current team and role, and changed periods remain bounded', async () => {
  const employee = await login('emp-sara');
  const manager = await login('emp-omar');
  const hr = await login('emp-noura');
  const start = nextSunday(140);
  const original = await createLeave(employee, start, addDays(start, 1), 'review-boundary-create');
  const approved = await approveOriginal(original, manager, hr);
  const excessive = await call(
    `/leaves/${approved.id}/changes`,
    employee,
    {
      kind: 'extend',
      version: approved.version,
      startDate: start,
      endDate: addDays(start, 367),
      reason: 'فترة مفرطة للاختبار',
    },
    'excessive-span',
  );
  assert.equal(excessive.status, 400);
  const submitted = await call(
    `/leaves/${approved.id}/changes`,
    employee,
    {
      kind: 'extend',
      version: approved.version,
      startDate: start,
      endDate: addDays(start, 3),
      reason: 'اختبار صلاحية إعادة المحاولة',
    },
    'review-boundary-change',
  );
  assert.equal(submitted.status, 201, await submitted.clone().text());
  const change = ((await submitted.json()) as any).change;
  const body = { decision: 'approve', version: change.version };
  assert.equal(
    (await call(`/leave-changes/${change.id}/decision`, manager, body, 'review-boundary-approve'))
      .status,
    200,
  );
  await database.execute("UPDATE employees SET manager_id=NULL WHERE id='emp-sara'");
  assert.equal(
    (await call(`/leave-changes/${change.id}/decision`, manager, body, 'review-boundary-approve'))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        `/leaves/${original.id}/decision`,
        manager,
        { decision: 'approve', version: original.version },
        `manager-${original.id}`,
      )
    ).status,
    403,
  );
  await database.execute("UPDATE employees SET access_role='employee' WHERE id='emp-noura'");
  assert.equal(
    (
      await call(
        `/leaves/${original.id}/decision`,
        hr,
        { decision: 'approve', version: 2 },
        `hr-${original.id}`,
      )
    ).status,
    403,
  );
});

test('early return and approved cancellation reverse consumed days once and permit reuse of released dates', async () => {
  const employee = await login('emp-sara');
  const manager = await login('emp-omar');
  const hr = await login('emp-noura');
  const before = ((await (await call('/bootstrap', employee)).json()) as any).balance;
  const start = nextSunday(140);
  const initial = await createLeave(employee, start, addDays(start, 3), 'leave-amend-create');
  const approved = await approveOriginal(initial, manager, hr);
  const early = await call(
    `/leaves/${approved.id}/changes`,
    employee,
    {
      kind: 'early_return',
      version: approved.version,
      startDate: start,
      endDate: addDays(start, 1),
      reason: 'عودة مبكرة اصطناعية',
    },
    'early-submit',
  );
  assert.equal(early.status, 201, await early.clone().text());
  const firstChange = ((await early.json()) as any).change;
  const managerStep = await call(
    `/leave-changes/${firstChange.id}/decision`,
    manager,
    { decision: 'approve', version: firstChange.version },
    'early-manager',
  );
  const managed = ((await managerStep.json()) as any).change;
  const hrStep = await call(
    `/leave-changes/${firstChange.id}/decision`,
    hr,
    { decision: 'approve', version: managed.version },
    'early-hr',
  );
  assert.equal(hrStep.status, 200, await hrStep.clone().text());
  const earlyDone = ((await hrStep.json()) as any).change;
  assert.equal(earlyDone.proposed.days, 2);
  let bootstrap = (await (await call('/bootstrap', employee)).json()) as any;
  assert.equal(bootstrap.balance.used, before.used + 2);
  const replacement = bootstrap.leaves.find((l: any) => l.id === earlyDone.replacementLeaveId);
  assert.equal(replacement.endDate, addDays(start, 1));
  const cancellation = await call(
    `/leaves/${replacement.id}/changes`,
    employee,
    { kind: 'cancel', version: replacement.version, reason: 'إلغاء اصطناعي بعد الاعتماد' },
    'cancel-approved-submit',
  );
  assert.equal(cancellation.status, 201, await cancellation.clone().text());
  const cancelChange = ((await cancellation.json()) as any).change;
  const cancelManager = await call(
    `/leave-changes/${cancelChange.id}/decision`,
    manager,
    { decision: 'approve', version: cancelChange.version },
    'cancel-manager',
  );
  const cancelManaged = ((await cancelManager.json()) as any).change;
  const cancelHr = await call(
    `/leave-changes/${cancelChange.id}/decision`,
    hr,
    { decision: 'approve', version: cancelManaged.version },
    'cancel-hr',
  );
  assert.equal(cancelHr.status, 200, await cancelHr.clone().text());
  const cancelled = ((await cancelHr.json()) as any).change;
  bootstrap = (await (await call('/bootstrap', employee)).json()) as any;
  assert.equal(bootstrap.balance.used, before.used);
  assert.equal(bootstrap.balance.reserved, before.reserved);
  const reused = await call(
    '/leaves',
    employee,
    { startDate: start, endDate: addDays(start, 1), note: 'إعادة استخدام التاريخ بعد الإلغاء' },
    'reuse-released-range',
  );
  assert.equal(reused.status, 201, await reused.clone().text());
  const cancellationReplacement = bootstrap.leaves.find(
    (l: any) => l.id === cancelled.replacementLeaveId,
  );
  assert.equal(cancellationReplacement.status, 'cancelled');
});

test('policy versioning and opening balance assignment require separate approvers and stay within effective dates', async () => {
  const hr = await login('emp-noura');
  const approver = await login('emp-abdullah');
  const today = todayInRiyadh();
  const body = {
    version: `pilot-${Date.now()}`,
    effectiveFrom: today,
    effectiveTo: addDays(today, 120),
    allocatedDays: 11,
    workingDays: [0, 1, 2, 3, 4],
    holidayDates: [addDays(today, 1)],
    source: 'قرار سياسة تجريبي معتمد داخليًا',
    sourceReference: 'REF-LEAVE-PILOT-01',
  };
  const created = await call('/leave-policies', hr, body, 'policy-draft-create');
  assert.equal(created.status, 201, await created.clone().text());
  const draft = ((await created.json()) as any).policy;
  const replay = await call('/leave-policies', hr, body, 'policy-draft-create');
  assert.equal(replay.status, 201);
  assert.equal(((await replay.json()) as any).policy.id, draft.id);
  const selfApproval = await call(
    `/leave-policies/${draft.id}/approve`,
    hr,
    { approvalReference: 'SELF' },
    'policy-self-approve',
  );
  assert.equal(selfApproval.status, 403);
  const approved = await call(
    `/leave-policies/${draft.id}/approve`,
    approver,
    { approvalReference: 'POLICY-APPROVAL-01' },
    'policy-approve',
  );
  assert.equal(approved.status, 200, await approved.clone().text());
  const outOfRange = await call(
    `/leave-policies/${draft.id}/assign`,
    hr,
    {
      employeeId: 'emp-sara',
      effectiveFrom: addDays(today, 119),
      effectiveTo: addDays(today, 121),
      openingBalance: 5,
      approvalReference: 'OPEN-01',
    },
    'assignment-out-of-range',
  );
  assert.equal(outOfRange.status, 409);
  assert.equal(((await outOfRange.json()) as any).error.code, 'ASSIGNMENT_POLICY_RANGE');
  const employeeBefore = await login('emp-sara');
  const balanceBefore = ((await (await call('/bootstrap', employeeBefore)).json()) as any).balance;
  const assignment = await call(
    `/leave-policies/${draft.id}/assign`,
    hr,
    {
      employeeId: 'emp-sara',
      effectiveFrom: today,
      effectiveTo: addDays(today, 90),
      openingBalance: 5,
      approvalReference: 'OPEN-02',
    },
    'assignment-valid',
  );
  assert.equal(assignment.status, 201, await assignment.clone().text());
  const rows = ((await (await call('/leave-policy-assignments', approver)).json()) as any)
    .assignments;
  const pending = rows.find(
    (row: any) =>
      row.employee_id === 'emp-sara' &&
      row.policy_version === body.version &&
      row.approval_status === 'pending',
  );
  assert.ok(pending);
  const selfGrant = await call(
    `/leave-policy-assignments/${pending.id}/approve`,
    await login('emp-sara'),
    { approvalReference: 'SELF-GRANT' },
    'assignment-self-grant',
  );
  assert.equal(selfGrant.status, 403);
  const allocation = await call(
    `/leave-policy-assignments/${pending.id}/approve`,
    approver,
    { approvalReference: 'OPEN-APPROVED-01' },
    'assignment-approve',
  );
  assert.equal(allocation.status, 200, await allocation.clone().text());
  const employee = await login('emp-sara');
  const balanceAfter = ((await (await call('/bootstrap', employee)).json()) as any).balance;
  assert.equal(balanceAfter.allocated, balanceBefore.allocated + 5);
  const policy = await currentPolicy(database, 'emp-sara', today, 'accounts');
  assert.equal(policy.effectiveFrom, today);
  assert.equal(policy.effectiveTo, addDays(today, 90));
  assert.equal(policy.holidayDates[0], addDays(today, 1));
  await assert.rejects(
    currentPolicy(database, 'emp-sara', addDays(today, 91), 'accounts'),
    (error: any) => error.code === 'LEAVE_POLICY_REQUIRED',
  );
  const beneficiaryAssignment = await call(
    `/leave-policies/${draft.id}/assign`,
    hr,
    {
      employeeId: 'emp-abdullah',
      effectiveFrom: today,
      effectiveTo: addDays(today, 10),
      openingBalance: 3,
      approvalReference: 'OPEN-03',
    },
    'assignment-beneficiary',
  );
  assert.equal(beneficiaryAssignment.status, 201);
  const beneficiaryRows = (
    (await (await call('/leave-policy-assignments', approver)).json()) as any
  ).assignments;
  const beneficiary = beneficiaryRows.find(
    (row: any) =>
      row.employee_id === 'emp-abdullah' &&
      row.policy_version === body.version &&
      row.approval_status === 'pending',
  );
  const beneficiarySelf = await call(
    `/leave-policy-assignments/${beneficiary.id}/approve`,
    approver,
    { approvalReference: 'SELF' },
    'assignment-beneficiary-self',
  );
  assert.equal(beneficiarySelf.status, 403);
  const futureAssignment = await call(
    `/leave-policies/${draft.id}/assign`,
    hr,
    {
      employeeId: 'emp-fahad',
      effectiveFrom: addDays(today, 1),
      effectiveTo: addDays(today, 20),
      openingBalance: 4,
      approvalReference: 'OPEN-FUTURE',
    },
    'assignment-future',
  );
  assert.equal(futureAssignment.status, 201);
  const futureRows = ((await (await call('/leave-policy-assignments', approver)).json()) as any)
    .assignments;
  const futureRow = futureRows.find(
    (row: any) => row.employee_id === 'emp-fahad' && row.approval_status === 'pending',
  );
  const earlyApprove = await call(
    `/leave-policy-assignments/${futureRow.id}/approve`,
    approver,
    { approvalReference: 'TOO-EARLY' },
    'assignment-future-approve',
  );
  assert.equal(earlyApprove.status, 409);
  assert.equal(((await earlyApprove.json()) as any).error.code, 'FUTURE_EFFECTIVE_DATE');
  const cancelled = await call(
    `/leave-policy-assignments/${futureRow.id}/decision`,
    hr,
    { decision: 'cancel', reason: 'تم إلغاء إدخال تجريبي' },
    'assignment-future-cancel',
  );
  assert.equal(cancelled.status, 200);
  const rejectAssignment = await call(
    `/leave-policies/${draft.id}/assign`,
    hr,
    {
      employeeId: 'emp-yousef',
      effectiveFrom: today,
      effectiveTo: addDays(today, 10),
      openingBalance: 2,
      approvalReference: 'OPEN-REJECT',
    },
    'assignment-reject',
  );
  assert.equal(rejectAssignment.status, 201);
  const rejectRows = ((await (await call('/leave-policy-assignments', approver)).json()) as any)
    .assignments;
  const rejectedRow = rejectRows.find(
    (row: any) => row.employee_id === 'emp-yousef' && row.approval_status === 'pending',
  );
  const rejectedAssignment = await call(
    `/leave-policy-assignments/${rejectedRow.id}/decision`,
    approver,
    { decision: 'reject', reason: 'رفض اختبار بسبب النطاق' },
    'assignment-reject-decision',
  );
  assert.equal(rejectedAssignment.status, 200);
});
