import { resolve } from 'node:path';

export type RuntimeConfig = {
  mode: 'local-demo' | 'hosted-demo' | 'operational';
  production: boolean;
  driver: 'sqlite' | 'postgres';
  publicOrigin?: string;
  databaseUrl?: string;
  databasePath: string;
  schema: 'hr_development' | 'hr_operational';
  seed: boolean;
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
};

/** Pure validation. Never includes credentials or key material in an error. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env.NODE_ENV === 'production';
  if (env.HR_MODE && !['hosted-demo', 'operational'].includes(env.HR_MODE))
    throw new Error('HR_MODE must be hosted-demo or operational.');
  const mode = env.HR_MODE ?? 'local-demo';
  if (mode === 'hosted-demo' && !production)
    throw new Error('Hosted previews require NODE_ENV=production.');
  if (production && mode === 'local-demo' && env.LOCAL_DEMO !== 'true')
    throw new Error('Select an explicit HR_MODE or enable LOCAL_DEMO on loopback.');
  if (env.HR_DB_DRIVER && !['sqlite', 'postgres'].includes(env.HR_DB_DRIVER))
    throw new Error('HR_DB_DRIVER must be sqlite or postgres.');
  const driver = (env.HR_DB_DRIVER ?? 'sqlite') as RuntimeConfig['driver'];
  const publicOrigin = mode !== 'local-demo' ? env.HR_PUBLIC_ORIGIN || undefined : undefined;
  if (publicOrigin) {
    let parsed: URL;
    try {
      parsed = new URL(publicOrigin);
    } catch {
      throw new Error('HR_PUBLIC_ORIGIN must be a valid HTTPS origin.');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      throw new Error('HR_PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.');
  }
  if (mode === 'hosted-demo' && (!publicOrigin || env.HR_DB_PATH))
    throw new Error('Hosted previews require HR_PUBLIC_ORIGIN and forbid HR_DB_PATH.');
  const databasePath =
    env.HR_DB_PATH ??
    resolve('.data', mode === 'operational' ? 'hr-operational.sqlite' : 'hr-local.sqlite');
  if (mode === 'operational') {
    const key = env.HR_DATA_KEY;
    if (
      !key ||
      Buffer.from(key, 'base64url').length !== 32 ||
      Buffer.from(key, 'base64url').toString('base64url') !== key.replace(/=+$/, '')
    )
      throw new Error(
        'Operational mode requires a fixed 32-byte HR_DATA_KEY from secure configuration.',
      );
    if (databasePath === ':memory:' || databasePath.startsWith('file:'))
      throw new Error('Operational mode requires a durable database path.');
    if (driver === 'sqlite' && publicOrigin)
      throw new Error(
        'Public operational hosting requires PostgreSQL; SQLite is restricted to local pilot use.',
      );
    if (
      env.HR_SEED_SYNTHETIC &&
      env.HR_SEED_SYNTHETIC !== 'true' &&
      env.HR_SEED_SYNTHETIC !== 'false'
    )
      throw new Error('HR_SEED_SYNTHETIC must be true or false.');
    if (publicOrigin && env.HR_SEED_SYNTHETIC === 'true')
      throw new Error('Synthetic account fixtures are restricted to the local operational pilot.');
  }
  if (driver === 'postgres' && !env.DATABASE_URL)
    throw new Error('PostgreSQL requires DATABASE_URL from secure configuration.');
  const port = Number(env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return {
    mode: mode as RuntimeConfig['mode'],
    production,
    driver,
    publicOrigin,
    databaseUrl: env.DATABASE_URL,
    databasePath,
    schema: mode === 'operational' ? 'hr_operational' : 'hr_development',
    seed: mode !== 'operational' || env.HR_SEED_SYNTHETIC === 'true',
    host: publicOrigin ? '0.0.0.0' : '127.0.0.1',
    port,
  };
}
