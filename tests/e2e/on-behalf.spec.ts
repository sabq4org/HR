import { test, expect, type Page } from '@playwright/test';

// Synthetic personas only.
async function persona(page: Page, employeeId: string) {
  await page.evaluate(async (employeeId) => {
    const r = await fetch('/api/demo/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }, employeeId);
}

test('HR enters a salary letter on an employee’s behalf; the approver decides', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: /سارة القحطاني/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  await persona(page, 'emp-noura');
  await page.goto('/services');
  await page.getByRole('button', { name: /تعريف بالراتب/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('الموظف المعني بالطلب').selectOption('emp-sara');
  await expect(dialog.getByText('مسار المراجعة: المعتمد')).toBeVisible();
  await dialog.getByLabel('كيف وصل الطلب').selectOption('email');
  await dialog.getByLabel(/مرجع الطلب/).fill('بريد الموظفة بتاريخ اليوم');
  await dialog.getByLabel('الجهة الموجه إليها').fill('بنك تجريبي');
  await dialog.getByLabel(/الغرض/).fill('فتح حساب');
  await dialog.getByLabel(/لغة الخطاب/).selectOption('ar');
  await page.screenshot({ path: testInfo.outputPath('on-behalf-form.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'إرسال للمراجعة' }).click();
  await expect(page.getByText(/تم إرسال الطلب/)).toBeVisible();

  await persona(page, 'emp-abdullah');
  await page.goto('/requests');
  await expect(page.getByText(/سارة القحطاني/).first()).toBeVisible();
});
