import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase, todayInRiyadh } from '../../server/database.js';
import type {
  FormValues,
  RequestKind,
  AdministrativeRequest,
} from '../../shared/administration.js';

const actors = {
  employee: 'emp-sara',
  manager: 'emp-omar',
  hr: 'emp-noura',
  finance: 'emp-reem',
  approver: 'emp-abdullah',
  auditor: 'emp-hind',
};
type ActorRole = keyof typeof actors;
const today = todayInRiyadh();
const reason = 'سبب اصطناعي لاختبار المعالجة والاعتماد';
const scenarios: {
  kind: RequestKind;
  creator: ActorRole;
  steps: ActorRole[];
  values: FormValues;
}[] = [
  {
    kind: 'contract',
    creator: 'hr',
    steps: ['approver'],
    values: {
      contractType: 'fixed',
      startDate: today,
      endDate: '2027-12-31',
      title: 'محررة متقدمة',
      basicSalary: 12345.67,
      reason,
    },
  },
  {
    kind: 'contract_amendment',
    creator: 'hr',
    steps: ['approver'],
    values: {
      contractReference: 'DEMO-CONTRACT',
      effectiveDate: today,
      changes: 'تعديل وصفي تجريبي',
      reason,
    },
  },
  {
    kind: 'probation',
    creator: 'manager',
    steps: ['hr', 'approver'],
    values: {
      reviewDate: today,
      rating: 'meets',
      recommendation: 'اجتياز تجريبي للمراجعة',
      reason,
    },
  },
  {
    kind: 'salary_letter',
    creator: 'employee',
    steps: ['hr'],
    values: { recipient: 'جهة تجريبية', language: 'ar', purpose: 'اختبار طلب تعريف' },
  },
  {
    kind: 'employment_letter',
    creator: 'employee',
    steps: ['hr'],
    values: { recipient: 'جهة تجريبية', purpose: 'اختبار طلب تعريف' },
  },
  {
    kind: 'experience_letter',
    creator: 'employee',
    steps: ['hr'],
    values: { recipient: 'جهة تجريبية', duties: 'تحرير أخبار اصطناعية' },
  },
  {
    kind: 'clearance',
    creator: 'employee',
    steps: ['hr', 'finance', 'approver'],
    values: {
      lastDay: today,
      assets: 'تمت مراجعة العهد التجريبية',
      financialObligations: 'لا التزامات في هذا الاختبار',
      reason,
    },
  },
  {
    kind: 'advance',
    creator: 'employee',
    steps: ['hr', 'finance', 'approver'],
    values: { amount: 2000.29, installments: 4, firstDeductionMonth: '2026-12', reason },
  },
  {
    kind: 'data_change',
    creator: 'employee',
    steps: ['hr'],
    values: { fieldName: 'mobile', newValue: '0500000999', reason },
  },
  {
    kind: 'bank_change',
    creator: 'employee',
    steps: ['hr', 'finance'],
    values: { bankName: 'بنك تجريبي', iban: 'DEMO-ACCOUNT-001', reason },
  },
  {
    kind: 'transfer',
    creator: 'manager',
    steps: ['hr', 'approver'],
    values: {
      department: 'التحقيقات',
      title: 'محررة أولى',
      managerId: 'emp-omar',
      effectiveDate: today,
      reason,
    },
  },
  {
    kind: 'special_leave',
    creator: 'employee',
    steps: ['manager', 'hr'],
    values: {
      leaveType: 'sick',
      startDate: today,
      endDate: today,
      note: 'ملاحظة طبية اصطناعية خاصة',
    },
  },
  {
    kind: 'leave_adjustment',
    creator: 'hr',
    steps: ['approver'],
    values: { days: 2, effectiveDate: today, reason },
  },
  {
    kind: 'overtime',
    creator: 'employee',
    steps: ['manager', 'hr', 'approver'],
    values: {
      date: today,
      hours: 2.5,
      compensation: 'payment',
      amount: 199.99,
      consent: true,
      reason,
    },
  },
  {
    kind: 'reward',
    creator: 'manager',
    steps: ['hr', 'approver'],
    values: { amount: 999.99, effectiveDate: today, achievement: 'إنجاز اصطناعي مميز', reason },
  },
  {
    kind: 'separation',
    creator: 'employee',
    steps: ['hr', 'approver'],
    values: {
      reasonType: 'mutual',
      noticeDate: today,
      lastDay: today,
      handover: 'استكمال تسليم اصطناعي',
      reason,
    },
  },
  {
    kind: 'settlement',
    creator: 'hr',
    steps: ['finance', 'approver'],
    values: {
      separationReference: 'DEMO-SEPARATION',
      lastDay: today,
      wageBasis: 10000,
      serviceDays: 365,
      excludedDays: 0,
      leaveDays: 5,
      eosAmount: 1000,
      leaveAmount: 500,
      otherAmount: 0,
      deductions: 0,
      calculationReference: 'قيم يدوية اصطناعية راجعها مسؤول الاختبار',
      reason,
    },
  },
  {
    kind: 'discipline',
    creator: 'manager',
    steps: ['hr', 'approver'],
    values: {
      incidentDate: today,
      incident: 'واقعة اصطناعية',
      notice: 'إبلاغ اصطناعي',
      investigation: 'محضر اصطناعي',
      defense: 'رد اصطناعي',
      policyReference: 'DEMO-POLICY',
      proposedDecision: 'تنبيه اصطناعي دون حسم مالي',
      reason,
    },
  },
  {
    kind: 'grievance',
    creator: 'employee',
    steps: ['hr', 'approver'],
    values: {
      decisionReference: 'DEMO-DECISION',
      requestedResolution: 'إعادة مراجعة القرار التجريبي',
      reason,
    },
  },
];

async function harness() {
  if (process.env.HR_ACCEPTANCE_POSTGRES === 'true' && existsSync('.env.pg-test'))
    process.loadEnvFile('.env.pg-test');
  const db =
    process.env.HR_ACCEPTANCE_POSTGRES === 'true'
      ? await createPostgresDatabase(
          process.env.HR_TEST_DATABASE_URL ?? '',
          `hr_preview_${randomUUID().replaceAll('-', '')}`,
        )
      : await createDatabase();
  const server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<ActorRole, string>();
  async function call(
    role: ActorRole,
    path: string,
    method = 'GET',
    body?: unknown,
    key = randomUUID(),
  ) {
    if (!cookies.has(role)) {
      const login = await fetch(`${origin}/api/demo/session`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ employeeId: actors[role] }),
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

for (const scenario of scenarios)
  test(
    `Acceptance: ${scenario.kind} reaches independent approval and preserves its result`,
    { timeout: 15000 },
    async () => {
      const h = await harness();
      try {
        const before = await (await h.call('employee', '/bootstrap')).json();
        const periodsBefore = await h.db.read(
          'SELECT * FROM employment_periods WHERE employee_id=? ORDER BY id',
          [actors.employee],
        );
        const created = await h.call(scenario.creator, '/admin/requests', 'POST', {
          kind: scenario.kind,
          employeeId: actors.employee,
          values: scenario.values,
          submit: true,
        });
        assert.equal(created.status, 201, await created.clone().text());
        let request = (await created.json()).request as AdministrativeRequest;
        assert.deepEqual(request.steps, scenario.steps);
        for (const role of scenario.steps) {
          assert.equal(request.state, `pending_${role}`);
          const decision = await h.call(role, `/admin/requests/${request.id}/actions`, 'POST', {
            version: request.version,
            action: 'approve',
            reason: 'موافقة مستقلة اصطناعية',
          });
          assert.equal(decision.status, 200, `${role}: ${await decision.clone().text()}`);
          request = (await decision.json()).request;
        }
        assert.equal(request.state, 'approved');
        assert.equal(
          request.timeline.filter((e) => e.action === 'approve').length,
          scenario.steps.length,
        );
        const reread = await h.call('hr', `/admin/requests/${request.id}`);
        assert.equal((await reread.json()).request.state, 'approved');
        const file = (await (await h.call('hr', `/admin/employees/${actors.employee}`)).json())
          .file;
        assert.ok(
          file.requests.some((r: AdministrativeRequest) => r.id === request.id),
          'Employee file must show the completed request',
        );
        if (scenario.kind === 'data_change') assert.equal(file.values.mobile, '0500000999');
        if (scenario.kind === 'bank_change') {
          assert.equal(file.values.bankName, 'بنك تجريبي');
          assert.equal(file.values.iban, 'DEMO-ACCOUNT-001');
        }
        if (scenario.kind === 'contract') {
          assert.equal(file.values.contractStart, today);
          assert.equal(file.values.basicSalary, 12345.67);
          assert.deepEqual(
            await h.db.read('SELECT * FROM employment_periods WHERE employee_id=? ORDER BY id', [
              actors.employee,
            ]),
            periodsBefore,
            'Contract renewal must preserve the continuous service period',
          );
        }
        if (scenario.kind === 'transfer') {
          assert.equal(file.employee.department, 'التحقيقات');
          assert.equal(file.employee.title, 'محررة أولى');
          const history = await h.db.read<{
            field_key: string;
            effective_at: string;
            actor_id: string;
          }>(
            'SELECT field_key,effective_at,actor_id FROM employee_profile_history WHERE employee_id=?',
            [actors.employee],
          );
          for (const field of ['department', 'title']) {
            assert.ok(
              history.some(
                (entry) =>
                  entry.field_key === field &&
                  entry.effective_at === today &&
                  entry.actor_id === actors.approver,
              ),
              'Transfer must record each changed field and approving actor',
            );
          }
          assert.ok(
            file.history.some((event: { action: string }) => event.action === 'field_updated'),
          );
        }
        if (scenario.kind === 'separation') {
          assert.equal(file.employee.status, 'terminated');
          assert.ok(file.periods.some((p: { endDate: string }) => p.endDate === today));
        }
        if (scenario.kind === 'leave_adjustment') {
          const after = await (await h.call('employee', '/bootstrap')).json();
          assert.equal(after.balance.available, before.balance.available + 2);
        }
      } finally {
        await h.close();
      }
    },
  );

test(
  'Returned requests restart every required approval; out-of-team managers cannot read or decide',
  { timeout: 15000 },
  async () => {
    const h = await harness();
    try {
      const created = await h.call('employee', '/admin/requests', 'POST', {
        kind: 'special_leave',
        employeeId: 'emp-sara',
        submit: true,
        values: { leaveType: 'exam', startDate: today, endDate: today },
      });
      let r = (await created.json()).request as AdministrativeRequest;
      assert.ok(r);
      const first = await h.call('manager', `/admin/requests/${r.id}/actions`, 'POST', {
        version: r.version,
        action: 'approve',
      });
      assert.equal(first.status, 200);
      r = (await first.json()).request;
      const returned = await h.call('hr', `/admin/requests/${r.id}/actions`, 'POST', {
        version: r.version,
        action: 'return',
        reason: 'استكمل المستند',
      });
      assert.equal(returned.status, 200);
      r = (await returned.json()).request;
      const submit = await h.call('employee', `/admin/requests/${r.id}/actions`, 'POST', {
        version: r.version,
        action: 'submit',
      });
      assert.equal(submit.status, 200);
      r = (await submit.json()).request;
      assert.equal(r.stepIndex, 0);
      const approved = await h.call('manager', `/admin/requests/${r.id}/actions`, 'POST', {
        version: r.version,
        action: 'approve',
      });
      assert.equal(approved.status, 200);
      r = (await approved.json()).request;
      assert.equal(r.state, 'pending_hr');
      const second = await h.call('employee', '/admin/requests', 'POST', {
        kind: 'special_leave',
        employeeId: 'emp-sara',
        submit: true,
        values: { leaveType: 'marriage', startDate: today, endDate: today },
      });
      const other = (await second.json()).request as AdministrativeRequest;
      await h.db.execute('UPDATE employees SET manager_id=NULL WHERE id=?', ['emp-sara']);
      assert.equal((await h.call('manager', `/admin/requests/${other.id}`)).status, 404);
      const forbidden = await h.call('manager', `/admin/requests/${other.id}/actions`, 'POST', {
        version: other.version,
        action: 'approve',
      });
      assert.ok([403, 404].includes(forbidden.status));
      const list = await (await h.call('manager', '/admin/requests')).json();
      assert.ok(!list.requests.some((x: AdministrativeRequest) => x.id === other.id));
    } finally {
      await h.close();
    }
  },
);

test(
  'Concurrent draft edits conflict; identical profile retries are idempotent',
  { timeout: 15000 },
  async () => {
    const h = await harness();
    try {
      const r = await h.call('employee', '/admin/requests', 'POST', {
        kind: 'employment_letter',
        employeeId: 'emp-sara',
        submit: false,
        values: { recipient: 'جهة تجريبية', purpose: 'اختبار' },
      });
      const req = (await r.json()).request as AdministrativeRequest;
      const edits = await Promise.all(
        ['أ', 'ب'].map((purpose) =>
          h.call('employee', `/admin/requests/${req.id}`, 'PATCH', {
            version: req.version,
            values: { recipient: 'جهة تجريبية', purpose },
          }),
        ),
      );
      assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
      const file = (await (await h.call('hr', '/admin/employees/emp-sara')).json()).file;
      const body = {
        version: file.version,
        values: { mobile: '0500000777' },
        reason: 'تعديل اصطناعي',
      };
      const key = randomUUID();
      const first = await h.call('hr', '/admin/employees/emp-sara', 'PATCH', body, key);
      assert.equal(first.status, 200, await first.clone().text());
      const second = await h.call('hr', '/admin/employees/emp-sara', 'PATCH', body, key);
      assert.equal(second.status, 200, await second.clone().text());
      assert.equal((await first.json()).file.version, (await second.json()).file.version);
    } finally {
      await h.close();
    }
  },
);

test(
  'Issued salary letters are immutable approval snapshots and medical notes stay private',
  { timeout: 15000 },
  async () => {
    const h = await harness();
    try {
      const created = await h.call('employee', '/admin/requests', 'POST', {
        kind: 'salary_letter',
        employeeId: 'emp-sara',
        submit: true,
        values: { recipient: 'جهة تجريبية', language: 'en', purpose: 'اختبار ثبات نسخة التعريف' },
      });
      let req = (await created.json()).request as AdministrativeRequest;
      const approved = await h.call('hr', `/admin/requests/${req.id}/actions`, 'POST', {
        version: req.version,
        action: 'approve',
      });
      assert.equal(approved.status, 200, await approved.clone().text());
      req = (await approved.json()).request;
      assert.ok(req.issuedDocument);
      assert.equal(req.issuedDocument.language, 'en');
      assert.ok(
        req.issuedDocument.facts.some(
          (f) => f.label === 'Basic salary' && f.value.includes('11,000'),
        ),
      );
      const snapshot = JSON.stringify(req.issuedDocument);
      const file = (await (await h.call('hr', '/admin/employees/emp-sara')).json()).file;
      assert.equal(
        (
          await h.call('hr', '/admin/employees/emp-sara', 'PATCH', {
            version: file.version,
            values: { basicSalary: 22000 },
            reason: 'تعديل اصطناعي لاحق',
          })
        ).status,
        200,
      );
      const reread = (await (await h.call('employee', `/admin/requests/${req.id}`)).json())
        .request as AdministrativeRequest;
      assert.equal(JSON.stringify(reread.issuedDocument), snapshot);
      const auditor = (await (await h.call('auditor', `/admin/requests/${req.id}`)).json()).request;
      assert.equal(auditor.issuedDocument, undefined);
      const medical = await h.call('employee', '/admin/requests', 'POST', {
        kind: 'special_leave',
        employeeId: 'emp-sara',
        submit: true,
        values: {
          leaveType: 'sick',
          startDate: today,
          endDate: today,
          note: 'PRIVATE_SYNTHETIC_MEDICAL_NOTE',
        },
      });
      const med = (await medical.json()).request as AdministrativeRequest;
      const manager = (await (await h.call('manager', `/admin/requests/${med.id}`)).json()).request;
      assert.equal(manager.values.note, undefined);
      const notifications = await (await h.call('manager', '/bootstrap')).json();
      assert.ok(
        notifications.notifications.some((n: { requestId?: string }) => n.requestId === med.id),
      );
      const raw = (
        await h.db.read<{ values_json: string }>(
          'SELECT values_json FROM administrative_requests WHERE id=?',
          [med.id],
        )
      )[0].values_json;
      assert.ok(!raw.includes('PRIVATE_SYNTHETIC_MEDICAL_NOTE'));
    } finally {
      await h.close();
    }
  },
);

test('An employee cannot become their own reporting manager', async () => {
  const h = await harness();
  try {
    const before = (await (await h.call('hr', `/admin/employees/${actors.manager}`)).json()).file;
    const result = await h.call('hr', `/admin/employees/${actors.manager}`, 'PATCH', {
      version: before.version,
      values: { managerId: actors.manager },
      reason: 'اختبار منع الإشراف الذاتي',
      effectiveAt: today,
    });
    assert.equal(result.status, 400, await result.clone().text());
    assert.equal((await result.json()).error.code, 'INVALID_MANAGER');
    const after = (await (await h.call('hr', `/admin/employees/${actors.manager}`)).json()).file;
    assert.equal(after.version, before.version);
    assert.equal(after.employee.managerId, before.employee.managerId);
  } finally {
    await h.close();
  }
});
