import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /سارة القحطاني/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
}

test('employee profile remains usable at narrow widths and opens a dedicated printable report', async ({
  page,
  browserName,
}) => {
  await login(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/profile/file');
    await expect(page.getByRole('heading', { name: 'الملف الوظيفي', exact: true })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, `unexpected horizontal overflow at ${width}px`).toBeFalsy();
    if (width === 390) {
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(result.violations.map((violation) => violation.id)).toEqual([]);
      const bankTab = page.getByRole('button', { name: 'البنك', exact: true });
      await bankTab.focus();
      await expect(bankTab).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('heading', { name: 'البيانات البنكية', exact: true }),
      ).toBeVisible();
    }
    await page.screenshot({ path: `artifacts/screenshots/profile-overview-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'طباعة / حفظ PDF' }).click();
  await expect(page.getByRole('heading', { name: 'الملف الوظيفي', exact: true })).toBeVisible();
  await expect(page.locator('.employee-report')).toBeVisible();
  await expect(page.locator('.employee-report-brand img')).toHaveAttribute(
    'src',
    '/brand/sabq-logo.svg',
  );
  await expect(page.getByRole('button', { name: 'طباعة / حفظ PDF' })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: 'artifacts/screenshots/profile-report.png', fullPage: true });
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.employee-report')).toBeVisible();
  await expect(page.locator('.employee-report-controls')).toBeHidden();
  await page.screenshot({ path: 'artifacts/screenshots/profile-report-print.png', fullPage: true });
  if (browserName === 'chromium') {
    await page.pdf({
      path: 'artifacts/screenshots/employee-profile-report.pdf',
      preferCSSPageSize: true,
      printBackground: true,
    });
  }
  await page.emulateMedia({ media: 'screen' });
});
