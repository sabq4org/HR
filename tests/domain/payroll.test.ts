import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createDatabase, createPostgresDatabase } from '../../server/database.js';
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
async function fixture(open: () => ReturnType<typeof createDatabase> = () => createDatabase()) {
  const db = await open();
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

test('synthetic seed keeps the profile-component policy available for payroll runs', async () => {
  const f = await fixture();
  try {
    const policies = await f.db.read<{ id: string; state: string }>(
      "SELECT id,state FROM administrative_policies WHERE id LIKE 'payroll-policy-demo-v%' ORDER BY id",
    );
    assert.deepEqual(
      policies.map((policy) => ({ id: policy.id, state: policy.state })),
      [
        { id: 'payroll-policy-demo-v1', state: 'synthetic_approved' },
        { id: 'payroll-policy-demo-v2', state: 'synthetic_approved' },
      ],
    );
    const created = await f.api<{ run: any }>(
      'hr',
      '',
      'POST',
      { period: '2026-07', policyId: 'payroll-policy-demo-v2', reason: 'اختبار سياسة المعاينة' },
      'profile-policy-seed',
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.run.policyId, 'payroll-policy-demo-v2');
    assert.ok(created.body.run.lines.length > 0);
  } finally {
    await f.close();
  }
});

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
    // The preparer, reviewer and approver are paid in the same run (decision 013).
    for (const signer of ['emp-noura', 'emp-reem', 'emp-abdullah'])
      assert.ok(
        draft.lines.some((line: any) => line.employeeId === signer),
        `${signer} is in the run`,
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

test('approver closes a run that includes their own salary (decision 013)', async () => {
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
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
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
    // Cancelling the first run (it never pays) frees the approved source for the other run.
    const cancelled = await f.api<{ run: any }>(
      'hr',
      `/${first.body.run.id}/actions`,
      'POST',
      { version: updated.body.run.version, action: 'cancel', reason: 'أُنشئ بالخطأ' },
      'source-cancel',
    );
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const kept = cancelled.body.run.lines.find((x: any) => x.component === 'مكافأة معتمدة');
    assert.equal(kept.sourceRequestId, null);
    assert.match(kept.source, new RegExp(sourceId));
    const reused = await f.api(
      'hr',
      `/${second.body.run.id}`,
      'PATCH',
      {
        version: 1,
        lines: [...second.body.run.lines, line],
        reason: 'المكافأة بعد إلغاء المسير الأول',
      },
      'source-add-3',
    );
    assert.equal(reused.status, 200, JSON.stringify(reused.body));
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

async function correctionChainScenario(f: Awaited<ReturnType<typeof fixture>>) {
  {
    let step = 0;
    const key = () => `chain-${++step}`;
    async function close(id: string, version: number) {
      const submit = await f.api<any>(
        'hr',
        `/${id}/actions`,
        'POST',
        { version, action: 'submit' },
        key(),
      );
      assert.equal(submit.status, 200, JSON.stringify(submit.body));
      const review = await f.api<any>(
        'finance',
        `/${id}/actions`,
        'POST',
        { version: version + 1, action: 'review' },
        key(),
      );
      assert.equal(review.status, 200, JSON.stringify(review.body));
      return f.api<any>(
        'approver',
        `/${id}/actions`,
        'POST',
        { version: version + 2, action: 'approve' },
        key(),
      );
    }
    // A correction that deducts `amount` from Sara's first line, ready for approval.
    async function correction(of: string, amount: number) {
      const made = await f.api<any>(
        'hr',
        '',
        'POST',
        {
          period: '2026-09',
          policyId: 'payroll-policy-demo-v1',
          reason: 'تصحيح تجريبي متتالٍ',
          correctionOf: of,
        },
        key(),
      );
      assert.equal(made.status, 200, JSON.stringify(made.body));
      const lines = made.body.run.lines.map((line: any) => ({ ...line }));
      const target = lines.find((line: any) => line.employeeId === 'emp-sara');
      assert.ok(target, 'Sara has a placeholder line in the correction');
      target.kind = 'deduction';
      target.amountMinor = amount;
      const edited = await f.api<any>(
        'hr',
        `/${made.body.run.id}`,
        'PATCH',
        { version: 1, lines, reason: 'فرق تجريبي' },
        key(),
      );
      return { id: made.body.run.id as string, edited };
    }

    const base = await f.api<any>(
      'hr',
      '',
      'POST',
      { period: '2026-09', policyId: 'payroll-policy-demo-v1', reason: 'مسير أساسي تجريبي' },
      key(),
    );
    assert.equal(base.status, 200);
    const original = base.body.run.id as string;
    const saraNet = base.body.run.lines
      .filter((line: any) => line.employeeId === 'emp-sara')
      .reduce(
        (sum: number, line: any) =>
          sum + (line.kind === 'earning' ? line.amountMinor : -line.amountMinor),
        0,
      );
    assert.ok(saraNet > 1000, 'synthetic net is large enough for the scenario');
    assert.equal((await close(original, 1)).body.run.state, 'closed');

    // Two corrections of the original are drafted while both still look valid against it.
    // The first takes Sara's net to 1000 halalas; the second deducts 1500 more.
    const first = await correction(original, saraNet - 1000);
    assert.equal(first.edited.status, 200, JSON.stringify(first.edited.body));
    const second = await correction(original, 1500);
    assert.equal(second.edited.status, 200, JSON.stringify(second.edited.body));
    assert.equal((await close(first.id, 2)).body.run.state, 'closed');

    // Closing the second would leave Sara at -500. Approval must see the first correction.
    const overdraw = await close(second.id, 2);
    assert.equal(overdraw.status, 400, JSON.stringify(overdraw.body));
    assert.match(JSON.stringify(overdraw.body), /negative_net/);

    // The same overdraw drafted after the first closed is refused when the lines are saved.
    const late = await correction(original, 1500);
    assert.equal(late.edited.status, 400, JSON.stringify(late.edited.body));
    assert.match(JSON.stringify(late.edited.body), /negative_net/);

    // A correction of the first correction deducting 400 leaves Sara at 600, which is valid.
    // It must not be measured against the first correction's delta alone (which is negative).
    const chained = await correction(first.id, 400);
    assert.equal(chained.edited.status, 200, JSON.stringify(chained.edited.body));
    const chainedClosed = await close(chained.id, 2);
    assert.equal(chainedClosed.status, 200, JSON.stringify(chainedClosed.body));
    assert.equal(chainedClosed.body.run.state, 'closed');
  }
}

test('successive correction runs are checked against the cumulative closed net, not the original alone', async () => {
  const f = await fixture();
  try {
    await correctionChainScenario(f);
  } finally {
    await f.close();
  }
});

test(
  'successive correction runs use the cumulative closed net on PostgreSQL',
  { skip: !process.env.HR_TEST_DATABASE_URL },
  async () => {
    const f = await fixture(() =>
      createPostgresDatabase(
        process.env.HR_TEST_DATABASE_URL!,
        `hr_preview_${randomUUID().replaceAll('-', '')}`,
        { seed: true },
      ),
    );
    try {
      await correctionChainScenario(f);
    } finally {
      await f.close();
    }
  },
);
