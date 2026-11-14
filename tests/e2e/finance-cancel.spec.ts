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

/** Synthetic data only. Cancelling keeps the document on record with a visible mark. */
test('draft quotes and draft invoices are cancelled, kept on record and marked', async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  const { customer } = await send<{ customer: { id: string } }>(page, '/customers', {
    name: `عميل اصطناعي للإلغاء ${tag}`,
    email: `cancel-${tag}@example.test`,
    vatNumber: '',
    address: { line: 'طريق الاختبار', city: 'الرياض', postalCode: '12345', country: 'SA' },
  });
  const quote = (title: string) =>
    send<{ quote: { id: string; number: string; version: number } }>(page, '/quotes', {
      customerId: customer.id,
      title,
      issueDate: '2026-11-14',
      validUntil: '2026-12-14',
      notes: '',
      lines: [
        {
          description: 'خدمة اصطناعية',
          quantity: '1',
          unitPrice: '1000.00',
          taxRateBps: 1500,
          taxReason: '',
        },
      ],
    });
  const first = (await quote(`عرض يُلغى ${tag}`)).quote;
  const second = (await quote(`عرض تُلغى فاتورته ${tag}`)).quote;
  const { invoice } = await send<{ invoice: { number: string } }>(
    page,
    `/quotes/${second.id}/convert`,
    { version: second.version, issueDate: '2026-11-14', dueDate: '2026-12-14' },
  );

  await page.goto('/finance?view=billing');
  await page.getByRole('button', { name: 'عروض الأسعار', exact: true }).click();
  const quoteRow = page.getByRole('row', { name: new RegExp(first.number) });
  await quoteRow.getByRole('button', { name: 'إلغاء', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'إلغاء عرض السعر' });
  await expect(confirm).toContainText(first.number);
  await expect(confirm).toContainText('الإلغاء ليس حذفًا');
  await confirm.getByRole('button', { name: 'تأكيد الإلغاء' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(quoteRow).toContainText('ملغي');
  await expect(quoteRow).toHaveClass(/fin-row-cancelled/);
  await expect(quoteRow.getByRole('button', { name: 'تعديل' })).toHaveCount(0);
  await expect(quoteRow.getByRole('button', { name: 'تحويل إلى مسودة فاتورة' })).toHaveCount(0);
  if (tag === 'chromium')
    await page.screenshot({ path: testInfo.outputPath('cancelled-quote-row.png') });

  await quoteRow.getByRole('button', { name: 'معاينة' }).click();
  const paper = page.locator('.fin-quote-paper');
  await expect(paper.locator('.fin-cancelled-stamp')).toBeVisible();
  await expect(paper).toContainText('عرض سعر ملغي');
  // The logo and the company details share one top and one bottom edge.
  const logo = await paper.locator('.fin-doc-logo').boundingBox();
  const details = await paper.locator('.fin-doc-brand > div').boundingBox();
  expect(logo && details).toBeTruthy();
  expect(Math.abs(logo!.y - details!.y)).toBeLessThan(1);
  expect(Math.abs(logo!.height - details!.height)).toBeLessThan(1);
  expect(logo!.width).toBeGreaterThan(logo!.height);
  if (tag === 'chromium')
    await paper.screenshot({ path: testInfo.outputPath('cancelled-quote-paper.png') });
  await page.getByRole('dialog').getByRole('button', { name: 'إغلاق' }).click();

  await page.getByRole('button', { name: 'الفواتير', exact: true }).click();
  const invoiceRow = page.getByRole('row', { name: new RegExp(invoice.number) });
  await invoiceRow.getByRole('button', { name: 'إلغاء', exact: true }).click();
  const confirmInvoice = page.getByRole('dialog', { name: 'إلغاء مسودة الفاتورة' });
  await confirmInvoice.getByRole('button', { name: 'تأكيد الإلغاء' }).click();
  await expect(confirmInvoice).toHaveCount(0);
  await expect(invoiceRow).toContainText('فاتورة ملغاة');
  await expect(invoiceRow.getByRole('button', { name: /إصدار ومزامنة/ })).toHaveCount(0);
  await invoiceRow.getByRole('button', { name: 'معاينة' }).click();
  await expect(page.locator('.fin-invoice-paper .fin-cancelled-stamp')).toBeVisible();
  if (tag === 'chromium')
    await page
      .locator('.fin-invoice-paper')
      .screenshot({ path: testInfo.outputPath('cancelled-invoice-paper.png') });
});
