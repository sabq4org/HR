import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';

/** Synthetic data only: the fixture server is in-memory and never reaches a real provider. */
async function post(page: Page, path: string, body: unknown) {
  const response = await page.request.post(`/api/finance/ledger${path}`, {
    data: body,
    headers: { 'Idempotency-Key': randomUUID(), Origin: 'http://127.0.0.1:4319' },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' })
  .format(new Date())
  .slice(0, 4);

test('accounting portal: setup, revenue, expense, journal entry, VAT return, budget and reports', async ({
  page,
}, testInfo) => {
  const desktop = testInfo.project.name === 'chromium';
  await page.setViewportSize(desktop ? { width: 1440, height: 1000 } : { width: 390, height: 844 });
  const shot = async (name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'النظام المالي', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // The fixture database is shared by both browser projects; only the first run sees the setup card.
  const setup = page.getByRole('button', { name: 'تهيئة دليل الحسابات المقترح' });
  const health = page.getByText('الدفاتر متوازنة', { exact: false });
  await expect(setup.or(health)).toBeVisible();
  if (await setup.isVisible()) {
    await shot('ledger-setup');
    await setup.click();
    await expect(page.getByText('تمت تهيئة دليل الحسابات.')).toBeVisible();
    // Opening balances and a spread of synthetic activity so the dashboard has something to show.
    await post(page, '/entries', {
      date: `${year}-01-01`,
      description: 'أرصدة افتتاحية اصطناعية',
      kind: 'opening',
      lines: [
        { accountCode: '1102', debit: '250000.00', credit: '0' },
        { accountCode: '3101', debit: '0', credit: '250000.00' },
      ],
    });
    const vendor = (
      await post(page, '/vendors', {
        name: 'مزود سحابي اصطناعي',
        vatNumber: '',
        country: 'US',
        resident: false,
      })
    ).vendor.id as string;
    for (let month = 1; month <= 9; month += 1) {
      const date = `${year}-${String(month).padStart(2, '0')}-15`;
      await post(page, '/revenues', {
        date,
        description: `حملة إعلانية اصطناعية ${month}`,
        accountCode: month % 3 === 0 ? '4103' : '4101',
        taxCode: 'S',
        net: String(42000 + month * 3500),
        cashAccountCode: '1102',
        customerName: 'عميل اصطناعي',
        reference: `SYN-${year}-${month}`,
      });
      await post(page, '/expenses', {
        date,
        description: `رواتب شهر ${month} (اصطناعية)`,
        accountCode: '5201',
        taxCode: 'O',
        net: '26000',
        cashAccountCode: '1102',
      });
      await post(page, '/expenses', {
        date,
        description: `استضافة سحابية ${month}`,
        accountCode: '5104',
        taxCode: 'RC',
        net: String(3200 + month * 110),
        cashAccountCode: '1102',
        vendorId: vendor,
      });
    }
    await post(page, '/expenses', {
      date: `${year}-03-10`,
      description: 'ضيافة فعالية اصطناعية',
      accountCode: '5306',
      taxCode: 'ND',
      net: '2000',
      cashAccountCode: '1102',
    });
    await page.request.patch(`/api/finance/ledger/budgets/${year}`, {
      headers: { 'Idempotency-Key': randomUUID(), Origin: 'http://127.0.0.1:4319' },
      data: {
        version: 1,
        lines: [
          { accountCode: '4101', months: Array.from({ length: 12 }, () => '50000') },
          { accountCode: '5201', months: Array.from({ length: 12 }, () => '25000') },
          { accountCode: '5104', months: Array.from({ length: 12 }, () => '3500') },
        ],
      },
    });
    await page.reload();
  }
  await expect(health).toBeVisible();
  await expect(page.getByText('إيرادات هذا الشهر')).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'أعمدة الإيرادات والمصروفات الشهرية' }),
  ).toBeVisible();
  await shot('ledger-home');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((item) => item.impact === 'critical' || item.impact === 'serious')
      .flatMap((item) => item.nodes.map((node) => `${item.id}: ${node.target.join(' ')}`)),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // ---- expense with deductible VAT, through the form
  const tag = testInfo.project.name;
  await page
    .getByRole('button', { name: /تسجيل مصروف/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'تسجيل مصروف' })).toBeVisible();
  await page.getByLabel('البيان').fill(`إيجار مكتب اصطناعي ${tag}`);
  await page.getByLabel('الحساب', { exact: false }).first().selectOption('5301');
  await page.getByLabel('المعالجة الضريبية').selectOption('S');
  await page.getByLabel('المبلغ قبل الضريبة').fill('10,000');
  await page.getByLabel('رقم الفاتورة الضريبية للمورد').fill(`RENT-${tag}`);
  if (desktop) await shot('ledger-expense-form');
  await page.getByRole('button', { name: 'حفظ وترحيل' }).click();
  await expect(page.getByText('سُجّل المصروف ورُحّل قيده.')).toBeVisible();
  await expect(page.getByText(`إيجار مكتب اصطناعي ${tag}`)).toBeVisible();
  if (desktop) await shot('ledger-expenses');

  // ---- direct revenue: a taxable revenue is refused without its tax invoice number
  await page.getByRole('button', { name: 'الإيرادات', exact: true }).click();
  await page.getByRole('button', { name: /تسجيل إيراد/ }).click();
  await page.getByLabel('البيان').fill(`رعاية فعالية اصطناعية ${tag}`);
  await page.getByLabel('المبلغ قبل الضريبة').fill('20000');
  await expect(page.getByLabel('رقم الفاتورة الضريبية')).toHaveAttribute('required', '');
  await page.getByLabel('رقم الفاتورة الضريبية').fill(`SPON-${tag}`);
  await expect(page.getByText('23,000.00')).toBeVisible();
  await page.getByRole('button', { name: 'حفظ وترحيل' }).click();
  await expect(page.getByText('سُجّل الإيراد ورُحّل قيده.')).toBeVisible();
  if (desktop) await shot('ledger-revenues');

  // ---- manual journal entry: unbalanced is flagged, balanced posts
  await page.getByRole('button', { name: 'القيد اليومي', exact: true }).click();
  await page.getByRole('button', { name: 'قيد جديد' }).click();
  await page.getByLabel('البيان', { exact: true }).fill(`إهلاك شهري اصطناعي ${tag}`);
  const lines = page.getByRole('group', { name: 'أطراف القيد' });
  await lines.getByRole('combobox').nth(0).selectOption('5308');
  await page.getByLabel('مدين السطر 1').fill('1500');
  await lines.getByRole('combobox').nth(1).selectOption('1290');
  await page.getByLabel('دائن السطر 2').fill('1000');
  await expect(page.getByText(/الفرق 500.00/)).toBeVisible();
  await page.getByLabel('دائن السطر 2').fill('1500');
  await expect(page.getByText('القيد متوازن')).toBeVisible();
  if (desktop) await shot('ledger-journal-form');
  await page.getByRole('button', { name: 'ترحيل القيد' }).click();
  await expect(page.getByText('رُحّل القيد.')).toBeVisible();
  await expect(page.getByText(`إهلاك شهري اصطناعي ${tag}`)).toBeVisible();
  if (desktop) await shot('ledger-journal');

  // ---- VAT return: boxes derived from the ledger, reconciled with the control accounts
  await page.getByRole('button', { name: 'الإقرار الضريبي', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'إقرار ضريبة القيمة المضافة' })).toBeVisible();
  await expect(page.getByText('الخانات مطابقة لأرصدة حسابات الضريبة في الأستاذ.')).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'الاستيرادات الخاضعة للضريبة بآلية الاحتساب العكسي' }),
  ).toBeVisible();
  await shot('ledger-vat');

  // ---- accounts, budget, reports
  await page.getByRole('button', { name: 'الحسابات والأستاذ', exact: true }).click();
  await expect(page.getByRole('cell', { name: /الضيافة والترفيه/ })).toBeVisible();
  if (desktop) await shot('ledger-accounts');
  await page.getByRole('button', { name: 'الموازنة', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'الموازنة التقديرية' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'صافي الربح', exact: true })).toBeVisible();
  if (desktop) await shot('ledger-budget');
  await page.getByRole('button', { name: 'التقارير', exact: true }).click();
  await expect(page.getByRole('cell', { name: /صافي الربح قبل الزكاة/ })).toBeVisible();
  if (desktop) await shot('ledger-income');
  await page.getByRole('tab', { name: 'المركز المالي' }).click();
  await expect(page.getByText(/المعادلة المحاسبية متحققة/)).toBeVisible();
  await page.getByRole('tab', { name: 'ميزان المراجعة' }).click();
  await expect(page.getByRole('columnheader', { name: 'رصيد آخر المدة' })).toBeVisible();
  if (desktop) await shot('ledger-trial');

  // ---- the billing pages stay reachable inside the portal, and old deep links keep working
  await page.getByRole('button', { name: 'الفواتير وعروض الأسعار', exact: true }).click();
  await expect(page).toHaveURL(/view=billing/);
  await page.goto('/finance?tab=settings');
  await expect(page.getByRole('heading', { name: 'إعدادات وافق والفوترة' })).toBeVisible();
});
