import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { registerFinance } from '../../server/finance/routes.js';
import { WafeqClient } from '../../server/integrations/wafeq.js';
import { createDatabase, type AsyncDb } from '../../server/database.js';
import { syntheticTlv, syntheticUbl, syntheticWafeqPdf } from '../support/zatca-pdf.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/wafeq/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

/**
 * Wafeq at the HTTP level with the response shapes seen on 2026-11-16: the invoice read has only
 * the accounting status (SENT), the tax authority verdict comes back from the report action, and
 * a reused idempotency key replays the stored report response (documented for one hour).
 */
function fakeWafeqHttp() {
  const invoices = new Map<string, { externalId: string; number: string }>();
  const reportReplay = new Map<string, unknown>();
  const stats = {
    reportsProcessed: 0,
    reportsReplayed: 0,
    posts: [] as string[],
    gets: [] as string[],
  };
  let loseNextReportReply = false;
  let downloadPdf: (number: string) => Buffer = () =>
    Buffer.from('%PDF-1.7 synthetic official copy');
  let readTaxAuthority: unknown;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\//, '');
    const method = init.method ?? 'GET';
    if (method === 'POST') stats.posts.push(path);
    else stats.gets.push(path);
    if (path === 'organization/') return json({ id: 'org-new', name: { ar: 'الشركة' } });
    if (path === 'contacts/' && method === 'GET')
      return json({ count: 0, next: null, results: [] });
    if (path === 'contacts/' && method === 'POST') return json({ id: 'co_synthetic' }, 201);
    if (path === 'invoices/' && method === 'GET') {
      const externalId = url.searchParams.get('external_id');
      const rows = [...invoices.entries()]
        .filter(([, row]) => row.externalId === externalId)
        .map(([id, row]) => ({
          ...fixture('invoice-retrieve-reported'),
          id,
          external_id: row.externalId,
          invoice_number: row.number,
        }));
      return json({ count: rows.length, next: null, results: rows });
    }
    if (path === 'invoices/' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { external_id: string; invoice_number: string };
      const id = `inv_synthetic_${invoices.size + 1}`;
      invoices.set(id, { externalId: body.external_id, number: body.invoice_number });
      return json(
        {
          ...fixture('invoice-retrieve-reported'),
          id,
          external_id: body.external_id,
          invoice_number: body.invoice_number,
        },
        201,
      );
    }
    const report = /^invoices\/([^/]+)\/tax-authority\/report\/$/.exec(path);
    if (report && method === 'POST') {
      const key = new Headers(init.headers).get('x-wafeq-idempotency-key') ?? '';
      if (reportReplay.has(key)) {
        stats.reportsReplayed++;
        return json(reportReplay.get(key), 200, { 'x-wafeq-idempotent-replayed': 'true' });
      }
      stats.reportsProcessed++;
      const { _source: _ignored, ...reply } = fixture('report-reported');
      reportReplay.set(key, reply);
      if (loseNextReportReply) {
        loseNextReportReply = false;
        throw new TypeError('socket hang up');
      }
      return json(reply);
    }
    const read = /^invoices\/([^/]+)\/$/.exec(path);
    if (read && method === 'GET') {
      const row = invoices.get(read[1]);
      if (!row) return json({ detail: 'Not found.' }, 404);
      return json({
        ...fixture('invoice-retrieve-reported'),
        id: read[1],
        external_id: row.externalId,
        invoice_number: row.number,
        ...(readTaxAuthority === undefined ? {} : { tax_authority: readTaxAuthority }),
      });
    }
    const download = /^invoices\/([^/]+)\/download\/$/.exec(path);
    if (download && method === 'GET')
      return new Response(new Uint8Array(downloadPdf(invoices.get(download[1])?.number ?? '')), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof fetch;
  return {
    fetchImpl,
    stats,
    loseNextReportReply: () => (loseNextReportReply = true),
    setReadTaxAuthority: (value: unknown) => (readTaxAuthority = value),
    setDownloadPdf: (make: (number: string) => Buffer) => (downloadPdf = make),
  };
}

type Invoice = {
  id: string;
  version: number;
  status: string;
  zatcaStatus: string;
  wafeqId: string | null;
  canDownload: boolean;
  qrCode: string | null;
  taxAuthorityStatus?: string;
  taxAuthorityReportedAt?: string;
};

async function harness() {
  const db: AsyncDb = await createDatabase();
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
  const call = async <T>(path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  assert.equal((await call('/api/finance/settings/api-key', { apiKey: 'synthetic' })).status, 200);
  assert.equal(
    (
      await call(
        '/api/finance/settings',
        {
          version: 1,
          seller: {
            name: 'Synthetic Seller',
            vatNumber: '310000000000003',
            commercialRegistration: '',
            address: { line: 'Riyadh', city: 'Riyadh', postalCode: '12345', country: 'SA' },
          },
          revenueAccountId: 'acc_SyntheticRevenue00000',
          standardTaxRateId: 'tax_SyntheticStandard0000',
          zeroTaxRateId: '',
        },
        'PATCH',
      )
    ).status,
    200,
  );
  const customer = (
    await call<{ customer: { id: string; version: number } }>('/api/finance/customers', {
      name: 'Synthetic Customer LLC',
      email: 'billing@example.test',
      vatNumber: '',
      address: { line: 'King Road', city: 'Riyadh', postalCode: '12345', country: 'SA' },
    })
  ).body.customer;
  assert.equal(
    (
      await call(`/api/finance/customers/${customer.id}/sync`, {
        version: customer.version,
      })
    ).status,
    200,
  );
  const issueInvoice = async () => {
    const quote = (
      await call<{ quote: { id: string; version: number } }>('/api/finance/quotes', {
        customerId: customer.id,
        title: 'Synthetic service',
        issueDate: '2026-11-16',
        validUntil: '2026-11-26',
        notes: '',
        lines: [
          {
            description: 'Synthetic service',
            quantity: '1',
            unitPrice: '3000.00',
            taxRateBps: 1500,
            taxReason: '',
          },
        ],
      })
    ).body.quote;
    return (
      await call<{ invoice: Invoice }>(`/api/finance/quotes/${quote.id}/convert`, {
        version: quote.version,
        issueDate: '2026-11-16',
        dueDate: '2026-11-26',
      })
    ).body.invoice;
  };
  const sync = (invoice: Invoice) =>
    call<{ invoice: Invoice; qrNotice?: { code: string } }>(
      `/api/finance/invoices/${invoice.id}/sync`,
      {
        version: invoice.version,
      },
    );
  const refresh = (invoice: Invoice) =>
    call<{ invoice: Invoice; notice?: { code: string }; qrNotice?: { code: string } }>(
      `/api/finance/invoices/${invoice.id}/refresh`,
      {},
    );
  const events = (invoiceId: string) =>
    db.read<{ action: string; details_json: string }>(
      "SELECT action,details_json FROM administration_events WHERE resource_type='finance_invoice' AND resource_id=? ORDER BY created_at,rowid",
      [invoiceId],
    );
  const pdf = async (invoiceId: string) => {
    const response = await fetch(`${base}/api/finance/invoices/${invoiceId}/pdf`);
    return { status: response.status, type: response.headers.get('content-type') };
  };
  const operationState = async (invoiceId: string) =>
    (
      await db.read<{ state: string }>(
        "SELECT state FROM finance_provider_operations WHERE resource_type='invoice' AND resource_id=?",
        [invoiceId],
      )
    )[0]?.state;
  return {
    db,
    wafeq,
    call,
    issueInvoice,
    sync,
    refresh,
    events,
    pdf,
    operationState,
    url: (path: string) => `${base}${path}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.close();
    },
  };
}

test('a REPORTED answer from the report action clears the invoice on sync, with an audit entry', async () => {
  const h = await harness();
  try {
    const invoice = await h.issueInvoice();
    const synced = await h.sync(invoice);
    assert.equal(synced.status, 200);
    assert.equal(synced.body.invoice.status, 'cleared');
    assert.equal(synced.body.invoice.zatcaStatus, 'cleared');
    assert.equal(synced.body.invoice.canDownload, true);
    assert.equal(synced.body.invoice.qrCode, null);
    assert.equal(synced.body.invoice.taxAuthorityStatus, 'REPORTED');
    assert.equal(synced.body.invoice.taxAuthorityReportedAt, '2026-11-16T08:06:38Z');
    assert.equal(await h.operationState(invoice.id), 'complete');
    const cleared = (await h.events(invoice.id)).find((e) => e.action === 'tax_authority_cleared');
    assert.ok(cleared);
    assert.deepEqual(JSON.parse(cleared.details_json), {
      from: 'draft',
      to: 'cleared',
      source: 'report',
      wafeqStatus: 'REPORTED',
    });
    assert.deepEqual(await h.pdf(invoice.id), { status: 200, type: 'application/pdf' });
  } finally {
    await h.close();
  }
});

test('reconciliation_required: refresh keeps it (the read has no verdict), retry sync replays the report and clears it', async () => {
  const h = await harness();
  try {
    const invoice = await h.issueInvoice();
    h.wafeq.loseNextReportReply();
    const lost = await h.sync(invoice);
    assert.equal(lost.status, 503);
    const stuck = (lost.body as unknown as { invoice: Invoice }).invoice;
    assert.equal(stuck.status, 'reconciliation_required');
    assert.equal(stuck.zatcaStatus, 'unknown');
    assert.equal(await h.operationState(invoice.id), 'reconciliation_required');

    const refreshed = await h.refresh(stuck);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.invoice.status, 'reconciliation_required');
    assert.equal(refreshed.body.invoice.version, stuck.version);
    assert.equal(refreshed.body.notice?.code, 'WAFEQ_TAX_STATUS_NOT_IN_READ');

    const retried = await h.sync(stuck);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.invoice.status, 'cleared');
    assert.equal(retried.body.invoice.canDownload, true);
    assert.equal(h.wafeq.stats.reportsProcessed, 1);
    assert.equal(h.wafeq.stats.reportsReplayed, 1);
    assert.equal(h.wafeq.stats.posts.filter((p) => p === 'invoices/').length, 1);
    assert.equal(await h.operationState(invoice.id), 'complete');
    const audit = (await h.events(invoice.id)).filter((e) => e.action === 'tax_authority_cleared');
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0].details_json), {
      from: 'reconciliation_required',
      to: 'cleared',
      source: 'report',
      wafeqStatus: 'REPORTED',
    });
    assert.deepEqual(await h.pdf(invoice.id), { status: 200, type: 'application/pdf' });
  } finally {
    await h.close();
  }
});

test('refresh clears a reconciliation_required invoice when the read carries a tax_authority verdict', async () => {
  const h = await harness();
  try {
    const invoice = await h.issueInvoice();
    h.wafeq.loseNextReportReply();
    const stuck = ((await h.sync(invoice)).body as unknown as { invoice: Invoice }).invoice;
    assert.equal(stuck.status, 'reconciliation_required');
    assert.equal((await h.pdf(invoice.id)).status, 409);
    h.wafeq.setReadTaxAuthority({
      status: 'REPORTED',
      reported_ts: '2026-11-16T08:06:38Z',
      metadata: { errors: [], warnings: [] },
    });
    const refreshed = await h.refresh(stuck);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.invoice.status, 'cleared');
    assert.equal(refreshed.body.invoice.canDownload, true);
    assert.equal(await h.operationState(invoice.id), 'complete');
    const audit = (await h.events(invoice.id)).filter((e) => e.action === 'tax_authority_cleared');
    assert.deepEqual(JSON.parse(audit[0].details_json), {
      from: 'reconciliation_required',
      to: 'cleared',
      source: 'refresh',
      wafeqStatus: 'REPORTED',
    });
    assert.deepEqual(await h.pdf(invoice.id), { status: 200, type: 'application/pdf' });
    // A later sync is a no-op: nothing is reported twice.
    const again = await h.sync(refreshed.body.invoice);
    assert.equal(again.body.invoice.status, 'cleared');
    assert.equal(h.wafeq.stats.reportsProcessed, 1);
    assert.equal(h.wafeq.stats.reportsReplayed, 0);
  } finally {
    await h.close();
  }
});

test('refresh never regresses a cleared invoice when the read has no verdict, and FAILED rejects', async () => {
  const h = await harness();
  try {
    const invoice = await h.issueInvoice();
    const cleared = (await h.sync(invoice)).body.invoice;
    assert.equal(cleared.status, 'cleared');
    const kept = await h.refresh(cleared);
    assert.equal(kept.body.invoice.status, 'cleared');
    assert.equal(kept.body.invoice.canDownload, true);
    assert.equal(kept.body.invoice.version, cleared.version);

    const second = await h.issueInvoice();
    h.wafeq.loseNextReportReply();
    const lostSecond = await h.sync(second);
    const stuck = (lostSecond.body as unknown as { invoice: Invoice }).invoice;
    h.wafeq.setReadTaxAuthority({ status: 'FAILED', metadata: { errors: [{ code: 'x' }] } });
    const rejected = await h.refresh(stuck);
    assert.equal(rejected.body.invoice.status, 'rejected');
    assert.equal(rejected.body.invoice.zatcaStatus, 'rejected');
    assert.equal(rejected.body.invoice.canDownload, false);
    assert.ok((await h.events(second.id)).some((e) => e.action === 'tax_authority_rejected'));
  } finally {
    await h.close();
  }
});

const officialQr = (values: Partial<{ vat: string; total: string; tax: string }> = {}) =>
  syntheticTlv({ vat: '310000000000003', total: '3450.00', tax: '450.00', ...values });
const officialPdf =
  (qr = officialQr()) =>
  (number: string) =>
    syntheticWafeqPdf(syntheticUbl(number, qr));

test('sync stores the official QR from the ZATCA XML embedded in Wafeq’s PDF, with an audit entry', async () => {
  const h = await harness();
  try {
    h.wafeq.setDownloadPdf(officialPdf());
    const invoice = await h.issueInvoice();
    const synced = await h.sync(invoice);
    assert.equal(synced.body.invoice.status, 'cleared');
    assert.equal(synced.body.invoice.qrCode, officialQr());
    assert.equal(synced.body.qrNotice, undefined);
    const stored = (await h.events(invoice.id)).filter((e) => e.action === 'official_qr_stored');
    assert.equal(stored.length, 1);
    assert.deepEqual(JSON.parse(stored[0].details_json), {
      source: 'wafeq_pdf_embedded_zatca_xml',
    });
    const qr = await fetch(h.url(`/api/finance/invoices/${invoice.id}/qr`));
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg|^<\?xml/);
  } finally {
    await h.close();
  }
});

test('refresh backfills the QR of an already cleared invoice with GETs only: no report, no POST', async () => {
  const h = await harness();
  try {
    const invoice = await h.issueInvoice();
    const synced = await h.sync(invoice);
    assert.equal(synced.body.invoice.status, 'cleared');
    assert.equal(synced.body.invoice.qrCode, null);
    assert.equal(synced.body.qrNotice?.code, 'no_embedded_zatca_xml');
    assert.equal((await fetch(h.url(`/api/finance/invoices/${invoice.id}/qr`))).status, 409);

    h.wafeq.setDownloadPdf(officialPdf());
    const posts = h.wafeq.stats.posts.length;
    const gets = h.wafeq.stats.gets.length;
    const refreshed = await h.refresh(synced.body.invoice);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.invoice.status, 'cleared');
    assert.equal(refreshed.body.invoice.qrCode, officialQr());
    assert.equal(h.wafeq.stats.posts.length, posts, 'refresh never POSTs to Wafeq');
    const seen = h.wafeq.stats.gets.slice(gets);
    assert.ok(seen.some((path) => /^invoices\/[^/]+\/download\/$/.test(path)));
    assert.ok(
      seen.every((path) => path === 'organization/' || /^invoices\/[^/]+\/download\/$/.test(path)),
      `only the PDF download is read: ${seen.join(', ')}`,
    );
    assert.equal(h.wafeq.stats.reportsProcessed, 1);
    assert.ok((await h.events(invoice.id)).some((e) => e.action === 'official_qr_stored'));
    // Once stored, refresh does not touch the QR again.
    const again = await h.refresh(refreshed.body.invoice);
    assert.equal(again.body.invoice.qrCode, officialQr());
    assert.equal(
      (await h.events(invoice.id)).filter((e) => e.action === 'official_qr_stored').length,
      1,
    );
  } finally {
    await h.close();
  }
});

test('a QR that does not match the invoice is refused and nothing is stored', async () => {
  const h = await harness();
  try {
    h.wafeq.setDownloadPdf(officialPdf(officialQr({ total: '3449.00' })));
    const invoice = await h.issueInvoice();
    const synced = await h.sync(invoice);
    assert.equal(synced.body.invoice.status, 'cleared');
    assert.equal(synced.body.invoice.qrCode, null);
    assert.equal(synced.body.qrNotice?.code, 'qr_total_mismatch');
    h.wafeq.setDownloadPdf(officialPdf(officialQr({ vat: '399999999999993' })));
    const refreshed = await h.refresh(synced.body.invoice);
    assert.equal(refreshed.body.invoice.qrCode, null);
    assert.equal(refreshed.body.qrNotice?.code, 'qr_seller_vat_mismatch');
    assert.equal(
      (await h.events(invoice.id)).some((e) => e.action === 'official_qr_stored'),
      false,
    );
  } finally {
    await h.close();
  }
});
