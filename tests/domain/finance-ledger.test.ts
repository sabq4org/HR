import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Actor } from '../../server/administration/service.js';
import { registerFinance, type WafeqClientLike } from '../../server/finance/routes.js';
import { vatPeriod } from '../../server/finance/ledger.js';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';
import type {
  AccountStatement,
  AgingRow,
  BalanceSheet,
  BudgetReport,
  CustomerStatement,
  IncomeStatement,
  JournalEntry,
  LedgerOverview,
  LedgerVoucher,
  TrialBalanceRow,
  VatComputation,
  VatReturn,
} from '../../shared/ledger.js';

const provider: WafeqClientLike = {
  getOrganization: async () => ({ id: 'org-test', name: 'Test organization' }),
  createCustomer: async () => ({ id: 'w-customer-1' }),
  getCustomer: async (id) => ({ id }),
  findCustomerByExternalId: async () => null,
  createInvoice: async () => ({ id: 'w-invoice-1', status: 'unknown', qrCode: null }),
  findInvoiceByExternalId: async () => null,
  getInvoice: async () => ({ id: 'w-invoice-1', status: 'cleared', number: 'W-1', qrCode: null }),
  reportInvoice: async () => ({
    id: 'w-invoice-1',
    status: 'cleared',
    number: 'W-1',
    qrCode: null,
  }),
  getInvoicePdf: async () => Buffer.from('%PDF test'),
};

type Harness = {
  db: AsyncDb;
  actor: { current: Actor };
  get: <T>(path: string) => Promise<{ status: number; body: T }>;
  send: <T>(
    path: string,
    body: unknown,
    method?: 'POST' | 'PATCH',
    key?: string,
  ) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
};
async function harness(db: AsyncDb): Promise<Harness> {
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
    db,
    actor,
    get: async (path) => parse(await fetch(`${base}${path}`)),
    send: async (path, body, method = 'POST', key = randomUUID()) =>
      parse(
        await fetch(`${base}${path}`, {
          method,
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
type Fail = { error: { code: string } };
const balanceOf = (overview: LedgerOverview, code: string) =>
  overview.accounts.find((item) => item.code === code)!.balanceHalalas;
const boxOf = (computation: VatComputation, id: number) =>
  computation.boxes.find((item) => item.box === id)!;

/** Creates a 10,000 + 15% invoice dated in Q3 2026 and returns its id. */
async function invoice(h: Harness, lines?: unknown[], documentType = 'standard') {
  const customer = await h.send<{ customer: { id: string } }>('/api/finance/customers', {
    name: 'عميل اصطناعي',
    email: 'billing@example.test',
    vatNumber: '',
    address: { line: 'طريق الاختبار', city: 'الرياض', postalCode: '12345', country: 'SA' },
  });
  const quote = await h.send<{ quote: { id: string; version: number } }>('/api/finance/quotes', {
    customerId: customer.body.customer.id,
    documentType,
    title: 'حملة إعلانية اصطناعية',
    issueDate: '2026-07-01',
    validUntil: '2026-07-31',
    notes: '',
    lines: lines ?? [
      {
        description: 'إعلان رقمي',
        quantity: '1',
        unitPrice: '10000.00',
        taxRateBps: 1500,
        taxReason: '',
      },
    ],
  });
  assert.equal(quote.status, 201);
  const converted = await h.send<{ invoice: { id: string } }>(
    `/api/finance/quotes/${quote.body.quote.id}/convert`,
    { version: quote.body.quote.version, issueDate: '2026-07-10', dueDate: '2026-08-09' },
  );
  assert.equal(converted.status, 201);
  return converted.body.invoice.id;
}

async function scenario(db: AsyncDb) {
  const h = await harness(db);
  try {
    // Access is the single granted account, and nothing works before explicit setup.
    h.actor.current = { id: 'other-hr', role: 'hr' };
    assert.equal((await h.get('/api/finance/ledger')).status, 403);
    h.actor.current = { id: 'finance-owner', role: 'employee' };
    const empty = await h.get<LedgerOverview>('/api/finance/ledger');
    assert.equal(empty.body.initialized, false);
    assert.equal(empty.body.accounts.length, 0);
    assert.equal(
      (await h.get<Fail>('/api/finance/ledger/entries')).body.error.code,
      'LEDGER_NOT_INITIALIZED',
    );
    const setup = await h.send<LedgerOverview>('/api/finance/ledger/setup', {});
    assert.equal(setup.status, 201);
    assert.equal(setup.body.initialized, true);
    assert.ok(setup.body.accounts.some((item) => item.systemKey === 'vat_settlement'));
    assert.equal(
      (await h.send<Fail>('/api/finance/ledger/setup', {})).body.error.code,
      'LEDGER_ALREADY_INITIALIZED',
    );

    // Manual journal: balance, postable accounts and VAT tags are enforced on the server.
    const line = (accountCode: string, debit: string, credit: string, tax?: unknown) => ({
      accountCode,
      debit,
      credit,
      tax,
    });
    const journal = (lines: unknown[], date = '2026-07-01') =>
      h.send<{ entry: JournalEntry } & Fail>('/api/finance/ledger/entries', {
        date,
        description: 'قيد اختبار',
        lines,
      });
    assert.equal(
      (await journal([line('1102', '100.00', '0'), line('3101', '0', '90.00')])).body.error.code,
      'ENTRY_UNBALANCED',
    );
    assert.equal(
      (await journal([line('11', '100.00', '0'), line('3101', '0', '100.00')])).body.error.code,
      'ACCOUNT_NOT_POSTABLE',
    );
    assert.equal(
      (await journal([line('2110', '0', '15.00'), line('1102', '15.00', '0')])).body.error.code,
      'VAT_LINE_TAX_REQUIRED',
    );
    assert.equal(
      (await journal([line('2111', '0', '15.00'), line('1102', '15.00', '0')])).body.error.code,
      'SYSTEM_ACCOUNT',
    );
    const capital = await journal([line('1102', '50000.00', '0'), line('3101', '0', '50000.00')]);
    assert.equal(capital.status, 201);
    assert.match(capital.body.entry.number, /^JE-2026-000001$/);

    // The database itself refuses to rewrite history.
    await assert.rejects(
      db.execute('UPDATE finance_journal_lines SET debit=1 WHERE owner_id=?', ['finance-owner']),
    );
    await assert.rejects(
      db.execute('DELETE FROM finance_journal_entries WHERE owner_id=?', ['finance-owner']),
    );

    const mistake = await journal([line('5309', '70.00', '0'), line('1102', '0', '70.00')]);
    const reversed = await h.send<{ entry: JournalEntry }>(
      `/api/finance/ledger/entries/${mistake.body.entry.id}/reverse`,
      { date: '2026-07-02', reason: 'قيد خاطئ' },
    );
    assert.equal(reversed.status, 201);
    assert.equal(reversed.body.entry.reversalOf, mistake.body.entry.id);
    assert.equal(
      (
        await h.send<Fail>(`/api/finance/ledger/entries/${mistake.body.entry.id}/reverse`, {
          date: '2026-07-03',
          reason: 'تكرار',
        })
      ).body.error.code,
      'ENTRY_ALREADY_REVERSED',
    );

    // Invoice 10,000 + 1,500: receivable against revenue and output VAT on the issue date.
    const invoiceId = await invoice(h);
    assert.equal(
      (
        await h.send<Fail>(`/api/finance/ledger/invoices/${invoiceId}/receipts`, {
          date: '2026-07-20',
          amount: '100.00',
          cashAccountCode: '1102',
        })
      ).body.error.code,
      'INVOICE_NOT_POSTED',
    );
    const posted = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/invoices/${invoiceId}/post`,
      { revenueAccountCode: '4101' },
    );
    assert.equal(posted.status, 201);
    assert.equal(posted.body.voucher.totalHalalas, 1_150_000);
    assert.equal(posted.body.voucher.date, '2026-07-10');
    const again = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/invoices/${invoiceId}/post`,
      { revenueAccountCode: '4102' },
    );
    assert.equal(again.body.voucher.id, posted.body.voucher.id, 'an invoice posts once');

    const receipt = (amount: string) =>
      h.send<{ voucher: LedgerVoucher } & Fail>(
        `/api/finance/ledger/invoices/${invoiceId}/receipts`,
        { date: '2026-07-20', amount, cashAccountCode: '1102', reference: 'حوالة 1' },
      );
    assert.equal((await receipt('5000.00')).status, 201);
    assert.equal((await receipt('6500.01')).body.error.code, 'RECEIPT_EXCEEDS_BALANCE');
    const credit = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/invoices/${invoiceId}/credit-notes`,
      { date: '2026-08-01', net: '2000.00', reason: 'خصم متفق عليه' },
    );
    assert.equal(credit.body.voucher.vatHalalas, 30_000);
    assert.equal(
      (
        await h.send<Fail>(`/api/finance/ledger/invoices/${invoiceId}/credit-notes`, {
          date: '2026-08-01',
          net: '8000.01',
          reason: 'أكبر من المتبقي',
        })
      ).body.error.code,
      'CREDIT_EXCEEDS_INVOICE',
    );
    const invoiceVoucher = (
      await h.get<{ vouchers: LedgerVoucher[] }>('/api/finance/ledger/vouchers?kind=invoice')
    ).body.vouchers[0];
    assert.equal(invoiceVoucher.outstandingHalalas, 1_150_000 - 500_000 - 230_000);
    assert.equal(
      (
        await h.send<Fail>(`/api/finance/ledger/vouchers/${invoiceVoucher.id}/reverse`, {
          version: invoiceVoucher.version,
          date: '2026-08-02',
          reason: 'محاولة',
        })
      ).body.error.code,
      'VOUCHER_HAS_SETTLEMENTS',
    );

    // Expenses under each VAT treatment.
    const expense = (body: Record<string, unknown>) =>
      h.send<{ voucher: LedgerVoucher } & Fail>('/api/finance/ledger/expenses', {
        date: '2026-08-05',
        description: 'مصروف اختبار',
        cashAccountCode: '1102',
        ...body,
      });
    assert.equal(
      (await expense({ accountCode: '5104', taxCode: 'S', net: '1000.00' })).body.error.code,
      'TAX_INVOICE_REFERENCE_REQUIRED',
    );
    const standard = await expense({
      accountCode: '5302',
      taxCode: 'S',
      net: '1000.00',
      reference: 'INV-77',
    });
    assert.equal(standard.body.voucher.totalHalalas, 115_000);
    assert.equal(
      (
        await expense({
          accountCode: '5302',
          taxCode: 'S',
          net: '1000.00',
          vat: '50.00',
          reference: 'INV-78',
        })
      ).body.error.code,
      'VAT_AMOUNT_MISMATCH',
    );
    // Reverse charge: 15% is due and deductible at once; the supplier is paid the net only.
    const reverseCharge = await expense({ accountCode: '5105', taxCode: 'RC', net: '1000.00' });
    assert.equal(reverseCharge.body.voucher.totalHalalas, 100_000);
    assert.equal(reverseCharge.body.voucher.vatHalalas, 15_000);
    // Hospitality: VAT is paid but not deductible, so it becomes part of the cost.
    const hospitality = await expense({ accountCode: '5306', taxCode: 'ND', net: '200.00' });
    assert.equal(hospitality.body.voucher.totalHalalas, 23_000);
    assert.equal((await expense({ accountCode: '5206', taxCode: 'O', net: '500.00' })).status, 201);
    assert.equal(
      (await expense({ accountCode: '1102', taxCode: 'O', net: '5.00' })).body.error.code,
      'INVALID_EXPENSE_ACCOUNT',
    );
    const vendor = await h.send<{ vendor: { id: string } }>('/api/finance/ledger/vendors', {
      name: 'مورد اصطناعي',
      vatNumber: '300000000000003',
      country: '',
      resident: true,
    });
    const onCredit = await expense({
      accountCode: '5304',
      taxCode: 'S',
      net: '2000.00',
      reference: 'INV-90',
      cashAccountCode: '',
      vendorId: vendor.body.vendor.id,
      dueDate: '2026-09-04',
    });
    assert.equal(onCredit.body.voucher.outstandingHalalas, 230_000);
    const pay = (amount: string) =>
      h.send<Fail>(`/api/finance/ledger/expenses/${onCredit.body.voucher.id}/payments`, {
        date: '2026-08-20',
        amount,
        cashAccountCode: '1102',
      });
    assert.equal((await pay('2300.01')).body.error.code, 'PAYMENT_EXCEEDS_BALANCE');
    assert.equal((await pay('1300.00')).status, 201);
    const direct = await h.send<{ voucher: LedgerVoucher } & Fail>('/api/finance/ledger/revenues', {
      date: '2026-09-01',
      description: 'إيراد منصة إعلانية أجنبية',
      accountCode: '4101',
      taxCode: 'ZE',
      net: '3000.00',
      cashAccountCode: '1102',
    });
    assert.equal(direct.body.voucher.vatHalalas, 0);
    assert.equal(
      (
        await h.send<Fail>('/api/finance/ledger/revenues', {
          date: '2026-09-01',
          description: 'بيع بلا فاتورة',
          accountCode: '4101',
          taxCode: 'S',
          net: '100.00',
          cashAccountCode: '1102',
        })
      ).body.error.code,
      'TAX_INVOICE_REFERENCE_REQUIRED',
    );

    // Balances after all postings.
    let overview = (await h.get<LedgerOverview>('/api/finance/ledger')).body;
    assert.equal(balanceOf(overview, '1110'), 420_000);
    assert.equal(balanceOf(overview, '2101'), 100_000);
    assert.equal(balanceOf(overview, '2110'), 150_000 - 30_000 + 15_000);
    assert.equal(balanceOf(overview, '1120'), 15_000 + 15_000 + 30_000);
    assert.equal(balanceOf(overview, '5306'), 23_000);
    assert.equal(overview.dashboard!.booksBalanced, true);

    // VAT return for Q3 2026 is derived from the tagged ledger lines.
    const vat = await h.get<{ computation: VatComputation }>(
      '/api/finance/ledger/vat?start=2026-07-01',
    );
    const computation = vat.body.computation;
    assert.equal(computation.dueDate, '2026-10-31');
    assert.deepEqual(
      [boxOf(computation, 1).amountHalalas, boxOf(computation, 1).adjustmentHalalas],
      [1_000_000, -200_000],
    );
    assert.equal(boxOf(computation, 1).vatHalalas, 120_000);
    assert.equal(boxOf(computation, 4).amountHalalas, 300_000);
    assert.deepEqual(
      [boxOf(computation, 7).amountHalalas, boxOf(computation, 7).vatHalalas],
      [300_000, 45_000],
    );
    assert.deepEqual(
      [boxOf(computation, 9).amountHalalas, boxOf(computation, 9).vatHalalas],
      [100_000, 15_000],
    );
    // Reverse charge nets to zero; non-deductible and out-of-scope purchases are not in the return.
    assert.equal(computation.currentPeriodHalalas, 120_000 - 45_000);
    assert.equal(boxOf(computation, 12).amountHalalas, 400_000);
    assert.equal(computation.unexplainedOutputHalalas, 0);
    assert.equal(computation.unexplainedInputHalalas, 0);

    assert.equal(
      (
        await h.send<Fail>('/api/finance/ledger/vat/close', {
          periodStart: '2026-07-01',
          correction: '20000.00',
          correctionNote: 'كبير',
        })
      ).body.error.code,
      'VAT_CORRECTION_LIMIT',
    );
    const closed = await h.send<{ return: VatReturn }>('/api/finance/ledger/vat/close', {
      periodStart: '2026-07-01',
      correction: '0',
    });
    assert.equal(closed.status, 201);
    assert.equal(closed.body.return.netDueHalalas, 75_000);
    overview = (await h.get<LedgerOverview>('/api/finance/ledger')).body;
    assert.equal(balanceOf(overview, '2110'), 0);
    assert.equal(balanceOf(overview, '1120'), 0);
    assert.equal(balanceOf(overview, '2111'), 75_000);
    assert.equal(overview.locks.length, 3);
    assert.equal(
      (await expense({ accountCode: '5206', taxCode: 'O', net: '1.00' })).body.error.code,
      'PERIOD_LOCKED',
    );
    assert.equal(
      (await h.send<Fail>('/api/finance/ledger/periods', { year: 2026, month: 8, locked: false }))
        .body.error.code,
      'PERIOD_IN_VAT_RETURN',
    );
    assert.equal(
      (
        await h.send<Fail>('/api/finance/ledger/vat/close', {
          periodStart: '2026-07-01',
          correction: '0',
        })
      ).body.error.code,
      'VAT_PERIOD_CLOSED',
    );
    const returnId = closed.body.return.id;
    assert.equal(
      (
        await h.send<Fail>(`/api/finance/ledger/vat/${returnId}/pay`, {
          version: 1,
          date: '2026-10-20',
          cashAccountCode: '1102',
        })
      ).body.error.code,
      'VAT_RETURN_NOT_FILED',
    );
    const filed = await h.send<{ return: VatReturn }>(`/api/finance/ledger/vat/${returnId}/file`, {
      version: 1,
      filedAt: '2026-10-20',
      reference: 'مرجع اصطناعي',
    });
    assert.equal(filed.body.return.status, 'filed');
    const paid = await h.send<{ return: VatReturn }>(`/api/finance/ledger/vat/${returnId}/pay`, {
      version: filed.body.return.version,
      date: '2026-10-20',
      cashAccountCode: '1102',
    });
    assert.equal(paid.body.return.status, 'paid');
    overview = (await h.get<LedgerOverview>('/api/finance/ledger')).body;
    assert.equal(balanceOf(overview, '2111'), 0);

    // A credit note issued after the period closed lands in the next return as an adjustment.
    const late = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/invoices/${invoiceId}/credit-notes`,
      { date: '2026-10-05', net: '1000.00', reason: 'خصم لاحق' },
    );
    assert.equal(late.status, 201);
    const next = (
      await h.get<{ computation: VatComputation }>('/api/finance/ledger/vat?start=2026-10-01')
    ).body.computation;
    assert.deepEqual(
      [boxOf(next, 1).amountHalalas, boxOf(next, 1).adjustmentHalalas, boxOf(next, 1).vatHalalas],
      [0, -100_000, -15_000],
    );

    // Aging is rebuilt as of the reporting date, not from today's balances.
    const agingAt = async (asOf: string) =>
      (
        await h.get<{ rows: AgingRow[] }>(
          `/api/finance/ledger/reports/aging?side=receivable&asOf=${asOf}`,
        )
      ).body.rows.reduce((sum, row) => sum + row.outstandingHalalas, 0);
    assert.equal(await agingAt('2026-07-09'), 0, 'not issued yet');
    assert.equal(await agingAt('2026-07-15'), 1_150_000, 'before the first receipt');
    assert.equal(await agingAt('2026-07-25'), 650_000, 'after the receipt, before the credit note');
    assert.equal(await agingAt('2026-10-31'), 1_150_000 - 500_000 - 230_000 - 115_000);

    // The statement's closing balance comes from the ledger and matches the account balance.
    const statement = (
      await h.get<AccountStatement>(
        '/api/finance/ledger/reports/account/1110?from=2026-01-01&to=2026-12-31',
      )
    ).body;
    assert.equal(statement.truncated, false);
    assert.equal(statement.closingHalalas, 305_000);
    assert.equal(statement.rows.at(-1)?.balanceHalalas, statement.closingHalalas);

    // Once a return is closed, VAT cannot be backdated before its end, even into an unlocked month.
    assert.equal(
      (
        await expense({
          date: '2026-06-15',
          accountCode: '5302',
          taxCode: 'S',
          net: '100.00',
          reference: 'LATE-1',
        })
      ).body.error.code,
      'VAT_PERIOD_CLOSED',
    );
    assert.equal(
      (await expense({ date: '2026-06-15', accountCode: '5206', taxCode: 'O', net: '10.00' }))
        .status,
      201,
      'a movement outside the return is still allowed in an open month',
    );

    // Statements: debits equal credits, and assets equal liabilities plus equity.
    const trial = await h.get<{ rows: TrialBalanceRow[] }>(
      '/api/finance/ledger/reports/trial-balance?from=2026-01-01&to=2026-12-31',
    );
    const total = (key: keyof TrialBalanceRow) =>
      trial.body.rows.reduce((sum, row) => sum + (row[key] as number), 0);
    assert.equal(total('closingDebit'), total('closingCredit'));
    assert.equal(total('periodDebit'), total('periodCredit'));
    const income = await h.get<IncomeStatement>(
      '/api/finance/ledger/reports/income-statement?from=2026-01-01&to=2026-12-31',
    );
    assert.equal(income.body.revenueHalalas, 1_000_000 - 300_000 + 300_000);
    assert.equal(income.body.expenseHalalas, 100_000 + 100_000 + 23_000 + 50_000 + 200_000 + 1_000);
    const sheet = await h.get<BalanceSheet>(
      '/api/finance/ledger/reports/balance-sheet?asOf=2026-12-31',
    );
    assert.equal(sheet.body.balanced, true);
    assert.equal(
      sheet.body.assetsHalalas,
      sheet.body.liabilitiesHalalas + sheet.body.equityHalalas,
    );

    // Budget against actuals.
    const months = Array.from({ length: 12 }, (_, i) => (i === 7 ? '1500.00' : '0'));
    const budget = await h.send<BudgetReport>(
      '/api/finance/ledger/budgets/2026',
      { version: 1, lines: [{ accountCode: '5302', months }] },
      'PATCH',
    );
    const utilities = budget.body.lines.find((item) => item.accountCode === '5302')!;
    assert.equal(utilities.budget[7], 150_000);
    assert.equal(utilities.actual[7], 100_000);
    assert.equal(
      (await h.send<Fail>('/api/finance/ledger/budgets/2026', { version: 1, lines: [] }, 'PATCH'))
        .body.error.code,
      'VERSION_CONFLICT',
    );

    // Replaying a mutation with the same key does not post twice.
    const key = randomUUID();
    const body = {
      date: '2026-10-10',
      description: 'مصروف مكرر',
      accountCode: '5206',
      taxCode: 'O',
      net: '10.00',
      cashAccountCode: '1102',
    };
    const first = await h.send<{ voucher: LedgerVoucher }>(
      '/api/finance/ledger/expenses',
      body,
      'POST',
      key,
    );
    const replay = await h.send<{ voucher: LedgerVoucher }>(
      '/api/finance/ledger/expenses',
      body,
      'POST',
      key,
    );
    assert.equal(first.body.voucher.id, replay.body.voucher.id);

    // Stored text is encrypted at rest.
    const raw = await db.read<{ description_ciphertext: string }>(
      'SELECT description_ciphertext FROM finance_journal_entries WHERE owner_id=?',
      ['finance-owner'],
    );
    assert.ok(raw.every((row) => row.description_ciphertext.startsWith('v1.')));
  } finally {
    await h.close();
  }
}

test('ledger: postings, VAT return, statements and locks on SQLite', async () => {
  process.env.HR_DATA_KEY ??= Buffer.alloc(32, 7).toString('base64url');
  await scenario(await createDatabase());
});

test(
  'ledger: the same scenario on PostgreSQL',
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

test('ledger: VAT returns close in chronological order and carry a credit forward', async () => {
  process.env.HR_DATA_KEY ??= Buffer.alloc(32, 7).toString('base64url');
  const h = await harness(await createDatabase());
  try {
    await h.send('/api/finance/ledger/setup', {});
    // Q1 2026: input VAT only (a SAR 150 credit). Q2 2026: SAR 60 output VAT.
    const purchase = await h.send('/api/finance/ledger/expenses', {
      date: '2026-02-10',
      description: 'شراء اصطناعي',
      accountCode: '5302',
      taxCode: 'S',
      net: '1000.00',
      cashAccountCode: '1102',
      reference: 'Q1-1',
    });
    assert.equal(purchase.status, 201);
    const sale = await h.send('/api/finance/ledger/revenues', {
      date: '2026-05-10',
      description: 'إيراد اصطناعي',
      accountCode: '4101',
      taxCode: 'S',
      net: '400.00',
      cashAccountCode: '1102',
      reference: 'Q2-1',
    });
    assert.equal(sale.status, 201);
    const close = (periodStart: string) =>
      h.send<{ return: VatReturn } & Fail>('/api/finance/ledger/vat/close', {
        periodStart,
        correction: '0',
      });
    assert.equal((await close('2026-04-01')).body.error.code, 'VAT_EARLIER_PERIOD_OPEN');
    const first = await close('2026-01-01');
    assert.equal(first.body.return.netDueHalalas, -15_000);
    const second = await close('2026-04-01');
    assert.equal(second.body.return.creditBroughtForwardHalalas, 15_000);
    assert.equal(second.body.return.netDueHalalas, 6_000 - 15_000);
  } finally {
    await h.close();
  }
});

test('ledger: mixed 0% lines need an explicit VAT treatment, and reversal frees the invoice', async () => {
  const h = await harness(await createDatabase());
  try {
    await h.send('/api/finance/ledger/setup', {});
    const invoiceId = await invoice(h, [
      {
        description: 'إعلان',
        quantity: '1',
        unitPrice: '1000.00',
        taxRateBps: 1500,
        taxReason: '',
      },
      {
        description: 'منحة',
        quantity: '1',
        unitPrice: '400.00',
        taxRateBps: 0,
        taxReason: 'خارج النطاق',
      },
    ]);
    assert.equal(
      (
        await h.send<Fail>(`/api/finance/ledger/invoices/${invoiceId}/post`, {
          revenueAccountCode: '4101',
        })
      ).body.error.code,
      'ZERO_LINES_TAX_CODE_REQUIRED',
    );
    const posted = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/invoices/${invoiceId}/post`,
      { revenueAccountCode: '4101', zeroLinesTaxCode: 'O' },
    );
    assert.equal(posted.body.voucher.totalHalalas, 155_000);
    const vat = (
      await h.get<{ computation: VatComputation }>('/api/finance/ledger/vat?start=2026-07-01')
    ).body.computation;
    assert.equal(boxOf(vat, 1).amountHalalas, 100_000);
    assert.equal(boxOf(vat, 6).amountHalalas, 100_000, 'out-of-scope revenue is not reported');
    const reversed = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/vouchers/${posted.body.voucher.id}/reverse`,
      { version: posted.body.voucher.version, date: '2026-07-10', reason: 'حساب إيراد خاطئ' },
    );
    assert.equal(reversed.body.voucher.status, 'reversed');
    const reposted = await h.send<{ voucher: LedgerVoucher }>(
      `/api/finance/ledger/invoices/${invoiceId}/post`,
      { revenueAccountCode: '4103', zeroLinesTaxCode: 'O' },
    );
    assert.notEqual(reposted.body.voucher.id, posted.body.voucher.id);
    const overview = (await h.get<LedgerOverview>('/api/finance/ledger')).body;
    assert.equal(balanceOf(overview, '1110'), 155_000);
    assert.equal(balanceOf(overview, '4101'), 0);
    assert.equal(balanceOf(overview, '4103'), 140_000);
  } finally {
    await h.close();
  }
});

test('VAT periods: quarterly and monthly boundaries with a fixed due date', () => {
  assert.deepEqual(vatPeriod('2026-11-14', 'quarterly'), {
    periodStart: '2026-10-01',
    periodEnd: '2026-12-31',
    dueDate: '2027-01-31',
    label: 'الربع الرابع 2026',
  });
  assert.equal(vatPeriod('2028-01-15', 'monthly').periodEnd, '2028-01-31');
  assert.equal(vatPeriod('2028-01-15', 'monthly').dueDate, '2028-02-29');
});

async function statementScenario(db: AsyncDb) {
  process.env.HR_DATA_KEY ??= Buffer.alloc(32, 7).toString('base64url');
  const h = await harness(db);
  try {
    await h.send('/api/finance/ledger/setup', {});
    const invoiceId = await invoice(h);
    await invoice(h); // another customer's invoice must never leak into this statement
    const customers = (await h.get<{ customers: { id: string }[] }>('/api/finance')).body.customers;
    assert.equal(customers.length, 2);
    const posted = await Promise.all(
      (
        await h.get<{ invoices: { id: string; quoteId: string }[] }>('/api/finance')
      ).body.invoices.map((item) =>
        h.send<{ voucher: LedgerVoucher }>(`/api/finance/ledger/invoices/${item.id}/post`, {
          revenueAccountCode: '4101',
        }),
      ),
    );
    assert.ok(posted.every((item) => item.status === 201));
    assert.equal(
      (
        await h.send(`/api/finance/ledger/invoices/${invoiceId}/receipts`, {
          date: '2026-07-20',
          amount: '5000.00',
          cashAccountCode: '1102',
          reference: 'TRF-1',
        })
      ).status,
      201,
    );
    const statements = await Promise.all(
      customers.map((item) =>
        h.get<{ statement: CustomerStatement }>(
          `/api/finance/customers/${item.id}/statement?to=2026-09-30`,
        ),
      ),
    );
    const paid = statements.find((item) => item.body.statement.rows.length === 2)!.body.statement;
    const unpaid = statements.find((item) => item.body.statement.rows.length === 1)!.body.statement;
    assert.deepEqual(
      paid.rows.map((row) => [
        row.kind,
        row.date,
        row.debitHalalas,
        row.creditHalalas,
        row.balanceHalalas,
      ]),
      [
        ['invoice', '2026-07-10', 1_150_000, 0, 1_150_000],
        ['receipt', '2026-07-20', 0, 500_000, 650_000],
      ],
    );
    assert.equal(paid.invoicedHalalas, 1_150_000);
    assert.equal(paid.paidHalalas, 500_000);
    assert.equal(paid.closingHalalas, 650_000);
    assert.equal(paid.overdueHalalas, 650_000, 'due 2026-08-09, statement closes 2026-09-30');
    assert.deepEqual(
      paid.openInvoices.map((item) => [
        item.settledHalalas,
        item.outstandingHalalas,
        item.daysOverdue,
      ]),
      [[500_000, 650_000, 52]],
    );
    assert.equal(unpaid.closingHalalas, 1_150_000);
    assert.equal(unpaid.paidHalalas, 0);

    // A period that starts after the invoice carries it as the opening balance.
    const customerId = customers[statements.findIndex((item) => item.body.statement === paid)]!.id;
    const later = (
      await h.get<{ statement: CustomerStatement }>(
        `/api/finance/customers/${customerId}/statement?from=2026-07-15&to=2026-07-31`,
      )
    ).body.statement;
    assert.equal(later.openingHalalas, 1_150_000);
    assert.equal(later.invoicedHalalas, 0);
    assert.equal(later.rows.length, 1);
    assert.equal(later.closingHalalas, 650_000);
    assert.equal(later.overdueHalalas, 0);
    const before = (
      await h.get<{ statement: CustomerStatement }>(
        `/api/finance/customers/${customerId}/statement?to=2026-07-01`,
      )
    ).body.statement;
    assert.equal(before.rows.length, 0);
    assert.equal(before.closingHalalas, 0);
    assert.equal(
      (
        await h.get<Fail>(
          `/api/finance/customers/${customerId}/statement?from=2026-08-01&to=2026-07-01`,
        )
      ).body.error.code,
      'INVALID_DATE_RANGE',
    );

    // Reversing the receipt later adds a movement; the balance reported for July stays as it was.
    const receipt = (
      await h.get<{ vouchers: LedgerVoucher[] }>('/api/finance/ledger/vouchers?kind=receipt')
    ).body.vouchers[0]!;
    assert.equal(
      (
        await h.send(`/api/finance/ledger/vouchers/${receipt.id}/reverse`, {
          version: receipt.version,
          date: '2026-08-15',
          reason: 'تحويل مرتجع',
        })
      ).status,
      200,
    );
    const at = async (to: string) =>
      (
        await h.get<{ statement: CustomerStatement }>(
          `/api/finance/customers/${customerId}/statement?to=${to}`,
        )
      ).body.statement;
    const july = await at('2026-07-31'),
      august = await at('2026-08-31');
    assert.equal(july.closingHalalas, 650_000);
    assert.equal(july.paidHalalas, 500_000);
    assert.deepEqual(
      august.rows.map((row) => [row.kind, row.debitHalalas, row.creditHalalas, row.balanceHalalas]),
      [
        ['invoice', 1_150_000, 0, 1_150_000],
        ['receipt', 0, 500_000, 650_000],
        ['reversal', 500_000, 0, 1_150_000],
      ],
    );
    assert.equal(august.invoicedHalalas, 1_150_000);
    assert.equal(august.paidHalalas, 0);
    assert.equal(august.openInvoices[0]!.outstandingHalalas, 1_150_000);

    h.actor.current = { id: 'other-hr', role: 'hr' };
    assert.equal((await h.get(`/api/finance/customers/${customerId}/statement`)).status, 403);
  } finally {
    await h.close();
  }
}
test('customer statement: invoices, receipts and the balance due per customer and period', async () => {
  await statementScenario(await createDatabase());
});
test(
  'customer statement: the same scenario on PostgreSQL',
  { skip: !process.env.HR_TEST_DATABASE_URL },
  async () => {
    await statementScenario(
      await createPostgresDatabase(
        process.env.HR_TEST_DATABASE_URL!,
        `hr_preview_${randomUUID().replaceAll('-', '')}`,
        { seed: false },
      ),
    );
  },
);
