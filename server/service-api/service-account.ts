/**
 * Stored actor row for the «محاسب سبق» service key (phase 2 writes).
 *
 * Profile history (actor_id), profile data (updated_by) and payroll runs (prepared_by) reference
 * employees(id). Rather than drop or rebuild those constraints, the key gets one fixed row:
 * - created lazily, inside the first write's transaction, never by a migration;
 * - employment_status 'suspended', no access_role, no employee_accounts row: it can never sign
 *   in, never receives work, and fails every "active employee" filter;
 * - hidden from the employee_access view (migration 016), so directories, payroll lines, leave,
 *   access management, exports and search never list it.
 * The row exists only so the existing foreign keys and audit joins resolve to «محاسب سبق».
 */
import type { AsyncDb } from '../database.js';
import { todayInRiyadh } from '../database.js';
import { SERVICE_ACCOUNT } from './keys.js';

export const SERVICE_ACCOUNT_EMPLOYEE_NUMBER = 'SVC-SABQ-ACCOUNTANT';

export async function ensureServiceAccountRow(tx: AsyncDb): Promise<void> {
  const existing = await tx.read<{ id: string }>('SELECT id FROM employees WHERE id=?', [
    SERVICE_ACCOUNT.id,
  ]);
  if (existing.length) return;
  await tx.execute(
    `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,access_role,employment_status)
    VALUES(?,?,?,?,?,?,?,?,NULL,?,'employee',?,NULL,'suspended') ON CONFLICT(id) DO NOTHING`,
    [
      SERVICE_ACCOUNT.id,
      SERVICE_ACCOUNT_EMPLOYEE_NUMBER,
      SERVICE_ACCOUNT.name,
      'م س',
      'حساب خدمة آلي بلا دخول',
      'حسابات الخدمة',
      'svc-sabq-accountant@service.invalid',
      '—',
      todayInRiyadh(),
      '#64748b',
    ],
  );
}
