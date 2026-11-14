import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../../server/database.js';
import { readRuntimeConfig } from '../../server/runtime-config.js';

const key = randomBytes(32).toString('base64url');

test('private-local is loopback SQLite with no seed and a separate database path', () => {
  const config = readRuntimeConfig({ HR_DATA_MODE: 'private' });
  assert.equal(config.mode, 'private-local');
  assert.equal(config.dataMode, 'private');
  assert.equal(config.seed, false);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.schema, 'hr_development');
  assert.ok(config.databasePath.endsWith('hr-private.sqlite'));
  assert.throws(
    () =>
      readRuntimeConfig({ HR_DATA_MODE: 'private', HR_PUBLIC_ORIGIN: 'https://hr.example.test' }),
    /SQLite-on-this-machine/,
  );
});

test('private-hosted remains separate from operational account mode', () => {
  const config = readRuntimeConfig({
    NODE_ENV: 'production',
    HR_MODE: 'private-hosted',
    HR_DATA_KEY: key,
    HR_ACCESS_PASSWORD: 'synthetic-test-password',
    HR_DB_DRIVER: 'postgres',
    DATABASE_URL: 'postgresql://unused@localhost/private',
    HR_PUBLIC_ORIGIN: 'https://private.example.test',
  });
  assert.equal(config.mode, 'private-hosted');
  assert.equal(config.dataMode, 'private');
  assert.equal(config.schema, 'hr_private');
  assert.equal(config.seed, false);
  assert.equal(config.accessPassword, 'synthetic-test-password');
  assert.throws(
    () =>
      readRuntimeConfig({
        NODE_ENV: 'production',
        HR_MODE: 'private-hosted',
        HR_DATA_MODE: 'private',
      }),
    /cannot be combined/,
  );
});

test('operational account mode has no shared password and does not seed by default', () => {
  const config = readRuntimeConfig({ HR_MODE: 'operational', HR_DATA_KEY: key });
  assert.equal(config.mode, 'operational');
  assert.equal(config.dataMode, 'private');
  assert.equal(config.accessPassword, undefined);
  assert.equal(config.seed, false);
  assert.equal(config.schema, 'hr_operational');
});

test('SQLite startup refuses an old migration version recorded under a different name', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sabq-hr-migration-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version,name,applied_at) VALUES(8,'accounts','2026-11-13T00:00:00.000Z');`);
  legacy.close();
  try {
    await assert.rejects(
      createDatabase(path, { seed: false }),
      /Migration version 8 is recorded as accounts; current migration is leave_opening_balance/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
