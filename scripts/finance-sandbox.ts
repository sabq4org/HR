/**
 * Local finance sandbox for the accountant API: private-mode app on loopback with a SQLite
 * file, a synthetic finance account, fake clients and price items, and an offline stand-in for
 * the e-invoicing provider (no network, nothing is reported to any authority).
 *
 *   HR_FINANCE_API_KEY_HASHES=sha256:... npm run finance:sandbox
 *
 * Env: HR_FINANCE_SANDBOX_PORT (default 4320), HR_FINANCE_SANDBOX_DB
 * (default .data/finance-sandbox.sqlite). Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/database.js';
import type { WafeqClientLike, WafeqInvoiceResult } from '../server/integrations/wafeq.js';
import {
  generateServiceKey,
  hashServiceKey,
  parseServiceKeyHashes,
} from '../server/finance/service-keys.js';

if (process.env.NODE_ENV === 'production' || process.env.HR_MODE)
  throw new Error('The finance sandbox is local and synthetic only.');
const hashes = parseServiceKeyHashes(process.env.HR_FINANCE_API_KEY_HASHES);
if (!hashes.length) throw new Error('Set HR_FINANCE_API_KEY_HASHES (npm run finance:key).');
const port = Number(process.env.HR_FINANCE_SANDBOX_PORT ?? 4320);
const dbPath = resolve(process.env.HR_FINANCE_SANDBOX_DB ?? '.data/finance-sandbox.sqlite');
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const OWNER = 'emp-finance-sandbox';

const db = await createDatabase(dbPath, { seed: false });
await db.execute(
  `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,join_date,role,color,access_role,employment_status)
   VALUES(?,?,?,'مح','محاسب اصطناعي','المالية','accountant@example.test','الرياض','2026-01-01','employee','#DCEEFF','finance','active')
   ON CONFLICT(id) DO NOTHING`,
  [OWNER, 'SANDBOX-FIN-1', 'حساب المحاسب التجريبي'],
);

// Offline provider stand-in: never contacts Wafeq, never returns an official QR.
const invoices = new Map<string, WafeqInvoiceResult>();
const provider: WafeqClientLike = {
  getOrganization: async () => ({ id: 'org-sandbox', name: 'منشأة تجريبية (وهمية)' }),
  createCustomer: async () => ({ id: `con_${randomUUID()}` }),
  getCustomer: async (id) => ({ id }),
  findCustomerByExternalId: async () => null,
  createInvoice: async (invoice) => {
    const result: WafeqInvoiceResult = {
      id: `inv_${randomUUID()}`,
      number: invoice.number,
      status: 'unknown',
      qrCode: null,
    };
    invoices.set(result.id, result);
    return result;
  },
  findInvoiceByExternalId: async () => null,
  getInvoice: async (id) => invoices.get(id) ?? { id, status: 'unknown', qrCode: null },
  reportInvoice: async (id) => invoices.get(id) ?? { id, status: 'unknown', qrCode: null },
  getInvoicePdf: async () => {
    throw new Error('The sandbox has no official provider PDF.');
  },
};

// A one-time in-process key seeds the books through the same API, then is withdrawn.
const seedKey = generateServiceKey();
const liveHashes: string[] = [...hashes, hashServiceKey(seedKey).slice(7)];
const app = createApp(db, {
  dataMode: 'private',
  financeEmployeeId: OWNER,
  financeApiKeyHashes: liveHashes,
  financeClientFactory: () => provider,
});
// After `npm run build`, the sandbox also serves the app so the finance UI (and its print
// preview) can be compared with the API output. Sign in as the synthetic finance persona.
const client = resolve('dist/client');
if (existsSync(resolve(client, 'index.html'))) {
  app.use(express.static(client, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: client }));
}
const server = createServer(app);
await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
const base = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${seedKey}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, any>;
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
};
try {
  const overview = await call('GET', '/api/finance');
  if (!overview.settings.seller?.name) {
    await call('PATCH', '/api/finance/settings', {
      version: overview.settings.version,
      seller: {
        name: 'مؤسسة سبق التجريبية (بيانات وهمية)',
        vatNumber: '300000000000003',
        commercialRegistration: '1010000000',
        address: { line: 'طريق تجريبي 1', city: 'الرياض', postalCode: '12345', country: 'SA' },
        bankAccount: {
          beneficiaryName: 'مؤسسة سبق التجريبية (بيانات وهمية)',
          bankName: 'بنك تجريبي',
          accountNumber: '0000000000000',
          iban: 'SA6000000000000000001234',
        },
      },
      revenueAccountId: '',
      standardTaxRateId: '',
      zeroTaxRateId: '',
    });
  }
  if (!(await call('GET', '/api/finance/ledger')).initialized)
    await call('POST', '/api/finance/ledger/setup', {});
  if (!overview.customers.length)
    for (const [name, email, vat] of [
      ['شركة المثال للإعلان (وهمية)', 'billing@example.test', '311111111100003'],
      ['مؤسسة النموذج الإعلامية (وهمية)', 'accounts@example.test', ''],
    ])
      await call('POST', '/api/finance/customers', {
        name,
        email,
        vatNumber: vat,
        address: { line: 'شارع تجريبي', city: 'الرياض', postalCode: '11564', country: 'SA' },
      });
  if (!overview.catalog.length)
    for (const [description, unitPrice] of [
      ['إعلان بانر رقمي — أسبوع', '5000.00'],
      ['مقال برعاية', '8000.00'],
    ])
      await call('POST', '/api/finance/catalog', {
        description,
        unitPrice,
        taxRateBps: 1500,
        taxReason: '',
      });
} finally {
  liveHashes.pop();
}
process.stdout.write(`Sabq HR finance sandbox (synthetic) on ${base}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => void db.close().then(() => process.exit(0))));
