import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function login(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
}

async function switchPersona(page: Page, name: string) {
  if (await page.locator('.sidebar').isVisible()) await page.locator('.switch-persona').click();
  else {
    await page.getByRole('button', { name: 'فتح القائمة' }).click();
    await page.getByRole('button', { name: 'تبديل حساب التجربة' }).click();
  }
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.header-profile')).toContainText(name.split(' ')[0]);
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
}

test('payroll real workflow is independently reviewed, scoped to payslip owners, and correctable', async ({
  page,
}, testInfo) => {
  const period = testInfo.project.name === 'webkit' ? '2027-10' : '2027-09';
  const width = testInfo.project.name === 'webkit' ? 320 : 390;
  await page.setViewportSize({ width, height: 844 });
  await login(page, 'نورة العتيبي');
  await page.goto('/payroll');
  await expect(page.getByRole('heading', { name: 'مسيرات الرواتب', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'مسيرات الرواتب' })).toHaveCSS(
    'font-family',
    /Year of Handicrafts/,
  );
  expect(await page.evaluate(() => document.fonts.check('700 24px "Year of Handicrafts"'))).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.locator('input[type="month"]').fill(period);
  await page.getByLabel('سبب الإنشاء').fill(`مسير تجريبي ${period}`);
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/payroll') &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'إنشاء مسودة', exact: true }).click();
  const created = await (await createResponse).json();
  const runId: string = created.run.id;
  await expect(page.getByRole('heading', { name: `مسير ${period}`, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('payroll-hr-desktop.png'), fullPage: true });
  expect((await new AxeBuilder({ page }).include('.payroll-page').analyze()).violations).toEqual(
    [],
  );
  await page.setViewportSize({ width, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Exercise the approved reward / cash overtime picker in the real editor.
  await page.getByRole('button', { name: 'تعديل الأسطر', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'مصدر الطلب المعتمد' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await page.getByRole('button', { name: 'إرسال للمالية', exact: true }).click();
  await expect(page.locator('.payroll-state')).toContainText('بانتظار مراجعة المالية');

  await switchPersona(page, 'ريم الحربي');
  await page.goto('/payroll');
  await page.getByRole('button', { name: new RegExp(period) }).click();
  await page.getByRole('button', { name: 'إكمال المراجعة وإرساله للمعتمد', exact: true }).click();
  await expect(page.locator('.payroll-state')).toContainText('بانتظار اعتماد مستقل');

  await switchPersona(page, 'عبدالله السبيعي');
  await page.goto('/payroll');
  await page.getByRole('button', { name: new RegExp(period) }).click();
  await page.getByRole('button', { name: 'اعتماد وإغلاق', exact: true }).click();
  await expect(page.locator('.payroll-state')).toContainText('مغلق');

  await switchPersona(page, 'سارة القحطاني');
  await page.goto('/payroll');
  await page.getByRole('button', { name: new RegExp(period) }).click();
  await expect(page.locator('.payroll-table-wrap tbody tr')).toHaveCount(3);
  await expect(
    page.getByRole('cell', { name: 'سارة القحطاني', exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'عمر الشمري', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'طباعة كشف الراتب' })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.payroll-print-sheet')).toBeVisible();
  await expect(page.locator('.payroll-print-sheet header')).toContainText('سارة القحطاني');
  await expect(page.locator('.payroll-heading')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.screenshot({
    path: testInfo.outputPath('payroll-employee-payslip.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).include('.payroll-page').analyze()).violations).toEqual(
    [],
  );

  await switchPersona(page, 'ريم الحربي');
  await page.goto('/payroll');
  await page.getByRole('button', { name: new RegExp(period) }).click();
  await page.getByLabel('الموظف').selectOption({ label: 'سارة القحطاني' });
  const saraNetMinor = await page.evaluate(async (id) => {
    const response = await fetch(`/api/admin/payroll/${id}`);
    const result = await response.json();
    return result.run.lines
      .filter((line: any) => line.employeeId === 'emp-sara')
      .reduce(
        (sum: number, line: any) =>
          sum + (line.kind === 'earning' ? line.amountMinor : -line.amountMinor),
        0,
      );
  }, runId);
  await page.getByLabel('المبلغ بالريال').fill((saraNetMinor / 100).toFixed(2));
  await page.getByLabel('مرجع داخلي').fill(`manual-${period}`);
  await page.getByRole('button', { name: 'حفظ الحالة يدويًا', exact: true }).click();
  await expect(page.locator('.payroll-payments p')).toContainText('سارة القحطاني');
  await expect(page.locator('.payroll-payments p')).toContainText('مدفوع');

  await switchPersona(page, 'نورة العتيبي');
  await page.goto('/payroll');
  await page.getByRole('button', { name: new RegExp(period) }).click();
  await expect(page.getByRole('button', { name: 'تعديل الأسطر', exact: true })).toHaveCount(0);
  const blockedEdit = await page.evaluate(async (id) => {
    const current = await (await fetch(`/api/admin/payroll/${id}`)).json();
    const response = await fetch(`/api/admin/payroll/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        version: current.run.version,
        lines: current.run.lines,
        reason: 'closed edit check',
      }),
    });
    return response.status;
  }, runId);
  expect(blockedEdit).toBe(409);

  await page.getByLabel('سبب الإنشاء').fill(`فرق تصحيحي مرتبط بمسير ${period}`);
  await page.getByRole('button', { name: 'إنشاء مسير تصحيح مرتبط', exact: true }).click();
  await expect(page.getByText('صافي فرق التصحيح')).toBeVisible();
  const correctionAmounts = await page
    .locator('.payroll-table-wrap tbody tr td:nth-child(4)')
    .allTextContents();
  expect(correctionAmounts.length).toBeGreaterThan(0);
  expect(correctionAmounts.every((amount) => amount.includes('0.00'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
