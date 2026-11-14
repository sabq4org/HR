import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../../server/database.js';
import { bootstrapAccounts } from '../../server/bootstrap-accounts.js';

const nominees = [
  {
    name: 'مسؤول حسابات اصطناعي',
    employeeNumber: 'TEST-HR',
    email: 'hr@example.test',
    title: 'موارد بشرية',
    department: 'اختبار',
    location: 'الرياض',
    joinDate: '2026-11-01',
    role: 'hr',
  },
  {
    name: 'معتمد اصطناعي',
    employeeNumber: 'TEST-APPROVER',
    email: 'approver@example.test',
    title: 'معتمد',
    department: 'اختبار',
    location: 'الرياض',
    joinDate: '2026-11-01',
    role: 'approver',
  },
];

test('offline bootstrap provisions distinct inactive MFA accounts atomically and persists without fictional balances', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hr-accounts-bootstrap-'));
  const path = join(directory, 'pilot.sqlite');
  let db = await createDatabase(path, { seed: false });
  try {
    const invitations = await bootstrapAccounts(db, nominees);
    assert.equal(invitations.length, 2);
    const accounts = await db.read<{
      activation_token_hash: string;
      enabled: number;
      password_hash: string | null;
    }>('SELECT * FROM employee_accounts');
    assert.equal(accounts.length, 2);
    assert.ok(accounts.every((account) => account.enabled === 0 && account.password_hash === null));
    assert.ok(
      accounts.every(
        (account) =>
          !invitations.some(
            (invitation) => invitation.activationToken === account.activation_token_hash,
          ),
      ),
    );
    assert.equal((await db.read('SELECT id FROM leave_ledger')).length, 0);
    await assert.rejects(() => bootstrapAccounts(db, nominees), /empty operational storage/);
    await db.close();
    db = await createDatabase(path, { seed: false });
    assert.equal((await db.read('SELECT employee_id FROM employee_accounts')).length, 2);
    assert.equal((await db.read('SELECT id FROM employees')).length, 2);
    assert.equal((await db.read('SELECT id FROM leave_ledger')).length, 0);
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent initial setup creates one pair, and invalid identities create no partial employees', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  try {
    await assert.rejects(() => bootstrapAccounts(db, [nominees[0], nominees[0]]), /distinct/);
    assert.equal((await db.read('SELECT id FROM employees')).length, 0);
    await assert.rejects(
      () =>
        bootstrapAccounts(db, nominees, {
          beforeCommit() {
            throw new Error('output write failed');
          },
        }),
      /output write failed/,
    );
    assert.equal(
      (await db.read('SELECT id FROM employees')).length,
      0,
      'failed secret delivery must roll back both identities',
    );
    assert.equal((await db.read('SELECT employee_id FROM employee_accounts')).length, 0);
    const outcomes = await Promise.allSettled([
      bootstrapAccounts(db, nominees),
      bootstrapAccounts(db, nominees),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal((await db.read('SELECT id FROM employees')).length, 2);
  } finally {
    await db.close();
  }
});
