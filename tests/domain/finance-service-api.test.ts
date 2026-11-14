// Accountant service key: finance-only machine access, hashed keys, server PDFs. Synthetic data.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, type Db } from '../../server/database.js';
import {
  generateServiceKey,
  hashServiceKey,
  inAccountantScope,
  matchesServiceKey,
  parseServiceKeyHashes,
} from '../../server/finance/service-keys.js';
import { visualRuns } from '../../server/finance/pdf.js';
import { closeChromium } from '../../server/finance/chromium-pdf.js';

process.env.HR_DATA_KEY ??= randomBytes(32).toString('base64url');
const OWNER = 'emp-finance-key-owner';
const OTHER = 'emp-hr-key-other';
after(() => closeChromium());

async function seed(): Promise<Db> {
  const db = await createDatabase(':memory:', { seed: false });
  for (const [id, number, role] of [
    [OWNER, 'KEY-1', 'finance'],
    [OTHER, 'KEY-2', 'hr'],
  ])
    await db.execute(
      `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,join_date,role,color,access_role,employment_status)
       VALUES(?,?,'حساب اصطناعي','حس','اختبار','اختبار',?,'الرياض','2026-01-01','employee','#DCEEFF',?,'active')`,
      [id, number, `${id}@example.test`, role],
    );
  return db;
}

async function serve(db: Db, options: Parameters<typeof createApp>[1]) {
  const server: Server = createServer(createApp(db, options));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (key: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'idempotency-key': randomUUID() };
    if (key !== null) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    return {
      status: res.status,
      type,
      bytes: type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : undefined,
      body: type.includes('json') ? ((await res.json()) as any) : undefined,
    };
  };
  return { base, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('service keys are random, stored only as digests, and compared in constant time', () => {
  const key = generateServiceKey();
  assert.match(key, /^sabqfin_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(key, generateServiceKey());
  const digest = hashServiceKey(key);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!digest.includes(key.slice(8)));
  const parsed = parseServiceKeyHashes(`${digest}, ${hashServiceKey(generateServiceKey())}`);
  assert.equal(parsed.length, 2);
  assert.ok(matchesServiceKey(key, parsed));
  assert.ok(!matchesServiceKey(generateServiceKey(), parsed));
  assert.ok(!matchesServiceKey('not-a-key', parsed));
  assert.throws(() => parseServiceKeyHashes('plaintext-key'));
  assert.deepEqual(parseServiceKeyHashes(''), []);
});

test('accountant scope covers finance only, without the provider credential', () => {
  assert.ok(inAccountantScope('GET', '/api/finance'));
  assert.ok(inAccountantScope('POST', '/api/finance/ledger/expenses'));
  assert.ok(inAccountantScope('GET', '/api/finance/ledger/vat'));
  for (const path of [
    '/api/admin/employees',
    '/api/admin/payroll',
    '/api/admin/audit',
    '/api/session',
    '/api/demo/session',
    '/api/access',
    '/api/bootstrap',
    '/api/financeX',
    '/api/finance/settings/api-key',
    '/api/finance/settings/test',
  ])
    assert.ok(!inAccountantScope('GET', path), path);
  assert.ok(!inAccountantScope('DELETE', '/api/finance/customers/x'));
});

test('bidi runs keep Arabic words, numbers and brackets in visual order', () => {
  const runs = visualRuns('شركة (وهمية) 2026');
  assert.deepEqual(
    runs.filter((r) => !r.space).map((r) => r.text),
    ['2026', '(', 'وهمية', ')', 'شركة'],
  );
});

test('an accountant key runs the whole finance cycle and is refused everywhere else', async () => {
  const db = await seed();
  const key = generateServiceKey();
  const app = await serve(db, {
    dataMode: 'private',
    financeEmployeeId: OWNER,
    financeApiKeyHashes: parseServiceKeyHashes(hashServiceKey(key)),
  });
  try {
    // Authentication
    assert.equal((await app.call(null, 'GET', '/api/finance')).status, 401);
    const wrong = await app.call(generateServiceKey(), 'GET', '/api/finance');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_API_KEY');
    assert.equal((await app.call('', 'GET', '/api/finance')).status, 401);

    // Scope: user management, payroll, sessions, documents, audit and provider key are 403.
    const denied: [string, string, unknown?][] = [
      ['GET', `/api/admin/employees/${OWNER}`],
      ['POST', '/api/admin/employees', { values: {} }],
      ['PATCH', `/api/admin/employees/${OTHER}`, { version: 1, values: {}, reason: 'x' }],
      ['GET', '/api/admin/payroll'],
      ['POST', '/api/admin/payroll', {}],
      ['GET', '/api/admin/payroll/sources'],
      ['GET', '/api/admin/documents'],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/bootstrap'],
      ['GET', '/api/session'],
      ['POST', '/api/demo/session', { employeeId: OTHER }],
      ['POST', '/api/finance/settings/api-key', { apiKey: 'x' }],
    ];
    for (const [method, path, body] of denied) {
      const res = await app.call(key, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.error.code, 'API_KEY_SCOPE', `${method} ${path}`);
    }

    // Clients
    const address = { line: 'شارع تجريبي', city: 'الرياض', postalCode: '12345', country: 'SA' };
    const customer = await app.call(key, 'POST', '/api/finance/customers', {
      name: 'عميل اصطناعي',
      email: 'client@example.test',
      vatNumber: '311111111100003',
      address,
    });
    assert.equal(customer.status, 201);
    const edited = await app.call(
      key,
      'PATCH',
      `/api/finance/customers/${customer.body.customer.id}`,
      {
        version: customer.body.customer.version,
        name: 'عميل اصطناعي معدل',
        email: 'client@example.test',
        vatNumber: '311111111100003',
        address,
      },
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body.customer.name, 'عميل اصطناعي معدل');

    // Price items
    const item = await app.call(key, 'POST', '/api/finance/catalog', {
      description: 'إعلان رقمي',
      unitPrice: '10000.00',
      taxRateBps: 1500,
      taxReason: '',
    });
    assert.equal(item.status, 201);

    // Quote, PDF, invoice, PDF
    const quote = await app.call(key, 'POST', '/api/finance/quotes', {
      customerId: customer.body.customer.id,
      documentType: 'standard',
      title: 'حملة اصطناعية',
      issueDate: '2026-07-01',
      validUntil: '2026-07-31',
      notes: '',
      lines: [
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
    assert.equal(quote.body.quote.totalHalalas, 1_150_000);
    const quotePdf = await app.call(
      key,
      'GET',
      `/api/finance/quotes/${quote.body.quote.id}/document.pdf`,
    );
    assert.equal(quotePdf.status, 200);
    assert.equal(quotePdf.bytes!.subarray(0, 5).toString(), '%PDF-');
    assert.ok(quotePdf.bytes!.length > 5000);
    const invoice = await app.call(
      key,
      'POST',
      `/api/finance/quotes/${quote.body.quote.id}/convert`,
      {
        version: quote.body.quote.version,
        issueDate: '2026-07-10',
        dueDate: '2026-08-09',
      },
    );
    assert.equal(invoice.status, 201);
    const invoiceId = invoice.body.invoice.id;
    const invoicePdf = await app.call(
      key,
      'GET',
      `/api/finance/invoices/${invoiceId}/document.pdf`,
    );
    assert.equal(invoicePdf.status, 200);
    assert.equal(invoicePdf.bytes!.subarray(0, 5).toString(), '%PDF-');
    // The official provider artifact is still refused before acceptance.
    assert.equal(
      (await app.call(key, 'GET', `/api/finance/invoices/${invoiceId}/pdf`)).status,
      409,
    );
    assert.equal(
      (await app.call(key, 'GET', '/api/finance/quotes/missing/document.pdf')).status,
      404,
    );

    // Ledger: post the invoice, mark it paid, revenue, expense
    assert.equal((await app.call(key, 'POST', '/api/finance/ledger/setup', {})).status, 201);
    const posted = await app.call(key, 'POST', `/api/finance/ledger/invoices/${invoiceId}/post`, {
      revenueAccountCode: '4101',
    });
    assert.equal(posted.status, 201);
    const paid = await app.call(key, 'POST', `/api/finance/ledger/invoices/${invoiceId}/receipts`, {
      date: '2026-07-20',
      amount: '11500.00',
      cashAccountCode: '1102',
      reference: 'حوالة',
    });
    assert.equal(paid.status, 201);
    const vouchers = await app.call(key, 'GET', '/api/finance/ledger/vouchers?kind=invoice');
    assert.equal(vouchers.body.vouchers[0].outstandingHalalas, 0);
    assert.equal(
      (
        await app.call(key, 'POST', '/api/finance/ledger/revenues', {
          date: '2026-07-12',
          description: 'إيراد اصطناعي',
          accountCode: '4101',
          taxCode: 'S',
          net: '1000.00',
          cashAccountCode: '1102',
          reference: 'INV-X',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await app.call(key, 'POST', '/api/finance/ledger/expenses', {
          date: '2026-07-15',
          description: 'مصروف اصطناعي',
          accountCode: '5302',
          taxCode: 'S',
          net: '1000.00',
          cashAccountCode: '1102',
          reference: 'SUP-1',
        })
      ).status,
      201,
    );

    // Reports
    const journal = await app.call(key, 'GET', '/api/finance/ledger/entries');
    assert.equal(journal.status, 200);
    for (const entry of journal.body.entries) {
      const debit = entry.lines.reduce((s: number, l: any) => s + l.debitHalalas, 0);
      const credit = entry.lines.reduce((s: number, l: any) => s + l.creditHalalas, 0);
      assert.equal(debit, credit, 'every entry balances');
    }
    for (const path of [
      '/api/finance/ledger/reports/account/1102?from=2026-01-01&to=2026-12-31',
      '/api/finance/ledger/reports/trial-balance?from=2026-01-01&to=2026-12-31',
      '/api/finance/ledger/reports/budget?year=2026',
    ])
      assert.equal((await app.call(key, 'GET', path)).status, 200, path);
    const sheet = await app.call(
      key,
      'GET',
      '/api/finance/ledger/reports/balance-sheet?asOf=2026-12-31',
    );
    assert.equal(sheet.status, 200);
    assert.equal(sheet.body.balanced, true);
    const vat = await app.call(key, 'GET', '/api/finance/ledger/vat?start=2026-07-01');
    assert.equal(vat.status, 200);
    assert.equal(vat.body.computation.outputVatHalalas, 150_000 + 15_000);
    assert.equal(vat.body.computation.inputVatHalalas, 15_000);
  } finally {
    await app.close();
    await db.close();
  }
});

test('service keys are disabled outside private finance or without a granted account', async () => {
  const db = await seed();
  const key = generateServiceKey();
  const synthetic = await serve(db, { financeApiKeyHashes: [hashServiceKey(key)] });
  try {
    const res = await synthetic.call(key, 'GET', '/api/finance');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'API_KEY_DISABLED');
  } finally {
    await synthetic.close();
  }
  const noOwner = await serve(db, {
    dataMode: 'private',
    financeApiKeyHashes: [hashServiceKey(key)],
  });
  try {
    assert.equal(
      (await noOwner.call(key, 'GET', '/api/finance')).body.error.code,
      'API_KEY_DISABLED',
    );
  } finally {
    await noOwner.close();
    await db.close();
  }
});
