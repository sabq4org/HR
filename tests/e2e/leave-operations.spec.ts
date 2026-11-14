import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, name = 'سارة القحطاني') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'لوحة العمل', exact: true })).toBeVisible();
}

test('approved annual change is linked, independently reviewed, and visible with history and actions', async ({
  page,
}, testInfo) => {
  await login(page);
  const operation = await page.evaluate(async (suffix) => {
    const future = (offset: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) + offset);
      return d.toISOString().slice(0, 10);
    };
    const plus = (date: string, n: number) => {
      const d = new Date(`${date}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const start = future(200 + (suffix === 'webkit' ? 7 : 0));
    const request = async (path: string, body: any, key: string) => {
      const response = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error?.message ?? `HTTP ${response.status}`);
      return json;
    };
    const persona = async (employeeId: string) =>
      request('/demo/session', { employeeId }, `session-${employeeId}-${suffix}`);
    const original = (
      await request(
        '/leaves',
        { startDate: start, endDate: plus(start, 1), note: 'اختبار تغطية واجهة' },
        `create-${suffix}`,
      )
    ).leave;
    await persona('emp-omar');
    const manager = (
      await request(
        `/leaves/${original.id}/decision`,
        { decision: 'approve', version: original.version },
        `manager-${suffix}`,
      )
    ).leave;
    await persona('emp-noura');
    const approved = (
      await request(
        `/leaves/${original.id}/decision`,
        { decision: 'approve', version: manager.version },
        `hr-${suffix}`,
      )
    ).leave;
    await persona('emp-sara');
    const change = (
      await request(
        `/leaves/${original.id}/changes`,
        {
          kind: 'extend',
          version: approved.version,
          startDate: start,
          endDate: plus(start, 3),
          reason: 'تمديد تغطية اصطناعي',
        },
        `change-${suffix}`,
      )
    ).change;
    await persona('emp-omar');
    const managerChange = (
      await request(
        `/leave-changes/${change.id}/decision`,
        { decision: 'approve', version: change.version },
        `manager-change-${suffix}`,
      )
    ).change;
    await persona('emp-noura');
    const finalChange = (
      await request(
        `/leave-changes/${change.id}/decision`,
        { decision: 'approve', version: managerChange.version },
        `hr-change-${suffix}`,
      )
    ).change;
    await persona('emp-sara');
    return { start, id: original.id, changeId: finalChange.id };
  }, testInfo.project.name);
  await page.goto('/leaves');
  await page.locator(`.leave-row[data-leave-id="${operation.id}"]`).click();
  await expect(page.getByRole('heading', { name: 'سجل التغييرات المرتبطة' })).toBeVisible();
  await expect(page.getByText(/تمديد · معتمد/)).toBeVisible();
  await expect(page.getByText('الأصل:', { exact: false })).toBeVisible();
});
