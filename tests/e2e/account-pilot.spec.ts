import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { generate } from 'otplib';
import { createDatabase, type Db } from '../../server/database.js';
import { createApp } from '../../server/app.js';
import { bootstrapAccounts } from '../../server/bootstrap-accounts.js';

let db: Db;
let server: Server;
let origin: string;
let activationToken: string;
test.beforeEach(async () => {
  db = await createDatabase(':memory:', { seed: false });
  const invitations = await bootstrapAccounts(db, [
    {
      name: 'مسؤولة حسابات اصطناعية',
      employeeNumber: 'TEST-HR',
      email: 'hr@example.test',
      title: 'موارد بشرية',
      department: 'اختبار',
      location: 'الرياض',
      joinDate: '2026-11-01',
      role: 'hr',
    },
    {
      name: 'معتمد اصطناعي',
      employeeNumber: 'TEST-APPROVER',
      email: 'approver@example.test',
      title: 'معتمد',
      department: 'اختبار',
      location: 'الرياض',
      joinDate: '2026-11-01',
      role: 'approver',
    },
  ]);
  activationToken = invitations[0].activationToken;
  const app = createApp(db, { authMode: 'accounts' });
  app.use(express.static(resolve('dist/client'), { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
  server = createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing account test listener.');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await db.close();
});

test('employee activates MFA, enters durable account workspace without a leave policy, and cannot reuse recovery code', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/activate#token=${activationToken}`);
  await expect(page.getByRole('heading', { name: 'إعداد الدخول الآمن' })).toBeVisible();
  const secretElement = page.locator('.account-setup-box > code').nth(1);
  await expect(secretElement).not.toBeEmpty();
  expect(new URL(page.url()).hash).toBe('');
  const secret = (await secretElement.textContent())!;
  const password = 'Synthetic-Test-Password-2026!';
  await page.getByLabel('كلمة مرور جديدة').fill(password);
  await page.getByLabel('رمز المصادقة من ستة أرقام').fill(await generate({ secret }));
  await page.getByRole('button', { name: 'تفعيل الحساب', exact: true }).click();
  await expect(page.locator('.recovery-codes li')).toHaveCount(10);
  const recoveryCode = (await page.locator('.recovery-codes li').first().textContent())!;
  await page.getByRole('button', { name: 'تم الحفظ والعودة' }).click();
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول', exact: true })).toBeVisible();
  await page.getByLabel('البريد الإلكتروني', { exact: true }).fill('hr@example.test');
  await page.getByLabel('كلمة المرور', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'استخدم رمز استرداد', exact: true }).click();
  await page.getByLabel('رمز استرداد لمرة واحدة').fill(recoveryCode);
  await page.getByRole('button', { name: 'دخول آمن' }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  const session = await (await page.request.get(`${origin}/api/session`)).json();
  expect(session.mode).toBe('operational');
  expect(session.personas).toEqual([]);
  expect(
    (
      await page.request.post(`${origin}/api/demo/session`, {
        headers: { origin },
        data: { employeeId: 'emp-noura' },
      })
    ).status(),
  ).toBe(404);
  expect((await page.request.get(`${origin}/api/admin/payroll`)).status()).toBe(409);
  await page.goto(`${origin}/settings/accounts`);
  await expect(page.getByRole('heading', { name: 'حسابات الموظفين' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/screenshots/account-pilot-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول', exact: true })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
  await page.getByLabel('البريد الإلكتروني', { exact: true }).fill('hr@example.test');
  await page.getByLabel('كلمة المرور', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'استخدم رمز استرداد', exact: true }).click();
  await page.getByLabel('رمز استرداد لمرة واحدة').fill(recoveryCode);
  await page.getByRole('button', { name: 'دخول آمن' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await page.request.get(`${origin}/api/bootstrap`)).status()).toBe(401);
  expect(errors).toEqual([]);
});
