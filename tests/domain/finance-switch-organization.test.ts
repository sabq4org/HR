import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Actor } from '../../server/administration/service.js';
import { registerFinance, type WafeqClientLike } from '../../server/finance/routes.js';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';
import { decryptSensitive, encryptSensitive } from '../../server/administration/security.js';

/**
 * A fake Wafeq account holding two organizations. Each key reaches one of them, and contacts are
 * kept per organization by external id, so a duplicate create is visible as a second contact.
 */
function fakeWafeq() {
  const orgs: Record<string, { id: string; name: string }> = {
    'old-key': { id: 'org-old', name: 'المؤسسة السابقة' },
    'new-key': { id: 'org-new', name: 'الشركة' },
  };
  const contacts = new Map<string, { id: string; externalId: string }[]>();
  let counter = 0;
  const stats = { creates: 0, finds: 0 };
  /** When set, the next create for this external id is saved in Wafeq but its reply is lost. */
  let dropReplyFor: string | null = null;
  const client = (key: string): WafeqClientLike => {
    const org = orgs[key];
    if (!org) throw new Error('unknown synthetic key');
    const list = () => contacts.get(org.id) ?? (contacts.set(org.id, []), contacts.get(org.id)!);
    return {
      getOrganization: async () => org,
      listCustomers: async () => [],
      findCustomerByExternalId: async (externalId) => {
        stats.finds++;
        const found = list().find((c) => c.externalId === externalId);
        return found ? { id: found.id } : null;
      },
      createCustomer: async (_input, externalId) => {
        stats.creates++;
        const created = { id: `${org.id}-co-${++counter}`, externalId };
        list().push(created);
        if (dropReplyFor === externalId) {
          dropReplyFor = null;
          throw new Error('network reply lost');
        }
        return { id: created.id };
      },
      getCustomer: async (id) => ({ id }),
      createInvoice: async () => {
        throw new Error('no invoices in this test');
      },
      findInvoiceByExternalId: async () => null,
      getInvoice: async () => {
        throw new Error('no invoices in this test');
      },
      reportInvoice: async () => {
        throw new Error('no invoices in this test');
      },
      getInvoicePdf: async () => Buffer.from(''),
    };
  };
  return {
    client,
    stats,
    contacts: (orgId: string) => contacts.get(orgId) ?? [],
    dropReply: (externalId: string) => (dropReplyFor = externalId),
  };
}

type Harness = {
  db: AsyncDb;
  wafeq: ReturnType<typeof fakeWafeq>;
  call: (path: string, body?: unknown, method?: string) => Promise<Response>;
  setActor: (actor: Actor) => void;
  close: () => Promise<void>;
};

async function harness(db: AsyncDb): Promise<Harness> {
  const wafeq = fakeWafeq();
  let actor: Actor = { id: 'finance-owner', role: 'hr' };
  const app = express();
  app.use(express.json());
  registerFinance(app, {
    db,
    requireActor: async () => actor,
    privateMode: true,
    allowedActorId: 'finance-owner',
    createClient: wafeq.client,
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    db,
    wafeq,
    setActor: (next) => (actor = next),
    call: (path, body, method = 'POST') =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.close();
    },
  };
}

type Customer = { id: string; version: number; wafeqId: string | null; syncStatus: string };
const customers = async (h: Harness) =>
  ((await (await h.call('/api/finance', undefined, 'GET')).json()) as { customers: Customer[] })
    .customers;

/** The loop to run after a switch: every customer goes through the normal sync route once. */
async function resyncAll(h: Harness) {
  const statuses: number[] = [];
  for (const customer of await customers(h))
    statuses.push(
      (await h.call(`/api/finance/customers/${customer.id}/sync`, { version: customer.version }))
        .status,
    );
  return statuses;
}

async function seedOldOrganization(h: Harness, count: number) {
  assert.equal((await h.call('/api/finance/settings/api-key', { apiKey: 'old-key' })).status, 200);
  for (let i = 1; i <= count; i++) {
    const created = await h.call('/api/finance/customers', {
      name: `عميل اصطناعي ${i}`,
      email: `c${i}@example.test`,
      vatNumber: '',
      address: { line: 'Synthetic Road', city: 'Riyadh', postalCode: '12345', country: 'SA' },
    });
    assert.equal(created.status, 201);
  }
  assert.deepEqual(new Set(await resyncAll(h)), new Set([200]));
  const all = await customers(h);
  assert.equal(all.filter((c) => c.syncStatus === 'synced').length, count);
  return new Set(all.map((c) => c.wafeqId));
}

const count = async (db: AsyncDb, sql: string, params: unknown[] = []) =>
  Number((await db.read<{ n: number | string }>(sql, params))[0].n);

const backends: [string, () => Promise<AsyncDb>][] = [
  ['SQLite', () => createDatabase()],
  ...(process.env.HR_TEST_DATABASE_URL
    ? ([
        [
          'PostgreSQL',
          () =>
            createPostgresDatabase(
              process.env.HR_TEST_DATABASE_URL!,
              `hr_test_switch_${randomUUID().replaceAll('-', '')}`,
              { seed: false },
            ),
        ],
      ] as [string, () => Promise<AsyncDb>][])
    : []),
];

for (const [backend, open] of backends) {
  test(`${backend}: switching organization resets 37 links and resyncs once each, without duplicates`, async () => {
    const h = await harness(await open());
    try {
      const oldIds = await seedOldOrganization(h, 37);
      assert.equal(oldIds.size, 37);
      assert.equal(h.wafeq.contacts('org-old').length, 37);
      // An older record whose snapshot carried provider fields: the switch must drop them too.
      const legacy = (await customers(h))[0];
      const legacyRow = (
        await h.db.read<{ customer_ciphertext: string }>(
          'SELECT customer_ciphertext FROM finance_customers WHERE id=?',
          [legacy.id],
        )
      )[0];
      const legacySnapshot = JSON.parse(
        decryptSensitive(legacyRow.customer_ciphertext, `finance:customer:${legacy.id}`),
      );
      await h.db.execute('UPDATE finance_customers SET customer_ciphertext=? WHERE id=?', [
        encryptSensitive(
          JSON.stringify({ ...legacySnapshot, wafeqId: legacy.wafeqId, syncStatus: 'synced' }),
          `finance:customer:${legacy.id}`,
        ),
        legacy.id,
      ]);

      // The ordinary key route still refuses another organization.
      const mismatch = await h.call('/api/finance/settings/api-key', { apiKey: 'new-key' });
      assert.equal(mismatch.status, 409);
      assert.equal(
        ((await mismatch.json()) as { error: { code: string } }).error.code,
        'WAFEQ_ORGANIZATION_MISMATCH',
      );

      // Without the confirmation nothing changes; the reply names both organizations.
      const preview = await h.call('/api/finance/settings/switch-organization', {
        apiKey: 'new-key',
      });
      assert.equal(preview.status, 409);
      const previewBody = (await preview.json()) as {
        error: { code: string };
        switch: { from: { id: string }; to: { id: string } };
      };
      assert.equal(previewBody.error.code, 'WAFEQ_SWITCH_CONFIRMATION_REQUIRED');
      assert.equal(previewBody.switch.from.id, 'org-old');
      assert.equal(previewBody.switch.to.id, 'org-new');
      assert.equal(JSON.stringify(previewBody).includes('new-key'), false);
      const wrong = await h.call('/api/finance/settings/switch-organization', {
        apiKey: 'new-key',
        confirmOrganizationId: 'org-old',
      });
      assert.equal(wrong.status, 409);
      assert.equal(
        (await customers(h)).filter((c) => c.syncStatus === 'synced').length,
        37,
        'unconfirmed switch must not touch customers',
      );

      const switched = await h.call('/api/finance/settings/switch-organization', {
        apiKey: 'new-key',
        confirmOrganizationId: 'org-new',
      });
      const switchedText = await switched.text();
      assert.equal(switched.status, 200, switchedText);
      assert.equal(switchedText.includes('new-key'), false);
      const result = JSON.parse(switchedText) as {
        reset: { customers: number; operations: number };
        settings: { organization: { id: string } };
      };
      assert.deepEqual(result.reset, { customers: 37, operations: 37 });
      assert.equal(result.settings.organization.id, 'org-new');

      const afterReset = await customers(h);
      assert.equal(afterReset.length, 37);
      assert.ok(afterReset.every((c) => c.wafeqId === null && c.syncStatus === 'not_synced'));
      assert.equal(
        await count(
          h.db,
          "SELECT COUNT(*) AS n FROM finance_provider_operations WHERE resource_type='customer'",
        ),
        0,
      );
      const rows = await h.db.read<{ id: string; customer_ciphertext: string }>(
        'SELECT id,customer_ciphertext FROM finance_customers',
      );
      for (const row of rows) {
        const snapshot = JSON.parse(
          decryptSensitive(row.customer_ciphertext, `finance:customer:${row.id}`),
        ) as Record<string, unknown>;
        assert.equal('wafeqId' in snapshot, false);
        assert.equal('syncStatus' in snapshot, false);
        assert.match(String(snapshot.name), /^عميل اصطناعي/);
      }
      assert.equal(
        await count(
          h.db,
          "SELECT COUNT(*) AS n FROM administration_events WHERE action='provider_organization_switched'",
        ),
        1,
      );
      assert.equal(
        await count(
          h.db,
          "SELECT COUNT(*) AS n FROM administration_events WHERE action='provider_link_reset'",
        ),
        37,
      );
      assert.equal((await h.call('/api/finance/settings/test', {})).status, 200);

      // One customer's create reaches Wafeq but its reply is lost; the loop resumes cleanly.
      const victim = afterReset[4];
      h.wafeq.dropReply(victim.id);
      const first = await resyncAll(h);
      assert.equal(first.filter((s) => s === 503).length, 1);
      assert.equal(first.filter((s) => s === 200).length, 36);
      assert.equal(h.wafeq.contacts('org-new').length, 37);

      const createsBeforeRerun = h.wafeq.stats.creates;
      const second = await resyncAll(h);
      assert.ok(second.every((s) => s === 200));
      assert.equal(h.wafeq.stats.creates, createsBeforeRerun, 'resume must find, not create');

      const synced = await customers(h);
      const newIds = new Set(synced.map((c) => c.wafeqId));
      assert.ok(synced.every((c) => c.syncStatus === 'synced' && c.wafeqId?.startsWith('org-new')));
      assert.equal(newIds.size, 37);
      assert.equal([...newIds].filter((id) => oldIds.has(id)).length, 0);
      assert.equal(h.wafeq.contacts('org-new').length, 37);
      assert.equal(
        new Set(h.wafeq.contacts('org-new').map((c) => c.externalId)).size,
        37,
        'one contact per customer',
      );

      // A third full run creates nothing.
      const createsBeforeThird = h.wafeq.stats.creates;
      assert.ok((await resyncAll(h)).every((s) => s === 200));
      assert.equal(h.wafeq.stats.creates, createsBeforeThird);
      assert.equal(h.wafeq.contacts('org-old').length, 37, 'old organization is never touched');

      // Switching to the organization already bound is refused.
      const same = await h.call('/api/finance/settings/switch-organization', {
        apiKey: 'new-key',
        confirmOrganizationId: 'org-new',
      });
      assert.equal(same.status, 409);
      assert.equal(
        ((await same.json()) as { error: { code: string } }).error.code,
        'WAFEQ_SAME_ORGANIZATION',
      );
    } finally {
      await h.close();
    }
  });

  test(`${backend}: switch is refused while any invoice was sent to the current organization`, async () => {
    const h = await harness(await open());
    try {
      await seedOldOrganization(h, 3);
      await h.db.execute(
        "INSERT INTO finance_provider_operations(id,owner_id,resource_type,resource_id,idempotency_key,report_idempotency_key,state,lease_until,created_at,updated_at) VALUES(?,?,'invoice',?,?,?,'complete',NULL,?,?)",
        [
          randomUUID(),
          'finance-owner',
          randomUUID(),
          randomUUID(),
          randomUUID(),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      const blocked = await h.call('/api/finance/settings/switch-organization', {
        apiKey: 'new-key',
        confirmOrganizationId: 'org-new',
      });
      assert.equal(blocked.status, 409);
      assert.equal(
        ((await blocked.json()) as { error: { code: string } }).error.code,
        'WAFEQ_SWITCH_BLOCKED',
      );
      const after = await customers(h);
      assert.ok(after.every((c) => c.syncStatus === 'synced' && c.wafeqId?.startsWith('org-old')));
      assert.equal(
        await count(
          h.db,
          "SELECT COUNT(*) AS n FROM finance_provider_operations WHERE resource_type='customer'",
        ),
        3,
      );
      // The stored credential still points at the old organization.
      assert.equal((await h.call('/api/finance/settings/test', {})).status, 200);
      assert.equal(
        (
          (await (await h.call('/api/finance/settings', undefined, 'GET')).json()) as {
            settings: { organization: { id: string } };
          }
        ).settings.organization.id,
        'org-old',
      );
    } finally {
      await h.close();
    }
  });

  test(`${backend}: switch needs an existing connection and the finance owner`, async () => {
    const h = await harness(await open());
    try {
      const none = await h.call('/api/finance/settings/switch-organization', {
        apiKey: 'new-key',
        confirmOrganizationId: 'org-new',
      });
      assert.equal(none.status, 409);
      assert.equal(
        ((await none.json()) as { error: { code: string } }).error.code,
        'WAFEQ_NOT_CONNECTED',
      );
      h.setActor({ id: 'someone-else', role: 'hr' });
      const denied = await h.call('/api/finance/settings/switch-organization', {
        apiKey: 'new-key',
        confirmOrganizationId: 'org-new',
      });
      assert.equal(denied.status, 403);
      assert.equal((await denied.text()).includes('new-key'), false);
    } finally {
      await h.close();
    }
  });
}
