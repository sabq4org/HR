import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readRuntimeConfig } from '../../server/runtime-config.js';
import { createDatabase } from '../../server/database.js';

const key = randomBytes(32).toString('base64url');
test('account runtime fails closed without durable storage and a fixed encryption key', () => {
  assert.throws(() => readRuntimeConfig({ HR_MODE: 'operational' }), /HR_DATA_KEY/);
  assert.throws(
    () => readRuntimeConfig({ HR_MODE: 'operational', HR_DATA_KEY: key, HR_DB_PATH: ':memory:' }),
    /durable/,
  );
  assert.throws(
    () =>
      readRuntimeConfig({
        HR_MODE: 'operational',
        HR_DATA_KEY: key,
        HR_PUBLIC_ORIGIN: 'https://hr.example.test',
      }),
    /PostgreSQL/,
  );
  assert.throws(
    () => readRuntimeConfig({ HR_MODE: 'operational', HR_DATA_KEY: key, HR_DB_DRIVER: 'postgres' }),
    /DATABASE_URL/,
  );
  const config = readRuntimeConfig({ HR_MODE: 'operational', HR_DATA_KEY: key });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.seed, false);
  assert.equal(config.schema, 'hr_operational');
  assert.ok(config.databasePath.endsWith('hr-operational.sqlite'));
  assert.equal(
    readRuntimeConfig({ HR_MODE: 'operational', HR_DATA_KEY: key, HR_PUBLIC_ORIGIN: '' })
      .publicOrigin,
    undefined,
    'An empty optional origin must preserve the localhost invitation URL fallback',
  );
});

test('public account runtime requires HTTPS and rejects synthetic fixture seeding', () => {
  const base = {
    HR_MODE: 'operational',
    HR_DATA_KEY: key,
    HR_DB_DRIVER: 'postgres',
    DATABASE_URL: 'postgresql://unused@localhost/synthetic',
  };
  assert.throws(
    () => readRuntimeConfig({ ...base, HR_PUBLIC_ORIGIN: 'http://hr.example.test' }),
    /HTTPS/,
  );
  assert.throws(
    () => readRuntimeConfig({ ...base, HR_PUBLIC_ORIGIN: 'https://hr.example.test/path' }),
    /origin/,
  );
  assert.throws(
    () =>
      readRuntimeConfig({
        ...base,
        HR_PUBLIC_ORIGIN: 'https://hr.example.test',
        HR_SEED_SYNTHETIC: 'true',
      }),
    /restricted/,
  );
  assert.equal(
    readRuntimeConfig({ ...base, HR_PUBLIC_ORIGIN: 'https://hr.example.test' }).host,
    '0.0.0.0',
  );
});

test('unseeded database does not grant fictional employees or annual opening balances', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  try {
    assert.deepEqual(await db.read('SELECT id FROM employees'), []);
    assert.deepEqual(await db.read('SELECT id FROM leave_ledger'), []);
    assert.deepEqual(await db.read('SELECT id FROM policy_versions'), []);
  } finally {
    await db.close();
  }
});
