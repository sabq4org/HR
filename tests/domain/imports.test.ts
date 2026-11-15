import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import ExcelJS from 'exceljs';
import {
  employeesTemplate,
  parseEmployeesWorkbook,
  inspectWorkbookZip,
} from '../../server/imports/workbook.js';
import { createDatabase } from '../../server/database.js';
import { createApp } from '../../server/app.js';

test('Excel template round trips Arabic fields; formulas, oversized workbooks and duplicate rows are rejected', async () => {
  const bytes = await employeesTemplate();
  const preview = await parseEmployeesWorkbook(bytes);
  assert.equal(preview.valid, true);
  assert.equal(preview.total, 1);
  assert.equal(preview.rows[0].values.name, 'موظف تجريبي');
  assert.equal(preview.rows[0].values.employmentStatus, 'active');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet('الموظفون')!;
  sheet.addRow(sheet.getRow(2).values);
  const duplicates = await parseEmployeesWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(duplicates.valid, false);
  assert.ok(duplicates.rows[1].errors.some((e) => e.includes('مكرر')));
  sheet.getCell('A2').value = { formula: 'HYPERLINK("https://example.com","x")', result: 'x' };
  await assert.rejects(
    parseEmployeesWorkbook(Buffer.from(await workbook.xlsx.writeBuffer())),
    /الصيغ/,
  );
  assert.throws(() => inspectWorkbookZip(Buffer.alloc(2 * 1024 * 1024 + 1)), /حجم/);
  assert.throws(() => inspectWorkbookZip(Buffer.from('not an Excel workbook')), /حجم|صالح/);
});

test('Employee imports require HR, preview duplicates, commit atomically and replay without duplicates', async () => {
  const db = await createDatabase();
  const server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    key = 'import-test-command',
  ) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { origin: base, cookie, 'content-type': 'application/json', 'idempotency-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (id: string) => {
    const r = await request('/demo/session', 'POST', { employeeId: id });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
  };
  try {
    await login('emp-sara');
    assert.equal((await request('/admin/imports/employees/template')).status, 403);
    await login('emp-noura');
    const template = await request('/admin/imports/employees/template');
    assert.equal(template.status, 200);
    const bytes = Buffer.from(await template.arrayBuffer());
    const previewResponse = await request('/admin/imports/employees/preview', 'POST', {
      filename: 'employees.xlsx',
      contentBase64: bytes.toString('base64'),
    });
    assert.equal(previewResponse.status, 200);
    const { preview } = await previewResponse.json();
    assert.equal(preview.valid, true);
    const rows = preview.rows.map((row: { values: unknown }) => row.values);
    const before = (await db.read<{ n: number }>('SELECT COUNT(*) AS n FROM employees'))[0].n;
    const saved = await request('/admin/imports/employees/commit', 'POST', { rows });
    assert.equal(saved.status, 201, await saved.clone().text());
    const savedBody = await saved.json();
    const replay = await request('/admin/imports/employees/commit', 'POST', { rows });
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), savedBody);
    assert.equal(
      (await db.read<{ n: number }>('SELECT COUNT(*) AS n FROM employees'))[0].n,
      before + 1,
    );
    const failedBatch = await request(
      '/admin/imports/employees/commit',
      'POST',
      { rows: [{ ...rows[0], employeeNumber: 'ROLLBACK-UNIQUE' }, rows[0]] },
      'import-rollback-command',
    );
    assert.equal(failedBatch.status, 409);
    assert.equal(
      (
        await db.read<{ n: number }>(
          "SELECT COUNT(*) AS n FROM employees WHERE employee_number='ROLLBACK-UNIQUE'",
        )
      )[0].n,
      0,
    );
    const duplicatePreview = await request('/admin/imports/employees/preview', 'POST', {
      filename: 'employees.xlsx',
      contentBase64: bytes.toString('base64'),
    });
    const duplicate = await duplicatePreview.json();
    // An employee already in the system is skipped on save, not an error (owner feedback).
    assert.equal(duplicate.preview.valid, true);
    assert.equal(duplicate.preview.rows[0].existing, true);
    assert.equal(duplicate.preview.existing, 1);
    assert.equal(duplicate.preview.ready, 0);

    // A mixed file: one already imported, one new, one with a mistake. The mistaken row comes
    // back as an XLSX with a «سبب الرفض» column, and the fixed file uploads again whole.
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheet = book.getWorksheet('الموظفون')!;
    const header = sheet.getRow(1).values as unknown[];
    const col = (label: string) => header.findIndex((v) => v === label);
    const sample = sheet.getRow(2).values as unknown[];
    const add = (number: string, joinDate: string) => {
      const row = [...sample];
      row[col('الرقم الوظيفي')] = number;
      row[col('تاريخ المباشرة الفعلي')] = joinDate;
      sheet.addRow(row.slice(1));
    };
    add('MIX-NEW', '2026-11-01');
    add('MIX-BAD', '01/11/2026');
    const mixed = Buffer.from(await book.xlsx.writeBuffer());
    const mixedPreview = (
      await (
        await request('/admin/imports/employees/preview', 'POST', {
          filename: 'mixed.xlsx',
          contentBase64: mixed.toString('base64'),
        })
      ).json()
    ).preview;
    assert.equal(mixedPreview.existing, 1);
    assert.equal(mixedPreview.ready, 1);
    assert.equal(mixedPreview.invalid, 1);
    assert.equal(mixedPreview.valid, false);
    assert.ok(mixedPreview.rejectedWorkbookBase64);
    const rejected = new ExcelJS.Workbook();
    await rejected.xlsx.load(
      Buffer.from(mixedPreview.rejectedWorkbookBase64, 'base64') as unknown as Parameters<
        typeof rejected.xlsx.load
      >[0],
    );
    const back = rejected.getWorksheet('الموظفون')!;
    assert.equal(back.getRow(1).getCell(1).value, 'سبب الرفض');
    assert.equal(back.rowCount, 2);
    assert.match(String(back.getRow(2).getCell(1).value), /تاريخ/);
    // Fix the date in the returned file and upload it as is: the reasons column is ignored.
    const backHeader = back.getRow(1).values as unknown[];
    back.getRow(2).getCell(backHeader.findIndex((v) => v === 'تاريخ المباشرة الفعلي')).value =
      '2026-11-02';
    const fixed = Buffer.from(await rejected.xlsx.writeBuffer());
    const fixedPreview = (
      await (
        await request('/admin/imports/employees/preview', 'POST', {
          filename: 'fixed.xlsx',
          contentBase64: fixed.toString('base64'),
        })
      ).json()
    ).preview;
    assert.equal(fixedPreview.valid, true, JSON.stringify(fixedPreview.rows[0]?.errors));
    assert.equal(fixedPreview.ready, 1);
    assert.equal(fixedPreview.rows[0].values.employeeNumber, 'MIX-BAD');
    await login('emp-sara');
    assert.equal((await request('/admin/imports/employees/commit', 'POST', { rows })).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
