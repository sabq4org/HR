import { test, expect, type Page } from '@playwright/test';

// Synthetic personas and a synthetic rule version only; the figures are test fixtures.
async function call(page: Page, path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(`/api${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
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

test('leave entitlement: rule approval, accrual, settlement review and approval', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: /سارة القحطاني/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()),
  );

  await persona(page, 'emp-noura');
  const { policy } = await call(page, '/admin/policies', {
    key: 'annual-leave-entitlement',
    name: 'قاعدة استحقاق الإجازة السنوية وتصفيتها',
    effectiveFrom: '2025-01-01',
    source:
      'نظام العمل م109 وم111 واللائحة م24؛ مصادر ثانوية لم تُطابق بالنص الرسمي (بيانات اختبار)',
    values: {
      calculation: 'annual-leave-accrual-v1',
      baseDays: 21,
      seniorDays: 30,
      seniorAfterYears: 5,
      yearDays: 365,
      dailyRateDivisor: 30,
      wageComponents: ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'],
      excludeContractors: true,
      sourceKind: 'secondary',
    },
  });
  await persona(page, 'emp-abdullah');
  await call(page, `/admin/policies/${policy.id}/actions`, {
    action: 'approve',
    version: policy.version,
    reason: 'اعتماد اختبار',
  });
  await persona(page, 'emp-noura');
  await call(page, '/leave-entitlement/accruals', { throughDate: today });

  await page.goto('/leave-entitlement');
  await expect(page.getByRole('heading', { name: 'استحقاق الإجازات والتصفية' })).toBeVisible();
  await expect(page.getByText('مصدر ثانوي').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'أرصدة الاستحقاق' })).toContainText('مها');

  // Prepare a settlement from the page.
  const form = page.locator('form').filter({ hasText: 'آخر يوم عمل' });
  await form
    .getByLabel('الموظف')
    .selectOption(testInfo.project.name === 'webkit' ? 'emp-khaled' : 'emp-maha');
  await form.getByLabel('آخر يوم عمل').fill(today);
  await form.getByRole('button', { name: 'احتساب' }).click();
  await expect(page.getByText('بدل الرصيد').first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('entitlement-hr.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'إرسال للمراجعة المالية' }).click();
  await expect(page.getByText('بانتظار مراجعة المالية')).toBeVisible();

  await persona(page, 'emp-reem');
  await page.goto('/leave-entitlement');
  await page.getByRole('button', { name: 'مراجعة وإحالة للاعتماد' }).click();
  await expect(page.getByText('بانتظار الاعتماد', { exact: true })).toBeVisible();

  await persona(page, 'emp-abdullah');
  await page.goto('/leave-entitlement');
  await expect(page.getByRole('button', { name: 'اعتماد', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('entitlement-approver.png'), fullPage: true });
  await page.getByRole('button', { name: 'اعتماد', exact: true }).click();
  await expect(page.getByText('معتمدة', { exact: true }).last()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('entitlement-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Art. 109: an approved leave next month is paid in advance in this month's run.
  const webkit = testInfo.project.name === 'webkit';
  const [period, start, end] = webkit
    ? ['2028-03', '2028-04-09', '2028-04-11']
    : ['2028-01', '2028-02-06', '2028-02-08'];
  await persona(page, 'emp-sara');
  const { leave } = await call(page, '/leaves', { startDate: start, endDate: end, note: '' });
  await persona(page, 'emp-omar');
  const managed = await call(page, `/leaves/${leave.id}/decision`, {
    decision: 'approve',
    version: leave.version,
  });
  await persona(page, 'emp-noura');
  await call(page, `/leaves/${leave.id}/decision`, {
    decision: 'approve',
    version: managed.leave.version,
  });
  const { run } = await call(page, '/admin/payroll', {
    period,
    reason: 'مسير اختبار الأجر المقدم',
  });
  const advance = run.lines.find(
    (l: { employeeId: string; component: string }) =>
      l.employeeId === 'emp-sara' && l.component === 'أجر إجازة مقدم',
  );
  expect(advance?.sourceLeaveId).toBe(leave.id);
  await page.goto('/payroll');
  await page.getByRole('button', { name: new RegExp(period) }).click();
  await expect(page.getByRole('columnheader', { name: 'أجر إجازة مقدم' }).first()).toBeVisible();
  await page.getByText('الأسطر التفصيلية ومصادرها').click();
  await expect(page.getByText('إجازة سنوية معتمدة (م109)').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('leave-advance-payroll.png'), fullPage: true });
});
