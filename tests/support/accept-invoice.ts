/** Marks a finance invoice tax-accepted without calling Wafeq. For tests only. */
import { encryptSensitive } from '../../server/administration/security.js';
import type { AsyncDb } from '../../server/database.js';
import { safeJson, type InvoiceRow } from '../../server/finance/routes.js';
import type { FinanceInvoice } from '../../shared/finance.js';

export async function acceptFinanceInvoice(
  db: AsyncDb,
  invoiceId: string,
): Promise<FinanceInvoice> {
  const row = (
    await db.read<InvoiceRow>('SELECT * FROM finance_invoices WHERE id=?', [invoiceId])
  )[0];
  if (!row) throw new Error(`invoice not found: ${invoiceId}`);
  const invoice = safeJson<FinanceInvoice>(row.invoice_ciphertext, `finance:invoice:${row.id}`);
  const next: FinanceInvoice = {
    ...invoice,
    version: invoice.version + 1,
    status: 'cleared',
    zatcaStatus: 'cleared',
  };
  const result = await db.execute(
    'UPDATE finance_invoices SET number=?,version=?,invoice_ciphertext=? WHERE id=? AND version=?',
    [
      next.number,
      next.version,
      encryptSensitive(JSON.stringify(next), `finance:invoice:${next.id}`),
      invoiceId,
      invoice.version,
    ],
  );
  if (result.rowCount !== 1) throw new Error('failed to accept invoice');
  return next;
}
