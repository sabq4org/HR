import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** Owner renewal journey: synthetic loopback fixture only. */
// The finance owner cannot edit his own personal file; seed the synthetic document on the
// second HR persona, then assign the case back to the finance owner.
const employeeId = 'emp-finance-other';
const financeOwnerId = 'emp-finance-owner';
const pdf = Buffer.from('%PDF-1.4\n% synthetic renewal proof\n%%EOF\n').toString('base64');

const riyadhDate = (offset = 0) => {
  const value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

async function jsonPost(page: Page, path: string, body: unknown) {
  const response = await page.request.post(path, {
    data: body,
    headers: { Origin: 'http://127.0.0.1:4319', 'Idempotency-Key': randomUUID() },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function jsonGet(page: Page, path: string) {
  const response = await page.request.get(path, {
    headers: { Origin: 'http://127.0.0.1:4319' },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

test('owner renewal: assign, prove, renew, reconcile an owner-paid voucher, and persist refunds', async ({
  page,
  browser,
}, testInfo) => {
  const runTag = `${testInfo.project.name}-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
  const otherHr = await browser.newPage();
  await otherHr.goto('/');
  await otherHr.getByRole('button', { name: /مسؤول آخر/ }).click();
  await expect(otherHr.getByRole('heading', { name: 'متابعة الوثائق', exact: true })).toBeVisible();
  await otherHr.close();

  // Seed only synthetic data through the authenticated loopback API. The document is deliberately
  // expiring soon and has an expected fee matching the owner-paid ledger voucher.
  const uploaded = (await jsonPost(page, `/api/admin/employees/${employeeId}/documents`, {
    category: 'passport',
    filename: `passport-expiring-synthetic-${runTag}.pdf`,
    mimeType: 'application/pdf',
    contentBase64: pdf,
    expiresAt: riyadhDate(7),
    renewalFee: '650',
  })) as { document: { id: string; version: number } };
  const documentId = uploaded.document.id;

  const ledger = (await jsonGet(page, '/api/finance/ledger')) as { initialized: boolean };
  if (!ledger.initialized) await jsonPost(page, '/api/finance/ledger/setup', {});
  const expense = (await jsonPost(page, '/api/finance/ledger/expenses', {
    date: riyadhDate(),
    description: 'رسوم تجديد جواز اصطناعي',
    accountCode: '5206',
    taxCode: 'O',
    net: '650.00',
    paidBy: 'owner',
    cashAccountCode: '',
    reference: `RENEWAL-${randomUUID().slice(0, 8)}`,
  })) as { voucher: { id: string; totalHalalas: number } };
  expect(expense.voucher.totalHalalas).toBe(65000);
  const voucherId = expense.voucher.id;

  // Landing identifies the expiring personal item before the case is opened.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'مكتب المالك', exact: true })).toBeVisible();
  const item = page.locator(`a[href="/renewals?document=${documentId}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(/\/renewals\?document=/);

  await page.getByLabel('المسؤول عن التجديد').selectOption(financeOwnerId);
  await page.getByRole('button', { name: 'فتح معاملة التجديد', exact: true }).click();
  await expect(page).toHaveURL(/\/renewals\?case=/);
  const caseId = new URL(page.url()).searchParams.get('case');
  expect(caseId).toBeTruthy();

  const proof = {
    name: `renewal-proof-synthetic-${runTag}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% proof\n%%EOF\n'),
  };
  await page.getByLabel('تاريخ الانتهاء الجديد').fill(riyadhDate(365));
  await page.getByLabel('طريقة السداد').selectOption('owner');
  await page.getByLabel('رفع إثبات التجديد').setInputFiles(proof);
  await page.getByLabel('مرجع التجديد أو ملاحظته').fill('تجديد جواز اصطناعي عبر الرحلة المقبولة');
  await page.getByRole('button', { name: 'تأكيد التجديد', exact: true }).click();
  await expect(page.getByText('تم تجديد الوثيقة', { exact: true })).toBeVisible();
  const renewalList = (await jsonGet(page, '/api/admin/renewals')) as {
    cases: Array<{ id: string; status: string; proofDocumentId: string | null }>;
  };
  const completedCase = renewalList.cases.find((item) => item.id === caseId);
  expect(completedCase?.status).toBe('renewed');
  expect(completedCase?.proofDocumentId).toBeTruthy();
  const employeeDocuments = (await jsonGet(
    page,
    `/api/admin/documents?employeeId=${encodeURIComponent(employeeId)}`,
  )) as { documents: Array<{ category: string; filename: string }> };
  expect(
    employeeDocuments.documents.filter(
      (item) => item.category === 'renewal_proof' && item.filename === proof.name,
    ),
  ).toHaveLength(1);

  // The finance card links the already-posted owner-paid voucher; it must not create another one.
  await expect(page.getByRole('region', { name: 'مطابقة رسوم التجديد' })).toBeVisible();
  const settlement = page.getByRole('region', { name: 'مطابقة رسوم التجديد' });
  await settlement.locator('select').selectOption(voucherId);
  await settlement.getByRole('button', { name: 'ربط السند بالحالة', exact: true }).click();
  await expect(settlement).toContainText('إجمالي 650.00');
  await expect(settlement).toContainText('المسترد 0.00');
  await expect(settlement).toContainText('المتبقي 650.00');

  // Reimbursements are posted through the ordinary owner-payable ledger API. The settlement view
  // derives its partial/full amounts from those posted allocations, rather than storing a copy.
  await jsonPost(page, '/api/finance/ledger/owner/refunds', {
    date: riyadhDate(),
    amount: '300.00',
    cashAccountCode: '1102',
    reference: 'REF-RENEWAL-PARTIAL',
    claimIds: [voucherId],
  });
  const partial = (await jsonGet(
    page,
    `/api/finance/ledger/renewal-settlements/${encodeURIComponent(caseId!)}`,
  )) as { settlement: { voucher: { refundedHalalas: number; remainingHalalas: number } } };
  expect(partial.settlement.voucher.refundedHalalas).toBe(30000);
  expect(partial.settlement.voucher.remainingHalalas).toBe(35000);

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'مطابقة رسوم التجديد' });
  await expect(reloaded).toContainText('المسترد 300.00');
  await expect(reloaded).toContainText('المتبقي 350.00');

  await jsonPost(page, '/api/finance/ledger/owner/refunds', {
    date: riyadhDate(),
    amount: '350.00',
    cashAccountCode: '1102',
    reference: 'REF-RENEWAL-FULL',
    claimIds: [voucherId],
  });
  const full = (await jsonGet(
    page,
    `/api/finance/ledger/renewal-settlements/${encodeURIComponent(caseId!)}`,
  )) as { settlement: { voucher: { refundedHalalas: number; remainingHalalas: number } } };
  expect(full.settlement.voucher.refundedHalalas).toBe(65000);
  expect(full.settlement.voucher.remainingHalalas).toBe(0);

  await page.reload();
  await expect(page.getByRole('region', { name: 'مطابقة رسوم التجديد' })).toContainText(
    'المسترد 650.00',
  );
  await expect(page.getByRole('region', { name: 'مطابقة رسوم التجديد' })).toContainText(
    'المتبقي 0.00',
  );

  // Reasonable mobile check for the same persisted state.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'مطابقة رسوم التجديد' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a profile-only expiry can be documented and assigned from the same renewal page', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: /مسؤول الفوترة التجريبي/ }).click();
  await expect(page.getByRole('heading', { name: 'مكتب المالك' })).toBeVisible();
  const employee = await jsonPost(page, '/api/admin/employees', {
    values: {
      name: 'موظف اختبار الوثيقة',
      email: 'test-' + randomUUID().slice(0, 8) + '@example.test',
      location: 'الرياض',
      employeeNumber: 'RENEW-' + randomUUID().slice(0, 8),
      department: 'التحرير',
      title: 'محرر',
      joinDate: riyadhDate(-200),
      nationalIdExpiry: riyadhDate(9),
      employmentStatus: 'active',
    },
  });
  const subjectId = employee.file.employee.id;
  await page.goto('/renewals');
  // The profile-derived key includes a "profile-" prefix and the underlying field.
  const profileRow = page.locator('a[href*="profile-' + subjectId + '-"]');
  await expect(profileRow).toBeVisible();
  await profileRow.click();
  await page.getByLabel('الوثيقة الحالية').setInputFiles({
    name: 'existing-synthetic-' + testInfo.project.name + '.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf, 'base64'),
  });
  await page.getByLabel('رسوم التجديد المتوقعة بالريال (اختياري)').fill('50');
  await page.getByRole('button', { name: 'إرفاق الوثيقة ومتابعة التجديد' }).click();
  await expect(page).toHaveURL(/renewals\?document=/);
  await page.getByRole('button', { name: 'فتح معاملة التجديد' }).click();
  await expect(page).toHaveURL(/renewals\?case=/);
  await expect(page.getByText('50 ريال', { exact: true })).toBeVisible();
});
