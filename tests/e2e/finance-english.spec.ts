import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:4319';
async function send<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`/api/finance${path}`, {
    data,
    headers: { 'Idempotency-Key': randomUUID(), Origin: origin },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as T;
}

/** Synthetic data only. A customer abroad gets its quotation and invoice in English. */
test('a foreign customer is saved with its country and gets English documents', async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  const name = `Synthetic Trading LLC ${tag}`;
  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();

  await page.goto('/finance?view=billing');
  await page.getByRole('button', { name: 'العملاء', exact: true }).click();
  await page.getByRole('button', { name: 'إضافة عميل', exact: true }).click();
  const form = page.locator('.fin-form-page');
  await form.getByLabel('الدولة').selectOption('AE');
  await expect(form.getByLabel('لغة المستندات')).toHaveValue('en');
  // Saudi national address fields are not asked for an address abroad.
  await expect(form.getByLabel('رقم المبنى')).toHaveCount(0);
  await form.getByLabel('اسم العميل', { exact: true }).fill(name);
  await form.getByLabel('الرقم الضريبي في بلده (اختياري)').fill('100000000000000AE');
  await form.getByLabel('البريد الإلكتروني').fill(`english-${tag}@example.test`);
  await form.getByLabel('المدينة').fill('Dubai');
  await form.getByLabel('العنوان', { exact: true }).fill('Synthetic Street 1');
  await form.getByRole('button', { name: 'حفظ العميل', exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();

  const overview = await (await page.request.get('/api/finance')).json();
  const customer = overview.customers.find((c: { name: string }) => c.name === name);
  expect(customer.address.country).toBe('AE');
  expect(customer.language).toBe('en');
  const { quote } = await send<{ quote: { id: string; number: string; version: number } }>(
    page,
    '/quotes',
    {
      customerId: customer.id,
      documentType: 'out_of_scope',
      title: 'Content production services',
      issueDate: '2026-11-14',
      validUntil: '2026-12-14',
      notes: 'Payment within 30 days.',
      lines: [
        {
          description: 'Video production',
          quantity: '2',
          unitPrice: '5000.00',
          taxRateBps: 0,
          taxReason: 'Outside the scope of VAT',
        },
      ],
    },
  );

  await page.reload();
  await page.getByRole('button', { name: 'عروض الأسعار', exact: true }).click();
  await page
    .getByRole('row', { name: new RegExp(quote.number) })
    .getByRole('button', { name: 'معاينة' })
    .click();
  const paper = page.locator('.fin-quote-paper');
  await expect(paper).toHaveAttribute('dir', 'ltr');
  await expect(paper).toHaveAttribute('lang', 'en');
  await expect(paper.getByRole('heading', { name: 'Price Quotation' })).toBeVisible();
  await expect(paper).toContainText('Customer Details');
  await expect(paper).toContainText('United Arab Emirates');
  await expect(paper).toContainText('Tax ID');
  // No Arabic label is left on an English paper (names typed in Arabic would be data, not labels).
  expect(
    await paper.locator('dt, th, .fin-detail-card header b').allInnerTexts(),
  ).not.toContainEqual(expect.stringMatching(/[؀-ۿ]/));
  if (tag === 'chromium')
    await paper.screenshot({ path: testInfo.outputPath('english-quote-paper.png') });
  await page.getByRole('dialog').getByRole('button', { name: 'إغلاق' }).click();

  const { invoice } = await send<{ invoice: { number: string; language: string } }>(
    page,
    `/quotes/${quote.id}/convert`,
    { version: quote.version, issueDate: '2026-11-14', dueDate: '2026-12-14' },
  );
  expect(invoice.language).toBe('en');
  await page.reload();
  await page.getByRole('button', { name: 'الفواتير', exact: true }).click();
  await page
    .getByRole('row', { name: new RegExp(invoice.number) })
    .getByRole('button', { name: 'معاينة المسودة' })
    .click();
  const invoicePaper = page.locator('.fin-invoice-paper');
  await expect(invoicePaper).toHaveAttribute('dir', 'ltr');
  await expect(invoicePaper).toContainText('Invoice Details');
  await expect(invoicePaper).toContainText('Total Due');
  if (tag === 'chromium')
    await invoicePaper.screenshot({ path: testInfo.outputPath('english-invoice-paper.png') });
});
