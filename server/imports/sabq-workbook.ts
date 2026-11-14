// Maps the Sabq employee export workbook (Arabic headers, optional embedded photos) to
// employee profile fields. Used only by the local private import (scripts/private-import.ts);
// it never runs in the hosted preview. See docs/private-local.md and decision 005.
import ExcelJS from 'exceljs';
import type { FormValues } from '../../shared/administration.js';
import { inspectWorkbookZip } from './workbook.js';

export type ImportedPhoto = { mime: 'image/png' | 'image/jpeg'; bytes: Buffer };
export type MappedRow = {
  rowNumber: number;
  values: FormValues;
  photo?: ImportedPhoto;
  /** Codes only (never values), safe to print. */
  issues: string[];
};
export type MappedWorkbook = {
  rows: MappedRow[];
  mappedColumns: string[];
  ignoredColumns: string[];
  photosFound: number;
};

export type SupplementRow = {
  rowNumber: number;
  /** Present only when the export itself carries a declared immutable source key. */
  sourceId?: string;
  values: FormValues;
  issues: string[];
};
export type SupplementWorkbook = {
  rows: SupplementRow[];
  mappedColumns: string[];
  ignoredColumns: string[];
};

const SUPPLEMENT_COLUMN_MAP: Record<string, string> = {
  'معرف المصدر': '$sourceId',
  'رقم المصدر': '$sourceId',
  'معرف الموظف': '$sourceId',
  'الرقم الوظيفي': '$sourceId',
  'Employee ID': '$sourceId',
  'Source ID': '$sourceId',
  'الراتب الأساسي': 'basicSalary',
  'بدل السكن': 'housingAllowance',
  'بدل النقل': 'transportAllowance',
  'بدلات ثابتة أخرى': 'otherAllowance',
  'تاريخ سريان الراتب': 'salaryEffectiveDate',
  'مصدر بيانات الراتب': 'salarySource',
  'نوع الموظف': 'relationshipType',
  نبذة: 'bio',
  البنك: 'bankName',
  الآيبان: 'iban',
  'دولة البنك': 'bankCountry',
  'رقم الحساب': 'accountNumber',
  'نوع الحساب': 'accountType',
  'العملة المفضلة': 'currency',
  سويفت: 'swiftCode',
  'فرع البنك': 'bankBranch',
  'الاسم لدى البنك': 'bankAccountName',
  'تاريخ تحديث الحساب البنكي': 'bankUpdatedAt',
  'مصدر التحقق المصرفي': 'bankVerificationSource',
  'تاريخ التحقق المصرفي': 'bankVerifiedAt',
  'رقم التأمينات الاجتماعية': 'insuranceNumber',
  'بداية التأمينات': 'insuranceStartDate',
  'مصدر بيانات التأمينات': 'insuranceSource',
  'تاريخ سريان بيانات التأمينات': 'insuranceEffectiveDate',
  'لديه تأمين طبي': 'medicalCoverageStatus',
  'شركة التأمين الطبي': 'medicalProvider',
  'رقم التأمين الطبي': 'medicalPolicyNumber',
  'أيام الإجازة السنوية': 'annualLeaveEntitlement',
};
const SUPPLEMENT_DATE_FIELDS = new Set([
  'salaryEffectiveDate',
  'bankUpdatedAt',
  'bankVerifiedAt',
  'insuranceStartDate',
  'insuranceEffectiveDate',
]);
const SUPPLEMENT_MONEY_FIELDS = new Set([
  'basicSalary',
  'housingAllowance',
  'transportAllowance',
  'otherAllowance',
]);

function parseMoney(value: ExcelJS.CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const raw = text(value)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٬,]/g, '')
    .replace(/٫/g, '.')
    .replace(/\s/g, '');
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const result = Number(raw);
  return Number.isFinite(result) ? result : null;
}

function parseCount(value: ExcelJS.CellValue): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 && Number.isInteger(value * 100) ? value : null;
  const raw = text(value)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/٫/g, '.')
    .trim();
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const result = Number(raw);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function mapRelationship(value: string): string | null {
  const normalized = value.replace(/\s/g, '').toLowerCase();
  if (
    ['موظف', 'موظفة', 'موظفون', 'موظفرسمي', 'موظفةرسمية', 'employee', 'employees'].includes(
      normalized,
    )
  )
    return 'employee';
  if (['متعاون', 'متعاونة', 'متعاونون', 'collaborator', 'collaborators'].includes(normalized))
    return 'collaborator';
  return null;
}

function mapAccountType(value: string): string | null {
  const normalized = value.replace(/\s/g, '').toLowerCase();
  if (/جاري|current|checking/.test(normalized)) return 'current';
  if (/ادخار|توفير|savings?/.test(normalized)) return 'savings';
  if (/أخرى|اخرى|other/.test(normalized)) return 'other';
  return null;
}

function mapCoverage(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (YES.has(normalized)) return 'covered';
  if (NO.has(normalized)) return 'not_covered';
  return null;
}

/** Maps optional profile fields without inferring empty values or printing workbook contents. */
export async function mapSabqSupplementWorkbook(bytes: Buffer): Promise<SupplementWorkbook> {
  inspectWorkbookZip(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no sheets.');
  const headers = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(column, text(cell.value)));
  const mappedColumns = [...headers.values()].filter((header) => header in SUPPLEMENT_COLUMN_MAP);
  const ignoredColumns = [...headers.values()].filter(
    (header) => header && !(header in SUPPLEMENT_COLUMN_MAP),
  );
  const rows: SupplementRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const values: FormValues = Object.create(null) as FormValues;
    const issues: string[] = [];
    let sourceId: string | undefined;
    for (const [column, header] of headers) {
      const field = SUPPLEMENT_COLUMN_MAP[header];
      if (!field) continue;
      const cell = sheet.getRow(r).getCell(column).value;
      const raw = text(cell);
      if (!raw) continue;
      if (field === '$sourceId') {
        sourceId = raw;
      } else if (SUPPLEMENT_DATE_FIELDS.has(field)) {
        const date = parseDate(cell);
        if (date) values[field] = date;
        else issues.push(`invalid_date:${field}`);
      } else if (SUPPLEMENT_MONEY_FIELDS.has(field)) {
        const amount = parseMoney(cell);
        if (amount !== null) values[field] = amount;
        else issues.push(`invalid_money:${field}`);
      } else if (field === 'annualLeaveEntitlement') {
        const days = parseCount(cell);
        if (days !== null && days <= 366) values[field] = days;
        else issues.push(`invalid_number:${field}`);
      } else if (field === 'relationshipType') {
        const relationship = mapRelationship(raw);
        if (relationship) values[field] = relationship;
        else issues.push(`unknown_relationship:${field}`);
      } else if (field === 'medicalCoverageStatus') {
        const coverage = mapCoverage(raw);
        if (coverage) values[field] = coverage;
        else issues.push(`unknown_coverage:${field}`);
      } else if (field === 'accountType') {
        const accountType = mapAccountType(raw);
        if (accountType) values[field] = accountType;
        else issues.push(`unknown_account_type:${field}`);
      } else {
        values[field] = raw;
      }
    }
    if (sourceId || Object.keys(values).length || issues.length)
      rows.push({ rowNumber: r, sourceId, values, issues });
  }
  return { rows, mappedColumns, ignoredColumns };
}

/** Workbook header → employee field key. Columns not listed here are ignored on purpose. */
export const COLUMN_MAP: Record<string, string> = {
  'اسم الموظف': 'name',
  'المسمى الوظيفي': 'title',
  القسم: 'department',
  'تاريخ التعيين': 'joinDate',
  'تاريخ انتهاء الخدمة': 'separationDate',
  الجنسية: 'nationality',
  'رقم الهوية أو الإقامة': 'nationalId',
  'انتهاء الإقامة': 'nationalIdExpiry',
  'رقم الجواز': 'passportNumber',
  'انتهاء الجواز': 'passportExpiry',
  'البريد الإلكتروني': 'email',
  الجوال: 'mobile',
  العنوان: 'nationalAddress',
  'رقم التأمينات الاجتماعية': 'insuranceNumber',
  البنك: 'bankName',
  الآيبان: 'iban',
  'اسم جهة اتصال الطوارئ': 'emergencyName',
  'جوال الطوارئ': 'emergencyMobile',
};
const STATUS_COLUMN = 'على رأس العمل';
const PHOTO_COLUMN = 'الصورة';
const OTHER_BANK_COLUMN = 'اسم البنك الآخر';
const DATE_FIELDS = new Set(['joinDate', 'separationDate', 'nationalIdExpiry', 'passportExpiry']);
const YES = new Set(['نعم', 'yes', 'true', '1', 'صح', '✓', 'نشط']);
const NO = new Set(['لا', 'no', 'false', '0', 'خطأ', '✗', 'غير نشط']);
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value)
      return value.richText
        .map((part) => part.text)
        .join('')
        .trim();
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('result' in value) return text(value.result as ExcelJS.CellValue);
    return '';
  }
  return String(value).trim();
}
function iso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    year < 1900 ||
    year > 2100
  )
    return null;
  return date.toISOString().slice(0, 10);
}
/** Gregorian dates only: YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY, or Excel dates. */
export function parseDate(value: ExcelJS.CellValue): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = text(value)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/T.*$/, '');
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));
  match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) return iso(Number(match[3]), Number(match[2]), Number(match[1]));
  return null;
}
function imageMime(bytes: Buffer): ImportedPhoto['mime'] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  return null;
}

export async function mapSabqWorkbook(bytes: Buffer): Promise<MappedWorkbook> {
  inspectWorkbookZip(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no sheets.');
  const headers = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(column, text(cell.value)));
  const columnOf = (header: string) =>
    [...headers.entries()].find(([, name]) => name === header)?.[0];
  for (const required of ['اسم الموظف', 'البريد الإلكتروني'])
    if (!columnOf(required)) throw new Error(`Missing required column: ${required}`);
  const known = new Set([
    ...Object.keys(COLUMN_MAP),
    STATUS_COLUMN,
    PHOTO_COLUMN,
    OTHER_BANK_COLUMN,
  ]);
  const mappedColumns = [...headers.values()].filter((h) => known.has(h));
  const ignoredColumns = [...headers.values()].filter((h) => h && !known.has(h));

  // Photos anchored in the photo column, keyed by worksheet row number.
  const photos = new Map<number, ImportedPhoto | 'invalid'>();
  const photoColumn = columnOf(PHOTO_COLUMN);
  if (photoColumn)
    for (const image of sheet.getImages()) {
      const col = Math.floor(image.range.tl.nativeCol ?? image.range.tl.col) + 1;
      const row = Math.floor(image.range.tl.nativeRow ?? image.range.tl.row) + 1;
      if (col !== photoColumn) continue;
      const media = workbook.getImage(Number(image.imageId));
      const buffer = media?.buffer ? Buffer.from(media.buffer as ArrayBuffer) : undefined;
      const mime = buffer ? imageMime(buffer) : null;
      photos.set(
        row,
        buffer && mime && buffer.length <= MAX_PHOTO_BYTES ? { mime, bytes: buffer } : 'invalid',
      );
    }

  const rows: MappedRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const issues: string[] = [];
    const values: FormValues = Object.create(null) as FormValues;
    for (const [column, header] of headers) {
      const field = COLUMN_MAP[header];
      if (!field) continue;
      const cell = row.getCell(column).value;
      if (DATE_FIELDS.has(field)) {
        if (!text(cell)) continue;
        const date = parseDate(cell);
        if (date) values[field] = date;
        else issues.push(`invalid_date:${field}`);
      } else {
        const value = text(cell);
        if (value) values[field] = field === 'email' ? value.toLowerCase() : value;
      }
    }
    if (!values.name && !values.email) continue; // blank line
    const otherBank = columnOf(OTHER_BANK_COLUMN);
    if (
      otherBank &&
      text(row.getCell(otherBank).value) &&
      (!values.bankName || /أخر/.test(String(values.bankName)))
    )
      values.bankName = text(row.getCell(otherBank).value);
    const statusColumn = columnOf(STATUS_COLUMN);
    const status = statusColumn ? text(row.getCell(statusColumn).value).toLowerCase() : '';
    if (YES.has(status)) values.employmentStatus = 'active';
    else if (NO.has(status)) values.employmentStatus = 'terminated';
    else if (values.separationDate) values.employmentStatus = 'terminated';
    else issues.push('status_unknown_defaulted_active');
    // Required by the profile schema but absent from this export: explicit placeholders
    // that HR must review; never inferred from other columns.
    if (!values.title) ((values.title = 'غير محدد'), issues.push('placeholder:title'));
    if (!values.department)
      ((values.department = 'غير محدد'), issues.push('placeholder:department'));
    values.location = 'غير محدد';
    if (!values.joinDate) issues.push('missing:joinDate');
    if (!values.email) issues.push('missing:email');
    const photo = photos.get(r);
    if (photo === 'invalid') issues.push('photo_invalid');
    rows.push({
      rowNumber: r,
      values,
      photo: photo && photo !== 'invalid' ? photo : undefined,
      issues,
    });
  }
  return {
    rows,
    mappedColumns,
    ignoredColumns,
    photosFound: [...photos.values()].filter((p) => p !== 'invalid').length,
  };
}
