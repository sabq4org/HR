import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import {
  createDatabase,
  createPostgresDatabase,
  todayInRiyadh,
  type Db,
} from '../../server/database.js';
import { registerRenewals } from '../../server/administration/renewals.js';
import type { Actor } from '../../server/administration/service.js';

const plus = (days: number) => {
  const date = new Date(`${todayInRiyadh()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

async function actorFor(db: Db, id: string): Promise<Actor | null> {
  const row = (
    await db.read<{ id: string; role: Actor['role'] }>(
      'SELECT id,role FROM employee_access WHERE id=?',
      [id],
    )
  )[0];
  if (!row) return null;
  const owner = (
    await db.read<{ id: string }>(
      'SELECT employee_id AS id FROM system_owners WHERE employee_id=?',
      [id],
    )
  )[0];
  return { id: row.id, role: row.role, owner: !!owner };
}

async function insertDocument(
  db: Db,
  id: string,
  employeeId: string,
  category: string,
  expiresAt: string | null,
  version = 1,
) {
  await db.execute(
    `INSERT INTO employee_documents
      (id,employee_id,category,filename,mime_type,size_bytes,expires_at,uploaded_at,uploaded_by,checksum,encrypted_content,version,state,renewal_fee_halalas)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      employeeId,
      category,
      `${category}.pdf`,
      'application/pdf',
      12,
      expiresAt,
      new Date().toISOString(),
      'emp-noura',
      randomUUID(),
      'synthetic-encrypted-content',
      version,
      'active',
      category === 'identity' ? 65000 : null,
    ],
  );
}

async function insertHrEmployee(db: Db, id: string) {
  await db.execute(
    `INSERT INTO employees
      (id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      `HR-${id}`,
      'مسؤول موارد بشرية اصطناعي',
      'م ب',
      'HR',
      'الموارد البشرية',
      `${id}@example.test`,
      'الرياض',
      null,
      '2026-01-01',
      'hr',
      '#fff',
    ],
  );
}

async function harness(db: Db) {
  const app = express();
  app.use(express.json());
  registerRenewals(app, {
    db,
    requireActor: async (req) => {
      const actor = await actorFor(db, req.header('x-actor') ?? '');
      if (!actor) throw new Error('test actor not found');
      return actor;
    },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (actor: string, path: string, method: string, body?: unknown, key?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'x-actor': actor,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    request,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function runRenewalScenario(db: Db) {
  await insertDocument(db, 'doc-renewal-1', 'emp-sara', 'identity', plus(5));
  await insertDocument(db, 'proof-renewal-1', 'emp-sara', 'renewal_proof', null);
  await insertHrEmployee(db, 'emp-hr2');
  await insertDocument(db, 'doc-renewal-hr-owner', 'emp-noura', 'identity', plus(20));
  const h = await harness(db);
  try {
    assert.equal((await h.request('emp-sara', '/api/admin/renewals', 'GET')).status, 403);
    const selfAssignment = await h.request(
      'emp-hr2',
      '/api/admin/renewals',
      'POST',
      { documentId: 'doc-renewal-hr-owner', documentVersion: 1, assignedTo: 'emp-noura' },
      'renewal-self-assignment',
    );
    assert.equal(selfAssignment.status, 400);
    assert.match(await selfAssignment.text(), /INVALID_ASSIGNEE/);
    const created = await h.request(
      'emp-noura',
      '/api/admin/renewals',
      'POST',
      { documentId: 'doc-renewal-1', documentVersion: 1, assignedTo: 'emp-noura' },
      'renewal-create-1',
    );
    assert.equal(created.status, 201, await created.clone().text());
    const createdCase = ((await created.json()) as { case: Record<string, unknown> }).case;
    assert.equal(createdCase.status, 'open');
    assert.equal(createdCase.documentVersion, 1);
    assert.equal(createdCase.feeHalalas, 65000);

    const replay = await h.request(
      'emp-noura',
      '/api/admin/renewals',
      'POST',
      { documentId: 'doc-renewal-1', documentVersion: 1, assignedTo: 'emp-noura' },
      'renewal-create-1',
    );
    assert.equal(replay.status, 201);
    assert.equal(((await replay.json()) as { case: { id: string } }).case.id, createdCase.id);
    assert.equal(
      (
        await h.request(
          'emp-noura',
          '/api/admin/renewals',
          'POST',
          { documentId: 'doc-renewal-1', documentVersion: 1, assignedTo: 'emp-noura' },
          'renewal-create-2',
        )
      ).status,
      409,
    );

    const completed = await h.request(
      'emp-noura',
      `/api/admin/renewals/${createdCase.id}/complete`,
      'POST',
      {
        version: 1,
        documentVersion: 1,
        proofDocumentId: 'proof-renewal-1',
        newExpiry: plus(365),
        payment: 'owner',
        reason: 'تم استلام الإثبات الاصطناعي',
      },
      'renewal-complete-1',
    );
    assert.equal(completed.status, 200, await completed.clone().text());
    const renewed = ((await completed.json()) as { case: Record<string, unknown> }).case;
    assert.equal(renewed.status, 'renewed');
    assert.equal(renewed.version, 2);
    assert.equal(renewed.documentVersion, 2);
    assert.equal(renewed.payment, 'owner');
    const source = (
      await db.read<{ expires_at: string; version: number }>(
        'SELECT expires_at,version FROM employee_documents WHERE id=?',
        ['doc-renewal-1'],
      )
    )[0];
    assert.equal(source.expires_at, plus(365));
    assert.equal(Number(source.version), 2);
    assert.equal(
      (
        await h.request(
          'emp-noura',
          `/api/admin/renewals/${createdCase.id}/complete`,
          'POST',
          {
            version: 1,
            documentVersion: 1,
            proofDocumentId: 'proof-renewal-1',
            newExpiry: plus(400),
            payment: 'none',
            reason: 'محاولة مزدوجة',
          },
          'renewal-complete-2',
        )
      ).status,
      409,
    );

    const next = await h.request(
      'emp-noura',
      '/api/admin/renewals',
      'POST',
      { documentId: 'doc-renewal-1', documentVersion: 2, assignedTo: 'emp-noura' },
      'renewal-create-3',
    );
    assert.equal(next.status, 201, await next.clone().text());
    const nextCase = ((await next.json()) as { case: { id: string; version: number } }).case;
    const cancelled = await h.request(
      'emp-noura',
      `/api/admin/renewals/${nextCase.id}/cancel`,
      'POST',
      { version: 1, reason: 'إسناد خاطئ' },
      'renewal-cancel-1',
    );
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    assert.equal(
      ((await cancelled.json()) as { case: { status: string } }).case.status,
      'cancelled',
    );
    const reopened = await h.request(
      'emp-noura',
      '/api/admin/renewals',
      'POST',
      { documentId: 'doc-renewal-1', documentVersion: 2, assignedTo: 'emp-noura' },
      'renewal-create-4',
    );
    assert.equal(reopened.status, 201, await reopened.clone().text());
    const reopenedCase = ((await reopened.json()) as { case: { id: string } }).case;
    await db.execute("UPDATE employees SET employment_status='terminated' WHERE id='emp-sara'");
    const historical = (await (
      await h.request('emp-noura', '/api/admin/renewals', 'GET')
    ).json()) as {
      cases: { id: string; status: string }[];
    };
    assert.ok(
      historical.cases.some((entry) => entry.id === reopenedCase.id && entry.status === 'open'),
    );
    const cancelDeparted = await h.request(
      'emp-noura',
      `/api/admin/renewals/${reopenedCase.id}/cancel`,
      'POST',
      { version: 1, reason: 'الموظف غادر قبل إتمام التجديد' },
      'renewal-cancel-departed',
    );
    assert.equal(cancelDeparted.status, 200, await cancelDeparted.clone().text());
    assert.equal(
      ((await cancelDeparted.json()) as { case: { status: string } }).case.status,
      'cancelled',
    );
    const listing = (await (await h.request('emp-noura', '/api/admin/renewals', 'GET')).json()) as {
      cases: { id: string; status: string; documentVersion: number }[];
      assignees: { id: string }[];
    };
    assert.ok(listing.cases.some((entry) => entry.status === 'cancelled'));
    assert.ok(listing.assignees.some((entry) => entry.id === 'emp-noura'));
  } finally {
    await h.close();
  }
}

test('document renewal workflow is atomic and idempotent on synthetic SQLite', async () => {
  const db = await createDatabase();
  try {
    await runRenewalScenario(db);
  } finally {
    await db.close();
  }
});

test(
  'document renewal migration and read route work on PostgreSQL when configured',
  { skip: !process.env.HR_TEST_DATABASE_URL },
  async () => {
    const schema = `hr_preview_${randomBytes(16).toString('hex')}`;
    const db = await createPostgresDatabase(process.env.HR_TEST_DATABASE_URL!, schema);
    try {
      await runRenewalScenario(db);
    } finally {
      await db.close();
    }
  },
);
