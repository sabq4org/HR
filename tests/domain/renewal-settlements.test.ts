import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Actor } from '../../server/administration/service.js';
import { registerFinance, type WafeqClientLike } from '../../server/finance/routes.js';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';
import type {
  RenewalSettlementDetails,
  RenewalSettlementSummary,
} from '../../shared/renewal-settlements.js';
import type { LedgerOverview, LedgerVoucher } from '../../shared/ledger.js';

const provider = {} as WafeqClientLike;
type Fail = { error: { code: string } };

async function harness(db: AsyncDb) {
  const actor = { current: { id: 'finance-owner', role: 'hr' } as Actor };
  const app = express();
  app.use(express.json());
  registerFinance(app, {
    db,
    requireActor: async () => actor.current,
    privateMode: true,
    allowedActorId: 'finance-owner',
    createClient: () => provider,
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  const base = `http://127.0.0.1:${address.port}`;
  const parse = async <T>(response: Response) => ({
    status: response.status,
    body: (await response.json()) as T,
  });
  return {
    actor,
    db,
    get: async <T>(path: string) => parse<T>(await fetch(`${base}${path}`)),
    getWithAuthorization: async <T>(path: string, authorization: string) =>
      parse<T>(await fetch(`${base}${path}`, { headers: { authorization } })),
    send: async <T>(path: string, body: unknown, key = randomUUID()) =>
      parse<T>(
        await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify(body),
        }),
      ),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.close();
    },
  };
}

async function insertRenewal(db: AsyncDb, id: string) {
  const employeeId = `employee-${id}`;
  await db.execute(
    `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,join_date,role,color,status)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      employeeId,
      `N-${id}`,
      'موظف اصطناعي',
      'م',
      'اختبار',
      'اختبار',
      `${id}@example.test`,
      'الرياض',
      '2026-01-01',
      'employee',
      '#fff',
      'active',
    ],
  );
  await db.execute(
    `INSERT INTO employee_documents(id,employee_id,category,filename,mime_type,size_bytes,expires_at,uploaded_at,uploaded_by,checksum,encrypted_content,version,state,renewal_fee_halalas)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      `document-${id}`,
      employeeId,
      'identity',
      'identity.pdf',
      'application/pdf',
      1,
      '2026-11-01',
      new Date().toISOString(),
      employeeId,
      `checksum-${id}`,
      'synthetic',
      1,
      'active',
      10000,
    ],
  );
  await db.execute(
    `INSERT INTO document_renewals(id,document_id,employee_id,category,original_expiry,assigned_to,status,payment,version,fee_halalas,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      `document-${id}`,
      employeeId,
      'identity',
      '2026-11-01',
      employeeId,
      'renewed',
      'owner',
      2,
      10000,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
}

test('renewal settlement links one owner voucher and derives refunds/reversals', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const h = await harness(db);
  try {
    assert.equal((await h.send('/api/finance/ledger/setup', {})).status, 201);
    const before = (await h.get<LedgerOverview>('/api/finance/ledger')).body.accounts.find(
      (item) => item.code === '5206',
    )?.balanceHalalas;
    const expense = await h.send<{ voucher: LedgerVoucher }>('/api/finance/ledger/expenses', {
      date: '2026-11-01',
      description: 'رسوم تجديد اصطناعية',
      accountCode: '5206',
      taxCode: 'O',
      net: '100.00',
      cashAccountCode: '',
      paidBy: 'owner',
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.body));
    const renewalId = 'renewal-owner-1';
    await insertRenewal(db, renewalId);
    const details = await h.get<RenewalSettlementDetails>(
      `/api/finance/ledger/renewal-settlements/${renewalId}`,
    );
    assert.equal(details.status, 200, JSON.stringify(details.body));
    assert.equal(details.body.eligible, true);
    assert.equal(details.body.options[0]?.id, expense.body.voucher.id);
    const key = randomUUID();
    const linked = await h.send<RenewalSettlementDetails>(
      `/api/finance/ledger/renewal-settlements/${renewalId}`,
      { voucherId: expense.body.voucher.id, version: 0 },
      key,
    );
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.settlement?.voucherId, expense.body.voucher.id);
    const replay = await h.send<RenewalSettlementDetails>(
      `/api/finance/ledger/renewal-settlements/${renewalId}`,
      { voucherId: expense.body.voucher.id, version: 0 },
      key,
    );
    assert.equal(replay.body.settlement?.id, linked.body.settlement?.id);
    const after = (await h.get<LedgerOverview>('/api/finance/ledger')).body.accounts.find(
      (item) => item.code === '5206',
    )?.balanceHalalas;
    assert.equal(after, before! + 10000, 'linking does not post a second expense');

    let summary = await h.get<{ renewals: RenewalSettlementSummary[] }>(
      '/api/finance/ledger/renewal-settlements/summary',
    );
    assert.deepEqual(summary.body.renewals[0], {
      renewalId,
      renewalStatus: 'renewed',
      payment: 'owner',
      state: 'outstanding',
      voucherId: expense.body.voucher.id,
      voucherNumber: expense.body.voucher.number,
      amountHalalas: 10000,
      refundedHalalas: 0,
      remainingHalalas: 10000,
    });

    const refund = await h.send('/api/finance/ledger/owner/refunds', {
      date: '2026-11-05',
      amount: '40.00',
      cashAccountCode: '1102',
      claimIds: [expense.body.voucher.id],
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    summary = await h.get<{ renewals: RenewalSettlementSummary[] }>(
      '/api/finance/ledger/renewal-settlements/summary',
    );
    assert.equal(summary.body.renewals[0]?.state, 'partial');
    assert.equal(summary.body.renewals[0]?.refundedHalalas, 4000);
    assert.equal(summary.body.renewals[0]?.remainingHalalas, 6000);

    const stale = await h.send<Fail>(
      `/api/finance/ledger/renewal-settlements/${renewalId}/correct`,
      { voucherId: null, version: 99, reason: 'قديم' },
    );
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    const removed = await h.send<RenewalSettlementDetails>(
      `/api/finance/ledger/renewal-settlements/${renewalId}/correct`,
      { voucherId: null, version: 1, reason: 'تصحيح الاختبار' },
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.settlement, null);
    assert.equal(removed.body.version, 2);
    const relink = await h.send<RenewalSettlementDetails>(
      `/api/finance/ledger/renewal-settlements/${renewalId}`,
      { voucherId: expense.body.voucher.id, version: 2 },
    );
    assert.equal(relink.status, 201, JSON.stringify(relink.body));
    assert.equal(relink.body.version, 3);
  } finally {
    await h.close();
  }
});

test('renewal settlement enforces finance owner access and marks a reversed voucher', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const h = await harness(db);
  try {
    assert.equal((await h.send('/api/finance/ledger/setup', {})).status, 201);
    const expense = await h.send<{ voucher: LedgerVoucher }>('/api/finance/ledger/expenses', {
      date: '2026-11-02',
      description: 'رسوم تجديد ثانية',
      accountCode: '5206',
      taxCode: 'O',
      net: '10.00',
      cashAccountCode: '',
      paidBy: 'owner',
    });
    const renewalId = 'renewal-owner-2';
    await insertRenewal(db, renewalId);
    h.actor.current = { id: 'not-the-finance-owner', role: 'hr' };
    const denied = await h.get<Fail>(`/api/finance/ledger/renewal-settlements/${renewalId}`);
    assert.equal(denied.status, 403);
    h.actor.current = { id: 'finance-owner', role: 'hr' };
    const bearerDenied = await h.getWithAuthorization<Fail>(
      `/api/finance/ledger/renewal-settlements/${renewalId}`,
      'Bearer sabqfin_synthetic',
    );
    assert.equal(bearerDenied.status, 403);
    const linked = await h.send<RenewalSettlementDetails>(
      `/api/finance/ledger/renewal-settlements/${renewalId}`,
      { voucherId: expense.body.voucher.id, version: 0 },
    );
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    const reversed = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/vouchers/${expense.body.voucher.id}/reverse`,
      { version: expense.body.voucher.version, date: '2026-11-03', reason: 'تصحيح السند' },
    );
    assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
    const summary = await h.get<{ renewals: RenewalSettlementSummary[] }>(
      '/api/finance/ledger/renewal-settlements/summary',
    );
    assert.equal(summary.body.renewals[0]?.state, 'reversed');
    assert.equal(summary.body.renewals[0]?.remainingHalalas, 0);
  } finally {
    await h.close();
  }
});

test(
  'renewal settlement uses PostgreSQL revisions for direct and indirect owner claims',
  { skip: !process.env.HR_TEST_DATABASE_URL },
  async () => {
    const db = await createPostgresDatabase(
      process.env.HR_TEST_DATABASE_URL!,
      `hr_preview_${randomUUID().replaceAll('-', '')}`,
      { seed: false },
    );
    const h = await harness(db);
    try {
      assert.equal((await h.send('/api/finance/ledger/setup', {})).status, 201);
      const direct = await h.send<{ voucher: LedgerVoucher }>('/api/finance/ledger/expenses', {
        date: '2026-11-01',
        description: 'مصروف مباشر اصطناعي',
        accountCode: '5206',
        taxCode: 'O',
        net: '100.00',
        cashAccountCode: '',
        paidBy: 'owner',
      });
      const payable = await h.send<{ voucher: LedgerVoucher }>('/api/finance/ledger/expenses', {
        date: '2026-11-02',
        description: 'مصروف مستحق اصطناعي',
        accountCode: '5206',
        taxCode: 'O',
        net: '50.00',
        cashAccountCode: '',
      });
      const indirect = await h.send<{ voucher: LedgerVoucher }>(
        `/api/finance/ledger/expenses/${payable.body.voucher.id}/payments`,
        { date: '2026-11-03', amount: '50.00', paidBy: 'owner', cashAccountCode: '' },
      );
      const firstRenewal = 'renewal-pg-concurrent';
      await insertRenewal(db, firstRenewal);
      const first = h.send<RenewalSettlementDetails>(
        `/api/finance/ledger/renewal-settlements/${firstRenewal}`,
        { voucherId: direct.body.voucher.id, version: 0 },
        randomUUID(),
      );
      const second = h.send<RenewalSettlementDetails>(
        `/api/finance/ledger/renewal-settlements/${firstRenewal}`,
        { voucherId: indirect.body.voucher.id, version: 0 },
        randomUUID(),
      );
      const concurrent = await Promise.all([first, second]);
      assert.deepEqual(
        concurrent.map((item) => item.status).sort((a, b) => a - b),
        [201, 409],
      );
      const linked = await h.get<RenewalSettlementDetails>(
        `/api/finance/ledger/renewal-settlements/${firstRenewal}`,
      );
      assert.equal(linked.body.version, 1);
      assert.ok(
        [direct.body.voucher.id, indirect.body.voucher.id].includes(
          linked.body.settlement!.voucherId,
        ),
      );
      assert.equal(
        linked.body.options.some((item) => item.id === direct.body.voucher.id),
        true,
      );
      assert.equal(
        linked.body.options.some((item) => item.id === indirect.body.voucher.id),
        true,
      );
      const stale = await h.send<Fail>(
        `/api/finance/ledger/renewal-settlements/${firstRenewal}/correct`,
        { voucherId: null, version: 1, reason: 'فك الربط' },
      );
      assert.equal(stale.status, 200, JSON.stringify(stale.body));
      const relinkVoucher =
        linked.body.settlement!.voucherId === direct.body.voucher.id
          ? indirect.body.voucher.id
          : direct.body.voucher.id;
      const relinked = await h.send<RenewalSettlementDetails>(
        `/api/finance/ledger/renewal-settlements/${firstRenewal}`,
        { voucherId: relinkVoucher, version: 2 },
      );
      assert.equal(relinked.status, 201, JSON.stringify(relinked.body));
      assert.equal(relinked.body.version, 3);
      const staleAgain = await h.send<Fail>(
        `/api/finance/ledger/renewal-settlements/${firstRenewal}/correct`,
        { voucherId: null, version: 1, reason: 'تبويب قديم' },
      );
      assert.equal(staleAgain.body.error.code, 'VERSION_CONFLICT');
    } finally {
      await h.close();
    }
  },
);
