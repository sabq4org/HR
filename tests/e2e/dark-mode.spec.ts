import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Dark appearance (decision 018): visible switch, saved per browser, AA contrast, light print and
// light paper previews.

async function login(page: Page, name = 'نورة العتيبي') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function chooseTheme(page: Page, label: 'فاتح' | 'داكن' | 'حسب الجهاز') {
  await page.locator('.topbar .theme-trigger').click();
  await page.getByRole('menuitemradio', { name: label }).click();
  await expect(page.getByRole('menu', { name: 'مظهر النظام' })).toHaveCount(0);
}

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('appearance switch saves the choice, follows the device, and keeps AA contrast', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  const html = page.locator('html');
  // Default: follow the device.
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.topbar .theme-trigger')).toHaveAccessibleName('المظهر: حسب الجهاز');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'light');

  // An explicit choice wins over the device and survives a reload (applied before first paint).
  await chooseTheme(page, 'داكن');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBackground(page)).toBe('rgb(18, 28, 41)');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.topbar .theme-trigger')).toHaveAccessibleName('المظهر: داكن');
  expect(await page.evaluate(() => localStorage.getItem('sabq-theme'))).toBe('dark');

  // The menu is keyboard operable and closes on Escape.
  await page.locator('.topbar .theme-trigger').click();
  await expect(page.getByRole('menuitemradio', { name: 'داكن' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'حسب الجهاز' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.topbar .theme-trigger')).toBeFocused();

  await page.screenshot({ path: testInfo.outputPath('dark-dashboard.png') });
  for (const path of [
    '/',
    '/profile',
    '/employees',
    '/leaves',
    '/approvals',
    '/calendar',
    '/payroll',
    '/leave-entitlement',
    '/end-of-service',
    '/audit',
    '/settings/accounts',
  ]) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    expect(violations, `${path} contrast in dark mode`).toEqual([]);
  }

  // Forms and dialogs.
  await page.goto('/leaves');
  await page.getByRole('button', { name: 'طلب إجازة' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const dialog = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(dialog.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('dark-leave-dialog.png') });

  // Print always uses the light rules.
  await page.emulateMedia({ media: 'print' });
  expect(await bodyBackground(page)).toBe('rgb(255, 255, 255)');
  await page.emulateMedia({ media: 'screen' });

  // Back to light.
  await page.keyboard.press('Escape');
  await chooseTheme(page, 'فاتح');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('payroll register reads in dark mode and its printed sheet stays light', async ({
  page,
}, testInfo) => {
  const period = testInfo.project.name === 'webkit' ? '2028-10' : '2028-09';
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/payroll');
  await page.locator('input[type="month"]').fill(period);
  await page.getByLabel('سبب الإنشاء').fill(`مسير تجريبي ${period}`);
  await page.getByRole('button', { name: 'إنشاء مسودة', exact: true }).click();
  await expect(page.getByRole('heading', { name: `مسير ${period}`, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dark-payroll.png'), fullPage: true });
  const { violations } = await new AxeBuilder({ page })
    .include('.payroll-page')
    .withRules(['color-contrast'])
    .analyze();
  expect(violations).toEqual([]);
  // The printable register on screen keeps its paper colours.
  const sheet = page.locator('.payroll-print-sheet').first();
  if (await sheet.count()) {
    expect(await sheet.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(20, 45, 72)');
  }
});
