import { randomUUID } from 'node:crypto';
import type { AsyncDb } from './database.js';
import { provisionEmployeeAccountInTransaction } from './access/index.js';

export type BootstrapIdentity = {
  name: string;
  employeeNumber: string;
  email: string;
  title: string;
  department: string;
  location: string;
  joinDate: string;
  role: 'hr' | 'approver';
};

export function validateBootstrapInput(value: unknown): BootstrapIdentity[] {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error('Supply exactly two explicitly nominated initial accounts: HR and approver.');
  const fields = [
    'name',
    'employeeNumber',
    'email',
    'title',
    'department',
    'location',
    'joinDate',
  ] as const;
  for (const record of value) {
    if (
      !record ||
      typeof record !== 'object' ||
      fields.some(
        (key) => typeof record[key] !== 'string' || !record[key].trim() || record[key].length > 200,
      )
    )
      throw new Error(
        'Each nominated account needs name, employeeNumber, email, title, department, location and joinDate.',
      );
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(record.joinDate) ||
      !Number.isFinite(Date.parse(`${record.joinDate}T00:00:00Z`)) ||
      new Date(`${record.joinDate}T00:00:00Z`).toISOString().slice(0, 10) !== record.joinDate
    )
      throw new Error('Initial employment dates must be valid ISO dates.');
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email) ||
      !['hr', 'approver'].includes(record.role)
    )
      throw new Error('Initial account email or role is invalid.');
  }
  if (
    new Set(value.map((record) => record.role)).size !== 2 ||
    new Set(value.map((record) => record.email.trim().toLowerCase())).size !== 2 ||
    new Set(value.map((record) => record.employeeNumber.trim())).size !== 2
  )
    throw new Error(
      'The initial HR and approver must be two distinct people with distinct account identifiers.',
    );
  return value.map((record) => ({
    ...Object.fromEntries(fields.map((key) => [key, record[key].trim()])),
    role: record.role,
  })) as BootstrapIdentity[];
}

/** Offline operator bootstrap only. No public route and no default personal identities. */
export async function bootstrapAccounts(
  db: AsyncDb,
  input: unknown,
  options: {
    beforeCommit?: (
      invitations: Array<{
        employeeId: string;
        loginName: string;
        role: string;
        activationToken: string;
        expiresAt: string;
      }>,
    ) => void | Promise<void>;
  } = {},
) {
  const identities = validateBootstrapInput(input);
  return db.transaction(async (tx) => {
    if (
      (await tx.read('SELECT employee_id FROM employee_accounts LIMIT 1')).length ||
      (await tx.read('SELECT id FROM employees LIMIT 1')).length
    )
      throw new Error(
        'Initial setup requires empty operational storage. No existing accounts or employees were changed.',
      );
    const invitations = [];
    const now = new Date().toISOString();
    for (const person of identities) {
      const id = `emp-${randomUUID()}`;
      await tx.execute(
        `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,access_role,employment_status)
         VALUES(?,?,?,?,?,?,?,?,NULL,?,'employee','#D8E8F3',?,'active')`,
        [
          id,
          person.employeeNumber,
          person.name,
          person.name
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join(' '),
          person.title,
          person.department,
          person.email,
          person.location,
          person.joinDate,
          person.role,
        ],
      );
      await tx.execute(
        "INSERT INTO employee_profile_data(employee_id,public_values_json,encrypted_values_json,updated_at,updated_by) VALUES(?,?,'{}',?,?)",
        [id, '{}', now, id],
      );
      await tx.execute(
        "INSERT INTO employment_periods(id,employee_id,start_date,relationship_type,source,status,created_at) VALUES(?,?,?,'pending-classification','Explicit offline account bootstrap; employment classification and entitlements require review.','pending-review',?)",
        [randomUUID(), id, person.joinDate, now],
      );
      await tx.execute(
        'INSERT INTO audit_events(actor_id,actor_role,action,resource_id,resource_version,reason,created_at) VALUES(?,?,?,?,1,?,?)',
        [
          'offline-operator',
          'operator',
          'initial_account_nominated',
          id,
          'Initial roles nominated through local controlled bootstrap. No leave balance granted.',
          now,
        ],
      );
      const invitation = await provisionEmployeeAccountInTransaction(tx, {
        employeeId: id,
        loginName: person.email,
      });
      invitations.push({
        employeeId: id,
        loginName: person.email,
        role: person.role,
        ...invitation,
      });
    }
    await options.beforeCommit?.(invitations);
    return invitations;
  });
}
