import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../server/database.js';
import { createApp } from '../../server/app.js';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { registerAdministration } from '../../server/administration/routes.js';
import {
  filterProfileValues,
  getEmployeeFile,
  mayReadProfileHistoryField,
  readEmployee,
  saveProfileValues,
  type Actor,
} from '../../server/administration/service.js';
import type { FormValues } from '../../shared/administration.js';

async function actor(
  db: Awaited<ReturnType<typeof createDatabase>>,
  role: string,
  id?: string,
): Promise<Actor> {
  if (id) return { id, role: role as Actor['role'] };
  const row = (
    await db.read<{ id: string }>('SELECT id FROM employee_access WHERE role=? LIMIT 1', [role])
  )[0];
  assert.ok(row, `missing ${role} persona`);
  return { id: row.id, role: role as Actor['role'] };
}

test('profile enhancement values preserve zero, keep absence unknown, and do not allocate leave', async () => {
  const db = await createDatabase();
  try {
    const hr = await actor(db, 'hr');
    const employee = await readEmployee(db, 'emp-sara');
    assert.ok(employee);
    const beforeLedger = await db.read('SELECT id FROM leave_ledger WHERE employee_id=?', [
      employee.id,
    ]);
    await db.transaction((tx) =>
      saveProfileValues(
        tx,
        hr,
        employee.id,
        {
          annualLeaveEntitlement: 0,
          annualLeaveSource: 'سجل معتمد تجريبي',
          annualLeaveEffectiveDate: '2026-01-01',
          annualLeaveVerificationStatus: 'unverified',
          wagesProtectionAmount: 0,
          relationshipType: 'collaborator',
        },
        'تسجيل بيانات تجريبية',
        '2026-11-14',
        employee.record_version,
      ),
    );
    const file = await getEmployeeFile(db, hr, employee.id);
    assert.equal(file.values.annualLeaveEntitlement, 0);
    assert.equal(file.values.wagesProtectionAmount, 0);
    assert.equal(file.values.relationshipType, 'collaborator');
    assert.equal(file.values.bankVerificationStatus, undefined);
    assert.equal(file.leaveSummary.balanceKnown, true);
    assert.equal(
      file.leaveSummary.policyApproved,
      false,
      'synthetic demo policy is not an approved policy',
    );
    assert.equal(file.leaveSummary.allocated, 24);
    assert.equal(
      file.leaveSummary.openingBalance,
      24,
      'only the identified synthetic seed allocation is classified as opening',
    );
    assert.equal(
      (await db.read('SELECT id FROM leave_ledger WHERE employee_id=?', [employee.id])).length,
      beforeLedger.length,
    );
  } finally {
    await db.close();
  }
});

test('EmployeeFile API includes readiness, protected history, leave ledger and authorized closed payslip references', async () => {
  const db = await createDatabase();
  const server: Server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/demo/session`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId: 'emp-noura' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const payrollPolicy = (
      await db.read<{ id: string }>('SELECT id FROM administrative_policies LIMIT 1')
    )[0];
    const runId = 'test-closed-profile-reference';
    await db.execute(
      "INSERT INTO payroll_runs(id,period,version,state,prepared_by,policy_id,correction_of,reason,created_at,updated_at,closed_at) VALUES(?,? ,1,'draft',?,?,NULL,'synthetic test',?,?,NULL)",
      [
        runId,
        '2026-10',
        'emp-noura',
        payrollPolicy.id,
        '2026-11-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',
      ],
    );
    await db.execute(
      "INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,created_at) VALUES(?,?,'emp-sara','راتب','earning',100,'test','2026-11-01T00:00:00.000Z')",
      ['test-closed-line', runId],
    );
    await db.execute(
      "UPDATE payroll_runs SET state='closed',closed_at='2026-11-01T00:00:00.000Z' WHERE id=?",
      [runId],
    );
    const response = await fetch(`${base}/api/admin/employees/emp-sara`, { headers: { cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as {
      file: {
        visibleFieldKeys: string[];
        sectionReadiness: Record<string, { status: string }>;
        leaveSummary: { available: number | null };
        leaveMovements: unknown[];
        closedPayslips: { runId: string; period: string }[];
      };
    };
    assert.ok(body.file.visibleFieldKeys.includes('medicalPolicyNumber'));
    assert.ok(body.file.sectionReadiness['التأمين الطبي']);
    assert.equal(typeof body.file.leaveSummary.available, 'number');
    assert.ok(body.file.leaveMovements.length > 0);
    assert.ok(
      body.file.closedPayslips.some((item) => item.runId === runId && item.period === '2026-10'),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
  }
});

test('bank changes reset verification and protected field history is returned only to authorized actors', async () => {
  const db = await createDatabase();
  try {
    const hr = await actor(db, 'hr');
    const auditor = await actor(db, 'auditor');
    const manager = await actor(db, 'manager');
    const finance = await actor(db, 'finance');
    const employee = await readEmployee(db, 'emp-sara');
    assert.ok(employee);
    await db.transaction((tx) =>
      saveProfileValues(
        tx,
        hr,
        employee.id,
        {
          accountNumber: 'SYNTHETIC-123',
          bankCountry: 'SA',
          bankVerificationStatus: 'verified',
          bankVerificationSource: 'bank-letter',
          bankVerifiedAt: '2026-11-13',
          medicalCoverageStatus: 'covered',
          medicalPolicyNumber: 'MED-TEST-001',
        },
        'إضافة بيانات مصرفية وطبية اصطناعية',
        '2026-11-14',
        employee.record_version,
      ),
    );
    let updated = await readEmployee(db, employee.id);
    assert.ok(updated);
    let file = await getEmployeeFile(db, hr, employee.id);
    assert.equal(
      file.values.bankVerificationStatus,
      'unverified',
      'first bank detail entry requires a later verification action',
    );
    assert.equal(file.values.bankVerificationSource, null);
    await db.transaction((tx) =>
      saveProfileValues(
        tx,
        hr,
        employee.id,
        {
          bankVerificationStatus: 'verified',
          bankVerificationSource: 'bank-letter',
          bankVerifiedAt: '2026-11-14',
        },
        'تسجيل تحقق يدوي',
        '2026-11-14',
        updated!.record_version,
      ),
    );
    updated = await readEmployee(db, employee.id);
    assert.ok(updated);
    await db.transaction((tx) =>
      saveProfileValues(
        tx,
        hr,
        employee.id,
        {
          accountNumber: 'SYNTHETIC-456',
        },
        'تغيير رقم الحساب',
        '2026-11-14',
        updated!.record_version,
      ),
    );
    file = await getEmployeeFile(db, hr, employee.id);
    assert.equal(file.values.bankVerificationStatus, 'unverified');
    assert.equal(
      file.fieldHistory.some(
        (entry) => entry.fieldKey === 'accountNumber' && entry.oldValue === 'SYNTHETIC-123',
      ),
      true,
    );
    assert.equal(
      file.fieldHistory.some(
        (entry) => entry.fieldKey === 'medicalPolicyNumber' && entry.newValue === 'MED-TEST-001',
      ),
      true,
    );
    const auditorFile = await getEmployeeFile(db, auditor, employee.id);
    assert.equal('accountNumber' in auditorFile.values, false);
    assert.equal('medicalPolicyNumber' in auditorFile.values, false);
    assert.equal(
      auditorFile.fieldHistory.some(
        (entry) => entry.fieldKey === 'accountNumber' || entry.fieldKey === 'medicalPolicyNumber',
      ),
      false,
    );
    const managerFile = await getEmployeeFile(db, manager, employee.id);
    assert.equal('accountNumber' in managerFile.values, false);
    assert.equal('medicalPolicyNumber' in managerFile.values, false);
    assert.equal(managerFile.visibleFieldKeys.includes('bio'), true);
    assert.equal(managerFile.fieldHistory.length, 0);
    const futureFields = { futureSensitiveField: 'protected future value', title: 'محرر تجريبي' };
    const managerValues = filterProfileValues(manager, employee.id, futureFields);
    assert.equal(managerValues.title, 'محرر تجريبي');
    assert.equal('futureSensitiveField' in managerValues, false);
    const financeValues = filterProfileValues(finance, employee.id, {
      accountNumber: 'SYNTHETIC-456',
      basicSalary: 0,
      medicalPolicyNumber: 'MED-TEST-001',
      futureSensitiveField: 'protected future value',
    });
    assert.equal(financeValues.accountNumber, 'SYNTHETIC-456');
    assert.equal(financeValues.basicSalary, 0);
    assert.equal('medicalPolicyNumber' in financeValues, false);
    assert.equal('futureSensitiveField' in financeValues, false);
    assert.equal(mayReadProfileHistoryField(finance, employee.id, 'basicSalary'), true);
    assert.equal(mayReadProfileHistoryField(finance, employee.id, 'medicalPolicyNumber'), false);
  } finally {
    await db.close();
  }
});

test('profile validation rejects inconsistent evidence, reversed coverage, and out of range rates', async () => {
  const db = await createDatabase();
  try {
    const hr = await actor(db, 'hr');
    const employee = await readEmployee(db, 'emp-sara');
    assert.ok(employee);
    const failures: { values: FormValues; code: string }[] = [
      {
        values: { bankVerificationStatus: 'verified' },
        code: 'BANK_VERIFICATION_EVIDENCE_REQUIRED',
      },
      {
        values: { insuranceVerificationStatus: 'verified' },
        code: 'INSURANCE_VERIFICATION_EVIDENCE_REQUIRED',
      },
      { values: { employeeContributionPercent: 101 }, code: 'INVALID_FIELD' },
      {
        values: { medicalStartDate: '2026-12-31', medicalEndDate: '2026-01-01' },
        code: 'INVALID_MEDICAL_DATES',
      },
    ];
    for (const item of failures) {
      await assert.rejects(
        db.transaction((tx) =>
          saveProfileValues(
            tx,
            hr,
            employee.id,
            item.values,
            'اختبار تحقق',
            '2026-11-14',
            employee.record_version,
          ),
        ),
        (error: unknown) =>
          !!error && typeof error === 'object' && 'code' in error && error.code === item.code,
      );
    }
  } finally {
    await db.close();
  }
});

test('zero opening leave balance is recorded only after independent approval and cannot be duplicated', async () => {
  const db = await createDatabase();
  const app = express();
  app.use(express.json());
  const ids = new Map<string, string>();
  const server: Server = createServer(app);
  registerAdministration(app, {
    db,
    requireActor: async (req) => {
      const id = req.header('x-actor') ?? '';
      const role = (
        await db.read<{ role: Actor['role'] }>('SELECT role FROM employee_access WHERE id=?', [id])
      )[0]?.role;
      if (!role) throw new Error('test actor not found');
      return { id, role };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const hr = await actor(db, 'hr');
    const approver = await actor(db, 'approver');
    const employeeId = 'profile-opening-zero';
    await db.execute(
      'INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,access_role) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,NULL)',
      [
        employeeId,
        'TEST-OPEN-0',
        'موظف اختبار',
        'مخ',
        'محرر',
        'التحرير',
        'opening-zero@example.test',
        'الرياض',
        '2026-01-01',
        'employee',
        'blue',
      ],
    );
    const request = async (owner: Actor, path: string, body: unknown, key: string) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          origin: base,
          'content-type': 'application/json',
          'x-actor': owner.id,
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      });
    const created = await request(
      hr,
      '/api/admin/requests',
      {
        kind: 'leave_adjustment',
        employeeId,
        submit: true,
        values: {
          adjustmentType: 'opening_balance',
          source: 'approved synthetic baseline record',
          days: 0,
          effectiveDate: '2026-11-14',
          reason: 'No opening days on sourced record',
        },
      },
      'opening-zero-create',
    );
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = (await created.json()) as {
      request: { id: string; version: number; state: string };
    };
    assert.equal(createdBody.request.state, 'pending_approver');
    const approved = await request(
      approver,
      `/api/admin/requests/${createdBody.request.id}/actions`,
      { version: 1, action: 'approve', reason: 'Reviewed source' },
      'opening-zero-approve',
    );
    assert.equal(approved.status, 200, await approved.clone().text());
    const file = await getEmployeeFile(db, hr, employeeId);
    assert.equal(file.leaveSummary.openingBalance, 0);
    assert.equal(file.leaveSummary.available, 0);
    assert.equal(file.leaveSummary.balanceKnown, true);
    assert.ok(
      file.leaveMovements.some((movement) => movement.kind === 'opening' && movement.days === 0),
    );
    assert.equal(
      (await db.read('SELECT id FROM leave_ledger WHERE employee_id=?', [employeeId])).length,
      0,
    );
    const duplicate = await request(
      hr,
      '/api/admin/requests',
      {
        kind: 'leave_adjustment',
        employeeId,
        submit: true,
        values: {
          adjustmentType: 'opening_balance',
          source: 'second source',
          days: 1,
          effectiveDate: '2026-11-14',
          reason: 'Duplicate attempt',
        },
      },
      'opening-zero-duplicate-create',
    );
    assert.equal(duplicate.status, 201);
    const duplicateBody = (await duplicate.json()) as { request: { id: string } };
    const duplicateApproval = await request(
      approver,
      `/api/admin/requests/${duplicateBody.request.id}/actions`,
      { version: 1, action: 'approve', reason: 'Should fail one-opening constraint' },
      'opening-zero-duplicate-approve',
    );
    assert.equal(duplicateApproval.status, 409);
    const duplicateState = await db.read<{ state: string }>(
      'SELECT state FROM administrative_requests WHERE id=?',
      [duplicateBody.request.id],
    );
    assert.equal(
      duplicateState[0].state,
      'pending_approver',
      'failed side effect rolls back request state',
    );
    const replayFailure = await request(
      approver,
      `/api/admin/requests/${duplicateBody.request.id}/actions`,
      { version: 1, action: 'approve', reason: 'Should fail one-opening constraint' },
      'opening-zero-duplicate-approve',
    );
    assert.equal(replayFailure.status, 409, 'failed action key does not replay a partial approval');
    const final = await db.read<{ count: number }>(
      'SELECT COUNT(*) AS count FROM leave_balance_openings WHERE employee_id=?',
      [employeeId],
    );
    assert.equal(Number(final[0].count), 1);
    const positiveId = 'profile-opening-positive';
    await db.execute(
      'INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,access_role) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,NULL)',
      [
        positiveId,
        'TEST-OPEN-5',
        'موظف اختبار آخر',
        'مخ',
        'محرر',
        'التحرير',
        'opening-positive@example.test',
        'الرياض',
        '2026-01-01',
        'employee',
        'blue',
      ],
    );
    const positiveCreated = await request(
      hr,
      '/api/admin/requests',
      {
        kind: 'leave_adjustment',
        employeeId: positiveId,
        submit: true,
        values: {
          adjustmentType: 'opening_balance',
          source: 'approved record #5',
          days: 5,
          effectiveDate: '2026-11-01',
          reason: 'Record sourced opening balance',
        },
      },
      'opening-positive-create',
    );
    assert.equal(positiveCreated.status, 201, await positiveCreated.clone().text());
    const positiveRequest = (await positiveCreated.json()) as { request: { id: string } };
    const positiveApproved = await request(
      approver,
      `/api/admin/requests/${positiveRequest.request.id}/actions`,
      { version: 1, action: 'approve', reason: 'Reviewed positive source' },
      'opening-positive-approve',
    );
    assert.equal(positiveApproved.status, 200, await positiveApproved.clone().text());
    const positiveFile = await getEmployeeFile(db, hr, positiveId);
    assert.equal(positiveFile.leaveSummary.openingBalance, 5);
    assert.equal(positiveFile.leaveSummary.available, 5);
    assert.ok(
      positiveFile.leaveMovements.some(
        (movement) =>
          movement.effectiveAt === '2026-11-01' && movement.source === 'approved record #5',
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
  }
});
