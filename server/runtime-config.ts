// Validates the process environment before anything listens or touches a database.
// Pure (reads only the env object it is given) so every refusal is unit-tested.
import { parseDataKey } from './administration/security.js';

export type RuntimeConfig =
  | {
      mode: 'private-hosted';
      databaseUrl: string;
      publicOrigin: string;
      accessPassword: string;
      trustProxyHops: number;
    }
  | {
      mode: 'hosted-demo';
      publicOrigin: string;
      /** Opt-in only, via HR_PREVIEW_DATABASE_URL; never DATABASE_URL. */
      previewDatabaseUrl?: string;
    }
  | { mode: 'private-local'; dbPath?: string }
  | {
      mode: 'synthetic-local';
      driver: 'sqlite' | 'postgres';
      dbPath?: string;
      databaseUrl?: string;
    };

// Variables that belong to the private (real-data) service. The public synthetic preview
// must never carry them: their presence means a private configuration was copied over.
export const PRIVATE_ONLY_VARIABLES = [
  'DATABASE_URL',
  'HR_PRIVATE_DATABASE_URL',
  'HR_DATA_KEY',
  'HR_ACCESS_PASSWORD',
] as const;

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const production = env.NODE_ENV === 'production';
  const hostedDemo = env.HR_MODE === 'hosted-demo';
  // HR_MODE=private-hosted: real data in a dedicated PostgreSQL schema (Neon), behind a
  // shared access password set as a deployment secret. Interim until SSO. Decision 006.
  const privateHosted = env.HR_MODE === 'private-hosted';
  if (env.HR_MODE && !hostedDemo && !privateHosted)
    throw new Error('Unsupported HR_MODE. Use hosted-demo or private-hosted.');
  if ((hostedDemo || privateHosted) && !production)
    throw new Error('Hosted modes require NODE_ENV=production.');
  if (production && !hostedDemo && !privateHosted && env.LOCAL_DEMO !== 'true')
    throw new Error('Select HR_MODE=hosted-demo or explicitly enable LOCAL_DEMO=true.');
  if (env.HR_DB_DRIVER && !['sqlite', 'postgres'].includes(env.HR_DB_DRIVER))
    throw new Error('HR_DB_DRIVER must be sqlite or postgres.');
  // Fail at boot, not on the first photo request, when the key is malformed. The value
  // itself is never echoed.
  if (env.HR_DATA_KEY !== undefined) parseDataKey(env.HR_DATA_KEY);

  if (privateHosted) {
    if (env.LOCAL_DEMO === 'true' || env.HR_DATA_MODE)
      throw new Error('private-hosted cannot be combined with LOCAL_DEMO or HR_DATA_MODE.');
    if (env.HR_PREVIEW_DATABASE_URL)
      throw new Error('private-hosted must not carry the public preview database variable.');
    if (!env.DATABASE_URL) throw new Error('private-hosted requires DATABASE_URL.');
    if (!env.HR_PUBLIC_ORIGIN) throw new Error('private-hosted requires HR_PUBLIC_ORIGIN.');
    if (!env.HR_DATA_KEY) throw new Error('private-hosted requires HR_DATA_KEY.');
    if ((env.HR_ACCESS_PASSWORD ?? '').length < 12)
      throw new Error('private-hosted requires HR_ACCESS_PASSWORD of at least 12 characters.');
    const hops = env.HR_TRUST_PROXY_HOPS ?? '1';
    if (!/^[0-9]$/.test(hops)) throw new Error('HR_TRUST_PROXY_HOPS must be a digit from 0 to 9.');
    return {
      mode: 'private-hosted',
      databaseUrl: env.DATABASE_URL,
      publicOrigin: env.HR_PUBLIC_ORIGIN,
      accessPassword: env.HR_ACCESS_PASSWORD!,
      trustProxyHops: Number(hops),
    };
  }

  if (hostedDemo) {
    if (env.HR_DB_PATH)
      throw new Error(
        'Hosted previews use isolated temporary databases; HR_DB_PATH is not allowed.',
      );
    if (env.LOCAL_DEMO === 'true' || env.HR_DATA_MODE || env.HR_DB_DRIVER)
      throw new Error(
        'hosted-demo cannot be combined with LOCAL_DEMO, HR_DATA_MODE or HR_DB_DRIVER.',
      );
    // Fail closed: a public, synthetic, unauthenticated preview refuses to start while any
    // private-service variable is present, instead of silently using (or ignoring) it.
    const leaked = PRIVATE_ONLY_VARIABLES.filter((name) => env[name] !== undefined);
    if (leaked.length)
      throw new Error(
        `hosted-demo is public and synthetic; remove ${leaked.join(', ')} from this service. ` +
          'A PostgreSQL preview needs its own separate database via HR_PREVIEW_DATABASE_URL.',
      );
    return {
      mode: 'hosted-demo',
      publicOrigin: env.HR_PUBLIC_ORIGIN ?? '',
      ...(env.HR_PREVIEW_DATABASE_URL ? { previewDatabaseUrl: env.HR_PREVIEW_DATABASE_URL } : {}),
    };
  }

  if (env.HR_PREVIEW_DATABASE_URL)
    throw new Error('HR_PREVIEW_DATABASE_URL is only valid with HR_MODE=hosted-demo.');
  // HR_DATA_MODE=private: real employee data on the owner's own machine only.
  // Loopback listener, separate SQLite file, no synthetic seed. See docs/private-local.md.
  const privateData = env.HR_DATA_MODE === 'private';
  if (env.HR_DATA_MODE && !privateData) throw new Error('HR_DATA_MODE must be "private" when set.');
  if (privateData && env.HR_PUBLIC_ORIGIN)
    throw new Error('Private data mode cannot run as a hosted or public preview.');
  if (privateData && env.HR_DB_DRIVER === 'postgres')
    throw new Error('Private data mode is SQLite-on-this-machine only until hosting is approved.');
  if (privateData)
    return { mode: 'private-local', ...(env.HR_DB_PATH ? { dbPath: env.HR_DB_PATH } : {}) };
  return env.HR_DB_DRIVER === 'postgres'
    ? { mode: 'synthetic-local', driver: 'postgres', databaseUrl: env.DATABASE_URL ?? '' }
    : {
        mode: 'synthetic-local',
        driver: 'sqlite',
        ...(env.HR_DB_PATH ? { dbPath: env.HR_DB_PATH } : {}),
      };
}
