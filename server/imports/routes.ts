import type { Express } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../database.js';
import type { RequireActor } from '../app.js';
import { createEmployee } from '../administration/service.js';
import { registerRoute } from '../administration/common.js';
import { employeesTemplate, parseEmployeesWorkbook, IMPORT_LIMIT } from './workbook.js';
import type { FormValues } from '../../shared/administration.js';

const fault = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code });
export function registerEmployeeImports(
  app: Express,
  { db, requireActor }: { db: Db; requireActor: RequireActor },
) {
  registerRoute(app, 'get', '/api/admin/imports/employees/template', async (req, res) => {
    const actor = await requireActor(req);
    if (actor.role !== 'hr')
      throw fault(403, 'FORBIDDEN', 'استيراد الموظفين متاح للموارد البشرية فقط.');
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment('sabq-employees-template.xlsx')
      .send(await employeesTemplate());
  });
  registerRoute(app, 'post', '/api/admin/imports/employees/preview', async (req, res) => {
    const actor = await requireActor(req);
    if (actor.role !== 'hr')
      throw fault(403, 'FORBIDDEN', 'استيراد الموظفين متاح للموارد البشرية فقط.');
    const body = req.body;
    if (
      !body ||
      typeof body.contentBase64 !== 'string' ||
      body.contentBase64.length > Math.ceil(IMPORT_LIMIT / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(body.contentBase64) ||
      !String(body.filename ?? '')
        .toLowerCase()
        .endsWith('.xlsx')
    )
      throw fault(400, 'INVALID_FILE', 'اختر ملف XLSX لا يتجاوز 2 ميجابايت.');
    const preview = await parseEmployeesWorkbook(Buffer.from(body.contentBase64, 'base64'));
    const existing = await db.read<{ employee_number: string }>(
      'SELECT employee_number FROM employee_access',
    );
    const numbers = new Set(existing.map((e) => e.employee_number));
    const employees = await db.read<{ id: string; role: string; status: string }>(
      'SELECT id,role,status FROM employee_access',
    );
    for (const row of preview.rows) {
      if (numbers.has(String(row.values.employeeNumber)))
        row.errors.push('الرقم الوظيفي موجود بالفعل في النظام');
      if (
        row.values.managerId &&
        !employees.some(
          (e) => e.id === row.values.managerId && e.role === 'manager' && e.status === 'active',
        )
      )
        row.errors.push('المدير المباشر غير موجود أو غير نشط');
    }
    preview.valid = preview.rows.every((row) => !row.errors.length);
    res.json({ preview });
  });
  registerRoute(app, 'post', '/api/admin/imports/employees/commit', async (req, res) => {
    const actor = await requireActor(req);
    if (actor.role !== 'hr')
      throw fault(403, 'FORBIDDEN', 'استيراد الموظفين متاح للموارد البشرية فقط.');
    const rows = req.body?.rows as FormValues[];
    const command = req.get('Idempotency-Key');
    if (!command || !/^[\w-]{8,100}$/.test(command))
      throw fault(400, 'IDEMPOTENCY_REQUIRED', 'أعد المحاولة بمفتاح عملية صالح.');
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      rows.length > 100 ||
      rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))
    )
      throw fault(400, 'INVALID_ROWS', 'الدفعة يجب أن تحتوي من 1 إلى 100 موظف.');
    const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const result = await db.transaction(async (tx) => {
      const previous = (
        await tx.read<{ payload_hash: string; response_json: string }>(
          'SELECT payload_hash,response_json FROM administration_idempotency WHERE actor_id=? AND action=? AND key=?',
          [actor.id, 'employee_import', command],
        )
      )[0];
      if (previous) {
        if (previous.payload_hash !== hash)
          throw fault(409, 'IDEMPOTENCY_CONFLICT', 'هذا المفتاح مستخدم لدفعة أخرى.');
        return JSON.parse(previous.response_json) as { count: number; createdIds: string[] };
      }
      const createdIds: string[] = [];
      for (const values of rows) {
        const file = await createEmployee(tx, actor, values);
        createdIds.push(file.employee.id);
      }
      const reply = { count: createdIds.length, createdIds };
      await tx.execute(
        'INSERT INTO administration_idempotency(actor_id,action,key,payload_hash,response_json,created_at) VALUES(?,?,?,?,?,?)',
        [
          actor.id,
          'employee_import',
          command,
          hash,
          JSON.stringify(reply),
          new Date().toISOString(),
        ],
      );
      await tx.execute(
        'INSERT INTO administration_events(id,resource_type,resource_id,actor_id,actor_role,action,reason,details_json,resource_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          'import',
          randomUUID(),
          actor.id,
          actor.role,
          'employees_imported',
          'استيراد دفعة موظفين اصطناعيين',
          JSON.stringify({ count: createdIds.length }),
          1,
          new Date().toISOString(),
        ],
      );
      return reply;
    });
    res.status(201).json(result);
  });
}
