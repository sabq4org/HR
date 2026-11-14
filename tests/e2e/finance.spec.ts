import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resolve } from 'node:path';

async function loginOwner(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  await page.goto('/finance?tab=settings');
  await expect(page.getByRole('heading', { name: 'إعدادات وافق والفوترة' })).toBeVisible();
}

test('private finance customer, quote, invoice, Wafeq readiness, and official output flow', async ({
  page,
}, testInfo) => {
  const width = testInfo.project.name === 'webkit' ? 320 : 390;
  const customerName = `شركة الاختبار الاصطناعية ${testInfo.project.name}`;
  const quoteTitle = `خدمات إنتاج محتوى ${testInfo.project.name}`;
  await page.setViewportSize({ width, height: 844 });
  await loginOwner(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // Configure a synthetic seller, mappings, and fixture-only provider key before invoicing.
  if (testInfo.project.name === 'chromium') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: testInfo.outputPath('finance-settings-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width, height: 844 });
  } else {
    await page.screenshot({
      path: testInfo.outputPath('finance-settings-mobile-320.png'),
      fullPage: true,
    });
  }
  await page.getByLabel('اسم المنشأة').fill('صحيفة سبق التجريبية');
  await page.getByLabel('الرقم الضريبي').nth(0).fill('300000000000003');
  await page.getByLabel('العنوان الوطني').fill('شارع الاختبار');
  await page.getByLabel('المدينة').nth(0).fill('الرياض');
  await page.getByLabel('الرمز البريدي').nth(0).fill('12345');
  await page.getByLabel('حساب الإيراد').fill('account-synthetic-revenue');
  await page.getByLabel('رمز ضريبة 15٪').fill('tax-synthetic-standard');
  await page.getByLabel('رمز الضريبة الصفرية').fill('tax-synthetic-zero');
  await page.getByLabel('اسم المستفيد').fill('مستفيد اختباري');
  await page.getByLabel('البنك').fill('بنك اصطناعي');
  await page.getByLabel('رقم الحساب').fill('0000000000000000000001');
  await page.getByLabel('رقم الآيبان').fill('SA8000000000000000000001');
  await page.getByRole('button', { name: 'حفظ الإعدادات', exact: true }).click();
  await expect(page.getByText('تم حفظ إعدادات الفوترة.')).toBeVisible();
  const key = 'synthetic-wafeq-key-for-tests-only';
  const keyField = page.getByLabel('مفتاح واجهة وافق');
  await expect(keyField).toHaveAttribute('type', 'password');
  await keyField.fill(key);
  await page.getByRole('button', { name: 'حفظ المفتاح', exact: true }).click();
  await expect(keyField).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(key);
  await page.getByRole('button', { name: 'اختبار الاتصال بوافق', exact: true }).click();
  await expect(page.getByText(/المنشأة المرتبطة/)).toBeVisible();

  await page.getByRole('button', { name: 'العملاء', exact: true }).click();
  await page.getByRole('button', { name: 'إضافة عميل', exact: true }).click();
  const customerDialog = page.getByRole('dialog');
  await customerDialog.getByLabel('اسم العميل بالعربية').fill(customerName);
  await customerDialog
    .getByLabel('البريد الإلكتروني')
    .fill(`${testInfo.project.name}@example.test`);
  await customerDialog.getByLabel('المدينة').fill('الرياض');
  await customerDialog.getByLabel('الشارع').fill('طريق الاختبار');
  await customerDialog.getByLabel('الرمز البريدي').fill('12345');
  await customerDialog.getByRole('button', { name: 'حفظ العميل', exact: true }).click();
  const customerRow = page.getByRole('row', { name: new RegExp(customerName) }).first();
  await expect(customerRow).toBeVisible();
  await customerRow.getByRole('button', { name: 'مزامنة وافق' }).click();
  await expect(customerRow.getByText('متزامن')).toBeVisible();

  await page.getByRole('button', { name: 'عروض الأسعار', exact: true }).click();
  await page.getByRole('button', { name: 'عرض سعر جديد', exact: true }).click();
  const quoteDialog = page.getByRole('dialog');
  await quoteDialog.getByLabel('العميل').selectOption({ label: customerName });
  await quoteDialog.getByLabel('عنوان العرض').fill(quoteTitle);
  await quoteDialog.getByLabel('صالح حتى').fill('2027-12-31');
  await quoteDialog.getByLabel('وصف البند').fill('إعداد مادة تحريرية للنشر الرقمي');
  await quoteDialog.getByLabel('سعر الوحدة (ر.س)').fill('125.50');
  await quoteDialog.getByRole('button', { name: 'إضافة بند' }).click();
  await quoteDialog
    .getByLabel('وصف البند')
    .nth(1)
    .fill('تحرير ومراجعة محتوى صحفي رقمي مع تدقيق لغوي وتسليم النسخة النهائية');
  await quoteDialog.getByLabel('سعر الوحدة (ر.س)').nth(1).fill('240.00');
  await quoteDialog.getByRole('button', { name: 'إضافة بند' }).click();
  await quoteDialog
    .getByLabel('وصف البند')
    .nth(2)
    .fill('إعداد تقرير تحليلي شامل يتضمن ملخصًا تنفيذيًا ومراجع داعمة ومحتوى صالحًا للنشر');
  await quoteDialog.getByLabel('سعر الوحدة (ر.س)').nth(2).fill('375.25');
  await quoteDialog
    .getByLabel('ملاحظات')
    .fill('عرض تجريبي ببيانات اصطناعية. تسري الأسعار حتى تاريخ صلاحية العرض الموضح.');
  await quoteDialog.getByRole('button', { name: 'حفظ عرض السعر', exact: true }).click();
  const quoteRow = page.getByRole('row', { name: new RegExp(quoteTitle) }).first();
  await expect(quoteRow).toBeVisible();
  await quoteRow.getByRole('button', { name: 'معاينة' }).click();
  await expect(page.locator('.fin-quote-paper')).toContainText('عرض سعر');
  await expect(page.locator('.fin-quote-paper')).toContainText('لم يُرسل إلى العميل');
  await expect(page.locator('.fin-quote-paper .fin-paper-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.fin-quote-paper .fin-bank-card')).toContainText('مستفيد اختباري');
  await expect(page.locator('.fin-quote-paper .fin-notes-box')).toContainText('بيانات اصطناعية');
  await expect(page.locator('.fin-quote-paper img[alt*="رمز"]')).toHaveCount(0);
  if (testInfo.project.name === 'chromium') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: testInfo.outputPath('finance-quote-preview-desktop.png'),
      fullPage: true,
    });
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.fin-quote-paper')).toBeVisible();
    const printedQuote = await page.pdf({
      path: resolve(process.cwd(), 'artifacts/finance-quote-synthetic.pdf'),
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    // A hidden modal previously produced a blank, approximately 1 KB PDF.
    expect(printedQuote.byteLength).toBeGreaterThan(10_000);
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width, height: 844 });
  } else {
    await page.screenshot({
      path: testInfo.outputPath('finance-quote-preview-mobile-320.png'),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'إغلاق' }).last().click();
  await quoteRow.getByRole('button', { name: 'تحويل إلى مسودة فاتورة' }).click();
  const convertDialog = page.getByRole('dialog');
  await convertDialog.getByLabel('رقم أمر الشراء (اختياري)').fill('PO-SYN-204');
  await expect(convertDialog.getByRole('option', { name: /مبسطة/ })).toBeDisabled();
  await convertDialog.getByRole('button', { name: 'إنشاء مسودة الفاتورة', exact: true }).click();
  await expect(page.getByRole('button', { name: 'الفواتير', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const invoiceRow = page.getByRole('row', { name: /HR-INV-/ }).first();
  await expect(invoiceRow).toContainText('مسودة فاتورة');
  await invoiceRow.getByRole('button', { name: 'معاينة المسودة' }).click();
  await expect(page.locator('.fin-invoice-paper .fin-draft-watermark')).toContainText(
    'للمعاينة الداخلية فقط',
  );
  await expect(page.getByRole('button', { name: /طباعة فاتورة سبق/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'إغلاق' }).last().click();

  const send = page.waitForResponse(
    (response) =>
      response.url().includes('/api/finance/invoices/') &&
      response.url().endsWith('/sync') &&
      response.request().method() === 'POST',
  );
  await invoiceRow.getByRole('button', { name: 'إصدار ومزامنة مع وافق', exact: true }).click();
  expect((await send).ok()).toBeTruthy();
  await expect(invoiceRow).toContainText('بانتظار نتيجة التحقق');
  await invoiceRow.getByRole('button', { name: 'تحديث حالة التحقق', exact: true }).click();
  await expect(invoiceRow).toContainText('معتمدة');
  await expect(invoiceRow).toContainText('بانتظار مستند الاعتماد ورمز التحقق');
  await expect(invoiceRow.getByRole('button', { name: 'طباعة فاتورة سبق' })).toHaveCount(0);

  if (testInfo.project.name === 'chromium') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: testInfo.outputPath('finance-invoices-desktop.png'),
      fullPage: true,
    });
  }
  expect((await new AxeBuilder({ page }).include('.finance-page').analyze()).violations).toEqual(
    [],
  );
  await page.setViewportSize({ width, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
