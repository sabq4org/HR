import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { employeeFields } from '../../shared/catalog.js';
import type { EmployeeImportPreview, ImportRow } from '../../shared/imports.js';

export const IMPORT_LIMIT = 2 * 1024 * 1024;
const fault = (message: string) =>
  Object.assign(new Error(message), { status: 400, code: 'INVALID_WORKBOOK' });

// Validate both declared and actual expanded sizes before the workbook parser.
// XLSX is a ZIP container; a small input alone is not a safe resource bound.
export function inspectWorkbookZip(bytes: Buffer) {
  if (bytes.length > IMPORT_LIMIT || bytes.length < 22)
    throw fault('حجم ملف Excel يجب ألا يتجاوز 2 ميجابايت.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    throw fault('ملف Excel غير صالح. استخدم قالب XLSX المرفق.');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  if (!count || count > 120 || cursor + size !== end)
    throw fault('بنية ملف Excel غير مدعومة. انسخ البيانات إلى القالب المرفق.');
  const seen = new Set<string>();
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw fault('تعذر قراءة ملف Excel.');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const original = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || local + 30 > bytes.length || flags & 1 || ![0, 8].includes(method))
      throw fault('ملفات Excel المشفرة أو غير القياسية غير مدعومة.');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (seen.has(name) || /(?:^\/|\.\.|\\|vbaProject|externalLinks|embeddings|\.bin$)/i.test(name))
      throw fault('الملف يحتوي على روابط خارجية أو محتوى مدمج غير مسموح.');
    seen.add(name);
    expanded += original;
    if (original > 4 * 1024 * 1024 || expanded > 8 * 1024 * 1024)
      throw fault('محتوى الملف أكبر من الحد المسموح. استخدم 100 موظف أو أقل في كل دفعة.');
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw fault('ملف Excel تالف.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > cursor || start > bytes.length) throw fault('ملف Excel تالف.');
    const packed = bytes.subarray(start, start + compressed);
    let content: Buffer;
    try {
      content =
        method === 8 ? inflateRawSync(packed, { maxOutputLength: 4 * 1024 * 1024 }) : packed;
    } catch {
      throw fault('تعذر فتح ملف Excel أو تجاوز حجمه الحد المسموح.');
    }
    if (content.length !== original) throw fault('حجم محتوى Excel غير متطابق.');
    if (/\.xml$|\.rels$/i.test(name)) {
      const xml = content.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']|<f(?:\s|>)/i.test(xml))
        throw fault('الصيغ الحسابية والروابط الخارجية غير مسموحة في الاستيراد. استخدم قيمًا فقط.');
    }
    cursor = next;
  }
  if (!seen.has('[Content_Types].xml') || !seen.has('xl/workbook.xml'))
    throw fault('الملف ليس مصنف XLSX.');
}

export async function parseEmployeesWorkbook(bytes: Buffer): Promise<EmployeeImportPreview> {
  inspectWorkbookZip(bytes);
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  } catch {
    throw fault('تعذر قراءة الملف. أعد حفظه بصيغة XLSX.');
  }
  const sheet = book.getWorksheet('الموظفون') ?? book.worksheets[0];
  if (!sheet || sheet.rowCount > 101 || sheet.columnCount > employeeFields.length)
    throw fault('استخدم ورقة لا تتجاوز 100 موظف وبنفس أعمدة القالب.');
  const headers: string[] = [];
  const fields = new Map(
    employeeFields.flatMap((f) => [
      [f.key, f],
      [f.label, f],
    ]),
  );
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    if (typeof cell.value !== 'string')
      throw fault('عناوين الأعمدة غير صالحة. استخدم القالب المرفق.');
    const f = fields.get(cell.value.trim());
    if (!f || headers.includes(f.key))
      throw fault(`عمود غير معروف أو مكرر: ${cell.text.slice(0, 60)}`);
    headers[col - 1] = f.key;
  });
  const missing = employeeFields.filter((f) => f.required && !headers.includes(f.key));
  if (missing.length)
    throw fault(`أعمدة مطلوبة غير موجودة: ${missing.map((f) => f.label).join('، ')}`);
  const rows: ImportRow[] = [];
  const numbers = new Set<string>();
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    if (!row.hasValues) continue;
    const result: ImportRow = { rowNumber: n, values: {}, errors: [] };
    for (let c = 1; c <= headers.length; c++) {
      const key = headers[c - 1];
      const f = employeeFields.find((f) => f.key === key)!;
      const raw = row.getCell(c).value;
      if (raw === null || raw === undefined || raw === '') {
        if (f.required) result.errors.push(`${f.label}: حقل مطلوب`);
        continue;
      }
      if (typeof raw === 'object' && !(raw instanceof Date)) {
        result.errors.push(`${f.label}: استخدم قيمة فقط`);
        continue;
      }
      const value = raw instanceof Date ? raw.toISOString().slice(0, 10) : raw;
      if (f.type === 'number' || f.type === 'money') {
        const number = Number(value);
        if (
          !Number.isFinite(number) ||
          (f.min !== undefined && number < f.min) ||
          (f.max !== undefined && number > f.max) ||
          (f.type === 'money' && Math.abs(number * 100 - Math.round(number * 100)) > 0.000001)
        )
          result.errors.push(`${f.label}: رقم غير صالح`);
        else result.values[key] = number;
      } else if (f.type === 'checkbox') {
        if (![true, false, 'نعم', 'لا', 'true', 'false', 1, 0].includes(value))
          result.errors.push(`${f.label}: استخدم نعم أو لا`);
        else result.values[key] = [true, 'نعم', 'true', 1].includes(value);
      } else {
        const text = String(value).trim();
        if (text.length > 2000 || /^[=+@\t\r]/.test(text))
          result.errors.push(`${f.label}: قيمة غير صالحة`);
        else if (
          f.type === 'date' &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
            !Number.isFinite(Date.parse(text)) ||
            new Date(text).toISOString().slice(0, 10) !== text)
        )
          result.errors.push(`${f.label}: استخدم YYYY-MM-DD`);
        else if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
          result.errors.push(`${f.label}: بريد غير صالح`);
        else if (f.type === 'select') {
          const option = f.options?.find((o) => o.value === text || o.label === text);
          if (!option) result.errors.push(`${f.label}: اختيار غير صالح`);
          else result.values[key] = option.value;
        } else result.values[key] = text;
      }
    }
    const number = String(result.values.employeeNumber ?? '');
    if (numbers.has(number)) result.errors.push('الرقم الوظيفي مكرر في الملف');
    numbers.add(number);
    rows.push(result);
  }
  if (!rows.length) throw fault('الملف لا يحتوي على صفوف موظفين.');
  return { rows, total: rows.length, valid: rows.every((row) => !row.errors.length) };
}

export async function employeesTemplate() {
  const book = new ExcelJS.Workbook();
  book.creator = 'مساحة فريق سبق';
  const sheet = book.addWorksheet('الموظفون', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = employeeFields.map((f) => ({ header: f.label, key: f.key, width: 25 }));
  sheet.getRow(1).height = 34;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1264A3' } };
  });
  sheet.addRow({
    name: 'موظف تجريبي',
    employeeNumber: 'DEMO-100',
    email: 'sample@example.invalid',
    department: 'التحرير',
    title: 'محرر تجريبي',
    joinDate: '2026-11-01',
    location: 'الرياض',
    employmentStatus: 'active',
  });
  const guide = book.addWorksheet('إرشادات', { views: [{ rightToLeft: true }] });
  guide.columns = [
    { header: 'الحقل', width: 33 },
    { header: 'مطلوب', width: 12 },
    { header: 'القيم والإرشادات', width: 95 },
  ];
  employeeFields.forEach((f) =>
    guide.addRow([
      f.label,
      f.required ? 'نعم' : 'لا',
      f.options?.map((o) => `${o.label} (${o.value})`).join(' / ') ||
        f.hint ||
        (f.type === 'date'
          ? 'YYYY-MM-DD'
          : f.type === 'employee'
            ? 'المعرف الداخلي للموظف، مثل emp-omar'
            : f.type === 'checkbox'
              ? 'نعم / لا'
              : ''),
    ]),
  );
  guide.addRow([
    'المعاينة',
    '',
    'بيانات وهمية فقط. حد الدفعة 100 موظف. احذف الصف التجريبي أو استبدله قبل الاستيراد. لا صيغ ولا روابط خارجية.',
  ]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
