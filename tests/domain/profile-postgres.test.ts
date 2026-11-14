import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { createPostgresDatabase } from '../../server/database.js';
import { registerAdministration } from '../../server/administration/routes.js';
import { getEmployeeFile, type Actor } from '../../server/administration/service.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

test(
  'PostgreSQL EmployeeFile and approved leave opening/correction links preserve dates and zero',
  { skip: !pgUrl },
  async () => {
    const schema = `hr_preview_${randomBytes(16).toString('hex')}`;
    const db = await createPostgresDatabase(pgUrl!, schema);
    const app = express();
    app.use(express.json());
    const server: Server = createServer(app);
    registerAdministration(app, {
      db,
      requireActor: async (req) => {
        const id = req.header('x-actor') ?? '';
        const role = (
          await db.read<{ role: Actor['role'] }>('SELECT role FROM employee_access WHERE id=?', [
            id,
          ])
        )[0]?.role;
        if (!role) throw new Error('test actor not found');
        return { id, role };
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const hr = (
        await db.read<{ id: string }>("SELECT id FROM employee_access WHERE role='hr' LIMIT 1")
      )[0].id;
      const approver = (
        await db.read<{ id: string }>(
          "SELECT id FROM employee_access WHERE role='approver' LIMIT 1",
        )
      )[0].id;
      const post = (actorId: string, path: string, body: unknown, key: string) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            origin: base,
            'content-type': 'application/json',
            'x-actor': actorId,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        });
      const addEmployee = async (id: string, num: string, email: string) =>
        db.execute(
          'INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,access_role) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,NULL)',
          [
            id,
            num,
            'موظف اختبار PostgreSQL',
            'مخ',
            'محرر',
            'التحرير',
            email,
            'الرياض',
            '2026-01-01',
            'employee',
            'blue',
          ],
        );
      const createAndApprove = async (
        employeeId: string,
        values: Record<string, unknown>,
        key: string,
      ) => {
        const created = await post(
          hr,
          '/api/admin/requests',
          { kind: 'leave_adjustment', employeeId, submit: true, values },
          `${key}-create`,
        );
        assert.equal(created.status, 201, await created.clone().text());
        const { request } = (await created.json()) as { request: { id: string } };
        const approved = await post(
          approver,
          `/api/admin/requests/${request.id}/actions`,
          { version: 1, action: 'approve', reason: 'Reviewed PostgreSQL fixture source' },
          `${key}-approve`,
        );
        assert.equal(approved.status, 200, await approved.clone().text());
        return request.id;
      };

      await addEmployee('pg-opening-zero', 'PG-OPEN-0', 'pg-opening-zero@example.test');
      await createAndApprove(
        'pg-opening-zero',
        {
          adjustmentType: 'opening_balance',
          source: 'PG source zero',
          days: 0,
          effectiveDate: '2026-11-10',
          reason: 'Explicit zero',
        },
        'pg-open-zero',
      );
      const zeroFile = await getEmployeeFile(db, { id: hr, role: 'hr' }, 'pg-opening-zero');
      assert.equal(zeroFile.leaveSummary.openingBalance, 0);
      assert.equal(zeroFile.leaveSummary.available, 0);
      assert.equal(zeroFile.leaveSummary.balanceKnown, true);

      await addEmployee('pg-opening-five', 'PG-OPEN-5', 'pg-opening-five@example.test');
      await createAndApprove(
        'pg-opening-five',
        {
          adjustmentType: 'opening_balance',
          source: 'PG source positive',
          days: 5,
          effectiveDate: '2026-11-09',
          reason: 'Opening five',
        },
        'pg-open-five',
      );
      await createAndApprove(
        'pg-opening-five',
        {
          adjustmentType: 'correction',
          source: 'PG source correction',
          days: -2,
          effectiveDate: '2026-11-11',
          reason: 'Correction negative two',
        },
        'pg-correction-negative',
      );
      const positiveFile = await getEmployeeFile(db, { id: hr, role: 'hr' }, 'pg-opening-five');
      assert.equal(positiveFile.leaveSummary.openingBalance, 5);
      assert.equal(positiveFile.leaveSummary.available, 3);
      assert.ok(
        positiveFile.leaveMovements.some(
          (movement) =>
            movement.days === 5 &&
            movement.effectiveAt === '2026-11-09' &&
            movement.source === 'PG source positive',
        ),
      );
      assert.ok(
        positiveFile.leaveMovements.some(
          (movement) =>
            movement.days === -2 &&
            movement.effectiveAt === '2026-11-11' &&
            movement.source === 'PG source correction',
        ),
      );
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);
