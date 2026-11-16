// Owner-paid expenses (decision 022): the owner pays company bills from his own card, the
// company refunds him later. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Actor } from '../../server/administration/service.js';
import { registerFinance, type WafeqClientLike } from '../../server/finance/routes.js';
import { ownerStatementHtml, statementHtml } from '../../server/finance/document-html.js';
import { chromiumExecutable, closeChromium, htmlToPdf } from '../../server/finance/chromium-pdf.js';
import { companySeller } from '../../shared/finance.js';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';
import type {
  CustomerStatement,
  LedgerOverview,
  LedgerVoucher,
  OwnerStatement,
  VoucherAttachment,
} from '../../shared/ledger.js';

const provider = {} as WafeqClientLike;
type Fail = { error: { code: string } };

async function harness(db: AsyncDb) {
  const actor = { current: { id: 'finance-owner', role: 'hr' } as Actor };
  const app = express();
  app.use(express.json({ limit: '7mb' }));
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
    db,
    actor,
    base,
    get: async <T>(path: string) => parse<T>(await fetch(`${base}${path}`)),
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
type Harness = Awaited<ReturnType<typeof harness>>;
const balance = async (h: Harness, code: string) =>
  (await h.get<LedgerOverview>('/api/finance/ledger')).body.accounts.find((a) => a.code === code)
    ?.balanceHalalas ?? 0;
const pdfBytes = Buffer.from('%PDF-1.4\n% synthetic supplier invoice\n%%EOF\n');

async function scenario(db: AsyncDb, legacyLedger = false) {
  const h = await harness(db);
  try {
    assert.equal((await h.send('/api/finance/ledger/setup', {})).status, 201);
    if (legacyLedger) {
      // A ledger set up before decision 022 has no owner account; first use adds it.
      await db.execute("DELETE FROM finance_accounts WHERE owner_id=? AND code='2160'", [
        'finance-owner',
      ]);
    } else {
      const chart = (await h.get<LedgerOverview>('/api/finance/ledger')).body.accounts;
      assert.equal(chart.find((a) => a.code === '2160')?.systemKey, 'owner_payable');
    }

    // 1. Hosting bill paid by the owner from his card: owed to him, the bank does not move.
    const hosting = await h.send<{ voucher: LedgerVoucher }>('/api/finance/ledger/expenses', {
      date: '2026-11-02',
      description: 'استضافة سحابية اصطناعية',
      accountCode: '5304',
      taxCode: 'S',
      net: '1000.00',
      cashAccountCode: '',
      paidBy: 'owner',
      reference: 'INV-TEST-1',
    });
    assert.equal(hosting.status, 201, JSON.stringify(hosting.body));
    assert.equal(hosting.body.voucher.paidByOwner, true);
    assert.equal(hosting.body.voucher.ownerOutstandingHalalas, 115000);
    assert.equal(hosting.body.voucher.outstandingHalalas, 0, 'nothing owed to a vendor');
    assert.equal(await balance(h, '2160'), 115000);
    assert.equal(await balance(h, '1102'), 0);
    assert.equal(await balance(h, '1120'), 15000, 'input VAT still deductible');

    // Owner-paid together with a bank account is contradictory.
    const both = await h.send<Fail>('/api/finance/ledger/expenses', {
      date: '2026-11-02',
      description: 'متعارض',
      accountCode: '5309',
      taxCode: 'O',
      net: '10.00',
      cashAccountCode: '1102',
      paidBy: 'owner',
    });
    assert.equal(both.body.error.code, 'INVALID_PAID_BY');

    // 2. A bill recorded on credit, then paid by the owner: the debt moves from vendor to him.
    const bill = await h.send<{ voucher: LedgerVoucher }>('/api/finance/ledger/expenses', {
      date: '2026-11-03',
      description: 'رسوم حكومية اصطناعية',
      accountCode: '5206',
      taxCode: 'O',
      net: '500.00',
      cashAccountCode: '',
    });
    assert.equal(await balance(h, '2101'), 50000);
    const paid = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/expenses/${bill.body.voucher.id}/payments`,
      { date: '2026-11-04', amount: '500.00', paidBy: 'owner', cashAccountCode: '' },
    );
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal(paid.body.voucher.paidByOwner, true);
    assert.equal(await balance(h, '2101'), 0);
    assert.equal(await balance(h, '2160'), 165000);

    let statement = (await h.get<OwnerStatement>('/api/finance/ledger/owner?asOf=2026-11-30')).body;
    assert.equal(statement.outstandingHalalas, 165000);
    assert.equal(statement.ledgerBalanceHalalas, 165000);
    assert.deepEqual(
      statement.claims.map((c) => [c.number, c.outstandingHalalas]),
      [
        [hosting.body.voucher.number, 115000],
        [paid.body.voucher.number, 50000],
      ],
    );
    assert.equal(
      statement.claims[1]!.accountName,
      'الرسوم الحكومية (إقامات ورخص عمل)',
      'a vendor payment shows the expense account of its bill',
    );
    // Before the first payment nothing was owed.
    assert.equal(
      (await h.get<OwnerStatement>('/api/finance/ledger/owner?asOf=2026-11-01')).body
        .outstandingHalalas,
      0,
    );

    // 3. Partial refund from the company bank, oldest first. Replays with the same key.
    const key = randomUUID();
    const refundBody = {
      date: '2026-11-10',
      amount: '1200.00',
      cashAccountCode: '1102',
      reference: 'TRF-TEST-1',
    };
    const refund = await h.send<{ voucher: LedgerVoucher }>(
      '/api/finance/ledger/owner/refunds',
      refundBody,
      key,
    );
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    assert.equal(refund.body.voucher.isOwnerRefund, true);
    assert.equal(refund.body.voucher.kind, 'payment');
    const replay = await h.send<{ voucher: LedgerVoucher }>(
      '/api/finance/ledger/owner/refunds',
      refundBody,
      key,
    );
    assert.equal(replay.body.voucher.id, refund.body.voucher.id);
    assert.equal(await balance(h, '1102'), -120000, 'the refund leaves the company bank');
    assert.equal(await balance(h, '2160'), 45000);
    statement = (await h.get<OwnerStatement>('/api/finance/ledger/owner?asOf=2026-11-30')).body;
    assert.equal(statement.outstandingHalalas, 45000);
    assert.deepEqual(
      statement.claims.map((c) => [c.number, c.refundedHalalas, c.outstandingHalalas]),
      [[paid.body.voucher.number, 5000, 45000]],
      'the fully refunded item drops out of the open list',
    );
    assert.deepEqual(
      statement.refunds[0]!.allocations.map((a) => a.amountHalalas),
      [115000, 5000],
    );

    // More than is owed, a claim not open, or a date before the expense are refused.
    const tooMuch = await h.send<Fail>('/api/finance/ledger/owner/refunds', {
      ...refundBody,
      amount: '450.01',
    });
    assert.equal(tooMuch.body.error.code, 'REFUND_EXCEEDS_BALANCE');
    const closed = await h.send<Fail>('/api/finance/ledger/owner/refunds', {
      ...refundBody,
      amount: '1.00',
      claimIds: [hosting.body.voucher.id],
    });
    assert.equal(closed.body.error.code, 'CLAIM_NOT_OPEN');
    const early = await h.send<Fail>('/api/finance/ledger/owner/refunds', {
      ...refundBody,
      date: '2026-11-01',
      amount: '1.00',
    });
    assert.equal(early.body.error.code, 'INVALID_DATE_RANGE');

    // 4. A refunded expense cannot be reversed before its refund; reversing the refund restores
    //    the debt with a mirror entry, nothing is deleted.
    const blocked = await h.send<Fail>(
      `/api/finance/ledger/vouchers/${hosting.body.voucher.id}/reverse`,
      { version: hosting.body.voucher.version, date: '2026-11-12', reason: 'اختبار' },
    );
    assert.equal(blocked.status, 409);
    const undone = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/vouchers/${refund.body.voucher.id}/reverse`,
      { version: refund.body.voucher.version, date: '2026-11-12', reason: 'تحويل خاطئ' },
    );
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(await balance(h, '2160'), 165000);
    assert.equal(await balance(h, '1102'), 0);
    statement = (await h.get<OwnerStatement>('/api/finance/ledger/owner?asOf=2026-11-30')).body;
    assert.equal(statement.outstandingHalalas, 165000);
    assert.equal(statement.refunds[0]!.status, 'reversed');

    // Chosen items, in the order given.
    const chosen = await h.send<{ voucher: LedgerVoucher }>('/api/finance/ledger/owner/refunds', {
      ...refundBody,
      amount: '500.00',
      claimIds: [paid.body.voucher.id],
    });
    assert.equal(chosen.status, 201);
    statement = (await h.get<OwnerStatement>('/api/finance/ledger/owner?asOf=2026-11-30')).body;
    assert.deepEqual(
      statement.claims.map((c) => c.number),
      [hosting.body.voucher.number],
    );

    // 5. The supplier invoice file: private, encrypted, verified, never deleted.
    const wrongType = await h.send<Fail>(
      `/api/finance/ledger/vouchers/${hosting.body.voucher.id}/attachments`,
      {
        fileName: 'invoice.png',
        mimeType: 'image/png',
        contentBase64: pdfBytes.toString('base64'),
      },
    );
    assert.equal(wrongType.body.error.code, 'FILE_TYPE_MISMATCH');
    const added = await h.send<{ attachment: VoucherAttachment }>(
      `/api/finance/ledger/vouchers/${hosting.body.voucher.id}/attachments`,
      {
        fileName: 'فاتورة الاستضافة.pdf',
        mimeType: 'application/pdf',
        contentBase64: pdfBytes.toString('base64'),
      },
    );
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.attachment.fileName, 'فاتورة الاستضافة.pdf');
    const stored = await db.read<{ content_ciphertext: string; file_name_ciphertext: string }>(
      'SELECT content_ciphertext, file_name_ciphertext FROM finance_voucher_attachments',
    );
    assert.ok(stored[0]!.content_ciphertext.startsWith('v1.'));
    assert.ok(!stored[0]!.file_name_ciphertext.includes('فاتورة'));
    const download = await fetch(
      `${h.base}/api/finance/ledger/attachments/${added.body.attachment.id}/download`,
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdfBytes);
    const listed = (
      await h.get<{ vouchers: LedgerVoucher[] }>('/api/finance/ledger/vouchers?kind=expense')
    ).body.vouchers.find((v) => v.id === hosting.body.voucher.id)!;
    assert.equal(listed.attachmentCount, 1);
    statement = (await h.get<OwnerStatement>('/api/finance/ledger/owner?asOf=2026-11-30')).body;
    assert.equal(statement.claims[0]!.attachmentCount, 1);

    // Another owner never reaches the file.
    h.actor.current = { id: 'someone-else', role: 'hr' } as Actor;
    const foreign = await fetch(
      `${h.base}/api/finance/ledger/attachments/${added.body.attachment.id}/download`,
    );
    assert.equal(foreign.status, 403);
    h.actor.current = { id: 'finance-owner', role: 'hr' } as Actor;

    const removed = await h.send(
      `/api/finance/ledger/attachments/${added.body.attachment.id}/remove`,
      {
        version: added.body.attachment.version,
        reason: 'ملف خاطئ',
      },
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(
      (
        await h.get<{ attachments: VoucherAttachment[] }>(
          `/api/finance/ledger/vouchers/${hosting.body.voucher.id}/attachments`,
        )
      ).body.attachments,
      [],
    );
    await assert.rejects(db.execute('DELETE FROM finance_voucher_attachments'));
    await assert.rejects(db.execute('DELETE FROM finance_owner_allocations'));

    // 6. The PDF paper lists what is still owed.
    const html = ownerStatementHtml(statement);
    assert.match(html, /كشف المبالغ المستحقة للمالك/);
    assert.match(html, /1,150\.00/);
    assert.match(html, new RegExp(hosting.body.voucher.number));
  } finally {
    await h.close();
  }
}

test('owner-paid expenses: claims, refunds, reversal and attachments on SQLite', async () => {
  process.env.HR_DATA_KEY ??= Buffer.alloc(32, 7).toString('base64url');
  await scenario(await createDatabase());
});

test('owner-paid expenses: a ledger without the owner account gets it on first use', async () => {
  process.env.HR_DATA_KEY ??= Buffer.alloc(32, 7).toString('base64url');
  await scenario(await createDatabase(), true);
});

test(
  'owner-paid expenses: the same scenario on PostgreSQL',
  { skip: !process.env.HR_TEST_DATABASE_URL },
  async () => {
    await scenario(
      await createPostgresDatabase(
        process.env.HR_TEST_DATABASE_URL!,
        `hr_preview_${randomUUID().replaceAll('-', '')}`,
        { seed: false },
      ),
    );
  },
);

test(
  'server PDFs of the owner and customer statements are not blank',
  { skip: !chromiumExecutable() },
  async () => {
    const owner: OwnerStatement = {
      seller: companySeller,
      asOf: '2026-11-16',
      accountCode: '2160',
      accountName: 'مستحق للمالك',
      claims: [],
      refunds: [],
      paidHalalas: 0,
      refundedHalalas: 0,
      outstandingHalalas: 0,
      ledgerBalanceHalalas: 0,
    };
    const customer = {
      customer: { name: 'عميل اصطناعي', vatNumber: '', address: { line: '', city: 'الرياض' } },
      seller: companySeller,
      from: null,
      to: '2026-11-16',
      openingHalalas: 0,
      invoicedHalalas: 0,
      paidHalalas: 0,
      creditedHalalas: 0,
      closingHalalas: 0,
      overdueHalalas: 0,
      rows: [],
      openInvoices: [],
      unpostedInvoices: 0,
    } as unknown as CustomerStatement;
    try {
      // A page with no visible text embeds no font; both papers must draw their headings.
      for (const html of [ownerStatementHtml(owner), statementHtml(customer)]) {
        const pdf = await htmlToPdf(html);
        assert.ok(pdf);
        assert.match(pdf.toString('latin1'), /\/FontFile|\/Font\b/);
      }
    } finally {
      await closeChromium();
    }
  },
);
