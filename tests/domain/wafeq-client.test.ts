import assert from 'node:assert/strict';
import test from 'node:test';
import type { FinanceCustomerInput, FinanceInvoice } from '../../shared/finance.js';
import { WafeqApiError, WafeqClient } from '../../server/integrations/wafeq.js';

const apiKey = 'test-key-must-never-appear';
const uuid = '7ac2d411-01d1-4b1a-9a41-7292ddf4106b';
const customer: FinanceCustomerInput = {
  name: 'عميل تجريبي',
  nameEnglish: 'Synthetic Customer',
  email: 'customer@example.test',
  vatNumber: '300000000000003',
  phone: '+966500000001',
  address: {
    line: '101 Example St',
    city: 'Riyadh',
    postalCode: '12345',
    country: 'SA',
    district: 'Al Olaya',
    buildingNumber: '1234',
    additionalNumber: '5678',
  },
};
const invoice: FinanceInvoice = {
  id: 'local-invoice-1',
  number: 'SABQ-0001',
  quoteId: 'quote-1',
  quoteNumber: 'Q-0001',
  title: 'Synthetic services',
  version: 1,
  issueDate: '2026-11-14',
  dueDate: '2026-12-14',
  status: 'syncing',
  purchaseOrder: 'PO-2048',
  currency: 'SAR',
  customer,
  seller: {
    name: 'Synthetic Seller',
    vatNumber: '300000000000010',
    commercialRegistration: '1010101010',
    address: customer.address,
  },
  lines: [
    {
      description: 'Taxable line',
      quantity: '2',
      unitPrice: '100.00',
      taxRateBps: 1500,
      taxReason: '',
      subtotalHalalas: 20_000,
      taxHalalas: 3_000,
      totalHalalas: 23_000,
    },
  ],
  notes: 'Synthetic only',
  subtotalHalalas: 20_000,
  taxHalalas: 3_000,
  totalHalalas: 23_000,
  wafeqId: null,
  zatcaStatus: 'not_submitted',
  qrCode: null,
  canDownload: false,
  createdAt: '2026-11-14T00:00:00.000Z',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('uses fixed v1 paths, API-key auth, external IDs, and Wafeq idempotency header', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new WafeqClient(apiKey, async (input, init = {}) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith('/organization/'))
      return json({ id: 'org-1', name: { en: 'Synthetic org', ar: 'منظمة تجريبية' } });
    if (String(input).includes('/contacts/')) return json({ id: 'contact-1' }, 201);
    if (String(input).includes('/invoices/'))
      return json({ id: 'invoice-1', invoice_number: 'W-1', status: 'DRAFT' }, 201);
    throw new Error('unexpected route');
  });

  assert.deepEqual(await client.getOrganization(), { id: 'org-1', name: 'منظمة تجريبية' });
  assert.deepEqual(await client.createCustomer(customer, 'hr-customer-7', uuid), {
    id: 'contact-1',
  });
  const result = await client.createInvoice(
    invoice,
    { revenueAccountId: 'acc-revenue', standardTaxRateId: 'tax-15', zeroTaxRateId: 'tax-zero' },
    'contact-1',
    uuid,
  );
  assert.deepEqual(result, { id: 'invoice-1', number: 'W-1', status: 'unknown', qrCode: null });

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://api.wafeq.com/v1/organization/',
      'https://api.wafeq.com/v1/contacts/',
      'https://api.wafeq.com/v1/invoices/',
    ],
  );
  const contactInit = requests[1].init;
  assert.equal(new Headers(contactInit.headers).get('authorization'), `Api-Key ${apiKey}`);
  assert.equal(new Headers(contactInit.headers).get('x-wafeq-idempotency-key'), uuid);
  assert.deepEqual(JSON.parse(String(contactInit.body)), {
    name: customer.name,
    email: customer.email,
    tax_registration_number: customer.vatNumber,
    address: customer.address.line,
    city: customer.address.city,
    postal_code: customer.address.postalCode,
    country: 'SA',
    is_customer: true,
    external_id: 'hr-customer-7',
    district: 'Al Olaya',
    building_number: '1234',
    additional_number: '5678',
    phone: '+966500000001',
  });
  const invoiceBody = JSON.parse(String(requests[2].init.body));
  assert.equal(invoiceBody.currency, 'SAR');
  assert.equal(invoiceBody.external_id, invoice.id);
  assert.equal(invoiceBody.purchase_order, 'PO-2048');
  assert.deepEqual(invoiceBody.line_items, [
    {
      description: 'Taxable line',
      account: 'acc-revenue',
      quantity: 2,
      unit_amount: 100,
      tax_rate: 'tax-15',
    },
  ]);
});

test('finds contacts and invoices using exact external_id filters', async () => {
  const urls: string[] = [];
  const client = new WafeqClient(apiKey, async (input) => {
    urls.push(String(input));
    if (String(input).includes('/contacts/'))
      return json({
        count: 1,
        next: null,
        previous: null,
        results: [{ id: 'c-1', external_id: 'customer-X' }],
      });
    return json({
      count: 1,
      next: null,
      previous: null,
      results: [{ id: 'i-1', invoice_number: 'W-2', external_id: 'invoice-X' }],
    });
  });
  assert.deepEqual(await client.findCustomerByExternalId('customer-X'), { id: 'c-1' });
  assert.deepEqual(await client.findInvoiceByExternalId('invoice-X'), {
    id: 'i-1',
    number: 'W-2',
    status: 'unknown',
    qrCode: null,
  });
  assert.match(urls[0], /contacts\/\?external_id=customer-X&page_size=100$/);
  assert.match(urls[1], /invoices\/\?external_id=invoice-X&page_size=100$/);
});

test('preserves the source unit price when fractional quantity rounds line subtotal', async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new WafeqClient(apiKey, async (_input, init = {}) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    return json({ id: 'invoice-fractional' }, 201);
  });
  const fractional: FinanceInvoice = {
    ...invoice,
    lines: [
      {
        ...invoice.lines[0],
        quantity: '0.3',
        unitPrice: '1.23',
        subtotalHalalas: 37,
        taxHalalas: 6,
        totalHalalas: 43,
      },
    ],
    subtotalHalalas: 37,
    taxHalalas: 6,
    totalHalalas: 43,
  };
  await client.createInvoice(
    fractional,
    { revenueAccountId: 'acc', standardTaxRateId: 'tax15', zeroTaxRateId: 'tax0' },
    'contact-1',
    uuid,
  );
  const items = sent?.line_items as Array<Record<string, unknown>>;
  assert.equal(fractional.lines[0].subtotalHalalas, 37);
  assert.equal(items[0].quantity, 0.3);
  assert.equal(items[0].unit_amount, 1.23);
});

test('fails closed on malformed lookup responses instead of allowing a duplicate create', async () => {
  const malformed = [
    json({ results: 'not-an-array', count: 1, next: null }),
    json({ results: [{}], count: 1, next: null }),
    json({ results: [{ id: 'c-1' }], count: 1, next: null }),
  ];
  for (const response of malformed) {
    const client = new WafeqClient(apiKey, async () => response.clone());
    await assert.rejects(
      () => client.findCustomerByExternalId('customer-X'),
      (error: unknown) => error instanceof WafeqApiError && error.code === 'invalid_response',
    );
  }
});

test('paginates lookups through the fixed Wafeq route and ignores returned next URLs', async () => {
  const urls: string[] = [];
  const client = new WafeqClient(apiKey, async (input) => {
    urls.push(String(input));
    if (!String(input).includes('&page=2')) {
      return json({
        count: 2,
        next: 'https://attacker.example/steal-key',
        previous: null,
        results: [{ id: 'c-other', external_id: 'other' }],
      });
    }
    return json({
      count: 2,
      next: null,
      previous: 'https://attacker.example/steal-key',
      results: [{ id: 'c-target', external_id: 'customer-X' }],
    });
  });
  assert.deepEqual(await client.findCustomerByExternalId('customer-X'), { id: 'c-target' });
  assert.equal(urls.length, 2);
  assert.equal(
    urls.every((url) => url.startsWith('https://api.wafeq.com/v1/contacts/')),
    true,
  );
  assert.match(urls[1], /page=2$/);
});

test('never sends simplified invoice input to the standard invoice endpoint', async () => {
  let called = false;
  const client = new WafeqClient(apiKey, async () => {
    called = true;
    return json({ id: 'unexpected' });
  });
  await assert.rejects(
    () =>
      client.createInvoice(
        { ...invoice, invoiceType: 'simplified' },
        { revenueAccountId: 'acc', standardTaxRateId: 'tax15', zeroTaxRateId: 'tax0' },
        'contact-1',
        uuid,
      ),
    (error: unknown) =>
      error instanceof WafeqApiError && error.code === 'simplified_invoice_not_supported',
  );
  assert.equal(called, false);
});

test('blocks zero-rated invoice lines when the saved reason is free text without a Wafeq reason-code mapping', async () => {
  let called = false;
  const client = new WafeqClient(apiKey, async () => {
    called = true;
    return json({ id: 'unexpected' });
  });
  const zeroRated: FinanceInvoice = {
    ...invoice,
    lines: [{ ...invoice.lines[0], taxRateBps: 0, taxReason: 'Outside the scope of VAT' }],
  };
  await assert.rejects(
    () =>
      client.createInvoice(
        zeroRated,
        { revenueAccountId: 'acc', standardTaxRateId: 'tax15', zeroTaxRateId: 'tax0' },
        'contact-1',
        uuid,
      ),
    (error: unknown) =>
      error instanceof WafeqApiError && error.code === 'zero_tax_reason_mapping_required',
  );
  assert.equal(called, false);
});

test('reports B2B invoices via the invoice tax-authority action and treats PENDING as nonterminal', async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new WafeqClient(apiKey, async (input, init = {}) => {
    request = { url: String(input), init };
    return json({
      status: 'PENDING',
      reported_ts: '2026-11-14T10:00:00Z',
      metadata: { errors: [], warnings: [] },
    });
  });
  assert.deepEqual(await client.reportInvoice('inv-1', uuid), {
    id: 'inv-1',
    status: 'pending',
    taxAuthorityStatus: 'PENDING',
    qrCode: null,
  });
  assert.equal(request?.url, 'https://api.wafeq.com/v1/invoices/inv-1/tax-authority/report/');
  assert.equal(new Headers(request?.init.headers).get('x-wafeq-idempotency-key'), uuid);
});

test('409 report_in_progress rereads the invoice, and undocumented states remain unknown', async () => {
  const methods: string[] = [];
  const client = new WafeqClient(apiKey, async (_input, init = {}) => {
    methods.push(String(init.method));
    return methods.length === 1
      ? json({ code: 'report_in_progress', detail: 'do not expose this payload' }, 409)
      : json({ id: 'inv-1', invoice_number: 'W-3', tax_authority: { status: 'VALIDATED' } });
  });
  assert.deepEqual(await client.reportInvoice('inv-1', uuid), {
    id: 'inv-1',
    number: 'W-3',
    status: 'unknown',
    qrCode: null,
  });
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('does not treat accounting status or undocumented report statuses as clearance', async () => {
  const client = new WafeqClient(apiKey, async () =>
    json({ id: 'inv-1', invoice_number: 'W-3', status: 'FINALIZED' }),
  );
  assert.deepEqual((await client.getInvoice('inv-1')).status, 'unknown');
  const unknown = new WafeqClient(apiKey, async () =>
    json({
      status: 'CLEARED',
      reported_ts: '2026-11-14T10:00:00Z',
      metadata: { errors: [], warnings: [] },
    }),
  );
  const result = await unknown.reportInvoice('inv-1', uuid);
  assert.equal(result.status, 'unknown');
  assert.equal(result.taxAuthorityStatus, 'CLEARED');
  assert.equal(result.qrCode, null);
});

test('downloads PDF only from the fixed invoice path with a bounded response', async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const bytes = Buffer.from('%PDF-1.4 synthetic');
  const client = new WafeqClient(apiKey, async (input, init = {}) => {
    request = { url: String(input), init };
    return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  });
  assert.deepEqual(await client.getInvoicePdf('inv-1'), bytes);
  assert.equal(request?.url, 'https://api.wafeq.com/v1/invoices/inv-1/download/');
  assert.equal(new Headers(request?.init.headers).get('accept'), 'application/pdf');
  assert.equal(request?.init.redirect, 'error');
  await assert.rejects(
    () => client.getInvoicePdf('https://attacker.test/file'),
    (error: unknown) => error instanceof WafeqApiError && error.code === 'invalid_invoice_id',
  );
});

test('redacts provider bodies and API key from auth/rate-limit errors and rejects malformed UUID keys', async () => {
  const client = new WafeqClient(apiKey, async (_input, init = {}) => {
    assert.equal(String(new Headers(init.headers).get('authorization')).includes(apiKey), true);
    return json(
      { code: 'permission_denied', detail: apiKey, url: 'https://private.example/path' },
      401,
    );
  });
  await assert.rejects(
    () => client.getOrganization(),
    (error: unknown) => {
      assert.ok(error instanceof WafeqApiError);
      assert.equal(error.code, 'permission_denied');
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(apiKey), false);
      assert.equal(error.message.includes('private.example'), false);
      return true;
    },
  );
  const limited = new WafeqClient(apiKey, async () => json({ message: 'rate limited' }, 429));
  await assert.rejects(
    () => limited.getOrganization(),
    (error: unknown) => error instanceof WafeqApiError && error.code === 'rate_limited',
  );
  await assert.rejects(
    () => limited.createCustomer(customer, 'cust', 'not-a-uuid'),
    (error: unknown) => error instanceof WafeqApiError && error.code === 'invalid_idempotency_key',
  );
});

test('translates request timeouts without leaking fetch exception details', async () => {
  const client = new WafeqClient(
    apiKey,
    async (_input, init = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error(`secret ${apiKey}`)), {
          once: true,
        });
      }),
  );
  await assert.rejects(
    () => client.getOrganization(),
    (error: unknown) => {
      assert.ok(error instanceof WafeqApiError);
      assert.equal(error.code, 'timeout');
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );
});
