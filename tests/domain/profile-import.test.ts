import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createDatabase } from '../../server/database.js';
import { mapSabqSupplementWorkbook } from '../../server/imports/sabq-workbook.js';
import { ensureLocalAdmin } from '../../server/private/local-admin.js';
import { readEmployee, getProfileValues } from '../../server/administration/service.js';
import {
  planMissingOnly,
  supplementProfiles,
  validateManifest,
} from '../../scripts/profile-supplement.js';

async function workbookBytes(headers: string[], rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الموظفون');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('supplement mapping preserves real zero, skips blanks and rejects invalid money without retaining it', async () => {
  const bytes = await workbookBytes(
    [
      'معرف المصدر',
      'أيام الإجازة السنوية',
      'الراتب الأساسي',
      'بدل السكن',
      'لديه تأمين طبي',
      'نوع الموظف',
      'نوع الحساب',
    ],
    [
      ['SRC-1', 0, 0, null, 'نعم', 'موظف رسمي', 'جاري'],
      ['SRC-2', null, '12 ريالx', null, 'غير معروف', 'متعاون', null],
      ['SRC-3', 1.5, null, null, null, null, null],
    ],
  );
  const mapped = await mapSabqSupplementWorkbook(bytes);
  assert.equal(mapped.rows.length, 3);
  assert.equal(mapped.rows[0].sourceId, 'SRC-1');
  assert.equal(mapped.rows[0].values.annualLeaveEntitlement, 0);
  assert.equal(mapped.rows[0].values.basicSalary, 0);
  assert.equal(mapped.rows[0].values.medicalCoverageStatus, 'covered');
  assert.equal(mapped.rows[0].values.relationshipType, 'employee');
  assert.equal(mapped.rows[0].values.accountType, 'current');
  assert.equal('housingAllowance' in mapped.rows[0].values, false);
  assert.ok(mapped.rows[1].issues.includes('invalid_money:basicSalary'));
  assert.ok(mapped.rows[1].issues.includes('unknown_coverage:medicalCoverageStatus'));
  assert.equal('basicSalary' in mapped.rows[1].values, false);
  assert.equal(mapped.rows[2].values.annualLeaveEntitlement, 1.5);
});

test('missing-only planner fills zero but reports differing existing values as conflicts', () => {
  const plan = planMissingOnly(
    { basicSalary: 5000, housingAllowance: '', annualLeaveEntitlement: null },
    { basicSalary: 5000, housingAllowance: 0, annualLeaveEntitlement: 0, accountNumber: '0012' },
  );
  assert.deepEqual(
    { ...plan.patch },
    {
      housingAllowance: 0,
      annualLeaveEntitlement: 0,
      accountNumber: '0012',
    },
  );
  assert.deepEqual(plan.unchanged, ['basicSalary']);
  const conflict = planMissingOnly({ basicSalary: 5000 }, { basicSalary: 5200 });
  assert.deepEqual(conflict.conflicts, ['basicSalary']);
  assert.deepEqual({ ...conflict.patch }, {});
});

test('manifest binds exact file hash, rejects duplicate identities, and repeated apply is idempotent', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const manifest = validateManifest(
    {
      version: 1,
      sourceSha256,
      rows: [{ rowNumber: 2, employeeId: 'emp-sara', expectedRecordVersion: 1 }],
    },
    sourceSha256,
  );
  assert.throws(() =>
    validateManifest({ ...manifest, sourceSha256: 'b'.repeat(64) }, sourceSha256),
  );
  assert.throws(() =>
    validateManifest(
      {
        ...manifest,
        rows: [
          { rowNumber: 2, employeeId: 'emp-sara', expectedRecordVersion: 1 },
          { rowNumber: 3, employeeId: 'emp-sara', expectedRecordVersion: 1 },
        ],
      },
      sourceSha256,
    ),
  );

  const previousKey = process.env.HR_DATA_KEY;
  process.env.HR_DATA_KEY = randomBytes(32).toString('base64url');
  const db = await createDatabase();
  try {
    await ensureLocalAdmin(db);
    const employee = await readEmployee(db, 'emp-sara');
    assert.ok(employee);
    const version = employee.record_version;
    const rows = [
      {
        rowNumber: 2,
        sourceId: 'SRC-1',
        values: { annualLeaveEntitlement: 0 },
        issues: [],
      },
    ];
    const exactManifest = {
      version: 1 as const,
      sourceSha256,
      rows: [{ rowNumber: 2, employeeId: employee.id, expectedRecordVersion: version }],
    };
    const preview = await supplementProfiles(db, rows, sourceSha256, exactManifest, false);
    assert.equal(preview.fieldsToFill, 3); // entitlement plus unverified status and provenance
    assert.equal((await readEmployee(db, employee.id))!.record_version, version);

    const applied = await supplementProfiles(db, rows, sourceSha256, exactManifest, true);
    assert.equal(applied.appliedRows, 1);
    assert.equal((await getProfileValues(db, employee.id)).annualLeaveEntitlement, 0);
    const afterApply = await readEmployee(db, employee.id);
    assert.ok(afterApply);
    const repeated = await supplementProfiles(db, rows, sourceSha256, exactManifest, true);
    assert.equal(repeated.repeatedRows, 1);
    assert.equal(repeated.appliedRows, 0);
    assert.equal((await readEmployee(db, employee.id))!.record_version, afterApply.record_version);
  } finally {
    await db.close();
    if (previousKey === undefined) delete process.env.HR_DATA_KEY;
    else process.env.HR_DATA_KEY = previousKey;
  }
});

test('duplicate source IDs in a workbook are not matched through row mappings', async () => {
  const bytes = await workbookBytes(
    ['معرف المصدر', 'أيام الإجازة السنوية'],
    [
      ['SRC-1', 20],
      ['SRC-1', 22],
    ],
  );
  const mapped = await mapSabqSupplementWorkbook(bytes);
  const sourceSha256 = 'c'.repeat(64);
  const manifest = {
    version: 1 as const,
    sourceSha256,
    rows: [
      { rowNumber: 2, employeeId: 'emp-sara', expectedRecordVersion: 1 },
      { rowNumber: 3, employeeId: 'emp-omar', expectedRecordVersion: 1 },
    ],
  };
  const result = await supplementProfiles(
    {
      transaction: async () => {
        throw new Error('not used');
      },
    } as never,
    mapped.rows,
    sourceSha256,
    manifest,
    false,
  );
  assert.equal(result.unmatchedRows, 2);
  assert.equal(result.issueCounts.duplicate_source_id, 2);
});
