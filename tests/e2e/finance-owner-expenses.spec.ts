import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Owner-paid expenses (decision 022). Synthetic data only, on the in-memory fixture server. */
async function post(page: Page, path: string, body: unknown) {
  const response = await page.request.post(`/api/finance/ledger${path}`, {
    data: body,
    headers: { 'Idempotency-Key': randomUUID(), Origin: 'http://127.0.0.1:4319' },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

test('owner-paid expenses: attach the invoice, export what is owed, record a refund', async ({
  page,
  browser,
}, testInfo) => {
  const desktop = testInfo.project.name === 'chromium';
  const tag = testInfo.project.name;
  const shot = async (name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

  // A synthetic supplier invoice image to attach.
  const paper = await browser.newPage({ viewport: { width: 420, height: 300 } });
  await paper.setContent(
    '<body style="font:16px sans-serif;padding:24px" dir="rtl"><h2>فاتورة اصطناعية</h2><p>مزود استضافة تجريبي</p><p>الإجمالي 1,150.00</p></body>',
  );
  const invoiceImage = await paper.screenshot({ type: 'jpeg' });
  await paper.close();

  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  // Wait for the sign-in to finish before navigating, as the other finance specs do; navigating
  // straight away can abort the session request and leave the page on the account picker.
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  await page.goto('/finance');
  const setup = page.getByRole('button', { name: 'تهيئة دليل الحسابات المقترح' });
  await expect(setup.or(page.getByText('الدفاتر متوازنة', { exact: false }))).toBeVisible({
    timeout: 15_000,
  });
  if (await setup.isVisible()) {
    await setup.click();
    await expect(page.getByText('تمت تهيئة دليل الحسابات.')).toBeVisible();
  }
  // Two earlier owner-paid items, one bill paid by the owner after it was recorded on credit.
  await post(page, '/expenses', {
    date: today,
    description: `اشتراك وكالة صور اصطناعي ${tag}`,
    accountCode: '5103',
    taxCode: 'S',
    net: '2400.00',
    paidBy: 'owner',
    cashAccountCode: '',
    reference: `PH-${tag}`,
  });
  const bill = await post(page, '/expenses', {
    date: today,
    description: `رسوم تجديد رخص اصطناعية ${tag}`,
    accountCode: '5206',
    taxCode: 'O',
    net: '650.00',
    cashAccountCode: '',
  });
  await post(page, `/expenses/${bill.voucher.id}/payments`, {
    date: today,
    amount: '650.00',
    paidBy: 'owner',
    cashAccountCode: '',
  });

  // ---- the form: "paid by the owner from his card" plus the invoice file
  await page.getByRole('button', { name: 'المصروفات', exact: true }).click();
  await page
    .getByRole('button', { name: /تسجيل مصروف/ })
    .first()
    .click();
  await page.getByLabel('البيان').fill(`استضافة سحابية اصطناعية ${tag}`);
  await page.getByLabel('الحساب', { exact: false }).first().selectOption('5302');
  await page.getByLabel('المعالجة الضريبية').selectOption('S');
  await page.getByLabel('المبلغ قبل الضريبة').fill('1000');
  await page.getByLabel('رقم الفاتورة الضريبية للمورد').fill(`HOST-${tag}`);
  await page.getByLabel('طريقة السداد').selectOption('__owner');
  await page
    .getByLabel('صورة الفاتورة أو ملف PDF (اختياري)')
    .setInputFiles({ name: 'فاتورة-استضافة.jpg', mimeType: 'image/jpeg', buffer: invoiceImage });
  await expect(page.getByText('المستحق للمالك', { exact: false }).first()).toBeVisible();
  if (desktop) await shot('owner-expense-form');
  await page.getByRole('button', { name: 'حفظ وترحيل' }).click();
  await expect(page.getByRole('status').filter({ hasText: /مستحقًا للمالك/ })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(`استضافة سحابية اصطناعية ${tag}`) });
  await expect(row.getByText('للمالك 1,150.00')).toBeVisible();
  if (desktop) await shot('owner-expenses-list');

  // ---- the attachment is there and opens
  await row.getByRole('button', { name: 'المرفقات' }).click();
  await expect(page.getByText('فاتورة-استضافة.jpg')).toBeVisible();
  if (desktop) await shot('owner-attachments');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /تنزيل/ }).click();
  // Headless Chromium reports blob/same-origin download names as "download"; check the bytes.
  const saved = await (await download).path();
  expect(readFileSync(saved!).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  await page.getByRole('button', { name: 'رجوع' }).click();

  // ---- what is owed to the owner, and its PDF
  await page.getByRole('button', { name: 'مستحقات المالك' }).click();
  await expect(page.getByRole('heading', { name: 'مستحقات المالك' })).toBeVisible();
  await expect(
    page.getByRole('cell', { name: new RegExp(`استضافة سحابية اصطناعية ${tag}`) }),
  ).toBeVisible();
  if (desktop) await shot('owner-due');
  // ---- a partial refund from the company bank
  await page.getByRole('button', { name: 'تسجيل رد مبلغ للمالك' }).click();
  await page.getByLabel('المبلغ المحوَّل').fill('2000');
  await page.getByLabel('مرجع التحويل البنكي (اختياري)').fill(`TRF-${tag}`);
  if (desktop) await shot('owner-refund-form');
  await page.getByRole('button', { name: 'حفظ وترحيل' }).click();
  await expect(page.getByRole('heading', { name: 'ما رُدّ للمالك' })).toBeVisible();
  await expect(page.getByRole('cell', { name: `TRF-${tag}`, exact: false })).toBeVisible();
  if (desktop) await shot('owner-due-after-refund');

  const pdf = page.waitForEvent('download');
  await page.getByRole('button', { name: 'تصدير PDF بالمستحق' }).click();
  const file = await pdf;
  expect(
    readFileSync((await file.path())!)
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');
  await file.saveAs(testInfo.outputPath('owner-due.pdf'));

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((item) => item.impact === 'critical' || item.impact === 'serious')
      .flatMap((item) => item.nodes.map((node) => `${item.id}: ${node.target.join(' ')}`)),
  ).toEqual([]);

  if (desktop) {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'مستحقات المالك' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot('owner-due-mobile');
  }
});
