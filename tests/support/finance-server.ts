/** Loopback-only, in-memory fixture. Never loads .env or uses a real Wafeq account. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from '../../server/app.js';
import { createDatabase } from '../../server/database.js';
import type { WafeqClientLike, WafeqInvoiceResult } from '../../server/integrations/wafeq.js';

process.env.HR_DATA_KEY = randomBytes(32).toString('base64url');
const db = await createDatabase(':memory:', { seed: false });
for (const [id, number, name, email] of [
  ['emp-finance-owner', 'TEST-FIN-1', 'مسؤول الفوترة التجريبي', 'finance-owner@example.test'],
  ['emp-finance-other', 'TEST-FIN-2', 'مسؤول آخر', 'finance-other@example.test'],
]) {
  await db.execute(
    `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,join_date,role,color,access_role,employment_status)
     VALUES(?,?,?,'تج','اختبار اصطناعي','اختبار',?,'الرياض','2026-01-01','hr','#DCEEFF','hr','active')`,
    [id, number, name, email],
  );
}
const contacts = new Map<string, { id: string }>();
const invoices = new Map<string, WafeqInvoiceResult>();
const byExternal = new Map<string, string>();
const provider: WafeqClientLike = {
  async getOrganization() {
    return { id: 'org-synthetic', name: 'منشأة الاختبار الاصطناعية' };
  },
  async createCustomer(_input, externalId) {
    const contact = contacts.get(externalId) ?? { id: `con_${randomUUID()}` };
    contacts.set(externalId, contact);
    return contact;
  },
  async getCustomer(id) {
    return { id };
  },
  async findCustomerByExternalId(externalId) {
    return contacts.get(externalId) ?? null;
  },
  async createInvoice(invoice) {
    const id = `inv_${randomUUID()}`;
    const result: WafeqInvoiceResult = {
      id,
      number: invoice.number,
      status: 'unknown',
      qrCode: null,
    };
    invoices.set(id, result);
    byExternal.set(invoice.id, id);
    return result;
  },
  async findInvoiceByExternalId(externalId) {
    const id = byExternal.get(externalId);
    return id ? invoices.get(id)! : null;
  },
  async getInvoice(id) {
    const prior = invoices.get(id);
    if (!prior) throw new Error('Unknown synthetic invoice');
    // Deliberately no QR: acceptance alone must not unlock a branded tax print.
    const result: WafeqInvoiceResult = { ...prior, status: 'cleared', qrCode: null };
    invoices.set(id, result);
    return result;
  },
  async reportInvoice(id) {
    const prior = invoices.get(id);
    if (!prior) throw new Error('Unknown synthetic invoice');
    const result: WafeqInvoiceResult = { ...prior, status: 'pending', qrCode: null };
    invoices.set(id, result);
    return result;
  },
  async getInvoicePdf() {
    return Buffer.from('%PDF-1.4\n% Synthetic test artifact only\n%%EOF\n');
  },
};
const app = createApp(db, {
  dataMode: 'private',
  financeEmployeeId: 'emp-finance-owner',
  financeClientFactory: () => provider,
});
const clientDirectory = fileURLToPath(new URL('../../dist/client', import.meta.url));
app.use(express.static(clientDirectory, { index: false }));
app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: clientDirectory }));
const server = createServer(app);
server.listen(4319, '127.0.0.1', () => {
  process.stdout.write('Synthetic private finance fixture listening on 127.0.0.1:4319\n');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => void db.close().then(() => process.exit(0))));
}
