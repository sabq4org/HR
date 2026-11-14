/**
 * HR service API for the «محاسب سبق» key. Mounted under /api/service/hr.
 *
 * Phase 1: reads. Phase 2: three writes, each through the same domain code as the session
 * routes (no bypass), with Idempotency-Key, a reason, and an administration event attributed to
 * the service account:
 * - PATCH /employees/:id               hr.employees.write  (saveProfileValues, record_version lock)
 * - POST  /payroll                     hr.payroll.write    (draft, same calculator as HR)
 * - POST  /payroll/:id/actions submit  hr.payroll.submit   (own draft -> pending_finance)
 * Review, reject and approve (which closes a run) answer 403 for the key whatever its scopes.
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
import {
  idempotent,
  requireRecord,
  requiredString,
  route,
  versionValue,
} from '../administration/common.js';
import { fault } from '../administration/validation.js';
import { saveProfileValues } from '../administration/service.js';
import { createPayrollCommands } from '../payroll/index.js';
import { SERVICE_ACCOUNT, serviceMayRunPayrollAction, type HrScope } from './keys.js';
import { ensureServiceAccountRow } from './service-account.js';
import { registerHrServiceExports } from './exports.js';

export type HrServiceContext = { scopes: readonly HrScope[]; keyId: string };
type Options = {
  db: AsyncDb;
  contextFor: (req: Request) => HrServiceContext | undefined;
  /** Private data mode (the printouts say «بيانات خاصة» like the in-app report). */
  privateData?: boolean;
};
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

export function requireKey(context: HrServiceContext | undefined): HrServiceContext {
  if (!context) throw fault(401, 'API_KEY_REQUIRED', 'هذا المسار لمفتاح خدمة الموارد البشرية فقط.');
  return context;
}

export function requireScope(
  context: HrServiceContext | undefined,
  scope: HrScope,
): HrServiceContext {
  context = requireKey(context);
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

export async function employeeOr404(db: AsyncDb, id: string): Promise<EmployeeRow> {
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
  extra: Record<string, unknown> = {},
) {
  if (!fields.length) return;
  await appendEvent(db, serviceActor, 'service_access', resourceId, action, null, {
    actorName: SERVICE_ACCOUNT.name,
    actorKind: 'service_key',
    keyId: context.keyId,
    fields: [...fields].sort(),
    ...extra,
  });
}

const isAction = (value: unknown): value is { action: unknown } =>
  typeof value === 'object' && value !== null && 'action' in value;
export const param = (req: Request, name: string) => String(req.params[name] ?? '');

/**
 * Profile fields the key never edits directly, even with hr.employees.write: they belong to a
 * workflow (work status, separation), decide who approves (manager), identify the file
 * (employee number), or are a human attestation (verification status).
 */
export const SERVICE_DENIED_FIELDS: ReadonlySet<string> = new Set([
  'employeeNumber',
  'managerId',
  'employmentStatus',
  'separationDate',
  'separationReason',
  'bankVerificationStatus',
  'bankVerificationSource',
  'bankVerifiedAt',
  'insuranceVerificationStatus',
  'annualLeaveVerificationStatus',
]);
const SALARY_COMPONENTS = [
  'basicSalary',
  'housingAllowance',
  'transportAllowance',
  'otherAllowance',
];
export const SERVICE_SALARY_SOURCE = 'محاسب سبق (مفتاح خدمة) بتوجيه مسجل في سبب التعديل';
const serviceAudit = (context: HrServiceContext) => ({
  actorName: SERVICE_ACCOUNT.name,
  actorKind: 'service_key',
  keyId: context.keyId,
});
// The payroll domain's own actor shape; 'service' is accepted only for draft and submit.
const payrollServiceActor = { id: SERVICE_ACCOUNT.id, role: 'service' as const };

export function registerHrServiceApi(
  app: Express,
  { db, contextFor, privateData = false }: Options,
) {
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
      if (withAmounts && runs.length)
        await auditRead(
          db,
          context,
          month ?? 'all',
          'service_read_payroll_list',
          ['deductionsMinor', 'earningsMinor', 'netMinor'],
          { month: month ?? null, count: runs.length },
        );
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

  // ---- Phase 2: writes -------------------------------------------------------------------

  app.patch(
    '/api/service/hr/employees/:id',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.employees.write');
      const employeeId = param(req, 'id');
      const body = requireRecord(req.body);
      const version = versionValue(body.version);
      const reason = requiredString(body.reason, 'REASON_REQUIRED', 'أدخل سبب التعديل ومن وجّه به.');
      if (reason.trim().length < 3)
        throw fault(400, 'REASON_REQUIRED', 'أدخل سبب التعديل ومن وجّه به.');
      const effectiveAt = requiredString(
        body.effectiveAt,
        'EFFECTIVE_DATE_REQUIRED',
        'أرسل تاريخ السريان بصيغة YYYY-MM-DD.',
        40,
      );
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveAt))
        throw fault(400, 'EFFECTIVE_DATE_REQUIRED', 'أرسل تاريخ السريان بصيغة YYYY-MM-DD.');
      const raw = requireRecord(body.values, 'أرسل الحقول المطلوب تعديلها.');
      const keys = Object.keys(raw);
      if (!keys.length || keys.length > 40)
        throw fault(400, 'INVALID_VALUES', 'أرسل من حقل إلى 40 حقلًا للتعديل.');
      const denied = keys.filter((key) => SERVICE_DENIED_FIELDS.has(key)).sort();
      if (denied.length)
        throw fault(
          403,
          'FIELD_NOT_ALLOWED_FOR_SERVICE',
          `هذه الحقول تعدل من مسارها البشري فقط: ${denied.join(', ')}`,
        );
      const values = { ...raw } as FormValues;
      // A salary change always carries its effective date and source, never a silent null.
      if (SALARY_COMPONENTS.some((key) => key in values)) {
        if (!('salaryEffectiveDate' in values)) values.salaryEffectiveDate = effectiveAt;
        if (!('salarySource' in values)) values.salarySource = SERVICE_SALARY_SOURCE;
      }
      const fields = Object.keys(values).sort();
      const result = await idempotent(
        db,
        serviceActor,
        `service:employee:update:${employeeId}`,
        req.get('Idempotency-Key') ?? undefined,
        { version, values, reason, effectiveAt },
        async (tx) => {
          const current = await employeeOr404(tx, employeeId);
          return {
            employee: summary(current),
            version: current.record_version,
            fields,
            replayed: true,
          };
        },
        async (tx) => {
          // employee_profile_history.actor_id and employee_profile_data.updated_by reference
          // employees(id): the key's hidden, non-login row must exist in this transaction.
          await ensureServiceAccountRow(tx);
          // approvedWorkflow=true replaces the session "HR manages this file" check, which the
          // scope check above stands in for; validation, version lock, field history,
          // verification resets and per-field audit all run unchanged.
          const next = await saveProfileValues(
            tx,
            serviceActor,
            employeeId,
            values,
            reason,
            effectiveAt,
            version,
            true,
          );
          await appendEvent(
            tx,
            serviceActor,
            'employee',
            employeeId,
            'profile_updated',
            reason,
            { ...serviceAudit(context), fields, effectiveAt },
            next,
          );
          const after = await employeeOr404(tx, employeeId);
          return {
            marker: { type: 'employee', id: employeeId },
            result: { employee: summary(after), version: next, fields, replayed: false },
          };
        },
      );
      res.json(result);
    }),
  );

  const payroll = createPayrollCommands(db);
  const payrollResponse = async (
    context: HrServiceContext,
    run: { id: string; period: string; state: string; version: number },
  ) => {
    const row = (await db.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [run.id]))[0];
    const { employeeCount, totals } = await runTotals(run.id);
    return {
      ...runSummary(row ?? run),
      preparedBy: row?.prepared_by ?? null,
      employeeCount,
      ...(context.scopes.includes('hr.compensation.read') ? { totals } : {}),
    };
  };

  app.post(
    '/api/service/hr/payroll',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.payroll.write');
      const body = requireRecord(req.body);
      if (body.correctionOf !== undefined && body.correctionOf !== null)
        throw fault(
          400,
          'SERVICE_CORRECTION_UNSUPPORTED',
          'مسير التصحيح يعده موظف الموارد البشرية؛ المفتاح يعد مسودة المسير الأساسي فقط.',
        );
      const result = (await payroll.createRun(req, payrollServiceActor, serviceAudit(context))) as {
        run: { id: string; period: string; state: string; version: number };
        excludedCount?: number;
      };
      res.status(201).json({
        run: await payrollResponse(context, result.run),
        excludedCount: result.excludedCount ?? 0,
      });
    }),
  );

  app.post(
    '/api/service/hr/payroll/:id/actions',
    route(async (req, res) => {
      const context = requireKey(contextFor(req));
      const action = isAction(req.body) ? req.body.action : undefined;
      // Approve, close, review and reject are never available to a key, whatever its scopes.
      if (action !== 'submit')
        throw fault(
          403,
          'PAYROLL_ACTION_FORBIDDEN',
          'اعتماد المسير وإغلاقه ومراجعته ورفضه للبشر فقط؛ المفتاح يرسل مسودته للمراجعة فقط.',
        );
      requireScope(context, 'hr.payroll.submit');
      if (!serviceMayRunPayrollAction(action, context.scopes))
        throw fault(403, 'API_KEY_SCOPE', 'المفتاح لا يملك صلاحية hr.payroll.submit.');
      const result = (await payroll.runAction(req, payrollServiceActor, serviceAudit(context))) as {
        run: { id: string; period: string; state: string; version: number };
      };
      res.json({ run: await payrollResponse(context, result.run) });
    }),
  );

  registerHrServiceExports(app, { db, contextFor, privateData });

  app.use('/api/service/hr', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود.' } });
  });
}
