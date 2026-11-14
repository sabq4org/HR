import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function login(page: Page, name = 'نورة العتيبي') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
}

async function switchPersona(page: Page, name: string) {
  await page.locator('.switch-persona').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.header-profile')).toContainText(name.split(' ')[0]);
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
}

test('HR creates an employee through grouped steps and edits the employee file', async ({
  page,
}, info) => {
  await login(page);
  await page.goto('/employees');
  await page.getByRole('button', { name: 'إضافة موظف' }).click();
  const dialog = page.getByRole('dialog');
  const suffix = `${Date.now()}-${info.project.name}`.replace(/[^a-z0-9-]/gi, '');
  const name = `موظف إداري ${suffix}`;
  await dialog.getByLabel(/الاسم بالعربية/).fill(name);
  await dialog.getByLabel(/الرقم الوظيفي/).fill(`ADM-${suffix}`);
  await dialog.getByRole('button', { name: 'التالي' }).click();
  await dialog
    .getByRole('textbox', { name: 'البريد الوظيفي' })
    .fill(`admin-${suffix}@example.test`);
  await dialog.getByRole('button', { name: 'التالي' }).click();
  await dialog.getByLabel(/الإدارة/).fill('التحرير');
  await dialog.getByLabel(/المسمى الوظيفي/).fill('محرر تجريبي');
  await dialog.getByLabel(/تاريخ المباشرة الفعلي/).fill('2026-01-01');
  await dialog.getByLabel(/موقع العمل/).fill('الرياض');
  await dialog.getByRole('button', { name: 'التالي' }).click();
  for (const group of ['العقد', 'المالية', 'التأمينات', 'الإجازات', 'المؤهلات', 'انتهاء العلاقة']) {
    await dialog.getByRole('button', { name: group, exact: true }).click();
    await dialog.getByRole('button', { name: 'التالي' }).click();
  }
  {
    await expect(dialog.getByRole('heading', { name: 'راجع البيانات قبل الحفظ' })).toBeVisible();
    await expect(dialog.getByText(name)).toBeVisible();
    await expect(page).toHaveURL(/\/employees$/);
    await dialog.getByRole('button', { name: 'إنشاء الملف' }).click();
  }
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/employees\/[^/]+\/file$/);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'تعديل الملف' }).click();
  await page.getByRole('button', { name: 'العمل', exact: true }).click();
  await page.getByLabel(/المسمى الوظيفي/).fill('محرر أول تجريبي');
  await page.getByRole('button', { name: 'المراجعة', exact: true }).click();
  await page.getByLabel('سبب التعديل').fill(`مراجعة ${suffix}`);
  await page.getByRole('button', { name: 'حفظ التعديلات' }).click();
  await expect(page.getByRole('button', { name: 'تعديل الملف' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'تعديل الملف' })).toBeVisible();
  await expect(page.getByText('محرر أول تجريبي', { exact: true })).toBeVisible();
  expect(
    await page
      .locator('.adm-tabs')
      .first()
      .evaluate((el) => getComputedStyle(el).flexDirection),
  ).toBe('row');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: 'artifacts/screenshots/administration-employee-file.png',
    fullPage: false,
  });
});

test('employee submits an employment letter, HR approves it and the internal preview prints', async ({
  page,
}) => {
  await login(page, 'سارة القحطاني');
  await page.goto('/services');
  await page.getByRole('button', { name: /تعريف بالعمل/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/الجهة الموجه إليها/).fill('جهة تجريبية');
  await dialog.getByLabel(/الغرض/).fill('اختبار إصدار خطاب عمل');
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/requests') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'إرسال للمراجعة' }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  const requestId = payload.request.id as string;
  await switchPersona(page, 'نورة العتيبي');
  await page.goto(`/requests/${requestId}`);
  await expect(
    page.getByRole('heading', { name: 'تعريف بالعمل', level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'اعتماد' }).click();
  await expect(page.getByText('معتمد', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'طباعة' })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.issued-letter')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.getByText(/نسخة محفوظة وقت الاعتماد/)).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await page.screenshot({
    path: 'artifacts/screenshots/administration-issued-letter.png',
    fullPage: true,
  });
});

test('private employee documents accept permitted files and download through the authenticated route', async ({
  page,
}, info) => {
  await login(page);
  const employeeId = await page.evaluate(
    async () =>
      (await (await fetch('/api/bootstrap')).json()).employees.find(
        (e: { name: string }) => e.name === 'سارة القحطاني',
      ).id as string,
  );
  await page.goto(`/employees/${employeeId}/file`);
  await page.getByRole('button', { name: 'الوثائق', exact: true }).click();
  const suffix = `${Date.now()}-${info.project.name}`;
  const path = `/tmp/sabq-private-${suffix}.pdf`;
  const fs = await import('node:fs/promises');
  await fs.writeFile(path, Buffer.from('%PDF-1.4\n% synthetic e2e document\n%%EOF'));
  await page.locator('.adm-upload').getByLabel('الصنف').selectOption('cv');
  await page.getByLabel('ملف حتى 2 ميغابايت').setInputFiles(path);
  await page.getByRole('button', { name: 'رفع الوثيقة' }).click();
  const filename = `sabq-private-${suffix}.pdf`;
  await expect(page.getByRole('button', { name: filename })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: filename }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(filename);
});

test('administrative pages stay RTL, fit desktop and mobile, and pass automated accessibility checks', async ({
  page,
}) => {
  await login(page);
  for (const path of [
    '/services',
    '/requests',
    '/attendance',
    '/documents',
    '/settings/policies',
    '/reports',
    '/audit',
  ]) {
    await page.goto(path);
    await page.locator('.admin-page h1').waitFor();
    expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      path,
    ).toBe(true);
    await axe(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${path} mobile`,
    ).toBe(true);
    await axe(page);
    if (path === '/services')
      await page.screenshot({
        path: 'artifacts/screenshots/administration-services-mobile.png',
        fullPage: true,
      });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.goto('/profile/file');
  await page.locator('.admin-page h1').waitFor();
  await axe(page);
});

test('manager chooses a team member for a reward and sees an Arabic approval route', async ({
  page,
}) => {
  await login(page, 'عمر الشمري');
  await page.goto('/services');
  await page.getByRole('button', { name: /توصية بمكافأة/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('الموظف المعني بالطلب').selectOption('emp-sara');
  await expect(dialog).toContainText('الشؤون الإدارية ← المعتمد المستقل');
  await dialog.getByLabel(/المبلغ بالريال/).fill('750.25');
  await dialog.getByLabel(/تاريخ السريان/).fill('2026-11-14');
  await dialog.getByLabel(/الإنجاز/).fill('تغطية اصطناعية لاختبار تجربة المدير');
  await dialog.getByLabel(/المبرر/).fill('توصية تجريبية لمراجعة الفريق');
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith('/api/admin/requests') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'إرسال للمراجعة' }).click();
  const response = await submitted;
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = await response.json();
  expect(payload.request.employeeId).toBe('emp-sara');
  await expect(dialog).toHaveCount(0);
});

test('HR downloads an Excel template, previews a row, and saves the employee batch', async ({
  page,
}, info) => {
  await login(page);
  await page.goto('/employees/import');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: 'تنزيل قالب Excel' }).click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).toBeTruthy();
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path!);
  const sheet = workbook.getWorksheet('الموظفون')!;
  const suffix = `${Date.now()}-${info.project.name}`;
  const values: Record<string, string> = {
    name: `موظف استيراد ${suffix}`,
    employeeNumber: `IMP-${suffix}`,
    department: 'التحرير',
    title: 'محرر تجريبي',
    email: `import-${suffix}@example.test`,
    location: 'الرياض',
    joinDate: '2026-01-01',
  };
  const { employeeFields } = await import('../../shared/catalog');
  sheet.getRow(1).eachCell((cell, col) => {
    const field = employeeFields.find((f) => f.label === cell.text || f.key === cell.text);
    sheet.getRow(2).getCell(col).value = field ? (values[field.key] ?? null) : null;
  });
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await page.getByLabel('ملف الموظفين Excel').setInputFiles({
    name: 'synthetic-employees.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  await expect(page.getByText('الدفعة جاهزة للحفظ')).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'حفظ 1 ملفًا' }).click();
  await expect(page.getByRole('heading', { name: 'أُضيفت الملفات بنجاح' })).toBeVisible();
  await page.getByRole('link', { name: 'عرض دليل الفريق' }).click();
  await expect(page.getByText(values.name)).toBeVisible();
});

test('HR sets on-duty status from the team card switch; other roles get no switch', async ({
  page,
}) => {
  await login(page);
  await page.goto('/employees');
  const card = page.locator('.person-card', { hasText: 'فهد الدوسري' });
  const toggle = card.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // HR cannot switch their own status.
  await expect(
    page.locator('.person-card', { hasText: 'نورة العتيبي' }).getByRole('switch'),
  ).toHaveCount(0);
  await axe(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(card).toContainText('منتهية الخدمة');
  await expect(page).toHaveURL(/\/employees$/);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(card).toContainText('على رأس العمل');
  // The rest of the card still opens the profile.
  await card.getByRole('link', { name: 'فهد الدوسري' }).click();
  await expect(page).toHaveURL(/\/employees\/emp-fahad$/);
  await switchPersona(page, 'عمر');
  await page.goto('/employees');
  await expect(page.locator('.person-card').first()).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(0);
});
