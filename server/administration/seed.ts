import { todayInRiyadh, type AsyncDb } from '../database.js';
import { employeeFields } from '../../shared/catalog.js';
import type { FormValues } from '../../shared/administration.js';
import { encryptSensitive } from './security.js';
import { readEmployee } from './service.js';

const DEMO_EMPLOYEE_IDS = [
  'emp-omar',
  'emp-noura',
  'emp-sara',
  'emp-fahad',
  'emp-lina',
  'emp-yousef',
  'emp-maha',
  'emp-khaled',
  'emp-reem',
  'emp-abdullah',
  'emp-hind',
] as const;
function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
function split(values: FormValues) {
  const sensitive: FormValues = Object.create(null) as FormValues;
  const ordinary: FormValues = Object.create(null) as FormValues;
  const fields = new Map(employeeFields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(values)) {
    if (fields.get(key)?.sensitive) sensitive[key] = value;
    else ordinary[key] = value;
  }
  return { ordinary, sensitive };
}

/** Fill only absent profiles with fictional fixture values; never overwrite user edits. */
export async function seedAdministrationProfiles(db: AsyncDb): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const [index, employeeId] of DEMO_EMPLOYEE_IDS.entries()) {
      const employee = await readEmployee(tx, employeeId);
      if (!employee) continue;
      const existing = (
        await tx.read<{ employee_id: string }>(
          'SELECT employee_id FROM employee_profile_data WHERE employee_id=?',
          [employeeId],
        )
      )[0];
      if (existing) continue;
      const suffix = String(index + 1).padStart(2, '0');
      const values: FormValues = {
        englishName: `Synthetic Employee ${suffix}`,
        nationality: 'جنسية تجريبية',
        nationalId: `DEMO-ID-${suffix}`,
        mobile: `0500000${String(100 + index).slice(-3)}`,
        emergencyName: `Synthetic Contact ${suffix}`,
        emergencyMobile: `0500001${String(100 + index).slice(-3)}`,
        qualification: index % 2 ? 'بكالوريوس تجريبي' : 'دبلوم تجريبي',
        specialization: 'اتصال وإعلام',
        contractType: 'fixed',
        contractStart: employee.join_date,
        contractEnd: addMonths(todayInRiyadh(), 9),
        renewalCount: 1,
        cumulativeContractMonths: 36,
        basicSalary: 10000 + index * 500,
        housingAllowance: 2500,
        transportAllowance: 750,
        otherAllowance: 0,
        bankName: 'بنك تجريبي',
        iban: `DEMO-ACCOUNT-${suffix}`,
        insuranceNumber: `DEMO-INS-${suffix}`,
        insuranceCategory: 'unreviewed',
        insuredWage: 10000 + index * 500,
        schedule: 'جدول تجريبي؛ راجع السياسة قبل الاعتماد',
      };
      const { ordinary, sensitive } = split(values);
      await tx.execute(
        `INSERT INTO employee_profile_data(employee_id,public_values_json,encrypted_values_json,version,updated_at,updated_by)
         VALUES(?,?,?,?,?,?) ON CONFLICT(employee_id) DO NOTHING`,
        [
          employeeId,
          JSON.stringify(ordinary),
          Object.keys(sensitive).length
            ? encryptSensitive(JSON.stringify(sensitive), `employee-profile:${employeeId}`)
            : '{}',
          1,
          now,
          'synthetic-seed',
        ],
      );
    }
  });
}
