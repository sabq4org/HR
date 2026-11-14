import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../server/database.js';
import { createEmployee, type Actor } from '../../server/administration/service.js';
import { importMappedWorkbook } from '../../server/private/local-admin.js';
import { createIssuedDocument } from '../../server/letters/document.js';
import type { MappedWorkbook } from '../../server/imports/sabq-workbook.js';
import type { FormValues } from '../../shared/administration.js';

const workbook: MappedWorkbook = {
  mappedColumns: ['name', 'email', 'joinDate', 'separationDate', 'employmentStatus'],
  ignoredColumns: [],
  photosFound: 0,
  rows: [
    {
      rowNumber: 2,
      issues: [],
      values: {
        name: 'موظف بتاريخ معروف',
        title: 'محرر',
        department: 'التحرير',
        location: 'غير محدد',
        email: 'known@example.test',
        joinDate: '2020-04-05',
        employmentStatus: 'active',
      },
    },
    {
      rowNumber: 3,
      issues: [],
      values: {
        name: 'موظف منتهٍ',
        title: 'محرر',
        department: 'التحرير',
        location: 'غير محدد',
        email: 'ended@example.test',
        joinDate: '2018-02-03',
        separationDate: '2023-06-30',
        employmentStatus: 'terminated',
      },
    },
    {
      rowNumber: 4,
      issues: ['missing:joinDate'],
      values: {
        name: 'موظف بلا تاريخ مباشرة',
        title: 'محرر',
        department: 'التحرير',
        location: 'غير محدد',
        email: 'missing@example.test',
        employmentStatus: 'active',
      },
    },
    {
      rowNumber: 5,
      issues: ['missing:joinDate'],
      values: {
        name: 'موظف منتهٍ بلا تاريخ نهاية',
        title: 'محرر',
        department: 'التحرير',
        location: 'غير محدد',
        email: 'undated-end@example.test',
        joinDate: '2017-01-01',
        employmentStatus: 'terminated',
      },
    },
  ],
};

test('private imports retain only sourced tenure dates and do not create demo schedule or leave fixtures', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  try {
    const summary = await importMappedWorkbook(db, workbook, {
      includeIncomplete: true,
      today: '2026-11-14',
    });
    assert.equal(summary.imported, 4, JSON.stringify(summary));

    const periods = await db.read<{
      employee_number: string;
      start_date: string;
      end_date: string | null;
      relationship_type: string;
      source: string;
      status: string;
    }>(
      `SELECT e.employee_number,p.start_date,p.end_date,p.relationship_type,p.source,p.status
       FROM employment_periods p JOIN employees e ON e.id=p.employee_id ORDER BY e.employee_number`,
    );
    assert.equal(periods.length, 2);
    assert.deepEqual(
      periods.map((p) => [p.start_date, p.end_date, p.relationship_type, p.status]),
      [
        ['2020-04-05', null, 'غير محددة', 'pending-review'],
        ['2018-02-03', '2023-06-30', 'غير محددة', 'pending-review'],
      ],
    );
    assert.ok(periods.every((p) => p.source.includes('Private workbook import')));
    assert.equal((await db.read('SELECT id FROM work_schedules')).length, 0);
    assert.equal((await db.read('SELECT employee_id FROM leave_ledger')).length, 0);

    const missingJoin = await db.read<{ join_date: string }>(
      "SELECT join_date FROM employees WHERE email='missing@example.test'",
    );
    assert.equal(missingJoin[0].join_date, '2026-11-14', 'placeholder remains profile-only');
  } finally {
    await db.close();
  }
});

test('synthetic employee creation keeps synthetic period, schedule and policy allocation', async () => {
  const db = await createDatabase();
  try {
    const hr = (
      await db.read<{ id: string }>("SELECT id FROM employee_access WHERE role='hr' LIMIT 1")
    )[0];
    const actor: Actor = { id: hr.id, role: 'hr' };
    await db.transaction((tx) =>
      createEmployee(tx, actor, {
        name: 'موظف تجريبي جديد',
        email: 'synthetic-new@example.test',
        employeeNumber: 'SYN-9001',
        title: 'محرر',
        department: 'التحرير',
        joinDate: '2026-01-01',
        location: 'الرياض',
        employmentStatus: 'active',
      }),
    );
    const id = (
      await db.read<{ id: string }>(
        "SELECT id FROM employees WHERE email='synthetic-new@example.test'",
      )
    )[0].id;
    const period = (
      await db.read<{ status: string; relationship_type: string }>(
        'SELECT status,relationship_type FROM employment_periods WHERE employee_id=?',
        [id],
      )
    )[0];
    assert.equal(period.status, 'synthetic-demo-only');
    assert.equal(period.relationship_type, 'fictional-demo-record');
    assert.equal(
      (await db.read('SELECT id FROM work_schedules WHERE employee_id=?', [id])).length,
      1,
    );
    assert.equal(
      (
        await db.read(
          "SELECT employee_id FROM leave_ledger WHERE employee_id=? AND kind='allocation'",
          [id],
        )
      ).length,
      1,
    );
  } finally {
    await db.close();
  }
});

test('experience letter cannot turn a private pending-review period into verified tenure', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  try {
    await importMappedWorkbook(
      db,
      {
        ...workbook,
        rows: [workbook.rows[0]],
      },
      { today: '2026-11-14', includeIncomplete: true },
    );
    const employee = (
      await db.read<{ id: string }>("SELECT id FROM employees WHERE email='known@example.test'")
    )[0];
    const actor: Actor = { id: 'system-local-admin', role: 'hr' };
    const values: FormValues = { duties: 'تحرير المحتوى' };
    await assert.rejects(
      createIssuedDocument(
        db,
        {
          id: 'request-test',
          number: 'REQ-TEST',
          kind: 'experience_letter',
          employeeId: employee.id,
          values,
        },
        actor,
      ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EXPERIENCE_PERIODS_UNVERIFIED',
        ),
    );
  } finally {
    await db.close();
  }
});

test('experience letter blocks a partial history when verified and pending periods are mixed', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  try {
    await importMappedWorkbook(
      db,
      { ...workbook, rows: [workbook.rows[0]] },
      { today: '2026-11-14' },
    );
    const employee = (
      await db.read<{ id: string }>("SELECT id FROM employees WHERE email='known@example.test'")
    )[0];
    await db.execute("UPDATE employment_periods SET status='verified' WHERE employee_id=?", [
      employee.id,
    ]);
    await db.execute(
      `INSERT INTO employment_periods(id,employee_id,start_date,end_date,relationship_type,source,status,created_at)
       VALUES('period-unreviewed',?,'2024-01-01','2024-12-31','غير محددة','Imported source pending review','pending-review','2026-11-14T00:00:00Z')`,
      [employee.id],
    );
    await assert.rejects(
      createIssuedDocument(
        db,
        {
          id: 'request-mixed',
          number: 'REQ-MIXED',
          kind: 'experience_letter',
          employeeId: employee.id,
          values: { duties: 'تحرير المحتوى' },
        },
        { id: 'system-local-admin', role: 'hr' },
      ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EXPERIENCE_PERIODS_UNVERIFIED',
        ),
    );
    await db.execute("UPDATE employment_periods SET status='active' WHERE id='period-unreviewed'");
    await assert.rejects(
      createIssuedDocument(
        db,
        {
          id: 'request-active',
          number: 'REQ-ACTIVE',
          kind: 'experience_letter',
          employeeId: employee.id,
          values: { duties: 'تحرير المحتوى' },
        },
        { id: 'system-local-admin', role: 'hr' },
      ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EXPERIENCE_PERIODS_UNVERIFIED',
        ),
    );
  } finally {
    await db.close();
  }
});
