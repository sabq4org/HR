/**
 * HR service keys («محاسب سبق»): scoped, read-only machine access to the team workspace.
 *
 * - Separate from the accountant finance key (`sabqfin_`, HR_FINANCE_API_KEY_HASHES), which is
 *   unchanged. An HR key never reaches /api/finance and a finance key never reaches this API.
 * - Only SHA-256 digests are configured (HR_SERVICE_API_KEY_HASHES), never the keys.
 * - The key acts as a fixed service account, not as an employee: every audit entry it leaves
 *   names «محاسب سبق». It has no role, so no existing session route accepts it.
 * - Scopes are explicit (HR_SERVICE_API_KEY_SCOPES). Phase 1 grants read scopes only; write
 *   scopes are declared for phase 2 and refused at boot until they are wired. Approving or
 *   closing a payroll run is never grantable to a key.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const HR_SERVICE_KEY_PREFIX = 'sabqhr_';
const HASH_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/;
const KEY_PATTERN = /^sabqhr_[A-Za-z0-9_-]{43}$/;

/** Fixed audit identity of the key. Not a row in employees; never a login. */
export const SERVICE_ACCOUNT = Object.freeze({
  id: 'svc-sabq-accountant',
  name: 'محاسب سبق',
  role: 'service' as const,
});

/** Display name for an audit actor id that is not an employee row. */
export function serviceActorName(actorId: string): string {
  return actorId === SERVICE_ACCOUNT.id ? SERVICE_ACCOUNT.name : 'مستخدم';
}

export const HR_READ_SCOPES = [
  'hr.employees.read',
  'hr.compensation.read',
  'hr.sensitive.read',
  'hr.leave.read',
  'hr.payroll.read',
] as const;
/** Phase 2 (not wired yet): configuring any of these is refused at boot. */
export const HR_WRITE_SCOPES = [
  'hr.employees.write',
  'hr.leave.write',
  'hr.payroll.write',
  'hr.payroll.submit',
] as const;
/** Never grantable to a machine key: payroll approval and closing stay with a human approver. */
export const HR_FORBIDDEN_SCOPES = ['hr.payroll.approve', 'hr.payroll.close'] as const;

export type HrReadScope = (typeof HR_READ_SCOPES)[number];
export type HrWriteScope = (typeof HR_WRITE_SCOPES)[number];
export type HrScope = HrReadScope | HrWriteScope;

export function generateHrServiceKey(): string {
  return `${HR_SERVICE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashHrServiceKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

export function parseHrServiceKeyHashes(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const match = entry.trim().toLowerCase().match(HASH_PATTERN);
      if (!match)
        throw new Error('HR_SERVICE_API_KEY_HASHES must contain sha256:<64 hex> digests only.');
      return match[1];
    });
}

/** Parses the granted scopes. Throws on unknown, not-yet-wired or forbidden scopes. */
export function parseHrServiceScopes(value: string | undefined): HrReadScope[] {
  if (!value || !value.trim()) return [];
  const scopes = new Set<HrReadScope>();
  for (const raw of value.split(/[\s,]+/).filter(Boolean)) {
    const scope = raw.trim();
    if ((HR_FORBIDDEN_SCOPES as readonly string[]).includes(scope))
      throw new Error(`${scope} can never be granted to a service key.`);
    if ((HR_WRITE_SCOPES as readonly string[]).includes(scope))
      throw new Error(`${scope} is not available yet (phase 2).`);
    if (!(HR_READ_SCOPES as readonly string[]).includes(scope))
      throw new Error(`Unknown HR service scope: ${scope}`);
    scopes.add(scope as HrReadScope);
  }
  return [...scopes];
}

/**
 * Returns the matching digest (hex) for a presented key, or undefined. Constant-time per digest.
 * The digest prefix is used as a non-secret key identifier in audit details.
 */
export function matchHrServiceKey(
  presented: string,
  digests: readonly string[],
): string | undefined {
  if (!KEY_PATTERN.test(presented) || digests.length === 0) return undefined;
  const actual = createHash('sha256').update(presented, 'utf8').digest();
  let found: string | undefined;
  for (const hex of digests) {
    const clean = hex.replace(/^sha256:/, '');
    const expected = Buffer.from(clean, 'hex');
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) found = clean;
  }
  return found;
}

/** Paths an HR service key may call: health and the read-only service API. */
export function inHrServiceScope(method: string, path: string): boolean {
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) return false;
  return path === '/api/health' || path.startsWith('/api/service/hr/');
}

/**
 * Payroll actions a service key may ever run. Approve and close are refused regardless of
 * scopes; submit needs the phase-2 write scope. Phase 1 wires no payroll action at all.
 */
export function serviceMayRunPayrollAction(action: string, scopes: readonly string[]): boolean {
  if (action === 'approve' || action === 'close') return false;
  if (action === 'submit') return scopes.includes('hr.payroll.submit');
  return false;
}
