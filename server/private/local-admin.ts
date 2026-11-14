// Local administration for the private (real-data) mode: import, role grants, managers.
// Runs only from scripts on the owner's machine against .data/hr-private.sqlite.
// Never exposed as an HTTP route. See docs/private-local.md and decision 005.
import { randomUUID } from 'node:crypto';
import type { Role } from '../../shared/contracts.js';
import type { AsyncDb } from '../database.js';
import { encryptSensitive, sha256 } from '../administration/security.js';
import {
  appendEvent,
  createEmployee,
  readEmployee,
  type Actor,
} from '../administration/service.js';
import type { MappedWorkbook } from '../imports/sabq-workbook.js';

/**
 * Audit and history rows reference employees(id), so local tools act through one
 * inactive service account. It is terminated, so it can never sign in or approve.
 */
export const LOCAL_ADMIN_ID = 'system-local-admin';
const LOCAL_ADMIN: Actor = { id: LOCAL_ADMIN_ID, role: 'hr' };
const GRANTABLE: Role[] = ['employee', 'manager', 'hr', 'finance', 'approver', 'auditor'];

export async function ensureLocalAdmin(db: AsyncDb): Promise<void> {
  await db.execute(
    `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,access_role,employment_status)
     VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,NULL,'terminated') ON CONFLICT(id) DO NOTHING`,
    [
      LOCAL_ADMIN_ID,
      'SYSTEM-LOCAL',
      'أدوات الإدارة المحلية (حساب نظام)',
      'نظام',
      'حساب نظام غير قابل للدخول',
      'النظام',
      'system-local-admin@invalid.local',
      'هذا الجهاز',
      '2000-01-01',
      'employee',
      '#E4E5E7',
    ],
  );
}

export type ImportSummary = {
  imported: number;
  photos: number;
  skipped: { rowNumber: number; reason: string }[];
  issueCounts: Record<string, number>;
};

async function nextEmployeeNumber(tx: AsyncDb): Promise<string> {
  const rows = await tx.read<{ employee_number: string }>(
    "SELECT employee_number FROM employees WHERE employee_number LIKE 'SBQ-%'",
  );
  const max = rows.reduce((m, r) => Math.max(m, Number(r.employee_number.slice(4)) || 0), 0);
  return `SBQ-${String(max + 1).padStart(4, '0')}`;
}

/** Placeholder email for a person the workbook lists without one. Can never sign in. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'pending.invalid';

/**
 * Imports mapped rows; existing emails are skipped so a re-run never duplicates people.
 * By default a row without email or join date is skipped. With includeIncomplete, it is
 * imported with explicit placeholders (an unusable `@pending.invalid` email and the import
 * date as join date), and an audit event lists which fields are placeholders so HR can
 * complete them. Placeholder values are never inferred from other columns.
 */
export async function importMappedWorkbook(
  db: AsyncDb,
  mapped: MappedWorkbook,
  options: { dryRun?: boolean; includeIncomplete?: boolean; today?: string } = {},
): Promise<ImportSummary> {
  await ensureLocalAdmin(db);
  const summary: ImportSummary = { imported: 0, photos: 0, skipped: [], issueCounts: {} };
  for (const row of mapped.rows)
    for (const issue of row.issues)
      summary.issueCounts[issue] = (summary.issueCounts[issue] ?? 0) + 1;
  const DRY_RUN = Symbol('dry-run');
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  for (const row of mapped.rows) {
    const placeholders = [
      ...(!row.values.email ? ['email'] : []),
      ...(!row.values.joinDate ? ['joinDate'] : []),
    ];
    if (placeholders.length && !options.includeIncomplete) {
      summary.skipped.push({
        rowNumber: row.rowNumber,
        reason: !row.values.email ? 'missing_email' : 'missing_join_date',
      });
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        const exists = row.values.email
          ? await tx.read<{ id: string }>(
              'SELECT id FROM employees WHERE lower(email)=lower(?) LIMIT 1',
              [String(row.values.email)],
            )
          : await tx.read<{ id: string }>(
              'SELECT id FROM employees WHERE name=? AND email LIKE ? LIMIT 1',
              [String(row.values.name), `%@${PLACEHOLDER_EMAIL_DOMAIN}`],
            );
        if (exists.length) throw Object.assign(new Error('duplicate'), { code: 'EMAIL_EXISTS' });
        const employeeNumber = await nextEmployeeNumber(tx);
        const file = await createEmployee(
          tx,
          LOCAL_ADMIN,
          {
            ...row.values,
            email:
              row.values.email ?? `${employeeNumber.toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`,
            joinDate: row.values.joinDate ?? today,
            employeeNumber,
          },
          {
            mode: 'private',
            employmentSource:
              'Private workbook import; employment terms require documentary review.',
            employmentStartDate: row.values.joinDate ? String(row.values.joinDate) : null,
            employmentEndDate: row.values.separationDate ? String(row.values.separationDate) : null,
          },
        );
        if (placeholders.length)
          await appendEvent(
            tx,
            LOCAL_ADMIN,
            'employee',
            file.employee.id,
            'import_placeholders',
            null,
            {
              fields: placeholders,
              placeholderJoinDate: row.values.joinDate ? undefined : today,
              source: 'private-import',
            },
          );
        if (row.photo) await attachPhoto(tx, file.employee.id, row.photo.mime, row.photo.bytes);
        if (options.dryRun) throw DRY_RUN; // validate fully, then roll back
      });
      summary.imported += 1;
      if (row.photo) summary.photos += 1;
    } catch (error) {
      if (error === DRY_RUN) {
        summary.imported += 1;
        if (row.photo) summary.photos += 1;
        continue;
      }
      const code = (error as { code?: string }).code ?? 'INVALID_ROW';
      summary.skipped.push({ rowNumber: row.rowNumber, reason: code });
    }
  }
  return summary;
}

export async function attachPhoto(
  tx: AsyncDb,
  employeeId: string,
  mime: 'image/png' | 'image/jpeg',
  bytes: Buffer,
): Promise<void> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await tx.execute(
    'INSERT INTO employee_documents(id,employee_id,category,filename,mime_type,size_bytes,expires_at,uploaded_at,uploaded_by,checksum,encrypted_content) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      employeeId,
      'photo',
      mime === 'image/png' ? 'photo.png' : 'photo.jpg',
      mime,
      bytes.length,
      null,
      now,
      LOCAL_ADMIN_ID,
      sha256(bytes),
      encryptSensitive(bytes.toString('base64'), `employee-document:${id}`),
    ],
  );
  await appendEvent(
    tx,
    LOCAL_ADMIN,
    'document',
    id,
    'document_uploaded',
    null,
    { employeeId, category: 'photo', size: bytes.length, source: 'private-import' },
    1,
    now,
  );
}

async function findEmployee(tx: AsyncDb, key: string) {
  const row = (
    await tx.read<{ id: string }>(
      'SELECT id FROM employees WHERE (lower(email)=lower(?) OR employee_number=?) AND id<>? LIMIT 1',
      [key, key, LOCAL_ADMIN_ID],
    )
  )[0];
  if (!row) throw new Error(`No employee matches "${key}" (use email or employee number).`);
  return (await readEmployee(tx, row.id))!;
}

/** Grants the one access role an employee signs in with. Recorded in the audit log. */
export async function grantRole(db: AsyncDb, key: string, role: string): Promise<void> {
  if (!GRANTABLE.includes(role as Role))
    throw new Error(`Role must be one of: ${GRANTABLE.join(', ')}`);
  await ensureLocalAdmin(db);
  await db.transaction(async (tx) => {
    const employee = await findEmployee(tx, key);
    if (['terminated', 'suspended'].includes(employee.status))
      throw new Error('Cannot grant access to an inactive employee.');
    await tx.execute(
      'UPDATE employees SET access_role=?,record_version=record_version+1 WHERE id=?',
      [role, employee.id],
    );
    await appendEvent(tx, LOCAL_ADMIN, 'employee', employee.id, 'access_role_granted', null, {
      from: employee.role,
      to: role,
    });
  });
}

/** Sets a direct manager. The manager must hold the manager role; no self-management. */
export async function setManager(db: AsyncDb, key: string, managerKey: string): Promise<void> {
  await ensureLocalAdmin(db);
  await db.transaction(async (tx) => {
    const employee = await findEmployee(tx, key);
    const manager = await findEmployee(tx, managerKey);
    if (employee.id === manager.id) throw new Error('An employee cannot manage themselves.');
    if (manager.role !== 'manager') throw new Error('Grant the manager role first.');
    await tx.execute(
      'UPDATE employees SET manager_id=?,record_version=record_version+1 WHERE id=?',
      [manager.id, employee.id],
    );
    await appendEvent(tx, LOCAL_ADMIN, 'employee', employee.id, 'manager_assigned', null, {
      from: employee.manager_id,
      to: manager.id,
    });
  });
}

export async function listAccess(db: AsyncDb) {
  return db.read<{
    employee_number: string;
    name: string;
    email: string;
    role: string;
    status: string;
    manager_id: string | null;
  }>(
    'SELECT employee_number,name,email,role,status,manager_id FROM employee_access WHERE id<>? ORDER BY name',
    [LOCAL_ADMIN_ID],
  );
}

/** Employees still carrying an import placeholder (field keys only, never values). */
export async function listIncomplete(db: AsyncDb) {
  const rows = await db.read<{
    details_json: string;
    employee_number: string;
    name: string;
    email: string;
    join_date: string;
  }>(
    `SELECT ev.details_json,e.employee_number,e.name,e.email,e.join_date
     FROM administration_events ev JOIN employees e ON e.id=ev.resource_id
     WHERE ev.action='import_placeholders' ORDER BY e.employee_number`,
  );
  return rows
    .map((row) => {
      const details = JSON.parse(row.details_json) as {
        fields?: string[];
        placeholderJoinDate?: string;
      };
      const open = (details.fields ?? []).filter((field) =>
        field === 'email'
          ? row.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)
          : field === 'joinDate'
            ? row.join_date === details.placeholderJoinDate
            : true,
      );
      return { employee_number: row.employee_number, name: row.name, fields: open };
    })
    .filter((row) => row.fields.length);
}
