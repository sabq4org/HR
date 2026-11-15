import { test, expect, type Page } from '@playwright/test';

// Synthetic personas and a synthetic rule version only; the figures are test fixtures.
async function call(page: Page, path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(`/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error?.message ?? `HTTP ${response.status}`);
      return json;
    },
    { path, body, method },
  );
}
const persona = (page: Page, employeeId: string) => call(page, '/demo/session', { employeeId });

test('end of service: rule approval, award preparation, review and approval', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: /سارة القحطاني/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()),
  );

  // HR drafts the rule from the page.
  await persona(page, 'emp-noura');
  await page.goto('/end-of-service');
  await expect(page.getByRole('heading', { name: 'نهاية الخدمة', exact: true })).toBeVisible();
  await page.getByText('إنشاء إصدار جديد').click();
  const ruleForm = page.locator('form').filter({ hasText: 'شرائح الاستقالة' });
  await ruleForm.getByLabel('يسري من').fill('2015-01-01');
  await ruleForm
    .getByLabel('المصدر والمواد')
    .fill('نظام العمل م84 وم85 وم87؛ مصادر ثانوية (بيانات اختبار)');
  await ruleForm.getByRole('button', { name: 'حفظ مسودة للاعتماد' }).click();
  await expect(page.getByText('مسودة بانتظار الاعتماد')).toBeVisible();

  await persona(page, 'emp-abdullah');
  await page.goto('/end-of-service');
  await page.getByRole('button', { name: 'اعتماد هذا الإصدار' }).click();
  await expect(page.getByText('معتمدة', { exact: true }).first()).toBeVisible();

  await persona(page, 'emp-noura');
  await page.goto('/end-of-service');
  const employee = testInfo.project.name === 'webkit' ? 'emp-khaled' : 'emp-maha';
  const form = page.locator('form').filter({ hasText: 'أيام مستبعدة' });
  await form.getByLabel('الموظف').selectOption(employee);
  await form.getByLabel('آخر يوم عمل').fill(today);
  await form.getByLabel('سبب انتهاء الخدمة').selectOption('contract_end');
  await form.getByRole('button', { name: 'احتساب' }).click();
  await expect(page.getByText('المكافأة المستحقة').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('eos-hr.png'), fullPage: true });
  await page.getByRole('button', { name: 'إرسال للمراجعة المالية' }).click();
  await expect(page.getByText('بانتظار مراجعة المالية')).toBeVisible();

  await persona(page, 'emp-reem');
  await page.goto('/end-of-service');
  await page.getByRole('button', { name: 'مراجعة وإحالة للاعتماد' }).click();
  await expect(page.getByText('بانتظار الاعتماد', { exact: true })).toBeVisible();

  await persona(page, 'emp-abdullah');
  await page.goto('/end-of-service');
  await page.getByRole('button', { name: 'اعتماد', exact: true }).click();
  await expect(page.getByText('معتمدة', { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('eos-approved.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('eos-mobile.png'), fullPage: true });
});
