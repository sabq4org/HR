import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** Synthetic data only: the fixture provider returns two made-up contacts and is never online. */
test('customers saved in Wafeq are reviewed, imported once, and then shown as existing', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  const saved = await page.request.post('/api/finance/settings/api-key', {
    data: { apiKey: 'synthetic-fixture-key' },
    headers: { 'Idempotency-Key': randomUUID(), Origin: 'http://127.0.0.1:4319' },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();

  await page.goto('/finance?view=billing');
  await page.getByRole('button', { name: 'استيراد من وافق' }).click();
  const dialog = page.getByRole('dialog', { name: 'استيراد العملاء من وافق' });
  const first = dialog.getByRole('row', { name: /وكالة اصطناعية للاستيراد/ });
  await expect(first).toBeVisible();
  // The fixture database is shared by both browser projects: the second one finds them imported.
  if (testInfo.project.name === 'chromium') {
    await expect(first).toContainText('جديد');
    await expect(dialog.getByRole('button', { name: 'استيراد المحدد (2)' })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('wafeq-import.png') });
    await dialog.getByRole('button', { name: 'استيراد المحدد (2)' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('row', { name: /مؤسسة اصطناعية بلا بريد/ })).toContainText(
      'متزامن',
    );
    await page.getByRole('button', { name: 'استيراد من وافق' }).click();
  }
  await expect(first).toContainText('موجود عندك');
  await expect(first.getByRole('checkbox')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /استيراد المحدد \(0\)/ })).toBeDisabled();
});
