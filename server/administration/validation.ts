import type { FormField, FormValues } from '../../shared/administration.js';
import type { Role } from '../../shared/contracts.js';

export type ApiFault = Error & { status: number; code: string };
export function fault(status: number, code: string, message: string): ApiFault {
  return Object.assign(new Error(message), { status, code });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateField(
  field: FormField,
  value: unknown,
): value is string | number | boolean | null {
  if (value === null) return !field.required;
  if (value === undefined) return !field.required;
  switch (field.type) {
    case 'number':
    case 'money':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max) &&
        Number.isSafeInteger(Math.round(value * 100)) &&
        (field.type !== 'money' || Math.abs(Math.round(value * 100) - value * 100) < 1e-6)
      );
    case 'checkbox':
      return typeof value === 'boolean' && (!field.required || value === true);
    case 'date':
      return typeof value === 'string' && validDate(value);
    case 'select':
      return (
        typeof value === 'string' && (field.options ?? []).some((option) => option.value === value)
      );
    case 'employee':
      return typeof value === 'string' && value.length > 0 && value.length <= 120;
    case 'email':
      return (
        typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      );
    case 'text':
    case 'textarea':
      return typeof value === 'string' && value.length <= (field.type === 'textarea' ? 5000 : 500);
  }
}

export function validateValues(
  fields: FormField[],
  input: unknown,
  options: { partial?: boolean } = {},
): FormValues {
  if (!isRecord(input)) throw fault(400, 'INVALID_VALUES', 'صيغة بيانات النموذج غير صالحة.');
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const unknown = Object.keys(input).filter((key) => !byKey.has(key));
  if (unknown.length) throw fault(400, 'UNKNOWN_FIELDS', 'يحتوي النموذج على حقول غير معتمدة.');
  const output: FormValues = Object.create(null) as FormValues;
  for (const field of fields) {
    const raw = input[field.key];
    const value =
      raw === '' &&
      !field.required &&
      ['select', 'date', 'employee', 'email', 'text', 'textarea'].includes(field.type)
        ? null
        : raw;
    if (value === undefined && options.partial) continue;
    if (value === undefined && !field.required) continue;
    if (field.required && (value === null || value === '' || value === undefined)) {
      throw fault(400, 'REQUIRED_FIELD', `الحقل «${field.label}» مطلوب.`);
    }
    if (!validateField(field, value))
      throw fault(400, 'INVALID_FIELD', `تحقق من الحقل «${field.label}».`);
    output[field.key] = value as FormValues[string];
  }
  return output;
}

export function roleFromState(state: string): Role | null {
  if (state === 'pending_manager') return 'manager';
  if (state === 'pending_hr') return 'hr';
  if (state === 'pending_finance') return 'finance';
  if (state === 'pending_approver') return 'approver';
  return null;
}

export function stateForRole(role: Role): string {
  if (role === 'manager') return 'pending_manager';
  if (role === 'hr') return 'pending_hr';
  if (role === 'finance') return 'pending_finance';
  if (role === 'approver') return 'pending_approver';
  return 'pending_approver';
}

export function safeFilename(value: string): string {
  const name = value
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!name || name.length > 160) throw fault(400, 'INVALID_FILENAME', 'اسم الملف غير صالح.');
  return name;
}

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  text = text.replace(/[\r\n]+/g, ' ');
  if (/^[\s]*[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
