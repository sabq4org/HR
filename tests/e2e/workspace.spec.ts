import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function login(page: Page, name = 'نورة العتيبي') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
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
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
}
function futureSunday(offset: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) + offset);
  return d.toISOString().slice(0, 10);
}

test('Arabic workspace uses supplied display font; all six pages and search work', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await page.screenshot({ path: 'artifacts/screenshots/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/screenshots/dashboard-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
    'Year of Handicrafts',
  );
  expect(await page.evaluate(() => document.fonts.check('700 24px "Year of Handicrafts"'))).toBe(
    true,
  );
  for (const [path, title] of [
    ['/profile', 'ملفي الوظيفي'],
    ['/leaves', 'الإجازات والطلبات'],
    ['/approvals', 'صندوق الموافقات'],
    ['/employees', 'دليل الفريق'],
    ['/calendar', 'تقويم الفريق'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.locator('.global-search').click();
  await page.getByRole('textbox', { name: 'بحث شامل' }).fill('سارة');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /سارة القحطاني محررة/ })
    .click();
  await expect(page.getByRole('heading', { name: 'سارة القحطاني', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('real leave journey persists across reload, goes manager then HR, and appears on calendar', async ({
  page,
}, testInfo) => {
  await login(page, 'سارة القحطاني');
  const offset = testInfo.project.name === 'webkit' ? 70 : 49;
  const before = await page.evaluate(
    async () => (await (await fetch('/api/bootstrap')).json()).balance,
  );
  const start = futureSunday(offset);
  const end = futureSunday(offset + 1);
  await page.getByRole('button', { name: 'طلب إجازة', exact: true }).click();
  await page.getByLabel('من تاريخ').fill(start);
  await page.getByLabel('إلى تاريخ').fill(end);
  await page.getByRole('button', { name: 'مراجعة الطلب', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('المدير المباشر، ثم الموارد البشرية'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'إرسال الطلب', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('أُرسل طلبك');
  const own = await page.evaluate(
    async () => (await (await fetch('/api/bootstrap')).json()).balance,
  );
  expect(own.reserved).toBe(before.reserved + 2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  const id = await page.evaluate(
    async (start) =>
      (await (await fetch('/api/bootstrap')).json()).leaves.find(
        (l: { startDate: string }) => l.startDate === start,
      ).id,
    start,
  );
  await switchPersona(page, 'عمر الشمري');
  await page.goto('/approvals');
  // Identify the new request by its local date label instead of relying on row order.
  const label = await page.evaluate(async (id) => {
    const b = await (await fetch('/api/bootstrap')).json();
    const l = b.leaves.find((l: { id: string }) => l.id === id);
    return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
      day: 'numeric',
      month: 'long',
      timeZone: 'Asia/Riyadh',
    }).format(new Date(l.startDate + 'T12:00:00Z'));
  }, id);
  await page
    .getByRole('button', { name: `تفاصيل طلب سارة القحطاني من ${label}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'موافقة', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await switchPersona(page, 'نورة العتيبي');
  await page.goto('/approvals');
  await page
    .getByRole('button', { name: `تفاصيل طلب سارة القحطاني من ${label}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'موافقة', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await switchPersona(page, 'سارة القحطاني');
  const result = await page.evaluate(async (id) => {
    const b = await (await fetch('/api/bootstrap')).json();
    return { leave: b.leaves.find((l: { id: string }) => l.id === id), balance: b.balance };
  }, id);
  expect(result.leave.status).toBe('approved');
  expect(result.balance.used).toBe(before.used + 2);
  expect(result.balance.reserved).toBe(before.reserved);
  await page.goto('/calendar');
  const targetMonth = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Riyadh',
  }).format(new Date(start + 'T12:00:00Z'));
  for (
    let i = 0;
    i < 4 && !(await page.getByRole('heading', { name: targetMonth, exact: true }).isVisible());
    i++
  )
    await page.getByRole('button', { name: 'الشهر التالي' }).click();
  await expect(page.locator('.calendar-event').filter({ hasText: 'سارة' }).first()).toBeVisible();
});

test('pending request can be cancelled, employee scope stays private, unsupported approval route is explained', async ({
  page,
}, testInfo) => {
  await login(page, 'سارة القحطاني');
  const start = futureSunday(testInfo.project.name === 'webkit' ? 105 : 98);
  const created = await page.evaluate(async (start) => {
    const response = await fetch('/api/leaves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ startDate: start, endDate: start, note: 'اختبار سحب الطلب' }),
    });
    return response.status;
  }, start);
  expect(created).toBe(201);
  await page.goto('/leaves');
  const label = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Riyadh',
  }).format(new Date(start + 'T12:00:00Z'));
  await page
    .getByRole('button', { name: `تفاصيل طلب سارة القحطاني من ${label}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'سحب الطلب', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد سحب الطلب' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/employees/emp-noura');
  await expect(page.getByRole('heading', { name: 'الملف غير متاح' })).toBeVisible();
  const forbidden = await page.evaluate(
    async () => (await fetch('/api/employees/emp-noura')).status,
  );
  expect(forbidden).toBe(403);
  await switchPersona(page, 'نورة العتيبي');
  await page.getByRole('button', { name: 'طلب إجازة', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('لا يتوفر لهذا الحساب مسار موافقة كامل');
});

test('mobile 390px and 320px navigates, forms fit, keyboard modal restores focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'سارة القحطاني');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [path, title] of [
      ['/', 'لوحة العمل'],
      ['/profile', 'ملفي الوظيفي'],
      ['/leaves', 'الإجازات والطلبات'],
      ['/calendar', 'تقويم الفريق'],
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'طلب إجازة', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'فتح القائمة' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'تقويم الفريق' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'تقويم الفريق', exact: true })).toBeVisible();
});

test('WCAG automated checks pass for main pages and leave dialog', async ({ page }) => {
  await login(page);
  for (const path of ['/', '/employees', '/profile', '/leaves', '/approvals', '/calendar']) {
    await page.goto(path);
    await page.locator('h1').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations,
      `${path}: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))}`,
    ).toEqual([]);
  }
  await switchPersona(page, 'سارة القحطاني');
  await page.getByRole('button', { name: 'طلب إجازة', exact: true }).click();
  const dialogResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(dialogResults.violations).toEqual([]);
});
