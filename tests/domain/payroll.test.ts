import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createDatabase } from '../../server/database.js';
import { registerPayroll } from '../../server/payroll/index.js';
import type { Role } from '../../shared/contracts.js';

const identities: Record<string, { id: string; role: Role }> = {
  hr: { id: 'emp-noura', role: 'hr' },
  hr_as_approver: { id: 'emp-noura', role: 'approver' },
  finance: { id: 'emp-reem', role: 'finance' },
  approver: { id: 'emp-abdullah', role: 'approver' },
  employee: { id: 'emp-sara', role: 'employee' },
  manager: { id: 'emp-omar', role: 'manager' },
  auditor: { id: 'emp-hind', role: 'auditor' },
};
async function fixture() {
  const db = await createDatabase();
  const app = express();
  app.use(express.json());
  registerPayroll(app, {
    db,
    requireActor: (req) => {
      const actor = identities[String(req.header('x-test-actor'))];
      if (!actor)
        throw Object.assign(new Error('unauthorized'), { status: 401, code: 'unauthorized' });
      return actor;
    },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  const base = `http://127.0.0.1:${address.port}/api/admin/payroll`;
  async function api<T>(
    as: string,
    path = '',
    method = 'GET',
    body?: unknown,
    key: string = crypto.randomUUID(),
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-test-actor': as,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  return {
    db,
    server,
    api,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await db.close();
    },
  };
}

test('payroll API enforces staged roles, approval independence, employee scope, immutable close and replay', async () => {
  const f = await fixture();
  try {
    const made = await f.api<{ run: any }>(
      'hr',
      '',
      'POST',
      { period: '2026-11', policyId: 'payroll-policy-demo-v1', reason: 'معاينة شهرية' },
      'create-key',
    );
    assert.equal(made.status, 200);
    const draft = made.body.run;
    assert.equal(draft.state, 'draft');
    assert.ok(draft.totals.netMinor > 0);
    assert.ok(
      draft.lines.every(
        (line: any) => !['emp-noura', 'emp-reem', 'emp-abdullah'].includes(line.employeeId),
      ),
    );
    assert.ok(
      draft.lines.some(
        (line: any) =>
          line.employeeId === 'emp-sara' &&
          line.component === 'الراتب الأساسي' &&
          line.amountMinor === 1100000,
      ),
    );
    assert.ok(
      draft.lines.some(
        (line: any) =>
          line.employeeId === 'emp-sara' &&
          line.component === 'بدل السكن' &&
          line.amountMinor === 250000,
      ),
    );
    const replay = await f.api<{ run: any }>(
      'hr',
      '',
      'POST',
      { period: '2026-11', policyId: 'payroll-policy-demo-v1', reason: 'معاينة شهرية' },
      'create-key',
    );
    assert.equal(replay.body.run.id, draft.id);
    assert.equal(
      (
        await f.api(
          'hr_as_approver',
          '',
          'POST',
          { period: '2026-11', policyId: 'payroll-policy-demo-v1', reason: 'معاينة شهرية' },
          'create-key',
        )
      ).status,
      403,
    );
    const storedCommand = (
      await f.db.read<any>('SELECT response_json FROM payroll_commands WHERE command_key=?', [
        'create-key',
      ])
    )[0].response_json;
    assert.ok(!storedCommand.includes('employeeName') && !storedCommand.includes('amountMinor'));
    assert.equal(
      (
        await f.api(
          'hr',
          '',
          'POST',
          { period: '2026-11', policyId: 'payroll-policy-demo-v1', reason: 'مسير أساسي مكرر' },
          'create-duplicate',
        )
      ).status,
      409,
    );
    const conflict = await f.api(
      'hr',
      '',
      'POST',
      { period: '2026-12', policyId: 'payroll-policy-demo-v1', reason: 'مختلف' },
      'create-key',
    );
    assert.equal(conflict.status, 409);
    assert.equal((await f.api('employee', `/${draft.id}`)).status, 404);
    assert.equal((await f.api('manager', `/${draft.id}`)).status, 404);
    const redacted = await f.api<any>('auditor', `/${draft.id}`);
    assert.equal(redacted.status, 200);
    assert.ok(
      redacted.body.run.lines.every(
        (line: any) => line.employeeId === '' && line.employeeName.startsWith('موظف'),
      ),
    );
    assert.equal(
      (await f.api('finance', `/${draft.id}/actions`, 'POST', { version: 1, action: 'submit' }))
        .status,
      403,
    );
    const submitted = await f.api<{ run: any }>(
      `hr`,
      `/${draft.id}/actions`,
      'POST',
      { version: 1, action: 'submit' },
      'submit',
    );
    assert.equal(submitted.body.run.state, 'pending_finance');
    assert.equal(
      (await f.api('hr', `/${draft.id}/actions`, 'POST', { version: 2, action: 'review' })).status,
      403,
    );
    const reviewed = await f.api<{ run: any }>(
      'finance',
      `/${draft.id}/actions`,
      'POST',
      { version: 2, action: 'review' },
      'review',
    );
    assert.equal(reviewed.body.run.state, 'pending_approver');
    assert.equal(
      (await f.api('finance', `/${draft.id}/actions`, 'POST', { version: 3, action: 'approve' }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.api('hr_as_approver', `/${draft.id}/actions`, 'POST', {
          version: 3,
          action: 'approve',
        })
      ).status,
      403,
    );
    const approved = await f.api<{ run: any }>(
      'approver',
      `/${draft.id}/actions`,
      'POST',
      { version: 3, action: 'approve' },
      'approve',
    );
    assert.equal(approved.body.run.state, 'closed');
    const pay = await f.api<{ run: any }>(
      'finance',
      `/${draft.id}/payments`,
      'POST',
      {
        version: 4,
        employeeId: 'emp-sara',
        state: 'paid',
        paidMinor: 1425000,
        reference: 'synthetic-ref',
      },
      'manual-payment',
    );
    assert.equal(pay.status, 200);
    assert.equal(pay.body.run.payments[0].state, 'paid');
    assert.equal(pay.body.run.payments[0].reference, 'synthetic-ref');
    const storedPayment = (
      await f.db.read<any>('SELECT encrypted_reference FROM payroll_payments WHERE run_id=?', [
        draft.id,
      ])
    )[0].encrypted_reference;
    assert.notEqual(storedPayment, 'synthetic-ref');
    assert.ok(storedPayment.startsWith('v1.'));
    assert.equal((await f.api('employee', `/${draft.id}`)).status, 200);
    assert.ok(
      (await f.api<any>('employee', `/${draft.id}`)).body.run.lines.every(
        (line: any) => line.employeeId === 'emp-sara',
      ),
    );
    const managerPayslip = await f.api<any>('manager', `/${draft.id}`);
    assert.equal(managerPayslip.status, 200);
    assert.ok(managerPayslip.body.run.lines.every((line: any) => line.employeeId === 'emp-omar'));
    await assert.rejects(
      f.db.execute('UPDATE payroll_lines SET amount_minor=1 WHERE run_id=?', [draft.id]),
    );
    assert.equal(
      (await f.api('hr', `/${draft.id}/actions`, 'POST', { version: 4, action: 'submit' })).status,
      409,
    );
    const correction = await f.api<any>(
      'hr',
      '',
      'POST',
      {
        period: '2026-11',
        policyId: 'payroll-policy-demo-v1',
        reason: 'تصحيح مرتبط بالمسير المغلق',
        correctionOf: draft.id,
      },
      'create-correction',
    );
    assert.equal(correction.status, 200);
    assert.equal(correction.body.run.correctionOf, draft.id);
    assert.ok(correction.body.run.lines.every((line: any) => line.amountMinor === 0));
    const reduction = { ...correction.body.run.lines[0], kind: 'deduction', amountMinor: 500 };
    const revised = await f.api<any>(
      'hr',
      `/${correction.body.run.id}`,
      'PATCH',
      {
        version: 1,
        lines: [reduction, ...correction.body.run.lines.slice(1)],
        reason: 'تصحيح حسم تجريبي',
      },
      'correction-edit',
    );
    assert.equal(revised.status, 200);
    const correctionSubmit = await f.api<any>(
      'hr',
      `/${correction.body.run.id}/actions`,
      'POST',
      { version: 2, action: 'submit' },
      'correction-submit',
    );
    assert.equal(correctionSubmit.status, 200);
    await f.api<any>(
      'finance',
      `/${correction.body.run.id}/actions`,
      'POST',
      { version: 3, action: 'review' },
      'correction-review',
    );
    const correctionClosed = await f.api<any>(
      'approver',
      `/${correction.body.run.id}/actions`,
      'POST',
      { version: 4, action: 'approve' },
      'correction-approve',
    );
    assert.equal(correctionClosed.body.run.state, 'closed');
    assert.equal(correctionClosed.body.run.totals.netMinor, -500);
  } finally {
    await f.close();
  }
});

test('payroll commands are concurrent-safe and payload amounts are validated in integer halalas', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.api<{ run: any }>(
        'hr',
        '',
        'POST',
        { period: '2026-10', policyId: 'payroll-policy-demo-v1', reason: 'اختبار تزامن' },
        'same-key',
      ),
      f.api<{ run: any }>(
        'hr',
        '',
        'POST',
        { period: '2026-10', policyId: 'payroll-policy-demo-v1', reason: 'اختبار تزامن' },
        'same-key',
      ),
    ]);
    assert.equal(a.body.run.id, b.body.run.id);
    const run = a.body.run;
    const lines = run.lines.map((line: any) => ({ ...line, amountMinor: 1.5 }));
    const invalid = await f.api(
      'hr',
      `/${run.id}`,
      'PATCH',
      { version: 1, lines, reason: 'قيمة عشرية غير مسموحة' },
      'invalid-lines',
    );
    assert.equal(invalid.status, 400);
    const negative = await f.api(
      'hr',
      `/${run.id}`,
      'PATCH',
      {
        version: 1,
        lines: run.lines.map((line: any) => ({ ...line, kind: 'deduction' })),
        reason: 'اختبار صافي سالب',
      },
      'negative-net',
    );
    assert.equal(negative.status, 400);
    const wrong = await f.api(
      'employee',
      `/${run.id}`,
      'PATCH',
      { version: 1, lines: run.lines, reason: 'تعديل غير مصرح' },
      'idor-edit',
    );
    assert.equal(wrong.status, 403);
  } finally {
    await f.close();
  }
});

test('approver cannot close a run that includes their own salary', async () => {
  const f = await fixture();
  try {
    const created = await f.api<any>(
      'hr',
      '',
      'POST',
      {
        period: '2026-07',
        policyId: 'payroll-policy-demo-v1',
        reason: 'اختبار منع اعتماد راتب المعتمد',
      },
      'subject-run',
    );
    const lines = [
      ...created.body.run.lines,
      {
        employeeId: 'emp-abdullah',
        employeeName: 'عبدالله',
        component: 'اختبار راتب المعتمد',
        kind: 'earning',
        amountMinor: 100000,
        source: 'Synthetic fixture',
      },
    ];
    const edited = await f.api<any>(
      'hr',
      `/${created.body.run.id}`,
      'PATCH',
      { version: 1, lines, reason: 'إضافة سطر المعتمد للاختبار' },
      'subject-edit',
    );
    assert.equal(edited.status, 200);
    const submitted = await f.api<any>(
      'hr',
      `/${created.body.run.id}/actions`,
      'POST',
      { version: 2, action: 'submit' },
      'subject-submit',
    );
    const reviewed = await f.api<any>(
      'finance',
      `/${created.body.run.id}/actions`,
      'POST',
      { version: 3, action: 'review' },
      'subject-review',
    );
    assert.equal(reviewed.body.run.state, 'pending_approver');
    const decision = await f.api(
      'approver',
      `/${created.body.run.id}/actions`,
      'POST',
      { version: 4, action: 'approve' },
      'subject-approve',
    );
    assert.equal(decision.status, 403);
    assert.equal(submitted.body.run.state, 'pending_finance');
  } finally {
    await f.close();
  }
});

test('approved reward sources use their reviewed amount and cannot be consumed twice', async () => {
  const f = await fixture();
  try {
    const sourceId = 'reward-source-demo';
    await f.db.execute(
      `INSERT INTO administrative_requests(id,request_number,kind,employee_id,created_by,state,version,values_json,steps_json,step_index,created_at,updated_at)
       VALUES(?,?,'reward','emp-sara','emp-omar','approved',2,?,'[]',0,?,?)`,
      [
        sourceId,
        'REQ-REWARD-TEST',
        JSON.stringify({ amount: 125.5 }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const first = await f.api<{ run: any }>(
      'hr',
      '',
      'POST',
      { period: '2026-09', policyId: 'payroll-policy-demo-v1', reason: 'مصدر معتمد' },
      'source-create-1',
    );
    const line = {
      employeeId: 'emp-sara',
      employeeName: 'سارة',
      component: 'مكافأة معتمدة',
      kind: 'earning',
      amountMinor: 12550,
      source: 'untrusted',
      sourceRequestId: sourceId,
    };
    const updated = await f.api<{ run: any }>(
      'hr',
      `/${first.body.run.id}`,
      'PATCH',
      { version: 1, lines: [...first.body.run.lines, line], reason: 'إضافة مكافأة معتمدة' },
      'source-add',
    );
    assert.equal(updated.status, 200);
    assert.equal(
      updated.body.run.lines.find((x: any) => x.sourceRequestId === sourceId).source,
      `طلب ${sourceId} معتمد؛ قيمة مقترحة`,
    );
    const second = await f.api<{ run: any }>(
      'hr',
      '',
      'POST',
      { period: '2026-08', policyId: 'payroll-policy-demo-v1', reason: 'محاولة تكرار المصدر' },
      'source-create-2',
    );
    const duplicate = await f.api(
      'hr',
      `/${second.body.run.id}`,
      'PATCH',
      { version: 1, lines: [...second.body.run.lines, line], reason: 'إعادة استخدام المكافأة' },
      'source-add-2',
    );
    assert.equal(duplicate.status, 409);
    const wrongAmount = await f.api(
      'hr',
      `/${second.body.run.id}`,
      'PATCH',
      {
        version: 1,
        lines: [...second.body.run.lines, { ...line, amountMinor: 12500 }],
        reason: 'قيمة لا تطابق المصدر',
      },
      'source-wrong-amount',
    );
    assert.equal(wrongAmount.status, 400);
  } finally {
    await f.close();
  }
});

test('employees without complete synthetic salary components are excluded and counted', async () => {
  const f = await fixture();
  try {
    await f.db.execute(
      "UPDATE employee_profile_data SET public_values_json='{}',encrypted_values_json='{}' WHERE employee_id='emp-sara'",
    );
    const result = await f.api<any>(
      'hr',
      '',
      'POST',
      { period: '2026-05', policyId: 'payroll-policy-demo-v1', reason: 'اختبار ملف راتب ناقص' },
      'missing-profile',
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.excludedCount, 1);
    assert.ok(!result.body.run.lines.some((line: any) => line.employeeId === 'emp-sara'));
    const replay = await f.api<any>(
      'hr',
      '',
      'POST',
      { period: '2026-05', policyId: 'payroll-policy-demo-v1', reason: 'اختبار ملف راتب ناقص' },
      'missing-profile',
    );
    assert.equal(replay.body.excludedCount, 1);
  } finally {
    await f.close();
  }
});
