import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDatabase, createPostgresDatabase, type Db } from '../../server/database.js';
import { decryptSensitive, encryptSensitive } from '../../server/administration/security.js';
import { runMaintenance, startOperations } from '../../server/operations/index.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;
const pgIsLocal = (() => {
  if (!pgUrl) return false;
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(pgUrl).hostname);
  } catch {
    return false;
  }
})();

const date = '2026-11-14T12:00:00.000Z';
const day = 24 * 60 * 60 * 1000;

async function addDocument(db: Db, id: string, category: string, expiresAt: string) {
  await db.execute(
    `INSERT INTO employee_documents
       (id,employee_id,category,filename,mime_type,size_bytes,expires_at,uploaded_at,uploaded_by,checksum,encrypted_content,version,state)
     VALUES(?, 'emp-sara', ?, 'synthetic.pdf', 'application/pdf', 10, ?, ?, 'emp-noura', 'synthetic', 'synthetic', 1, 'active')`,
    [id, category, expiresAt, date],
  );
}

test('maintenance adds private internal reminders once and keys replay to resource version and recipient', async () => {
  const db = await createDatabase();
  try {
    // Three days remain: this falls into the configured seven-day band.
    await addDocument(db, 'doc-ops-1', 'identity', '2026-11-17');
    await addDocument(db, 'doc-ops-medical', 'medical_insurance', '2026-11-15');
    const profile = (
      await db.read<{ encrypted_values_json: string }>(
        'SELECT encrypted_values_json FROM employee_profile_data WHERE employee_id=?',
        ['emp-sara'],
      )
    )[0];
    const values = JSON.parse(
      decryptSensitive(profile.encrypted_values_json, 'employee-profile:emp-sara'),
    );
    values.contractEnd = '2026-11-16';
    await db.execute(
      'UPDATE employee_profile_data SET encrypted_values_json=?,version=version+1 WHERE employee_id=?',
      [encryptSensitive(JSON.stringify(values), 'employee-profile:emp-sara'), 'emp-sara'],
    );
    await db.execute("UPDATE employees SET employment_status='terminated' WHERE id='emp-omar'");
    await db.execute(
      `INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,status,created_at)
       VALUES('leave-ops-1','emp-sara','2026-12-01','2026-12-01',1,'pending_manager',?)`,
      [new Date(Date.parse(date) - 5 * day).toISOString()],
    );
    const overdue = new Date(Date.parse(date) - 5 * day).toISOString();
    await db.execute(
      `INSERT INTO administrative_requests
       (id,request_number,kind,employee_id,created_by,state,version,values_json,steps_json,step_index,created_at,updated_at)
       VALUES('request-ops-1','OPS-1','employment_letter','emp-sara','emp-sara','pending_hr',1,'{}','["hr"]',0,?,?)`,
      [overdue, overdue],
    );

    const first = await runMaintenance(db, { now: date });
    assert.equal(first.status, 'succeeded');
    // Document and contract reminders go only to the employee and active HR.
    assert.equal(first.remindersCreated, 5);
    assert.equal(
      (
        await db.read<{ n: number }>(
          "SELECT count(*) AS n FROM outbox WHERE leave_id='leave-ops-1'",
        )
      )[0].n,
      0,
      'terminated manager must not receive overdue leave approval',
    );
    assert.equal(
      (
        await db.read<{ recipient_id: string }>(
          "SELECT recipient_id FROM outbox WHERE request_id='request-ops-1'",
        )
      )[0].recipient_id,
      'emp-noura',
      'an overdue request routes to its current active HR role recipient',
    );
    const messages = await db.read<{ recipient_id: string; title: string; body: string }>(
      'SELECT recipient_id,title,body FROM outbox ORDER BY id',
    );
    assert.deepEqual(messages.map((message) => message.recipient_id).sort(), [
      'emp-noura',
      'emp-noura',
      'emp-noura',
      'emp-sara',
      'emp-sara',
    ]);
    assert.ok(
      messages.every(
        (message) => !/medical|2026|Sara|هوية|عقد|تأمين/u.test(`${message.title} ${message.body}`),
      ),
    );
    assert.ok(messages.every((message) => message.body.length < 100));

    const replay = await runMaintenance(db, { now: date });
    assert.equal(replay.status, 'succeeded');
    assert.equal(replay.remindersCreated, 0);

    await db.execute("UPDATE employee_documents SET version=version+1 WHERE id='doc-ops-1'");
    const updated = await runMaintenance(db, { now: date });
    assert.equal(updated.status, 'succeeded');
    assert.equal(
      updated.remindersCreated,
      2,
      'resource version changes permit a fresh reminder per recipient',
    );
    const runs = await db.read<{ status: string; failure_code: string | null }>(
      'SELECT status,failure_code FROM operations_job_runs ORDER BY started_at',
    );
    assert.equal(runs.length, 3);
    assert.ok(runs.every((run) => run.status === 'succeeded' && run.failure_code === null));
  } finally {
    await db.close();
  }
});

test('failed maintenance rolls back notifications and a corrected profile succeeds on retry', async () => {
  const db = await createDatabase();
  try {
    await addDocument(db, 'doc-retry', 'identity', '2026-11-16');
    const valid = (
      await db.read<{ encrypted_values_json: string }>(
        'SELECT encrypted_values_json FROM employee_profile_data WHERE employee_id=?',
        ['emp-sara'],
      )
    )[0].encrypted_values_json;
    await db.execute(
      "UPDATE employee_profile_data SET encrypted_values_json='bad-ciphertext' WHERE employee_id='emp-sara'",
    );
    const failed = await runMaintenance(db, { now: date });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'MAINTENANCE_PASS_FAILED');
    assert.equal(failed.remindersCreated, 0);
    assert.equal((await db.read<{ n: number }>('SELECT count(*) AS n FROM outbox'))[0].n, 0);
    assert.equal(
      (await db.read<{ n: number }>('SELECT count(*) AS n FROM operations_reminder_dedupe'))[0].n,
      0,
    );
    await db.execute(
      "UPDATE employee_profile_data SET encrypted_values_json=? WHERE employee_id='emp-sara'",
      [valid],
    );
    const retried = await runMaintenance(db, { now: date });
    assert.equal(retried.status, 'succeeded');
    assert.equal(retried.remindersCreated, 2);
    assert.equal(
      (
        await db.read<{ status: string; failure_code: string | null }>(
          'SELECT status,failure_code FROM operations_job_runs WHERE id=?',
          [failed.runId],
        )
      )[0].status,
      'failed',
    );
  } finally {
    await db.close();
  }
});

test('scheduler validates intervals, prevents overlap, and waits for its active pass on close', async () => {
  const db = await createDatabase();
  try {
    assert.throws(() => startOperations(db, { intervalMs: 1 }), /interval/i);
    const scheduler = startOperations(db, { intervalMs: 60_000 });
    await scheduler.close();
    const runs = await db.read<{ status: string }>('SELECT status FROM operations_job_runs');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
  } finally {
    await db.close();
  }
});

test(
  'PostgreSQL maintenance migrations, transactional outbox, replay, and retry work on a local isolated schema',
  { skip: !pgIsLocal },
  async () => {
    const schema = `hr_preview_${randomBytes(16).toString('hex')}`;
    const db = await createPostgresDatabase(pgUrl!, schema);
    try {
      await addDocument(db, 'pg-doc-ops', 'identity', '2026-11-16');
      const profile = (
        await db.read<{ encrypted_values_json: string }>(
          'SELECT encrypted_values_json FROM employee_profile_data WHERE employee_id=?',
          ['emp-sara'],
        )
      )[0];
      const values = JSON.parse(
        decryptSensitive(profile.encrypted_values_json, 'employee-profile:emp-sara'),
      );
      values.contractEnd = '2026-11-16';
      await db.execute(
        'UPDATE employee_profile_data SET encrypted_values_json=?,version=version+1 WHERE employee_id=?',
        [encryptSensitive(JSON.stringify(values), 'employee-profile:emp-sara'), 'emp-sara'],
      );
      const first = await runMaintenance(db, { now: date });
      assert.equal(first.status, 'succeeded');
      assert.equal(first.remindersCreated, 4);
      const replay = await runMaintenance(db, { now: date });
      assert.equal(replay.status, 'succeeded');
      assert.equal(replay.remindersCreated, 0);
      await db.execute("UPDATE employee_documents SET version=version+1 WHERE id='pg-doc-ops'");
      const changed = await runMaintenance(db, { now: date });
      assert.equal(changed.status, 'succeeded');
      assert.equal(changed.remindersCreated, 2);

      await addDocument(db, 'pg-doc-retry', 'identity', '2026-11-15');
      const validProfile = encryptSensitive(JSON.stringify(values), 'employee-profile:emp-sara');
      const dedupeBeforeFailure = (
        await db.read<{ n: string }>('SELECT count(*)::text AS n FROM operations_reminder_dedupe')
      )[0].n;
      await db.execute(
        "UPDATE employee_profile_data SET encrypted_values_json='bad-ciphertext' WHERE employee_id='emp-sara'",
      );
      const failed = await runMaintenance(db, { now: date });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failureCode, 'MAINTENANCE_PASS_FAILED');
      assert.equal(
        (
          await db.read<{ n: string }>('SELECT count(*)::text AS n FROM operations_reminder_dedupe')
        )[0].n,
        dedupeBeforeFailure,
      );
      await db.execute(
        'UPDATE employee_profile_data SET encrypted_values_json=? WHERE employee_id=?',
        [validProfile, 'emp-sara'],
      );
      const retried = await runMaintenance(db, { now: date });
      assert.equal(retried.status, 'succeeded');
      assert.equal(retried.remindersCreated, 2);
    } finally {
      await db.close();
    }
  },
);
