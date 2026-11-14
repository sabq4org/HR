// API PDFs are printed from the same paper components and stylesheet as the in-app preview.
// Synthetic data only. Chromium-backed checks skip when no Chromium is installed (the routes then
// fall back to pdfkit for quotes/invoices and refuse statements with 503).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, type Db } from '../../server/database.js';
import { postInvoice } from '../../server/finance/ledger.js';
import { acceptFinanceInvoice } from '../support/accept-invoice.js';
import {
  generateServiceKey,
  hashServiceKey,
  inAccountantScope,
  parseServiceKeyHashes,
} from '../../server/finance/service-keys.js';
import { chromiumExecutable, closeChromium } from '../../server/finance/chromium-pdf.js';
import {
  DOCUMENT_ORIGIN,
  PREVIEW_PAGE_CSS,
  documentAsset,
  documentStylesheet,
  invoiceHtml,
  quoteHtml,
  statementHtml,
} from '../../server/finance/document-html.js';
import { invoiceQrSrc } from '../../server/finance/qr-image.js';
import { completeSeller, formatIban, type FinanceSeller } from '../../shared/finance.js';
import {
  INTERNAL_COPY_LABEL,
  invoiceStatusKind,
  invoiceStatusText,
  quoteFooterText,
  quoteStatus,
} from '../../src/finance/paper.js';

process.env.HR_DATA_KEY ??= randomBytes(32).toString('base64url');
const OWNER = 'emp-finance-pdf-owner';
const hasChromium = Boolean(chromiumExecutable());
after(() => closeChromium());

const seller: FinanceSeller = {
  name: 'مؤسسة اختبار سبق (وهمية)',
  vatNumber: '300000000000003',
  commercialRegistration: '1010000000',
  address: { line: 'طريق تجريبي 1', city: 'الرياض', postalCode: '12345', country: 'SA' },
  bankAccount: {
    beneficiaryName: 'مستفيد تجريبي (وهمي)',
    bankName: 'بنك تجريبي',
    accountNumber: '0000000000000',
    iban: 'SA6000000000000000001234',
  },
};

async function serve() {
  const db: Db = await createDatabase(':memory:', { seed: false });
  await db.execute(
    `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,join_date,role,color,access_role,employment_status)
     VALUES(?,'PDF-1','حساب اصطناعي','حس','اختبار','اختبار','pdf@example.test','الرياض','2026-01-01','employee','#DCEEFF','finance','active')`,
    [OWNER],
  );
  const key = generateServiceKey();
  const server: Server = createServer(
    createApp(db, {
      dataMode: 'private',
      financeEmployeeId: OWNER,
      financeApiKeyHashes: parseServiceKeyHashes(hashServiceKey(key)),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const headers: Record<string, string> = { 'idempotency-key': randomUUID() };
    if (auth) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    return {
      status: res.status,
      renderer: res.headers.get('x-pdf-renderer'),
      disposition: res.headers.get('content-disposition'),
      bytes: type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : undefined,
      body: type.includes('json') ? ((await res.json()) as any) : undefined,
    };
  };
  // Books with company and bank details, one client, a quote, its invoice posted to the ledger.
  const overview = await call('GET', '/api/finance');
  assert.equal(
    (
      await call('PATCH', '/api/finance/settings', {
        version: overview.body.settings.version,
        seller,
        revenueAccountId: '',
        standardTaxRateId: '',
        zeroTaxRateId: '',
      })
    ).status,
    200,
  );
  const customer = (
    await call('POST', '/api/finance/customers', {
      name: 'عميل اختبار الطباعة (وهمي)',
      email: 'client@example.test',
      vatNumber: '311111111100003',
      address: { line: 'شارع تجريبي', city: 'جدة', postalCode: '21411', country: 'SA' },
    })
  ).body.customer;
  const quote = (
    await call('POST', '/api/finance/quotes', {
      customerId: customer.id,
      documentType: 'standard',
      title: 'حملة اختبار الطباعة',
      issueDate: '2026-07-01',
      validUntil: '2026-07-31',
      notes: 'ملاحظة تجريبية',
      lines: [
        {
          description: 'إعلان بانر رقمي',
          quantity: '2',
          unitPrice: '5000.00',
          taxRateBps: 1500,
          taxReason: '',
        },
      ],
    })
  ).body.quote;
  const invoice = (
    await call('POST', `/api/finance/quotes/${quote.id}/convert`, {
      version: quote.version,
      issueDate: '2026-07-10',
      dueDate: '2026-08-09',
    })
  ).body.invoice;
  assert.equal((await call('POST', '/api/finance/ledger/setup', {})).status, 201);
  const accepted = await acceptFinanceInvoice(db, invoice.id);
  await db.transaction((tx) => postInvoice(tx, { id: OWNER, role: 'hr' }, accepted, '4101'));
  const events = async (action: string) =>
    Number(
      (
        await db.read<{ n: number }>(
          'SELECT COUNT(*) AS n FROM administration_events WHERE action = ?',
          [action],
        )
      )[0]!.n,
    );
  return {
    call,
    db,
    events,
    customer,
    quote,
    invoice,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.close();
    },
  };
}

const pageSize = (pdf: Buffer) => {
  const box = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  assert.ok(box, 'MediaBox');
  return { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) };
};
const pageCount = (pdf: Buffer) =>
  pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;

test('document HTML is the preview paper with the settings seller and bank details', async () => {
  const app = await serve();
  try {
    const full = completeSeller(app.quote.seller, seller);
    const quote = quoteHtml(app.quote, full);
    for (const text of [
      '<html lang="ar" dir="rtl">',
      'fin-document-paper fin-quote-paper',
      app.quote.number,
      'عميل اختبار الطباعة (وهمي)',
      'إعلان بانر رقمي',
      'SA60 0000 0000 0000 0000 1234',
      'بنك تجريبي',
      '/brand/sabq-logo.svg',
      '@page finance-document',
      PREVIEW_PAGE_CSS,
    ])
      assert.ok(quote.includes(text), text);
    const invoice = invoiceHtml(app.invoice, completeSeller(app.invoice.seller, seller));
    assert.ok(invoice.includes('fin-invoice-paper'));
    assert.ok(invoice.includes(app.invoice.number));
    assert.ok(!invoice.includes('/qr'), 'no QR request from the server copy');
    const statement = await app.call('GET', `/api/finance/customers/${app.customer.id}/statement`);
    const html = statementHtml(statement.body.statement);
    assert.ok(html.includes('fin-document-paper fin-statement-paper'));
    assert.ok(html.includes('@page { size: A4 landscape; margin: 10mm 12mm; }'));
    assert.ok(html.includes(app.invoice.number));
  } finally {
    await app.close();
  }
});

test('formatIban groups in blocks of 4 and leaves the stored value untouched', () => {
  assert.equal(formatIban('SA5680000305608010040444'), 'SA56 8000 0305 6080 1004 0444');
  assert.equal(formatIban('SA56 8000 0305 6080 1004 0444'), 'SA56 8000 0305 6080 1004 0444');
  assert.equal(formatIban(' sa5680000305608010040444 '), 'SA56 8000 0305 6080 1004 0444');
});

test('quote HTML follows the real status, groups the IBAN and right-aligns bank values', async () => {
  const app = await serve();
  try {
    const full = completeSeller(app.quote.seller, seller);
    const draft = quoteHtml(app.quote, full);
    assert.equal(app.quote.status, 'draft');
    assert.ok(draft.includes('مسودة عرض سعر'), 'draft badge');
    assert.ok(!draft.includes('تم التحويل إلى مسودة فاتورة'), 'draft is not converted');
    assert.ok(draft.includes('SA60 0000 0000 0000 0000 1234'), 'grouped IBAN');
    assert.ok(!draft.includes('SA6000000000000000001234'), 'ungrouped IBAN stays out of the paper');
    assert.match(
      draft,
      /<dd class="fin-bank-value" dir="ltr">\s*SA60 0000 0000 0000 0000 1234\s*<\/dd>/,
    );
    assert.match(draft, /<dd class="fin-bank-value" dir="ltr">\s*0000000000000\s*<\/dd>/);

    const converted = quoteHtml({ ...app.quote, status: 'converted' }, full);
    assert.ok(converted.includes('تم التحويل إلى مسودة فاتورة'), 'converted badge');
    assert.ok(!converted.includes('مسودة عرض سعر'), 'converted is not a draft badge');

    const invoice = invoiceHtml(app.invoice, completeSeller(app.invoice.seller, seller));
    assert.equal(app.invoice.status, 'draft');
    assert.ok(invoice.includes('مسودة فاتورة'), 'draft invoice badge stays');

    const css = documentStylesheet();
    assert.match(
      css,
      /\.fin-bank-card dd\.fin-bank-value\s*\{[^}]*text-align:\s*right/,
      'bank values right-aligned under their labels',
    );
    assert.match(css, /\.fin-bank-card dd\.fin-bank-value\s*\{[^}]*unicode-bidi:\s*isolate/);
    assert.match(css, /\.fin-bank-card dd\.fin-bank-value\s*\{[^}]*direction:\s*ltr/);
  } finally {
    await app.close();
  }
});

test('invoice and linked quote only show issued green badges after confirmed acceptance', async () => {
  const app = await serve();
  try {
    const quote = { ...app.quote, status: 'converted' as const, invoiceId: app.invoice.id };
    assert.deepEqual(quoteStatus(quote, app.invoice), {
      text: 'تم التحويل إلى مسودة فاتورة',
      kind: 'waiting',
    });
    assert.equal(quoteStatus(quote).kind, 'waiting', 'missing invoice does not imply issuance');
    for (const status of ['syncing', 'pending', 'rejected', 'reconciliation_required'] as const) {
      const invoice = { ...app.invoice, status, wafeqId: 'synthetic-provider-id' };
      assert.notEqual(invoiceStatusKind(status), 'good', status);
      assert.notEqual(quoteStatus(quote, invoice).kind, 'good', status);
      assert.ok(!invoiceStatusText(invoice).includes('صادرة'), status);
      assert.notEqual(quoteStatus(quote, invoice).text, 'تم إصدار الفاتورة', status);
    }
    for (const status of ['cleared', 'reported'] as const) {
      const invoice = { ...app.invoice, status };
      assert.equal(invoiceStatusText(invoice), 'فاتورة ضريبية صادرة');
      assert.equal(invoiceStatusKind(status), 'good');
      assert.deepEqual(quoteStatus(quote, invoice), { text: 'تم إصدار الفاتورة', kind: 'good' });
      assert.equal(
        invoiceStatusText({ ...invoice, documentType: 'out_of_scope' }),
        'فاتورة صادرة',
        'non-tax invoice is not labelled as a tax invoice',
      );
    }
  } finally {
    await app.close();
  }
});

test('converted quote footer follows the real status', async () => {
  const app = await serve();
  try {
    const full = completeSeller(app.quote.seller, seller);
    const draft = quoteHtml(app.quote, full);
    assert.ok(draft.includes(quoteFooterText.draft));
    assert.ok(!draft.includes(quoteFooterText.converted));
    const converted = quoteHtml({ ...app.quote, status: 'converted' }, full);
    assert.ok(converted.includes(quoteFooterText.converted));
    assert.ok(!converted.includes('عرض سعر محفوظ كمسودة'));
  } finally {
    await app.close();
  }
});

test('cleared invoice HTML shows the stored QR and an internal-copy label', async () => {
  const app = await serve();
  try {
    const full = completeSeller(app.invoice.seller, seller);
    const payload = 'SA-TEST-QR-PAYLOAD-001';
    const cleared = invoiceHtml(
      { ...app.invoice, status: 'cleared', zatcaStatus: 'cleared', qrCode: payload },
      full,
    );
    const qrSrc = invoiceQrSrc(payload);
    assert.ok(qrSrc, 'QR data URL');
    assert.ok(cleared.includes('class="fin-qr"'), 'QR image is present');
    assert.ok(cleared.includes(qrSrc), 'QR encodes the stored payload');
    assert.ok(cleared.includes(INTERNAL_COPY_LABEL));
    assert.ok(cleared.includes('نسخة داخلية – ليست الفاتورة الضريبية الرسمية'));
    assert.ok(
      !cleared.includes('فاتورة سبق متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك.'),
      'API copy must not claim ZATCA compliance',
    );
    assert.ok(!cleared.includes('/api/finance/invoices/') && !cleared.includes('"/qr"'));

    const draft = invoiceHtml(app.invoice, full);
    assert.equal(app.invoice.status, 'draft');
    assert.ok(draft.includes('هذه معاينة داخلية للمسودة وليست فاتورة صادرة أو مستندًا ضريبيًا.'));
    assert.ok(draft.includes(INTERNAL_COPY_LABEL));
    assert.ok(draft.includes('مسودة فاتورة · للمعاينة الداخلية فقط'));
    assert.ok(!draft.includes('class="fin-qr"'));
    assert.ok(!draft.includes('فاتورة سبق متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك.'));

    const acceptedNoQr = invoiceHtml(
      { ...app.invoice, status: 'cleared', zatcaStatus: 'cleared', qrCode: null },
      full,
    );
    assert.ok(acceptedNoQr.includes(INTERNAL_COPY_LABEL));
    assert.ok(!acceptedNoQr.includes('class="fin-qr"'));
    assert.ok(
      !acceptedNoQr.includes('فاتورة سبق متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك.'),
    );
  } finally {
    await app.close();
  }
});

test('the preview page box copied by the server still matches the app stylesheet', () => {
  // The in-app print uses the last unnamed @page rule in the bundle (payroll.css). Keep in sync.
  const payroll = readFileSync(new URL('../../src/payroll/payroll.css', import.meta.url), 'utf8');
  assert.match(payroll, /@page\s*{\s*size:\s*A4 portrait;\s*margin:\s*18mm;\s*}/);
  assert.match(PREVIEW_PAGE_CSS, /size: A4 portrait; margin: 18mm;/);
});

test('the document page may only load the app fonts and logo from disk', () => {
  assert.match(
    String(documentAsset(`${DOCUMENT_ORIGIN}/brand/sabq-logo.svg`)),
    /public\/brand\/sabq-logo\.svg$/,
  );
  assert.match(
    String(
      documentAsset(`${DOCUMENT_ORIGIN}/fontsource/ibm-plex-sans-arabic-arabic-400-normal.woff2`),
    ),
    /@fontsource\/ibm-plex-sans-arabic\/files\/ibm-plex-sans-arabic-arabic-400-normal\.woff2$/,
  );
  for (const url of [
    'https://example.com/brand/sabq-logo.svg',
    `${DOCUMENT_ORIGIN}/brand/../../.env`,
    `${DOCUMENT_ORIGIN}/brand/%2e%2e/%2e%2e/package.json`,
    `${DOCUMENT_ORIGIN}/fonts/../server/index.ts`,
    `${DOCUMENT_ORIGIN}/api/finance`,
    `${DOCUMENT_ORIGIN}/brand/logo.png`,
    `${DOCUMENT_ORIGIN}/.data/hr.sqlite`,
  ])
    assert.equal(documentAsset(url), null, url);
});

test('statement PDFs are inside the accountant key scope', () => {
  assert.ok(inAccountantScope('GET', '/api/finance/customers/x/statement.pdf'));
  assert.ok(inAccountantScope('GET', '/api/finance/quotes/x/document.pdf'));
  assert.ok(inAccountantScope('GET', '/api/finance/invoices/x/document.pdf'));
});

test(
  'the accountant key gets quote, invoice and statement PDFs printed by Chromium',
  { skip: !hasChromium && 'no Chromium on this machine' },
  async () => {
    const app = await serve();
    try {
      const quote = await app.call('GET', `/api/finance/quotes/${app.quote.id}/document.pdf`);
      assert.equal(quote.status, 200);
      assert.equal(quote.renderer, 'chromium');
      assert.equal(quote.bytes!.subarray(0, 5).toString(), '%PDF-');
      assert.deepEqual(pageSize(quote.bytes!), { width: 595, height: 842 });
      assert.equal(pageCount(quote.bytes!), 1);

      const invoice = await app.call('GET', `/api/finance/invoices/${app.invoice.id}/document.pdf`);
      assert.equal(invoice.status, 200);
      assert.equal(invoice.renderer, 'chromium');
      assert.deepEqual(pageSize(invoice.bytes!), { width: 595, height: 842 });
      assert.match(String(invoice.disposition), /-internal\.pdf"$/);

      const path = `/api/finance/customers/${app.customer.id}/statement.pdf`;
      const statement = await app.call('GET', `${path}?from=2026-07-01&to=2026-07-31`);
      assert.equal(statement.status, 200);
      assert.equal(statement.renderer, 'chromium');
      assert.deepEqual(pageSize(statement.bytes!), { width: 842, height: 595 });
      assert.match(String(statement.disposition), /statement-2026-07-31\.pdf"$/);
      assert.equal(await app.events('statement_pdf_exported'), 1);
      // `to` defaults to today, like the preview.
      assert.equal((await app.call('GET', path)).status, 200);
    } finally {
      await app.close();
    }
  },
);

test('statement PDF keeps the JSON route rules: auth, unknown client and date range', async () => {
  const app = await serve();
  try {
    const path = `/api/finance/customers/${app.customer.id}/statement.pdf`;
    assert.equal((await app.call('GET', path, undefined, false)).status, 401);
    const range = await app.call('GET', `${path}?from=2026-08-01&to=2026-07-01`);
    assert.equal(range.status, 400);
    assert.equal(range.body.error.code, 'INVALID_DATE_RANGE');
    assert.equal(
      (await app.call('GET', '/api/finance/customers/missing/statement.pdf')).status,
      404,
    );
    assert.equal(await app.events('statement_pdf_exported'), 0);
  } finally {
    await app.close();
  }
});

test('without Chromium quotes and invoices fall back to pdfkit and statements answer 503', async () => {
  const saved = process.env.HR_PDF_CHROMIUM_PATH;
  process.env.HR_PDF_CHROMIUM_PATH = '/nonexistent/chromium';
  const app = await serve();
  try {
    const quote = await app.call('GET', `/api/finance/quotes/${app.quote.id}/document.pdf`);
    assert.equal(quote.status, 200);
    assert.equal(quote.renderer, 'pdfkit');
    assert.equal(quote.bytes!.subarray(0, 5).toString(), '%PDF-');
    const invoice = await app.call('GET', `/api/finance/invoices/${app.invoice.id}/document.pdf`);
    assert.equal(invoice.renderer, 'pdfkit');
    const statement = await app.call(
      'GET',
      `/api/finance/customers/${app.customer.id}/statement.pdf`,
    );
    assert.equal(statement.status, 503);
    assert.equal(statement.body.error.code, 'PDF_RENDERER_UNAVAILABLE');
    assert.equal(await app.events('statement_pdf_exported'), 0);
  } finally {
    if (saved === undefined) delete process.env.HR_PDF_CHROMIUM_PATH;
    else process.env.HR_PDF_CHROMIUM_PATH = saved;
    await app.close();
  }
});
