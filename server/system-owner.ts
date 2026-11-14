// Decision 014: the system owner is an HR account that may also approve payroll runs and payroll
// rule versions. Membership lives in system_owners and is never written by a route.
import type { Role } from '../shared/contracts.js';
import type { AsyncDb } from './database.js';

export async function isSystemOwner(query: AsyncDb, id: string, role: Role): Promise<boolean> {
  if (role !== 'hr') return false;
  const rows = await query.read<{ found: number }>(
    'SELECT 1 found FROM system_owners WHERE employee_id=?',
    [id],
  );
  return rows.length > 0;
}

/** Approver-equivalent for payroll and payroll rules: the approver, or the system owner. */
export const approvesPayroll = (actor: { role: string; owner?: boolean }) =>
  actor.role === 'approver' || (actor.role === 'hr' && actor.owner === true);
