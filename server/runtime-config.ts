import { resolve } from 'node:path';

export type RuntimeConfig = {
  mode: 'local-demo' | 'hosted-demo' | 'operational' | 'private-local' | 'private-hosted';
  production: boolean;
  driver: 'sqlite' | 'postgres';
  dataMode: 'synthetic' | 'private';
  publicOrigin?: string;
  databaseUrl?: string;
  accessPassword?: string;
  databasePath: string;
  schema: 'hr_development' | 'hr_operational' | 'hr_private';
  seed: boolean;
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
};

/** Pure validation. Never includes credentials or key material in an error. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env.NODE_ENV === 'production';
  const requestedMode = env.HR_MODE;
  if (requestedMode && !['hosted-demo', 'operational', 'private-hosted'].includes(requestedMode))
    throw new Error('HR_MODE must be hosted-demo, operational, or private-hosted.');
  if (env.HR_DATA_MODE && env.HR_DATA_MODE !== 'private')
    throw new Error('HR_DATA_MODE must be "private" when set.');
  if (requestedMode === 'private-hosted' && env.HR_DATA_MODE)
    throw new Error('private-hosted cannot be combined with HR_DATA_MODE.');
  if (requestedMode && requestedMode !== 'operational' && env.HR_DATA_MODE)
    throw new Error('HR_DATA_MODE applies only to local mode.');

  let mode: RuntimeConfig['mode'] = (requestedMode as RuntimeConfig['mode']) ?? 'local-demo';
  if (!requestedMode && env.HR_DATA_MODE === 'private') mode = 'private-local';
  if ((mode === 'hosted-demo' || mode === 'private-hosted') && !production)
    throw new Error('Hosted modes require NODE_ENV=production.');
  if (production && mode === 'local-demo' && env.LOCAL_DEMO !== 'true')
    throw new Error('Select an explicit HR_MODE or enable LOCAL_DEMO on loopback.');
  if (mode === 'private-hosted' && (env.LOCAL_DEMO === 'true' || env.HR_DB_PATH))
    throw new Error('private-hosted cannot be combined with LOCAL_DEMO or HR_DB_PATH.');
  if (env.HR_DB_DRIVER && !['sqlite', 'postgres'].includes(env.HR_DB_DRIVER))
    throw new Error('HR_DB_DRIVER must be sqlite or postgres.');
  const driver = (env.HR_DB_DRIVER ??
    (mode === 'private-hosted' ? 'postgres' : 'sqlite')) as RuntimeConfig['driver'];
  if (mode === 'private-hosted' && driver !== 'postgres')
    throw new Error('private-hosted requires PostgreSQL.');
  const publicOrigin =
    mode === 'hosted-demo' || mode === 'operational' || mode === 'private-hosted'
      ? env.HR_PUBLIC_ORIGIN || undefined
      : undefined;
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
  const databaseUrl = env.DATABASE_URL;
  if (mode === 'hosted-demo' && (!publicOrigin || env.HR_DB_PATH))
    throw new Error('Hosted previews require HR_PUBLIC_ORIGIN and forbid HR_DB_PATH.');
  if (mode === 'private-hosted') {
    const dataKey = env.HR_DATA_KEY;
    if (!databaseUrl || !publicOrigin || !dataKey)
      throw new Error('private-hosted requires DATABASE_URL, HR_PUBLIC_ORIGIN, and HR_DATA_KEY.');
    if (
      Buffer.from(dataKey, 'base64url').length !== 32 ||
      Buffer.from(dataKey, 'base64url').toString('base64url') !== dataKey.replace(/=+$/, '')
    )
      throw new Error('private-hosted requires a fixed 32-byte HR_DATA_KEY.');
    if ((env.HR_ACCESS_PASSWORD ?? '').length < 12)
      throw new Error('private-hosted requires HR_ACCESS_PASSWORD of at least 12 characters.');
  }
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
    if (driver === 'sqlite' && publicOrigin)
      throw new Error(
        'Public operational hosting requires PostgreSQL; SQLite is restricted to local pilot use.',
      );
    if (env.HR_SEED_SYNTHETIC && !['true', 'false'].includes(env.HR_SEED_SYNTHETIC))
      throw new Error('HR_SEED_SYNTHETIC must be true or false.');
    if (publicOrigin && env.HR_SEED_SYNTHETIC === 'true')
      throw new Error('Synthetic account fixtures are restricted to the local operational pilot.');
  }
  if (driver === 'postgres' && !databaseUrl)
    throw new Error('PostgreSQL requires DATABASE_URL from secure configuration.');
  if (mode === 'private-local' && (env.HR_PUBLIC_ORIGIN || driver === 'postgres'))
    throw new Error('Private local mode is SQLite-on-this-machine only.');
  const databasePath =
    env.HR_DB_PATH ??
    resolve(
      '.data',
      mode === 'operational'
        ? 'hr-operational.sqlite'
        : mode === 'private-local'
          ? 'hr-private.sqlite'
          : 'hr-local.sqlite',
    );
  if (mode === 'operational' && (databasePath === ':memory:' || databasePath.startsWith('file:')))
    throw new Error('Operational mode requires a durable database path.');
  const port = Number(env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return {
    mode,
    production,
    driver,
    dataMode:
      mode === 'operational' || mode === 'private-local' || mode === 'private-hosted'
        ? 'private'
        : 'synthetic',
    publicOrigin,
    databaseUrl,
    accessPassword: mode === 'private-hosted' ? env.HR_ACCESS_PASSWORD : undefined,
    databasePath,
    schema:
      mode === 'operational'
        ? 'hr_operational'
        : mode === 'private-hosted'
          ? 'hr_private'
          : 'hr_development',
    seed:
      (mode !== 'operational' && mode !== 'private-local' && mode !== 'private-hosted') ||
      (mode === 'operational' && env.HR_SEED_SYNTHETIC === 'true'),
    host: publicOrigin ? '0.0.0.0' : '127.0.0.1',
    port,
  };
}
