import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** Synthetic data only: the fixture server is in-memory and never reaches a real provider. */
const headers = () => ({ 'Idempotency-Key': randomUUID(), Origin: 'http://127.0.0.1:4319' });
async function post<T>(page: Page, path: string, body: unknown, allowFailure = false) {
  const response = await page.request.post(`/api/finance${path}`, {
    data: body,
    headers: headers(),
  });
  if (!allowFailure) expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}
const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' })
  .format(new Date())
  .slice(0, 4);

test('customer statement: invoices, payments and balance due on landscape A4', async ({
  page,
}, testInfo) => {
  const desktop = testInfo.project.name === 'chromium';
  await page.setViewportSize(desktop ? { width: 1440, height: 1000 } : { width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();

  // The fixture database is shared by both browser projects; setup may already be done.
  await post(page, '/ledger/setup', {}, true);
  const name = `شركة اصطناعية للكشف ${testInfo.project.name}`;
  const customer = (
    await post<{ customer: { id: string } }>(page, '/customers', {
      name,
      email: 'statement@example.test',
      vatNumber: '300000000000003',
      address: { line: 'طريق الاختبار', city: 'الرياض', postalCode: '12345', country: 'SA' },
    })
  ).customer.id;
  const issue = async (title: string, price: string, date: string, due: string) => {
    const quote = (
      await post<{ quote: { id: string; version: number } }>(page, '/quotes', {
        customerId: customer,
        documentType: 'standard',
        title,
        issueDate: date,
        validUntil: due,
        notes: '',
        lines: [
          { description: title, quantity: '1', unitPrice: price, taxRateBps: 1500, taxReason: '' },
        ],
      })
    ).quote;
    const id = (
      await post<{ invoice: { id: string } }>(page, `/quotes/${quote.id}/convert`, {
        version: quote.version,
        issueDate: date,
        dueDate: due,
      })
    ).invoice.id;
    await post(page, `/ledger/invoices/${id}/post`, { revenueAccountCode: '4101' });
    return id;
  };
  const first = await issue('حملة إعلانية اصطناعية', '20000.00', `${year}-02-08`, `${year}-03-10`);
  const second = await issue('رعاية فعالية اصطناعية', '12000.00', `${year}-05-04`, `${year}-06-03`);
  await issue('محتوى ترويجي اصطناعي', '8000.00', `${year}-09-15`, `${year}-10-15`);
  await post(page, `/ledger/invoices/${first}/receipts`, {
    date: `${year}-03-02`,
    amount: '23000.00',
    cashAccountCode: '1102',
    reference: 'TRF-0001',
  });
  await post(page, `/ledger/invoices/${second}/receipts`, {
    date: `${year}-06-20`,
    amount: '6000.00',
    cashAccountCode: '1102',
  });

  await page.goto('/finance?view=billing');
  const row = page.getByRole('row', { name: new RegExp(name) });
  await row.getByRole('button', { name: 'كشف حساب' }).click();
  const paper = page.locator('.fin-statement-paper');
  await expect(paper.getByRole('heading', { name: 'كشف حساب العميل' })).toBeVisible();
  await expect(paper.getByText(name)).toBeVisible();
  // 46,000 invoiced, 29,000 paid, 17,000 still due.
  const stats = paper.locator('.fin-statement-stats');
  await expect(stats.getByText('46,000.00')).toBeVisible();
  await expect(stats.getByText('29,000.00')).toBeVisible();
  await expect(paper.locator('.fin-statement-closing')).toContainText('17,000.00');
  await expect(paper.getByRole('row', { name: /سداد فاتورة/ })).toHaveCount(2);
  await expect(paper.getByRole('heading', { name: /الفواتير غير المسددة/ })).toBeVisible();

  // A later start carries the earlier movements as an opening balance.
  await page.getByLabel('من', { exact: true }).fill(`${year}-06-01`);
  await expect(paper.getByText('رصيد افتتاحي مرحّل')).toBeVisible();
  await expect(paper.locator('.fin-statement-closing')).toContainText('17,000.00');
  await page.getByLabel('من', { exact: true }).fill('');
  await expect(paper.getByText('رصيد افتتاحي مرحّل')).toHaveCount(0);

  if (desktop) {
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    writeFileSync(testInfo.outputPath('customer-statement.pdf'), pdf);
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
    expect(box, 'PDF page size').not.toBeNull();
    expect(Number(box![1])).toBeGreaterThan(Number(box![2]));
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length).toBe(1);
  }
});
