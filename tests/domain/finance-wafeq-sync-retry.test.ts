import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { registerFinance } from '../../server/finance/routes.js';
import { WafeqClient } from '../../server/integrations/wafeq.js';
import { encryptSensitive } from '../../server/administration/security.js';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';

/**
 * Wafeq at the HTTP level, as observed on 2026-11-16: an empty email fails validation with a
 * field error, and a stored response is replayed for a reused idempotency key even when the
 * body changed. A create can also be saved while its reply is lost.
 */
function fakeWafeqHttp() {
  const contacts: { id: string; external_id: string; body: Record<string, unknown> }[] = [];
  const replay = new Map<string, { status: number; body: unknown }>();
  const stats = { creates: 0, rejected: 0, replayed: 0 };
  let loseNextReply = false;
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\//, '');
    if (path === 'organization/') return json({ id: 'org-new', name: { ar: 'الشركة' } }, 200);
    if (path === 'contacts/' && (init.method ?? 'GET') === 'GET') {
      const externalId = url.searchParams.get('external_id');
      const rows = contacts
        .filter((c) => externalId === null || c.external_id === externalId)
        .map((c) => ({ id: c.id, external_id: c.external_id }));
      return json({ count: rows.length, next: null, results: rows }, 200);
    }
    if (path === 'contacts/' && init.method === 'POST') {
      const key = new Headers(init.headers).get('x-wafeq-idempotency-key') ?? '';
      const stored = replay.get(key);
      if (stored) {
        stats.replayed++;
        return json(stored.body, stored.status);
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      let reply: { status: number; body: unknown };
      if ('email' in body && !String(body.email).trim()) {
        stats.rejected++;
        reply = { status: 400, body: { email: ['Enter a valid email address.'] } };
      } else {
        stats.creates++;
        const created = { id: `co_${stats.creates}`, external_id: String(body.external_id), body };
        contacts.push(created);
        reply = { status: 201, body: { id: created.id, external_id: created.external_id } };
      }
      replay.set(key, reply);
      if (loseNextReply && reply.status === 201) {
        loseNextReply = false;
        throw new TypeError('socket hang up');
      }
      return json(reply.body, reply.status);
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${path}`);
  }) as typeof fetch;
  return {
    fetchImpl,
    contacts,
    replay,
    stats,
    loseNextReply: () => (loseNextReply = true),
  };
}

async function harness(db: AsyncDb) {
  const wafeq = fakeWafeqHttp();
  const app = express();
  app.use(express.json());
  registerFinance(app, {
    db,
    requireActor: async () => ({ id: 'finance-owner', role: 'hr' }),
    privateMode: true,
    allowedActorId: 'finance-owner',
    createClient: (key) => new WafeqClient(key, wafeq.fetchImpl),
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, body?: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await call('/api/finance/settings/api-key', { apiKey: 'synthetic' })).status, 200);
  // The customer form requires an email; the email-less ones in production came from the
  // Wafeq import, which stores the contact as Wafeq had it. This inserts the same row it does.
  const createCustomer = async (email: string) => {
    const id = randomUUID(),
      at = new Date().toISOString();
    const input = {
      name: `عميل ${id.slice(0, 6)}`,
      email,
      vatNumber: '',
      address: { line: 'Synthetic Road', city: 'Riyadh', postalCode: '12345', country: 'SA' },
      type: 'business',
    };
    await db.execute(
      "INSERT INTO finance_customers(id,owner_id,version,customer_ciphertext,created_at,updated_at,wafeq_id,sync_status) VALUES(?,?,1,?,?,?,NULL,'not_synced')",
      [
        id,
        'finance-owner',
        encryptSensitive(JSON.stringify(input), `finance:customer:${id}`),
        at,
        at,
      ],
    );
    return { id, version: 1 };
  };
  const sync = async (id: string) => {
    const current = (
      (await (await call('/api/finance', undefined, 'GET')).json()) as {
        customers: { id: string; version: number }[];
      }
    ).customers.find((c) => c.id === id)!;
    const response = await call(`/api/finance/customers/${id}/sync`, {
      version: current.version,
    });
    const body = (await response.json()) as {
      customer?: { syncStatus: string; wafeqId: string | null; syncMessage?: string };
      error?: { code: string };
    };
    return { status: response.status, ...body };
  };
  const operationKey = async (id: string) =>
    (
      await db.read<{ idempotency_key: string; state: string }>(
        "SELECT idempotency_key,state FROM finance_provider_operations WHERE resource_type='customer' AND resource_id=?",
        [id],
      )
    )[0];
  return {
    db,
    wafeq,
    createCustomer,
    sync,
    operationKey,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.close();
    },
  };
}

const backends: [string, () => Promise<AsyncDb>][] = [
  ['SQLite', () => createDatabase()],
  ...(process.env.HR_TEST_DATABASE_URL
    ? ([
        [
          'PostgreSQL',
          () =>
            createPostgresDatabase(
              process.env.HR_TEST_DATABASE_URL!,
              `hr_test_retry_${randomUUID().replaceAll('-', '')}`,
              { seed: false },
            ),
        ],
      ] as [string, () => Promise<AsyncDb>][])
    : []),
];

for (const [backend, open] of backends) {
  test(`${backend}: customers without an email sync on the first attempt`, async () => {
    const h = await harness(await open());
    try {
      for (let i = 0; i < 4; i++) {
        const customer = await h.createCustomer('');
        const result = await h.sync(customer.id);
        assert.equal(result.status, 200);
        assert.equal(result.customer?.syncStatus, 'synced');
      }
      assert.equal(h.wafeq.stats.rejected, 0);
      assert.equal(h.wafeq.contacts.length, 4);
      assert.ok(h.wafeq.contacts.every((c) => !('email' in c.body)));
      assert.ok(
        h.wafeq.contacts.every(
          (c) => !('phone' in c.body) && !('tax_registration_number' in c.body),
        ),
      );
    } finally {
      await h.close();
    }
  });

  test(`${backend}: a rejected attempt stuck on a replayed key recovers with one contact`, async () => {
    const h = await harness(await open());
    try {
      const customer = await h.createCustomer('');
      // The state production was left in: the old payload sent email "" under this key, Wafeq
      // stored the rejection, and the customer shows the error.
      const stuck = randomUUID();
      const at = new Date().toISOString();
      await h.db.execute(
        "INSERT INTO finance_provider_operations(id,owner_id,resource_type,resource_id,idempotency_key,report_idempotency_key,state,lease_until,created_at,updated_at) VALUES(?,?,'customer',?,?,?,'reconciliation_required',NULL,?,?)",
        [randomUUID(), 'finance-owner', customer.id, stuck, randomUUID(), at, at],
      );
      await h.db.execute(
        "UPDATE finance_customers SET sync_status='error',sync_message='تعذر إكمال المزامنة (http_error).' WHERE id=?",
        [customer.id],
      );
      h.wafeq.replay.set(stuck, { status: 400, body: { email: ['Enter a valid email address.'] } });

      const first = await h.sync(customer.id);
      assert.equal(first.status, 503);
      assert.equal(first.error?.code, 'WAFEQ_SYNC_UNCERTAIN');
      assert.match(first.customer?.syncMessage ?? '', /invalid_email/);
      assert.equal(h.wafeq.stats.replayed, 1);
      const rotated = await h.operationKey(customer.id);
      assert.notEqual(rotated.idempotency_key, stuck, 'a definite rejection rotates the key');

      const second = await h.sync(customer.id);
      assert.equal(second.status, 200);
      assert.equal(second.customer?.syncStatus, 'synced');
      const third = await h.sync(customer.id);
      assert.equal(third.status, 200);
      assert.equal(h.wafeq.contacts.filter((c) => c.external_id === customer.id).length, 1);
      assert.equal(h.wafeq.stats.creates, 1);
      assert.equal(second.customer?.wafeqId, h.wafeq.contacts[0].id);
    } finally {
      await h.close();
    }
  });

  test(`${backend}: an uncertain create keeps its key and the retry finds the contact`, async () => {
    const h = await harness(await open());
    try {
      const customer = await h.createCustomer('billing@example.test');
      h.wafeq.loseNextReply();
      const lost = await h.sync(customer.id);
      assert.equal(lost.status, 503);
      assert.equal(lost.customer?.syncStatus, 'error');
      const before = await h.operationKey(customer.id);
      assert.equal(before.state, 'reconciliation_required');
      assert.equal(h.wafeq.contacts.length, 1, 'Wafeq saved it although the reply was lost');

      const retried = await h.sync(customer.id);
      assert.equal(retried.status, 200);
      assert.equal(retried.customer?.wafeqId, h.wafeq.contacts[0].id);
      assert.equal(
        (await h.operationKey(customer.id)).idempotency_key,
        before.idempotency_key,
        'an uncertain failure keeps its key',
      );
      assert.equal(h.wafeq.stats.creates, 1);
      assert.equal((await h.sync(customer.id)).status, 200);
      assert.equal(h.wafeq.contacts.length, 1);
    } finally {
      await h.close();
    }
  });
}
