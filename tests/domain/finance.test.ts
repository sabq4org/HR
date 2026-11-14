import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { Actor } from '../../server/administration/service.js';
import { registerFinance, type WafeqClientLike } from '../../server/finance/routes.js';
import { createDatabase, createPostgresDatabase, type AsyncDb } from '../../server/database.js';

let db: AsyncDb;
let server: Server;
let base = '';
let actor: Actor = { id: 'finance-owner', role: 'hr' };
let clientCalls = 0;
let providerInvoiceCalls = 0;
const client: WafeqClientLike = {
  getOrganization: async () => ({ id: 'org-test', name: 'Test organization' }),
  createCustomer: async () => {
    clientCalls++;
    return { id: 'w-customer-1' };
  },
  getCustomer: async (id) => ({ id }),
  findCustomerByExternalId: async () => null,
  createInvoice: async () => {
    clientCalls++;
    providerInvoiceCalls++;
    return { id: 'w-invoice-1', status: 'unknown', qrCode: null };
  },
  findInvoiceByExternalId: async () => {
    providerInvoiceCalls++;
    return null;
  },
  getInvoice: async () => ({ id: 'w-invoice-1', status: 'cleared', number: 'W-1', qrCode: null }),
  reportInvoice: async () => ({
    id: 'w-invoice-1',
    status: 'cleared',
    number: 'W-1',
    qrCode: null,
  }),
  getInvoicePdf: async () => Buffer.from('%PDF test'),
};

beforeEach(async () => {
  db = await createDatabase();
  actor = { id: 'finance-owner', role: 'hr' };
  clientCalls = 0;
  providerInvoiceCalls = 0;
  const app = express();
  app.use(express.json());
  registerFinance(app, {
    db,
    requireActor: async () => actor,
    privateMode: true,
    allowedActorId: 'finance-owner',
    createClient: (key) => ({
      ...client,
      getOrganization: async () => ({
        id: key === 'other-secret' ? 'other-org' : 'org-test',
        name: 'Test organization',
      }),
    }),
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await db.close();
});

async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('content-type', 'application/json');
  if (['POST', 'PATCH'].includes(options.method ?? ''))
    headers.set('idempotency-key', headers.get('idempotency-key') ?? 'finance-test-key');
  return fetch(`${base}${path}`, { ...options, headers });
}
const post = (body: unknown, key = 'key-1'): RequestInit => ({
  method: 'POST',
  headers: { 'idempotency-key': key },
  body: JSON.stringify(body),
});
const customerBody = {
  name: 'Sample LLC',
  email: 'billing@example.test',
  vatNumber: '',
  address: { line: 'King Road', city: 'Riyadh', postalCode: '12345', country: 'SA' },
};
const quoteBody = (customerId: string) => ({
  customerId,
  title: 'Sample quote',
  issueDate: '2026-11-14',
  validUntil: '2026-12-14',
  notes: '',
  lines: [
    {
      description: 'Service',
      quantity: '1.005',
      unitPrice: '10.00',
      taxRateBps: 1500,
      taxReason: '',
    },
  ],
});
async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

test('finance access is private and scoped to the configured identity, regardless of role', async () => {
  actor = { id: 'other-hr', role: 'hr' };
  assert.equal((await api('/api/finance')).status, 403);
  actor = { id: 'finance-owner', role: 'employee' };
  assert.equal((await api('/api/finance')).status, 200);
});

test('customers and snapshots are encrypted; quote amounts use decimal half-up and remain frozen', async () => {
  actor = { id: 'finance-owner', role: 'hr' };
  const created = await api('/api/finance/customers', post(customerBody));
  assert.equal(created.status, 201);
  const customer = (await json<{ customer: { id: string; version: number } }>(created)).customer;
  const quoteResponse = await api(
    '/api/finance/quotes',
    post(quoteBody(customer.id), 'quote-create'),
  );
  assert.equal(quoteResponse.status, 201);
  const quote = (
    await json<{
      quote: {
        id: string;
        subtotalHalalas: number;
        taxHalalas: number;
        totalHalalas: number;
        customer: { name: string };
      };
    }>(quoteResponse)
  ).quote;
  assert.deepEqual(
    [quote.subtotalHalalas, quote.taxHalalas, quote.totalHalalas],
    [1005, 151, 1156],
  );
  const update = await api(`/api/finance/customers/${customer.id}`, {
    ...post({ ...customerBody, name: 'Changed LLC' }, 'cust-update'),
    method: 'PATCH',
    body: JSON.stringify({ version: customer.version, ...customerBody, name: 'Changed LLC' }),
  });
  assert.equal(update.status, 200);
  const raw = await db.read<{ customer_ciphertext: string }>(
    'SELECT customer_ciphertext FROM finance_customers WHERE id=?',
    [customer.id],
  );
  assert.equal(raw[0].customer_ciphertext.includes('Changed LLC'), false);
  assert.equal(quote.customer.name, 'Sample LLC');
  actor = { id: 'other-hr', role: 'hr' };
  const scoped = await api('/api/finance');
  assert.equal(scoped.status, 403);
  const hidden = await api(`/api/finance/customers/${customer.id}`, {
    ...post({ version: 1, ...customerBody }, 'cross-owner'),
    method: 'PATCH',
  });
  assert.equal(hidden.status, 403);
  actor = { id: 'finance-owner', role: 'hr' };
  const all = await api('/api/finance');
  assert.equal(all.status, 200);
});

test('seller bank details normalize and remain encrypted in immutable quote and invoice snapshots', async () => {
  const seller = {
    name: 'Sabq Test Seller',
    vatNumber: '310000000000003',
    commercialRegistration: '',
    address: { line: 'Riyadh', city: 'Riyadh', postalCode: '1', country: 'SA' },
    bankAccount: {
      beneficiaryName: 'Sabq Synthetic Beneficiary',
      bankName: 'Synthetic Test Bank',
      accountNumber: 'SYNTHETIC-ACCOUNT-001',
      iban: 'sa03 8000 0000 6080 1016 7519',
    },
  };
  const badIban = await api('/api/finance/settings', {
    ...post(
      { version: 1, seller: { ...seller, bankAccount: { ...seller.bankAccount, iban: 'SA123' } } },
      'bad-iban',
    ),
    method: 'PATCH',
  });
  assert.equal(badIban.status, 400);
  const saved = await api('/api/finance/settings', {
    ...post(
      {
        version: 1,
        seller,
        revenueAccountId: 'rev',
        standardTaxRateId: 'tax15',
        zeroTaxRateId: '',
      },
      'bank-settings',
    ),
    method: 'PATCH',
  });
  assert.equal(saved.status, 200);
  const savedSettings = (
    await json<{ settings: { version: number; seller: typeof seller } }>(saved)
  ).settings;
  assert.equal(savedSettings.seller.bankAccount.iban, 'SA0380000000608010167519');

  const customer = (
    await json<{ customer: { id: string } }>(
      await api('/api/finance/customers', post(customerBody, 'bank-customer')),
    )
  ).customer;
  const quote = (
    await json<{ quote: { id: string; version: number; seller: typeof seller } }>(
      await api('/api/finance/quotes', post(quoteBody(customer.id), 'bank-quote')),
    )
  ).quote;
  assert.deepEqual(quote.seller.bankAccount, {
    ...seller.bankAccount,
    iban: 'SA0380000000608010167519',
  });
  const invoice = (
    await json<{ invoice: { id: string; seller: typeof seller } }>(
      await api(
        `/api/finance/quotes/${quote.id}/convert`,
        post(
          { version: quote.version, issueDate: '2026-11-14', dueDate: '2026-12-14' },
          'bank-convert',
        ),
      ),
    )
  ).invoice;
  assert.deepEqual(invoice.seller.bankAccount, quote.seller.bankAccount);

  const updatedSeller = {
    ...seller,
    name: 'Sabq Updated Seller',
    bankAccount: {
      beneficiaryName: 'Updated Synthetic Beneficiary',
      bankName: 'Updated Synthetic Test Bank',
      accountNumber: 'SYNTHETIC-ACCOUNT-002',
      iban: 'SA0380000000608010167519',
    },
  };
  const updatedSettings = await api('/api/finance/settings', {
    ...post(
      {
        version: savedSettings.version,
        seller: updatedSeller,
        revenueAccountId: 'rev',
        standardTaxRateId: 'tax15',
        zeroTaxRateId: '',
      },
      'bank-settings-update',
    ),
    method: 'PATCH',
  });
  assert.equal(updatedSettings.status, 200);
  const overview = await json<{
    quotes: Array<{ id: string; seller: typeof seller }>;
    invoices: Array<{ id: string; seller: typeof seller }>;
  }>(await api('/api/finance'));
  assert.deepEqual(
    overview.quotes.find((item) => item.id === quote.id)?.seller.bankAccount,
    quote.seller.bankAccount,
  );
  assert.deepEqual(
    overview.invoices.find((item) => item.id === invoice.id)?.seller.bankAccount,
    invoice.seller.bankAccount,
  );
  const ciphertexts = await Promise.all([
    db.read<{ seller_ciphertext: string }>('SELECT seller_ciphertext FROM finance_settings'),
    db.read<{ quote_ciphertext: string }>(
      'SELECT quote_ciphertext FROM finance_quotes WHERE id=?',
      [quote.id],
    ),
    db.read<{ invoice_ciphertext: string }>(
      'SELECT invoice_ciphertext FROM finance_invoices WHERE id=?',
      [invoice.id],
    ),
  ]);
  const encryptedRows = [
    ciphertexts[0][0].seller_ciphertext,
    ciphertexts[1][0].quote_ciphertext,
    ciphertexts[2][0].invoice_ciphertext,
  ];
  for (const ciphertext of encryptedRows) {
    assert.equal(ciphertext.includes('SYNTHETIC-ACCOUNT'), false);
    assert.equal(ciphertext.includes('SA0380000000608010167519'), false);
  }
});

test('strict dates, zero-tax reason, and stale versions are rejected', async () => {
  const badCustomer = await api(
    '/api/finance/customers',
    post({ ...customerBody, address: { ...customerBody.address, postalCode: '1' } }),
  );
  assert.equal(badCustomer.status, 201);
  const customer = (await json<{ customer: { id: string; version: number } }>(badCustomer))
    .customer;
  const invalid = await api(
    '/api/finance/quotes',
    post({ ...quoteBody(customer.id), issueDate: '2026-02-30' }, 'invalid-date'),
  );
  assert.equal(invalid.status, 400);
  const noReason = await api(
    '/api/finance/quotes',
    post(
      {
        ...quoteBody(customer.id),
        lines: [
          {
            description: 'Exempt?',
            quantity: '1',
            unitPrice: '1.00',
            taxRateBps: 0,
            taxReason: '',
          },
        ],
      },
      'no-reason',
    ),
  );
  assert.equal(noReason.status, 400);
  const stale = await api('/api/finance/settings', {
    ...post(
      {
        version: 7,
        seller: {
          name: 'S',
          vatNumber: '',
          commercialRegistration: '',
          address: { line: 'R', city: 'Riyadh', postalCode: '1', country: 'SA' },
        },
      },
      'stale',
    ),
    method: 'PATCH',
  });
  assert.equal(stale.status, 409);
});

test('quote conversion is atomic and returns one immutable invoice across distinct retry keys', async () => {
  const created = await api('/api/finance/customers', post(customerBody, 'customer'));
  const customer = (await json<{ customer: { id: string } }>(created)).customer;
  const q = (
    await json<{ quote: { id: string; version: number } }>(
      await api('/api/finance/quotes', post(quoteBody(customer.id), 'quote')),
    )
  ).quote;
  const body = { version: q.version, issueDate: '2026-11-14', dueDate: '2026-12-14' };
  const responses = await Promise.all([
    api(`/api/finance/quotes/${q.id}/convert`, post(body, 'convert-a')),
    api(`/api/finance/quotes/${q.id}/convert`, post(body, 'convert-b')),
  ]);
  const invoices = await Promise.all(
    responses.map((r) => json<{ invoice: { id: string; number: string; status: string } }>(r)),
  );
  assert.equal(invoices[0].invoice.id, invoices[1].invoice.id);
  assert.match(invoices[0].invoice.number, /^HR-INV-\d{6}$/);
  assert.equal((await api('/api/finance')).status, 200);
  const count = await db.read<{ n: number }>('SELECT COUNT(*) AS n FROM finance_invoices');
  assert.equal(count[0].n, 1);
});

test('hostile API key payload is neither echoed nor recorded before private provider validation', async () => {
  actor = { id: 'someone-else', role: 'hr' };
  const response = await api(
    '/api/finance/settings/api-key',
    post({ apiKey: 'do-not-store-this-secret' }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes('do-not-store-this-secret'), false);
  const rows = await db.read<{ n: number }>(
    'SELECT COUNT(*) AS n FROM finance_provider_credentials',
  );
  assert.equal(rows[0].n, 0);
});

test('private credential save uses the fixed default Wafeq client with a mocked fetch', async () => {
  const secondary = await createDatabase();
  let secondaryServer: Server | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://api.wafeq.com/v1/organization/');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Api-Key synthetic-default-key');
    return Response.json({
      id: 'org-default',
      name: { ar: 'اختبار عميل وافق', en: 'Default client test' },
    });
  }) as typeof fetch;
  try {
    const app = express();
    app.use(express.json());
    registerFinance(app, {
      db: secondary,
      requireActor: async () => ({ id: 'default-owner', role: 'hr' }),
      privateMode: true,
      allowedActorId: 'default-owner',
    });
    secondaryServer = createServer(app);
    await new Promise<void>((resolve) => secondaryServer!.listen(0, '127.0.0.1', resolve));
    const address = secondaryServer.address();
    assert.ok(address && typeof address !== 'string');
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/api/finance/settings/api-key',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'safe-key-test' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ apiKey: 'synthetic-default-key' }));
    });
    assert.equal(reply.status, 200, reply.body);
    assert.equal(reply.body.includes('synthetic-default-key'), false);
    const saved = await secondary.read<{ api_key_ciphertext: string }>(
      'SELECT api_key_ciphertext FROM finance_provider_credentials WHERE owner_id=?',
      ['default-owner'],
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0].api_key_ciphertext.includes('synthetic-default-key'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (secondaryServer)
      await new Promise<void>((resolve, reject) =>
        secondaryServer!.close((error) => (error ? reject(error) : resolve())),
      );
    await secondary.close();
  }
});

test('private key is organization-bound and encrypted; customer and invoice sync use durable UUID operation keys', async () => {
  actor = { id: 'finance-owner', role: 'hr' };
  const key = 'synthetic-fake-key';
  const saved = await api('/api/finance/settings/api-key', post({ apiKey: key }, 'key-save'));
  assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes(key), false);
  const secretRows = await db.read<{ api_key_ciphertext: string }>(
    'SELECT api_key_ciphertext FROM finance_provider_credentials',
  );
  assert.equal(secretRows[0].api_key_ciphertext.includes(key), false);
  const idemRows = await db.read<{ n: number }>(
    'SELECT COUNT(*) AS n FROM administration_idempotency',
  );
  assert.equal(idemRows[0].n, 0);
  const mismatch = await api(
    '/api/finance/settings/api-key',
    post({ apiKey: 'other-secret' }, 'key-replace'),
  );
  assert.equal(mismatch.status, 409);

  const customer = (
    await json<{ customer: { id: string; version: number } }>(
      await api('/api/finance/customers', post(customerBody, 'sync-customer-create')),
    )
  ).customer;
  const synced = await api(
    `/api/finance/customers/${customer.id}/sync`,
    post({ version: customer.version }, 'sync-customer'),
  );
  assert.equal(synced.status, 200);
  assert.equal(
    (await json<{ customer: { syncStatus: string; version: number } }>(synced)).customer.syncStatus,
    'synced',
  );
  const mappings = {
    version: 1,
    seller: {
      name: 'Sabq',
      vatNumber: '310000000000003',
      commercialRegistration: '',
      address: { line: 'Riyadh', city: 'Riyadh', postalCode: '1', country: 'SA' },
    },
    revenueAccountId: 'revenue',
    standardTaxRateId: 'tax15',
    zeroTaxRateId: '',
  };
  const settings = await api('/api/finance/settings', {
    ...post(mappings, 'settings-save'),
    method: 'PATCH',
  });
  assert.equal(settings.status, 200);
  const q = (
    await json<{ quote: { id: string; version: number } }>(
      await api('/api/finance/quotes', post(quoteBody(customer.id), 'sync-quote')),
    )
  ).quote;
  const invoice = (
    await json<{ invoice: { id: string } }>(
      await api(
        `/api/finance/quotes/${q.id}/convert`,
        post(
          { version: q.version, issueDate: '2026-11-14', dueDate: '2026-12-14' },
          'sync-convert',
        ),
      ),
    )
  ).invoice;
  const syncedInvoice = await api(
    `/api/finance/invoices/${invoice.id}/sync`,
    post({ version: 1 }, 'sync-invoice'),
  );
  assert.equal(syncedInvoice.status, 200);
  const result = (
    await json<{
      invoice: { status: string; wafeqId: string; qrCode: string | null; canDownload: boolean };
    }>(syncedInvoice)
  ).invoice;
  assert.equal(result.status, 'cleared');
  assert.equal(result.wafeqId, 'w-invoice-1');
  assert.equal(result.qrCode, null);
  assert.equal(result.canDownload, true);
  const operations = await db.read<{ idempotency_key: string; report_idempotency_key: string }>(
    'SELECT idempotency_key,report_idempotency_key FROM finance_provider_operations ORDER BY resource_type',
  );
  assert.equal(operations.length, 2);
  for (const op of operations) {
    assert.match(op.idempotency_key, /^[0-9a-f-]{36}$/i);
    assert.match(op.report_idempotency_key, /^[0-9a-f-]{36}$/i);
  }
  assert.equal((await api(`/api/finance/invoices/${invoice.id}/qr`)).status, 409);
  const pdf = await api(`/api/finance/invoices/${invoice.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const storedPdf = await db.read<{ content_ciphertext: string }>(
    'SELECT content_ciphertext FROM finance_private_artifacts WHERE owner_id=? AND invoice_id=?',
    [actor.id, invoice.id],
  );
  assert.equal(storedPdf.length, 1);
  assert.equal(storedPdf[0].content_ciphertext.includes('%PDF test'), false);
  const lateCustomer = (
    await json<{ customer: { id: string; version: number } }>(
      await api('/api/finance/customers', post(customerBody, 'late-customer')),
    )
  ).customer;
  const lateQuote = (
    await json<{ quote: { id: string; version: number } }>(
      await api('/api/finance/quotes', post(quoteBody(lateCustomer.id), 'late-quote')),
    )
  ).quote;
  const lateInvoice = (
    await json<{ invoice: { id: string; version: number } }>(
      await api(
        `/api/finance/quotes/${lateQuote.id}/convert`,
        post(
          {
            version: lateQuote.version,
            issueDate: '2026-11-14',
            dueDate: '2026-12-14',
          },
          'late-convert',
        ),
      ),
    )
  ).invoice;
  const edited = await api(`/api/finance/customers/${lateCustomer.id}`, {
    ...post(
      { version: lateCustomer.version, ...customerBody, name: 'Changed after conversion' },
      'late-customer-update',
    ),
    method: 'PATCH',
  });
  assert.equal(edited.status, 200);
  const changedVersion = (await json<{ customer: { version: number } }>(edited)).customer.version;
  assert.equal(
    (
      await api(
        `/api/finance/customers/${lateCustomer.id}/sync`,
        post({ version: changedVersion }, 'late-customer-sync'),
      )
    ).status,
    200,
  );
  const providerCallsBefore = providerInvoiceCalls;
  const staleSnapshot = await api(
    `/api/finance/invoices/${lateInvoice.id}/sync`,
    post({ version: lateInvoice.version }, 'late-invoice-sync'),
  );
  assert.equal(staleSnapshot.status, 409);
  assert.equal(providerInvoiceCalls, providerCallsBefore);
  assert.equal(
    (await json<{ error: { code: string } }>(staleSnapshot)).error.code,
    'CUSTOMER_SNAPSHOT_STALE',
  );
  const person = (
    await json<{ customer: { id: string; version: number } }>(
      await api(
        '/api/finance/customers',
        post({ ...customerBody, name: 'Private Person', type: 'individual' }, 'person-create'),
      ),
    )
  ).customer;
  await api(
    `/api/finance/customers/${person.id}/sync`,
    post({ version: person.version }, 'person-sync'),
  );
  const individualQuote = (
    await json<{ quote: { id: string; version: number } }>(
      await api(
        '/api/finance/quotes',
        post({ ...quoteBody(person.id), documentType: 'simplified' }, 'person-quote'),
      ),
    )
  ).quote;
  const individualInvoice = (
    await json<{ invoice: { id: string } }>(
      await api(
        `/api/finance/quotes/${individualQuote.id}/convert`,
        post(
          {
            version: individualQuote.version,
            issueDate: '2026-11-14',
            dueDate: '2026-12-14',
            invoiceType: 'simplified',
          },
          'person-convert',
        ),
      ),
    )
  ).invoice;
  const personCallsBefore = clientCalls;
  const blocked = await api(
    `/api/finance/invoices/${individualInvoice.id}/sync`,
    post({ version: 1 }, 'person-invoice-sync'),
  );
  assert.equal(blocked.status, 409);
  assert.equal(clientCalls, personCallsBefore);
});

test('document type fixes line tax rules and the converted invoice type', async () => {
  const customer = (
    await json<{ customer: { id: string } }>(
      await api('/api/finance/customers', post(customerBody, 'doc-type-customer')),
    )
  ).customer;
  const zeroLine = {
    description: 'Service for a non-resident client',
    quantity: '2',
    unitPrice: '100.00',
    taxRateBps: 0,
    taxReason: 'Non-resident client',
  };
  const mixed = await api(
    '/api/finance/quotes',
    post(
      {
        ...quoteBody(customer.id),
        documentType: 'zero_rated',
        lines: [zeroLine, { ...zeroLine, taxRateBps: 1500, taxReason: '' }],
      },
      'zero-mixed',
    ),
  );
  assert.equal(mixed.status, 400);
  assert.equal(
    ((await mixed.json()) as { error: { code: string } }).error.code,
    'ZERO_RATED_LINES_REQUIRED',
  );
  assert.equal(
    (
      await api(
        '/api/finance/quotes',
        post({ ...quoteBody(customer.id), documentType: 'other' }, 'bad-type'),
      )
    ).status,
    400,
  );
  const zero = (
    await json<{
      quote: { id: string; version: number; documentType: string; taxHalalas: number };
    }>(
      await api(
        '/api/finance/quotes',
        post(
          { ...quoteBody(customer.id), documentType: 'zero_rated', lines: [zeroLine] },
          'zero-ok',
        ),
      ),
    )
  ).quote;
  assert.equal(zero.documentType, 'zero_rated');
  assert.equal(zero.taxHalalas, 0);
  const mismatch = await api(
    `/api/finance/quotes/${zero.id}/convert`,
    post(
      {
        version: zero.version,
        issueDate: '2026-11-14',
        dueDate: '2026-12-14',
        invoiceType: 'simplified',
      },
      'zero-convert-mismatch',
    ),
  );
  assert.equal(mismatch.status, 409);
  const invoice = (
    await json<{ invoice: { invoiceType: string; documentType: string; taxHalalas: number } }>(
      await api(
        `/api/finance/quotes/${zero.id}/convert`,
        post(
          { version: zero.version, issueDate: '2026-11-14', dueDate: '2026-12-14' },
          'zero-convert',
        ),
      ),
    )
  ).invoice;
  assert.equal(invoice.invoiceType, 'standard');
  assert.equal(invoice.documentType, 'zero_rated');
  assert.equal(invoice.taxHalalas, 0);
  // Quotes created before document types existed read as B2B tax quotes.
  const legacy = (
    await json<{ quote: { id: string; documentType: string } }>(
      await api('/api/finance/quotes', post(quoteBody(customer.id), 'legacy-quote')),
    )
  ).quote;
  assert.equal(legacy.documentType, 'standard');
  // Out-of-scope (non-tax) documents also reject taxed lines.
  const outTaxed = await api(
    '/api/finance/quotes',
    post(
      {
        ...quoteBody(customer.id),
        documentType: 'out_of_scope',
        lines: [{ ...zeroLine, taxRateBps: 1500, taxReason: '' }],
      },
      'out-taxed',
    ),
  );
  assert.equal(outTaxed.status, 400);
  const outOfScope = (
    await json<{ quote: { documentType: string; taxHalalas: number } }>(
      await api(
        '/api/finance/quotes',
        post(
          {
            ...quoteBody(customer.id),
            documentType: 'out_of_scope',
            lines: [{ ...zeroLine, taxReason: 'Outside VAT scope' }],
          },
          'out-ok',
        ),
      ),
    )
  ).quote;
  assert.equal(outOfScope.documentType, 'out_of_scope');
  assert.equal(outOfScope.taxHalalas, 0);
});

test('saved catalog items validate tax, keep versions, and archive instead of deleting', async () => {
  const missingReason = await api(
    '/api/finance/catalog',
    post({ description: 'Banner', unitPrice: '100.00', taxRateBps: 0, taxReason: '' }, 'c0'),
  );
  assert.equal(missingReason.status, 400);
  assert.equal(
    (
      await api(
        '/api/finance/catalog',
        post({ description: 'Banner', unitPrice: '100.00', taxRateBps: 500, taxReason: '' }, 'c1'),
      )
    ).status,
    400,
  );
  const createdResponse = await api(
    '/api/finance/catalog',
    post({ description: 'Homepage banner', unitPrice: '18500.00', taxRateBps: 1500 }, 'c2'),
  );
  assert.equal(createdResponse.status, 201);
  const created = (
    await json<{ item: { id: string; version: number; active: boolean; taxReason: string } }>(
      createdResponse,
    )
  ).item;
  assert.equal(created.active, true);
  assert.equal(created.taxReason, '');
  const replay = await api(
    '/api/finance/catalog',
    post({ description: 'Homepage banner', unitPrice: '18500.00', taxRateBps: 1500 }, 'c2'),
  );
  assert.equal(((await replay.json()) as { item: { id: string } }).item.id, created.id);
  const patch = (body: unknown, key: string): RequestInit => ({
    method: 'PATCH',
    headers: { 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  const archived = (
    await json<{ item: { version: number; active: boolean; unitPrice: string } }>(
      await api(
        `/api/finance/catalog/${created.id}`,
        patch(
          {
            version: created.version,
            active: false,
            description: 'Homepage banner',
            unitPrice: '19000.00',
            taxRateBps: 1500,
            taxReason: '',
          },
          'c3',
        ),
      ),
    )
  ).item;
  assert.equal(archived.active, false);
  assert.equal(archived.unitPrice, '19000.00');
  assert.equal(archived.version, 2);
  const stale = await api(
    `/api/finance/catalog/${created.id}`,
    patch(
      {
        version: 1,
        active: true,
        description: 'Homepage banner',
        unitPrice: '1.00',
        taxRateBps: 1500,
        taxReason: '',
      },
      'c4',
    ),
  );
  assert.equal(stale.status, 409);
  const overview = (await json<{ catalog: { id: string; active: boolean }[] }>(
    await api('/api/finance'),
  )) as { catalog: { id: string; active: boolean }[] };
  assert.deepEqual(
    overview.catalog.map((item) => [item.id, item.active]),
    [[created.id, false]],
  );
  actor = { id: 'other-hr', role: 'hr' };
  assert.equal(
    (
      await api(
        '/api/finance/catalog',
        post({ description: 'x', unitPrice: '1.00', taxRateBps: 1500 }, 'c5'),
      )
    ).status,
    403,
  );
});

test('zero-tax invoice sync is blocked before provider calls even when no zero-rate mapping is configured', async () => {
  const saved = await api('/api/finance/settings', {
    ...post(
      {
        version: 1,
        seller: {
          name: 'Sabq',
          vatNumber: '310000000000003',
          commercialRegistration: '',
          address: { line: 'Riyadh', city: 'Riyadh', postalCode: '1', country: 'SA' },
        },
        revenueAccountId: 'rev',
        standardTaxRateId: 'tax15',
        zeroTaxRateId: '',
      },
      'zero-settings',
    ),
    method: 'PATCH',
  });
  assert.equal(saved.status, 200);
  await api('/api/finance/settings/api-key', post({ apiKey: 'synthetic-key' }, 'zero-key'));
  const customer = (
    await json<{ customer: { id: string; version: number } }>(
      await api('/api/finance/customers', post(customerBody, 'zero-customer')),
    )
  ).customer;
  assert.equal(
    (
      await api(
        `/api/finance/customers/${customer.id}/sync`,
        post({ version: customer.version }, 'zero-customer-sync'),
      )
    ).status,
    200,
  );
  const quote = (
    await json<{ quote: { id: string; version: number } }>(
      await api(
        '/api/finance/quotes',
        post(
          {
            ...quoteBody(customer.id),
            lines: [
              {
                description: 'Exempt service',
                quantity: '1',
                unitPrice: '10.00',
                taxRateBps: 0,
                taxReason: 'documented exemption reason',
              },
            ],
          },
          'zero-quote',
        ),
      ),
    )
  ).quote;
  const invoice = (
    await json<{ invoice: { id: string; version: number } }>(
      await api(
        `/api/finance/quotes/${quote.id}/convert`,
        post(
          { version: quote.version, issueDate: '2026-11-14', dueDate: '2026-12-14' },
          'zero-convert',
        ),
      ),
    )
  ).invoice;
  const providerCalls = providerInvoiceCalls;
  const response = await api(
    `/api/finance/invoices/${invoice.id}/sync`,
    post({ version: invoice.version }, 'zero-invoice-sync'),
  );
  assert.equal(response.status, 409);
  assert.equal(
    (await json<{ error: { code: string } }>(response)).error.code,
    'ZERO_TAX_INVOICE_UNSUPPORTED',
  );
  assert.equal(providerInvoiceCalls, providerCalls);
});

test(
  'PostgreSQL migrates finance tables and serializes duplicate conversion and provider sync',
  { skip: !process.env.HR_TEST_DATABASE_URL },
  async () => {
    const pg = await createPostgresDatabase(
      process.env.HR_TEST_DATABASE_URL!,
      `hr_preview_${randomUUID().replaceAll('-', '')}`,
      { seed: false },
    );
    let pgServer: Server | undefined;
    let pgBase = '';
    let releaseContact!: () => void;
    let releaseInvoice!: () => void;
    let contactEntered!: () => void;
    let invoiceEntered!: () => void;
    const contactGate = new Promise<void>((resolve) => (releaseContact = resolve)),
      invoiceGate = new Promise<void>((resolve) => (releaseInvoice = resolve));
    const contactStarted = new Promise<void>((resolve) => (contactEntered = resolve)),
      invoiceStarted = new Promise<void>((resolve) => (invoiceEntered = resolve));
    let customerCreates = 0,
      invoiceCreates = 0,
      contactFinds = 0,
      invoiceFinds = 0;
    const pgClient: WafeqClientLike = {
      getOrganization: async () => ({ id: 'pg-org', name: 'PG test' }),
      findCustomerByExternalId: async () => {
        contactFinds++;
        contactEntered();
        await contactGate;
        return null;
      },
      createCustomer: async () => {
        customerCreates++;
        return { id: 'pg-customer' };
      },
      getCustomer: async (id) => ({ id }),
      findInvoiceByExternalId: async () => {
        invoiceFinds++;
        invoiceEntered();
        await invoiceGate;
        return null;
      },
      createInvoice: async () => {
        invoiceCreates++;
        return { id: 'pg-invoice', status: 'unknown', qrCode: null };
      },
      reportInvoice: async () => ({
        id: 'pg-invoice',
        status: 'pending',
        number: 'HR-INV-000001',
        qrCode: null,
      }),
      getInvoice: async (id) => ({ id, status: 'pending', qrCode: null }),
      getInvoicePdf: async () => Buffer.from('%PDF'),
    };
    try {
      const app = express();
      app.use(express.json());
      registerFinance(app, {
        db: pg,
        requireActor: async () => ({ id: 'pg-owner', role: 'hr' }),
        privateMode: true,
        allowedActorId: 'pg-owner',
        createClient: () => pgClient,
      });

      pgServer = createServer(app);
      await new Promise<void>((resolve) => pgServer!.listen(0, '127.0.0.1', resolve));
      const addr = pgServer.address();
      assert.ok(addr && typeof addr !== 'string');
      pgBase = `http://127.0.0.1:${addr.port}`;
      const call = async (path: string, body?: unknown, key = 'pg-key', method = 'POST') =>
        fetch(`${pgBase}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      assert.deepEqual(
        (
          await pg.read<{ version: number }>(
            'SELECT version FROM schema_migrations ORDER BY version',
          )
        ).map((row) => row.version),
        [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12],
      );
      assert.equal(
        (await call('/api/finance/settings/api-key', { apiKey: 'pg-fake-secret' })).status,
        200,
      );
      const settings = {
        version: 1,
        seller: {
          name: 'Sabq',
          vatNumber: '310000000000003',
          commercialRegistration: '',
          address: { line: 'Riyadh', city: 'Riyadh', postalCode: '1', country: 'SA' },
        },
        revenueAccountId: 'rev',
        standardTaxRateId: 'tax15',
        zeroTaxRateId: 'tax0',
      };
      assert.equal(
        (await call('/api/finance/settings', settings, 'pg-settings', 'PATCH')).status,
        200,
      );
      const concurrentSettings = [
        { ...settings, version: 2, seller: { ...settings.seller, name: 'Sabq A' } },
        { ...settings, version: 2, seller: { ...settings.seller, name: 'Sabq B' } },
      ];
      const settingsRace = await Promise.all(
        concurrentSettings.map((body, index) =>
          call('/api/finance/settings', body, `pg-settings-race-${index}`, 'PATCH'),
        ),
      );
      assert.deepEqual(settingsRace.map((response) => response.status).sort(), [200, 409]);
      const customerReply = await call(
        '/api/finance/customers',
        customerBody,
        'pg-customer-create',
      );
      const customer = (
        (await customerReply.json()) as { customer: { id: string; version: number } }
      ).customer;
      const syncOne = call(
        `/api/finance/customers/${customer.id}/sync`,
        { version: customer.version },
        'pg-contact-a',
      );
      await contactStarted;
      const syncTwo = await call(
        `/api/finance/customers/${customer.id}/sync`,
        { version: customer.version },
        'pg-contact-b',
      );
      assert.equal(syncTwo.status, 409);
      releaseContact();
      assert.equal((await syncOne).status, 200);
      assert.equal(contactFinds, 1);
      assert.equal(customerCreates, 1);
      const quote = (
        (await (await call('/api/finance/quotes', quoteBody(customer.id), 'pg-quote')).json()) as {
          quote: { id: string; version: number };
        }
      ).quote;
      const convertBody = {
        version: quote.version,
        issueDate: '2026-11-14',
        dueDate: '2026-12-14',
      };
      const converted = await Promise.all([
        call(`/api/finance/quotes/${quote.id}/convert`, convertBody, 'pg-convert-a'),
        call(`/api/finance/quotes/${quote.id}/convert`, convertBody, 'pg-convert-b'),
      ]);
      const invoiceA = ((await converted[0].json()) as { invoice: { id: string; version: number } })
          .invoice,
        invoiceB = ((await converted[1].json()) as { invoice: { id: string } }).invoice;
      assert.equal(invoiceA.id, invoiceB.id);
      const invoiceSync1 = call(
        `/api/finance/invoices/${invoiceA.id}/sync`,
        { version: invoiceA.version },
        'pg-invoice-a',
      );
      await invoiceStarted;
      const invoiceSync2 = await call(
        `/api/finance/invoices/${invoiceA.id}/sync`,
        { version: invoiceA.version },
        'pg-invoice-b',
      );
      assert.equal(invoiceSync2.status, 409);
      releaseInvoice();
      assert.equal((await invoiceSync1).status, 200);
      assert.equal(invoiceFinds, 1);
      assert.equal(invoiceCreates, 1);
      const final = (
        (await (await call('/api/finance', undefined, 'unused', 'GET')).json()) as {
          invoices: Array<{ id: string; status: string; wafeqId: string | null; version: number }>;
        }
      ).invoices[0];
      assert.equal(final.id, invoiceA.id);
      assert.equal(final.status, 'pending');
      assert.equal(final.wafeqId, 'pg-invoice');
      assert.ok(final.version > 1);
      const operation = (
        await pg.read<{ state: string; lease_until: string | null }>(
          "SELECT state,lease_until FROM finance_provider_operations WHERE owner_id=? AND resource_type='invoice'",
          ['pg-owner'],
        )
      )[0];
      assert.equal(operation.state, 'complete');
      assert.equal(operation.lease_until, null);
      const invoiceCount = (
        await pg.read<{ n: string }>(
          'SELECT COUNT(*)::text AS n FROM finance_invoices WHERE owner_id=?',
          ['pg-owner'],
        )
      )[0];
      assert.equal(invoiceCount.n, '1');
    } finally {
      releaseContact?.();
      releaseInvoice?.();
      if (pgServer)
        await new Promise<void>((resolve, reject) =>
          pgServer!.close((error) => (error ? reject(error) : resolve())),
        );
      await pg.close();
    }
  },
);
