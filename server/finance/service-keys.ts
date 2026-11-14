/**
 * Accountant service keys: machine access to the finance workspace only.
 *
 * - Only SHA-256 digests are configured (HR_FINANCE_API_KEY_HASHES), never the keys.
 * - A key acts as the single granted finance account (HR_FINANCE_EMPLOYEE_ID) and nothing else.
 * - Scope is enforced before any route runs: user management, payroll, sessions, documents,
 *   the employee directory and the provider credential are refused with 403.
 * - Bearer requests carry no cookies by design, so the browser Origin (CSRF) check does not
 *   apply to them; cookies on a bearer request are ignored.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SERVICE_KEY_PREFIX = 'sabqfin_';
const HASH_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/;
const KEY_PATTERN = /^sabqfin_[A-Za-z0-9_-]{43}$/;

export function generateServiceKey(): string {
  return `${SERVICE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashServiceKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/** Parses a comma/space separated list of `sha256:<hex>` digests. Throws on any malformed entry. */
export function parseServiceKeyHashes(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const match = entry.trim().toLowerCase().match(HASH_PATTERN);
      if (!match)
        throw new Error('HR_FINANCE_API_KEY_HASHES must contain sha256:<64 hex> digests only.');
      return match[1];
    });
}

/** Constant-time comparison against every configured digest. */
export function matchesServiceKey(presented: string, digests: readonly string[]): boolean {
  if (!KEY_PATTERN.test(presented) || digests.length === 0) return false;
  const actual = createHash('sha256').update(presented, 'utf8').digest();
  let found = false;
  for (const hex of digests) {
    const expected = Buffer.from(hex.replace(/^sha256:/, ''), 'hex');
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) found = true;
  }
  return found;
}

/** Paths an accountant key may call. Everything else is a scope violation (403). */
export function inAccountantScope(method: string, path: string): boolean {
  if (path === '/api/health') return true;
  if (path !== '/api/finance' && !path.startsWith('/api/finance/')) return false;
  // The provider credential and its live connection test stay with the human owner.
  if (path === '/api/finance/settings/api-key' || path === '/api/finance/settings/test')
    return false;
  return ['GET', 'HEAD', 'POST', 'PATCH'].includes(method.toUpperCase());
}

export function bearerToken(header: string | undefined): string | undefined | null {
  if (header === undefined) return undefined;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}
