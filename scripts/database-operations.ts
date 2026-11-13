import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

if (existsSync('.env')) process.loadEnvFile('.env');
const mode = process.argv[2];
const source = resolve(process.argv[3] ?? process.env.HR_DB_PATH ?? '.data/hr-local.sqlite');
if (!existsSync(source))
  throw new Error('Local database does not exist. Start the app once before backing it up.');

function inspect(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    assert.equal(Object.values(integrity[0])[0], 'ok', 'SQLite integrity check failed');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'Broken foreign key');
    const tables = [
      'employees',
      'employment_periods',
      'policy_versions',
      'work_schedules',
      'leave_requests',
      'leave_ledger',
      'audit_events',
      'outbox',
      'idempotency',
      'schema_migrations',
    ];
    const counts: Record<string, number> = {};
    const hash = createHash('sha256');
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      counts[table] = rows.length;
      hash.update(table).update(JSON.stringify(rows));
    }
    return { integrity: 'ok', counts, contentHash: hash.digest('hex') };
  } finally {
    db.close();
  }
}

if (mode === 'backup') {
  const destination = resolve(
    '.data/backups',
    `hr-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`,
  );
  mkdirSync(dirname(destination), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  const verification = inspect(destination);
  // Exercise restoration into a separate temporary location; never replace the active database.
  const temporary = mkdtempSync(join(tmpdir(), 'sabq-hr-restore-'));
  try {
    const restored = join(temporary, 'restored.sqlite');
    copyFileSync(destination, restored);
    assert.deepEqual(inspect(restored), verification, 'Restored database differs from backup');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  process.stdout.write(
    JSON.stringify({ backup: destination, restoredCopyVerified: true, ...verification }, null, 2) +
      '\n',
  );
} else if (mode === 'verify') {
  process.stdout.write(JSON.stringify({ database: source, ...inspect(source) }, null, 2) + '\n');
} else {
  throw new Error('Usage: tsx scripts/database-operations.ts backup|verify [database-path]');
}
