/**
 * Read-only HR service API for the «محاسب سبق» key (phase 1). Mounted under /api/service/hr.
 *
 * Each route checks its own scope. Sensitive values are returned only with the matching scope:
 * - financial fields (salary, allowances, IBAN, account, insurance): hr.compensation.read
 * - personal and medical fields (national ID, passport, birth date, medical): hr.sensitive.read
 * Any response that carries sensitive values appends an administration event attributed to the
 * service account, listing field names only (never values).
 */
import type { Express, Request } from 'express';
import type { AsyncDb } from '../database.js';
import type { FormValues } from '../../shared/administration.js';
import { employeeFields } from '../../shared/catalog.js';
import {
  appendEvent,
  getEmployeeFile,
  getProfileValues,
  readEmployee,
  type Actor,
  type EmployeeRow,
} from '../administration/service.js';
import { route } from '../administration/common.js';
import { fault } from '../administration/validation.js';
import { SERVICE_ACCOUNT, type HrReadScope } from './keys.js';

export type HrServiceContext = { scopes: readonly HrReadScope[]; keyId: string };
type Options = { db: AsyncDb; contextFor: (req: Request) => HrServiceContext | undefined };
type Row = Record<string, any>;

const fieldByKey = new Map(employeeFields.map((field) => [field.key, field]));
const serviceActor = { id: SERVICE_ACCOUNT.id, role: SERVICE_ACCOUNT.role } as unknown as Actor;
// Internal least-privilege reader used only to compute leave summaries; never a request actor.
const leaveReader: Actor = { id: SERVICE_ACCOUNT.id, role: 'auditor' };

/** Arabic-insensitive normalisation for name search (diacritics, tatweel, alef/yaa/taa forms). */
export function normalizeArabic(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function requireScope(context: HrServiceContext | undefined, scope: HrReadScope): HrServiceContext {
  if (!context) throw fault(401, 'API_KEY_REQUIRED', 'هذا المسار لمفتاح خدمة الموارد البشرية فقط.');
  if (!context.scopes.includes(scope))
    throw fault(403, 'API_KEY_SCOPE', `المفتاح لا يملك صلاحية ${scope}.`);
  return context;
}

function summary(row: EmployeeRow) {
  return {
    id: row.id,
    employeeNumber: row.employee_number,
    name: row.name,
    title: row.title,
    department: row.department,
    status: row.status,
  };
}

async function employeeOr404(db: AsyncDb, id: string): Promise<EmployeeRow> {
  const row = await readEmployee(db, id);
  if (!row) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
  return row;
}

function pick(values: FormValues, keep: (sensitive: string | undefined) => boolean): FormValues {
  const out = Object.create(null) as FormValues;
  for (const [key, value] of Object.entries(values)) {
    const field = fieldByKey.get(key);
    if (!field) continue;
    if (keep(field.sensitive)) out[key] = value;
  }
  return out;
}

async function auditRead(
  db: AsyncDb,
  context: HrServiceContext,
  resourceId: string,
  action: string,
  fields: string[],
) {
  if (!fields.length) return;
  await appendEvent(db, serviceActor, 'service_access', resourceId, action, null, {
    actorName: SERVICE_ACCOUNT.name,
    actorKind: 'service_key',
    keyId: context.keyId,
    fields: [...fields].sort(),
  });
}

const param = (req: Request, name: string) => String(req.params[name] ?? '');

export function registerHrServiceApi(app: Express, { db, contextFor }: Options) {
  app.get(
    '/api/service/hr/employees',
    route(async (req, res) => {
      requireScope(contextFor(req), 'hr.employees.read');
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const needle = normalizeArabic(q);
      if (needle.length < 2 || q.length > 100)
        throw fault(400, 'QUERY_REQUIRED', 'أرسل اسمًا أو رقمًا وظيفيًا من حرفين على الأقل.');
      const rows = await db.read<EmployeeRow>('SELECT * FROM employee_access ORDER BY name,id');
      const terms = needle.split(' ');
      const matches = rows.filter((row) => {
        const haystack = `${normalizeArabic(row.name)} ${normalizeArabic(row.employee_number)}`;
        return terms.every((term) => haystack.includes(term));
      });
      res.json({ employees: matches.slice(0, 20).map(summary), total: matches.length });
    }),
  );

  app.get(
    '/api/service/hr/employees/:id',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.employees.read');
      const employee = await employeeOr404(db, param(req, 'id'));
      const values = await getProfileValues(db, employee.id);
      const withSensitive = context.scopes.includes('hr.sensitive.read');
      const visible = pick(
        values,
        (s) => !s || (withSensitive && (s === 'personal' || s === 'medical')),
      );
      const sensitiveKeys = Object.keys(visible).filter((k) => fieldByKey.get(k)?.sensitive);
      await auditRead(db, context, employee.id, 'service_read_sensitive_profile', sensitiveKeys);
      res.json({
        employee: {
          ...summary(employee),
          email: employee.email,
          location: employee.location,
          managerId: employee.manager_id,
          joinDate: employee.join_date,
        },
        values: visible,
        included: { personalAndMedical: withSensitive, compensation: false },
      });
    }),
  );

  app.get(
    '/api/service/hr/employees/:id/compensation',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.compensation.read');
      const employee = await employeeOr404(db, param(req, 'id'));
      const visible = pick(await getProfileValues(db, employee.id), (s) => s === 'financial');
      await auditRead(db, context, employee.id, 'service_read_compensation', Object.keys(visible));
      res.json({ employee: summary(employee), compensation: visible });
    }),
  );

  app.get(
    '/api/service/hr/employees/:id/leave',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.leave.read');
      const employee = await employeeOr404(db, param(req, 'id'));
      const file = await getEmployeeFile(db, leaveReader, employee.id);
      const requests = await db.read<Row>(
        'SELECT id,start_date,end_date,days,status,created_at FROM leave_requests WHERE employee_id=? ORDER BY created_at DESC,id LIMIT 200',
        [employee.id],
      );
      let entitlement: unknown = undefined;
      if (context.scopes.includes('hr.sensitive.read')) {
        const values = await getProfileValues(db, employee.id);
        entitlement = values.annualLeaveEntitlement ?? null;
        await auditRead(db, context, employee.id, 'service_read_sensitive_leave', [
          'annualLeaveEntitlement',
        ]);
      }
      res.json({
        employee: summary(employee),
        summary: file.leaveSummary,
        ...(entitlement !== undefined ? { annualLeaveEntitlement: entitlement } : {}),
        movements: file.leaveMovements.map((m) => ({
          id: m.id,
          kind: m.kind,
          days: m.days,
          effectiveAt: m.effectiveAt,
          createdAt: m.createdAt,
        })),
        requests: requests.map((r) => ({
          id: r.id,
          startDate: r.start_date,
          endDate: r.end_date,
          days: Number(r.days),
          status: r.status,
          createdAt: r.created_at,
        })),
      });
    }),
  );

  const runTotals = async (runId: string) => {
    const lines = await db.read<Row>(
      'SELECT employee_id,kind,amount_minor FROM payroll_lines WHERE run_id=?',
      [runId],
    );
    let earningsMinor = 0;
    let deductionsMinor = 0;
    for (const line of lines)
      if (line.kind === 'earning') earningsMinor += Number(line.amount_minor);
      else deductionsMinor += Number(line.amount_minor);
    return {
      employeeCount: new Set(lines.map((l) => l.employee_id)).size,
      totals: { earningsMinor, deductionsMinor, netMinor: earningsMinor - deductionsMinor },
    };
  };
  const runSummary = (r: Row) => ({
    id: r.id,
    period: r.period,
    state: r.state,
    version: Number(r.version),
    correctionOf: r.correction_of ?? null,
    createdAt: r.created_at,
    closedAt: r.closed_at ?? null,
  });

  app.get(
    '/api/service/hr/payroll',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.payroll.read');
      const month = typeof req.query.month === 'string' ? req.query.month : undefined;
      if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw fault(400, 'INVALID_MONTH', 'أرسل الشهر بصيغة YYYY-MM.');
      const rows = month
        ? await db.read<Row>(
            'SELECT * FROM payroll_runs WHERE period=? ORDER BY created_at DESC,id',
            [month],
          )
        : await db.read<Row>('SELECT * FROM payroll_runs ORDER BY period DESC,created_at DESC,id');
      const withAmounts = context.scopes.includes('hr.compensation.read');
      const runs = [];
      for (const row of rows) {
        const { employeeCount, totals } = await runTotals(row.id);
        runs.push({ ...runSummary(row), employeeCount, ...(withAmounts ? { totals } : {}) });
      }
      res.json({ runs });
    }),
  );

  app.get(
    '/api/service/hr/payroll/:id',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.payroll.read');
      const run = (
        await db.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [param(req, 'id')])
      )[0];
      if (!run) throw fault(404, 'PAYROLL_NOT_FOUND', 'المسير غير موجود.');
      const withAmounts = context.scopes.includes('hr.compensation.read');
      const lines = await db.read<Row>(
        'SELECT l.id,l.employee_id,l.component,l.kind,l.amount_minor,e.name employee_name FROM payroll_lines l JOIN employee_access e ON e.id=l.employee_id WHERE l.run_id=? ORDER BY e.name,l.id',
        [run.id],
      );
      const { employeeCount, totals } = await runTotals(run.id);
      if (withAmounts && lines.length)
        await auditRead(db, context, run.id, 'service_read_payroll_amounts', ['amountMinor']);
      res.json({
        run: { ...runSummary(run), employeeCount, ...(withAmounts ? { totals } : {}) },
        lines: lines.map((l) => ({
          id: l.id,
          employeeId: l.employee_id,
          employeeName: l.employee_name,
          component: l.component,
          kind: l.kind,
          ...(withAmounts ? { amountMinor: Number(l.amount_minor) } : {}),
        })),
      });
    }),
  );

  app.use('/api/service/hr', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود.' } });
  });
}
