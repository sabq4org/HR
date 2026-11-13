import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
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
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const counts: Record<string, number> = {};
    const hash = createHash('sha256');
    hash.update(
      JSON.stringify(
        db
          .prepare(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
          )
          .all(),
      ),
    );
    for (const table of tables) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(table))
        throw new Error('Unsafe table name in backup inspection');
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
    chmodSync(destination, 0o600);
  } finally {
    db.close();
  }
  const verification = inspect(destination);
  // Local development only. An environment-managed key must be backed up by
  // its secret manager; never print it or embed it into a Git-tracked manifest.
  const localKey = resolve('.data/hr-data.key');
  const keyBackup = !process.env.HR_DATA_KEY && existsSync(localKey) ? `${destination}.key` : null;
  if (keyBackup) {
    copyFileSync(localKey, keyBackup);
    chmodSync(keyBackup, 0o600);
  }
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
    JSON.stringify(
      {
        backup: destination,
        localKeyBackup: keyBackup,
        environmentKeyRequiresSecretManagerBackup: !!process.env.HR_DATA_KEY,
        restoredCopyVerified: true,
        ...verification,
      },
      null,
      2,
    ) + '\n',
  );
} else if (mode === 'verify') {
  process.stdout.write(JSON.stringify({ database: source, ...inspect(source) }, null, 2) + '\n');
} else {
  throw new Error('Usage: tsx scripts/database-operations.ts backup|verify [database-path]');
}
