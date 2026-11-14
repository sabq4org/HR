import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { todayInRiyadh, type AsyncDb } from '../database.js';
import type {
  AdministrativeOverview,
  AdministrativeRequest,
  FormValues,
  RequestKind,
  RequestState,
  WorkflowEvent,
} from '../../shared/administration.js';
import { documentCategories, employeeFields, formByKind } from '../../shared/catalog.js';
import type { Role } from '../../shared/contracts.js';
import { registerPayroll } from '../payroll/index.js';
import { registerEmployeeImports } from '../imports/routes.js';
import { createIssuedDocument } from '../letters/document.js';
import {
  actorOrThrow,
  idempotent,
  newId,
  registerRoute,
  requiredString,
  requireRecord,
  route,
  versionValue,
  type RequireActor,
} from './common.js';
import {
  appendEvent,
  createEmployee,
  filterProfileValues,
  getEmployeeFile,
  mayManageEmployee,
  mayReadEmployee,
  protectFormValues,
  readEmployee,
  readProtectedFormValues,
  saveProfileValues,
  validateEffectiveAt,
  visibleRequestValues,
  type Actor,
  type EmployeeRow,
} from './service.js';
import { decryptSensitive, encryptSensitive, sha256 } from './security.js';
import { csvCell, fault, roleFromState, stateForRole, validateValues } from './validation.js';

const at = () => new Date().toISOString();
const isRole = (value: string): value is Role =>
  ['employee', 'manager', 'hr', 'finance', 'approver', 'auditor'].includes(value);
function workflowState(steps: Role[], index: number): RequestState {
  if (index >= steps.length) return 'approved';
  return stateForRole(steps[index]) as RequestState;
}
function validateFormRelationships(kind: RequestKind, values: FormValues) {
  if (
    kind === 'contract' &&
    typeof values.startDate === 'string' &&
    typeof values.endDate === 'string' &&
    values.endDate < values.startDate
  )
    throw fault(400, 'INVALID_CONTRACT_DATES', 'نهاية العقد تسبق بدايته.');
  if (
    kind === 'special_leave' &&
    typeof values.startDate === 'string' &&
    typeof values.endDate === 'string' &&
    values.endDate < values.startDate
  )
    throw fault(400, 'INVALID_LEAVE_DATES', 'تاريخ نهاية الإجازة يسبق بدايتها.');
  if (
    kind === 'separation' &&
    typeof values.noticeDate === 'string' &&
    typeof values.lastDay === 'string' &&
    values.lastDay < values.noticeDate
  )
    throw fault(400, 'INVALID_SEPARATION_DATES', 'آخر يوم عمل يسبق تاريخ الإشعار.');
  if (kind === 'transfer' && typeof values.managerId === 'string' && values.managerId.length > 120)
    throw fault(400, 'INVALID_MANAGER', 'المدير الجديد غير صالح.');
}
async function ensureWorkflowAvailable(
  tx: AsyncDb,
  actor: Actor,
  employeeId: string,
  steps: Role[],
) {
  if (steps.length === 0)
    throw fault(409, 'APPROVAL_ROUTE_UNCONFIGURED', 'لا يمكن إرسال طلب دون مرحلة اعتماد مستقلة.');
  const employee = await readEmployee(tx, employeeId);
  for (const role of steps) {
    let eligible = false;
    if (role === 'manager') {
      const managerId = employee?.manager_id;
      if (managerId && managerId !== actor.id && managerId !== employeeId) {
        const manager = await readEmployee(tx, managerId);
        eligible = manager?.role === 'manager' && manager.status === 'active';
      }
    } else {
      const rows = await tx.read<{ id: string }>(
        'SELECT id FROM employee_access WHERE role=? AND status=? AND id<>? AND id<>? LIMIT 1',
        [role, 'active', actor.id, employeeId],
      );
      eligible = rows.length > 0;
    }
    if (!eligible)
      throw fault(
        409,
        'APPROVAL_ROUTE_UNCONFIGURED',
        `لا يوجد معتمد مستقل نشط لمرحلة ${role}؛ لم يُرسل الطلب.`,
      );
  }
}
async function notifyRequestTransition(
  tx: AsyncDb,
  actor: Actor,
  request: {
    id: string;
    request_number: string;
    kind: RequestKind;
    employee_id: string;
    created_by: string;
  },
  state: RequestState,
) {
  const now = at();
  const form = formByKind[request.kind];
  if (state.startsWith('pending_')) {
    const role = roleFromState(state);
    let recipient: string | undefined;
    if (role === 'manager')
      recipient = (await readEmployee(tx, request.employee_id))?.manager_id ?? undefined;
    else if (role) {
      recipient = (
        await tx.read<{ id: string }>(
          'SELECT id FROM employee_access WHERE role=? AND status=? AND id<>? AND id<>? ORDER BY id LIMIT 1',
          [role, 'active', request.created_by, request.employee_id],
        )
      )[0]?.id;
    }
    if (
      recipient &&
      recipient !== actor.id &&
      recipient !== request.employee_id &&
      recipient !== request.created_by
    ) {
      await tx.execute(
        'INSERT INTO outbox(recipient_id,title,body,leave_id,created_at,request_id) VALUES(?,?,?,NULL,?,?)',
        [
          recipient,
          'طلب إداري بانتظار المراجعة',
          `${request.request_number} — ${form?.title ?? 'طلب إداري'} بانتظار مراجعتك.`,
          now,
          request.id,
        ],
      );
    }
  } else if (['approved', 'rejected', 'returned', 'cancelled'].includes(state)) {
    const title =
      state === 'approved'
        ? 'اكتملت مراجعة الطلب'
        : state === 'rejected'
          ? 'صدر قرار على الطلب'
          : state === 'returned'
            ? 'أُعيد الطلب لاستكماله'
            : 'أُلغي الطلب';
    await tx.execute(
      'INSERT INTO outbox(recipient_id,title,body,leave_id,created_at,request_id) VALUES(?,?,?,NULL,?,?)',
      [
        request.employee_id,
        title,
        `${request.request_number} — ${form?.title ?? 'طلب إداري'}.`,
        now,
        request.id,
      ],
    );
  }
}
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw fault(400, 'INVALID_ID', 'معرف السجل غير صالح.');
  return value;
}
function cleanRequest(
  row: any,
  owner: EmployeeRow,
  values: FormValues,
  events: WorkflowEvent[],
  actor: Actor,
  form: any,
): AdministrativeRequest {
  return {
    id: row.id,
    number: row.request_number,
    kind: row.kind,
    employeeId: owner.id,
    employeeName: actor.role === 'auditor' ? 'موظف' : owner.name,
    createdBy: row.created_by,
    state: row.state,
    version: Number(row.version),
    values: visibleRequestValues(
      actor,
      {
        ownerId: owner.id,
        createdBy: row.created_by,
        kind: row.kind,
        steps: JSON.parse(row.steps_json) as Role[],
      },
      values,
    ),
    steps: JSON.parse(row.steps_json) as Role[],
    stepIndex: Number(row.step_index),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canAct:
      roleFromState(row.state) === actor.role &&
      row.created_by !== actor.id &&
      owner.id !== actor.id &&
      (actor.role !== 'manager' || owner.manager_id === actor.id),
    canEdit: row.created_by === actor.id && ['draft', 'returned'].includes(row.state),
    timeline: events,
  };
}
async function getRequest(db: AsyncDb, actor: Actor, id: string): Promise<AdministrativeRequest> {
  const row = (await db.read<any>('SELECT * FROM administrative_requests WHERE id=?', [id]))[0];
  if (!row) throw fault(404, 'REQUEST_NOT_FOUND', 'الطلب غير موجود.');
  const owner = await readEmployee(db, row.employee_id);
  const directManager = actor.role === 'manager' && owner?.manager_id === actor.id;
  const assignedReviewer =
    ['hr', 'finance', 'approver'].includes(actor.role) &&
    (JSON.parse(row.steps_json) as Role[]).includes(actor.role);
  if (
    !owner ||
    !(
      mayReadEmployee(actor, owner) ||
      (roleFromState(row.state) === actor.role && (actor.role !== 'manager' || directManager)) ||
      assignedReviewer ||
      row.created_by === actor.id ||
      (actor.role === 'finance' &&
        ['advance', 'overtime', 'reward', 'settlement', 'salary_letter'].includes(row.kind))
    )
  )
    throw fault(404, 'REQUEST_NOT_FOUND', 'الطلب غير موجود.');
  const form = formByKind[row.kind as RequestKind];
  if (!form) throw fault(500, 'REQUEST_KIND_INVALID', 'نوع الطلب غير معروف.');
  const values = readProtectedFormValues(row.values_json, `admin-request:${row.id}:values`);
  const rows = await db.read<any>(
    "SELECT * FROM administration_events WHERE resource_type='request' AND resource_id=? ORDER BY created_at,id",
    [id],
  );
  const timeline = await Promise.all(
    rows.map(async (e): Promise<WorkflowEvent> => {
      const employee = await readEmployee(db, e.actor_id);
      let reason: string | null = null;
      if (
        e.reason &&
        (actor.role === 'hr' || actor.id === row.employee_id || row.created_by === actor.id)
      ) {
        try {
          reason = decryptSensitive(e.reason, `administration-event:${e.id}:reason`);
        } catch {
          reason = '[معلومة محمية]';
        }
      }
      return {
        id: e.id,
        actorId: actor.role === 'auditor' ? '' : e.actor_id,
        actorName: actor.role === 'auditor' ? `مستخدم` : (employee?.name ?? 'مستخدم'),
        role: e.actor_role,
        action: e.action,
        reason,
        createdAt: e.created_at,
        version: Number(e.resource_version ?? 1),
      };
    }),
  );
  const result = cleanRequest(row, owner, values, timeline, actor, form);
  const mayReadIssued =
    actor.id === owner.id ||
    actor.role === 'hr' ||
    (['finance', 'approver'].includes(actor.role) &&
      (JSON.parse(row.steps_json) as Role[]).includes(actor.role));
  if (row.issued_document_json && mayReadIssued) {
    try {
      result.issuedDocument = JSON.parse(
        decryptSensitive(row.issued_document_json, `issued-document:${row.id}`),
      );
    } catch {
      throw fault(500, 'ISSUED_DOCUMENT_INVALID', 'تعذر قراءة النسخة المعتمدة.');
    }
  }
  return result;
}
async function scopedEmployee(db: AsyncDb, actor: Actor, id: string): Promise<EmployeeRow> {
  const employee = await readEmployee(db, id);
  if (!employee) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
  if (!mayReadEmployee(actor, employee))
    throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية الاطلاع على هذا الملف.');
  return employee;
}
function routeWithActor(
  app: Express,
  method: 'get' | 'post' | 'patch',
  path: string,
  requireActor: RequireActor,
  handler: (req: Request, res: Response, actor: Actor) => Promise<void>,
) {
  app[method](
    path,
    route(async (req, res) => handler(req, res, actorOrThrow(await requireActor(req)))),
  );
}

async function buildAdministrativeOverview(
  db: AsyncDb,
  actor: Actor,
): Promise<AdministrativeOverview> {
  const employees = await db.read<EmployeeRow>('SELECT * FROM employee_access WHERE status=?', [
    'active',
  ]);
  const scoped = employees.filter((employee) => mayReadEmployee(actor, employee));
  const ids = new Set(scoped.map((employee) => employee.id));
  const today = todayInRiyadh();
  const horizon = new Date(`${today}T12:00:00+03:00`);
  horizon.setUTCDate(horizon.getUTCDate() + 45);
  const until = horizon.toISOString().slice(0, 10);
  const expiries: AdministrativeOverview['expiries'] = [];
  const docs = await db.read<any>(
    "SELECT d.*,e.name employee_name FROM employee_documents d JOIN employee_access e ON e.id=d.employee_id WHERE d.state='active' AND d.expires_at>=? AND d.expires_at<=? ORDER BY d.expires_at LIMIT 200",
    [today, until],
  );
  for (const doc of docs) {
    if (!ids.has(doc.employee_id) || !documentCanRead(actor, doc.category)) continue;
    const category = documentCategories.find((item) => item.key === doc.category);
    expiries.push({
      id: doc.id,
      employeeName: actor.role === 'auditor' ? 'موظف' : doc.employee_name,
      title: category?.label ?? 'مستند',
      date: doc.expires_at,
      type: 'document',
    });
  }
  let expiringContracts = 0;
  for (const employee of scoped) {
    const profile = (
      await db.read<{ public_values_json: string }>(
        'SELECT public_values_json FROM employee_profile_data WHERE employee_id=?',
        [employee.id],
      )
    )[0];
    let expiry: unknown;
    try {
      expiry = profile
        ? (JSON.parse(profile.public_values_json) as Record<string, unknown>).contractEnd
        : undefined;
    } catch {
      expiry = undefined;
    }
    if (typeof expiry === 'string' && validIsoDate(expiry) && expiry >= today && expiry <= until) {
      expiringContracts += 1;
      expiries.push({
        id: `contract-${employee.id}`,
        employeeName: actor.role === 'auditor' ? 'موظف' : employee.name,
        title: 'نهاية العقد',
        date: expiry,
        type: 'contract',
      });
    }
  }
  const rows = await db.read<{ id: string }>(
    "SELECT id FROM administrative_requests WHERE state LIKE 'pending_%' ORDER BY created_at DESC LIMIT 500",
  );
  const requests: AdministrativeRequest[] = [];
  for (const row of rows) {
    const request = await getRequest(db, actor, row.id).catch(() => null);
    if (request) requests.push(request);
  }
  const attendance = await db.read<{ employee_id: string }>(
    "SELECT employee_id FROM attendance_records WHERE state='submitted'",
  );
  const payroll = ['hr', 'finance', 'approver'].includes(actor.role)
    ? await db.read<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM payroll_runs WHERE state IN ('draft','pending_finance','pending_approver')",
      )
    : [{ n: 0 }];
  return {
    counts: {
      employees: scoped.length,
      pendingRequests: requests.length,
      expiringDocuments: expiries.filter((item) => item.type === 'document').length,
      expiringContracts,
      attendancePending: attendance.filter((row) => ids.has(row.employee_id)).length,
      payrollDrafts: Number(payroll[0]?.n ?? 0),
    },
    requests,
    expiries: expiries.slice(0, 100),
    capabilities: {
      manageEmployees: actor.role === 'hr',
      payroll: ['hr', 'finance', 'approver'].includes(actor.role),
      reports: ['hr', 'finance', 'auditor'].includes(actor.role),
      policies: actor.role === 'hr' || actor.role === 'approver',
      audit: actor.role === 'hr' || actor.role === 'auditor',
    },
  };
}

export function registerAdministration(
  app: Express,
  { db, requireActor }: { db: AsyncDb; requireActor: RequireActor },
) {
  registerPayroll(app, { db, requireActor });
  registerEmployeeImports(app, { db, requireActor });

  routeWithActor(app, 'get', '/api/admin/overview', requireActor, async (_req, res, actor) => {
    res.json({ overview: await buildAdministrativeOverview(db, actor) });
  });

  routeWithActor(app, 'get', '/api/admin/employees/:id', requireActor, async (req, res, actor) => {
    res.json({ file: await getEmployeeFile(db, actor, param(req, 'id')) });
  });
  routeWithActor(app, 'post', '/api/admin/employees', requireActor, async (req, res, actor) => {
    const body = requireRecord(req.body);
    const key = req.get('Idempotency-Key') ?? undefined;
    const file = await idempotent(
      db,
      actor,
      'employee:create',
      key,
      body,
      (tx, m) => getEmployeeFile(tx, actor, m.id),
      async (tx) => {
        const file = await createEmployee(tx, actor, body.values);
        return { marker: { type: 'employee', id: file.employee.id }, result: file };
      },
    );
    res.status(201).json({ file });
  });
  routeWithActor(
    app,
    'patch',
    '/api/admin/employees/:id',
    requireActor,
    async (req, res, actor) => {
      const employeeId = param(req, 'id');
      const body = requireRecord(req.body);
      const version = versionValue(body.version);
      const values = validateValues(employeeFields, body.values, { partial: true });
      const reason = requiredString(body.reason, 'REASON_REQUIRED', 'أدخل سبب التعديل.', 1000);
      const requestedEffectiveAt = typeof body.effectiveAt === 'string' ? body.effectiveAt : null;
      const file = await idempotent(
        db,
        actor,
        `employee:update:${employeeId}`,
        req.get('Idempotency-Key') ?? undefined,
        { version, values, reason, effectiveAt: requestedEffectiveAt },
        async (tx, m) => getEmployeeFile(tx, actor, m.id),
        async (tx) => {
          const effectiveAt = requestedEffectiveAt ?? at();
          await saveProfileValues(tx, actor, employeeId, values, reason, effectiveAt, version);
          await appendEvent(
            tx,
            actor,
            'employee',
            employeeId,
            'profile_updated',
            reason,
            { fields: Object.keys(values) },
            version + 1,
          );
          return {
            marker: { type: 'employee', id: employeeId },
            result: await getEmployeeFile(tx, actor, employeeId),
          };
        },
      );
      res.json({ file });
    },
  );
  routeWithActor(
    app,
    'post',
    '/api/admin/employees/:id/rehire',
    requireActor,
    async (req, res, actor) => {
      const employeeId = param(req, 'id');
      const b = requireRecord(req.body);
      const version = versionValue(b.version);
      const startDate = requiredString(b.startDate, 'INVALID_DATE', 'تاريخ بدء العلاقة مطلوب.', 10);
      const type = requiredString(
        b.relationshipType,
        'INVALID_RELATIONSHIP',
        'نوع العلاقة مطلوب.',
        80,
      );
      const reason = requiredString(b.reason, 'REASON_REQUIRED', 'أدخل سبب إعادة التعيين.', 1000);
      validateEffectiveAt(startDate);
      if (
        !employeeFields
          .find((field) => field.key === 'contractType')
          ?.options?.some((option) => option.value === type)
      )
        throw fault(400, 'INVALID_RELATIONSHIP', 'اختر نوع عقد صالحًا لإعادة التعيين.');
      const file = await idempotent(
        db,
        actor,
        `employee:rehire:${employeeId}`,
        req.get('Idempotency-Key') ?? undefined,
        { version, startDate, relationshipType: type, reason },
        async (tx, m) => getEmployeeFile(tx, actor, m.id),
        async (tx) => {
          const e = await readEmployee(tx, employeeId);
          if (!e) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
          if (!mayManageEmployee(actor, e))
            throw fault(403, 'FORBIDDEN', 'تتطلب إعادة التعيين صلاحية الشؤون الإدارية.');
          if (e.record_version !== version) throw fault(409, 'STALE_VERSION', 'تغير الملف.');
          if (e.status !== 'terminated')
            throw fault(
              409,
              'EMPLOYEE_NOT_TERMINATED',
              'إعادة التعيين متاحة بعد انتهاء العلاقة السابقة.',
            );
          const periods = await tx.read<{ end_date: string | null }>(
            'SELECT end_date FROM employment_periods WHERE employee_id=?',
            [e.id],
          );
          if (periods.some((period) => period.end_date === null || period.end_date >= startDate))
            throw fault(
              409,
              'OVERLAPPING_EMPLOYMENT',
              'تاريخ إعادة التعيين يجب أن يلي نهاية جميع فترات العمل السابقة.',
            );
          const now = at();
          await tx.execute(
            "INSERT INTO employment_periods(id,employee_id,start_date,relationship_type,source,status,created_at) VALUES(?,?,?,?,?,'synthetic-demo-only',?)",
            [newId(), e.id, startDate, type, 'User-created synthetic rehire.', now],
          );
          await tx.execute(
            "UPDATE employees SET employment_status='active',record_version=record_version+1 WHERE id=? AND record_version=?",
            [e.id, version],
          );
          await appendEvent(
            tx,
            actor,
            'employee',
            e.id,
            'employee_rehired',
            reason,
            { startDate, relationshipType: type },
            version + 1,
          );
          return {
            marker: { type: 'employee', id: e.id },
            result: await getEmployeeFile(tx, actor, e.id),
          };
        },
      );
      res.status(201).json({ file });
    },
  );

  routeWithActor(app, 'get', '/api/admin/requests', requireActor, async (req, res, actor) => {
    const rows = await db.read<any>(
      'SELECT id FROM administrative_requests ORDER BY created_at DESC LIMIT 500',
    );
    const items: AdministrativeRequest[] = [];
    for (const row of rows) {
      try {
        const r = await getRequest(db, actor, row.id);
        if (
          (!req.query.kind || r.kind === req.query.kind) &&
          (!req.query.state || r.state === req.query.state)
        )
          items.push(r);
      } catch {}
    }
    res.json({ requests: items });
  });
  routeWithActor(app, 'get', '/api/admin/requests/:id', requireActor, async (req, res, actor) => {
    res.json({ request: await getRequest(db, actor, param(req, 'id')) });
  });
  routeWithActor(app, 'post', '/api/admin/requests', requireActor, async (req, res, actor) => {
    const b = requireRecord(req.body);
    if (typeof b.submit !== 'boolean')
      throw fault(400, 'INVALID_INPUT', 'حدد هل تريد إرسال الطلب الآن.');
    const kind = requiredString(b.kind, 'INVALID_KIND', 'نوع الطلب غير صالح.', 60) as RequestKind;
    const form = formByKind[kind];
    if (!form) throw fault(400, 'INVALID_KIND', 'نوع الطلب غير معروف.');
    if (!form.initiators.includes(actor.role))
      throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية إنشاء هذا النوع من الطلبات.');
    const employeeId = requiredString(b.employeeId, 'EMPLOYEE_REQUIRED', 'حدد الموظف.', 120);
    const owner = await scopedEmployee(db, actor, employeeId);
    if (actor.role === 'employee' && owner.id !== actor.id)
      throw fault(403, 'FORBIDDEN', 'يمكنك إنشاء طلبك لنفسك فقط.');
    const values = validateValues(form.fields, b.values, { partial: !b.submit });
    validateFormRelationships(kind, values);
    const id = newId();
    const steps = form.stepsByInitiator?.[actor.role] ?? form.steps;
    const initial: RequestState = b.submit
      ? steps.length
        ? workflowState(steps, 0)
        : 'approved'
      : 'draft';
    const body = { kind, employeeId, values, submit: b.submit };
    const request = await idempotent(
      db,
      actor,
      'request:create',
      req.get('Idempotency-Key') ?? undefined,
      body,
      async (tx, m) => getRequest(tx, actor, m.id),
      async (tx) => {
        const now = at();
        if (b.submit) await ensureWorkflowAvailable(tx, actor, employeeId, steps);
        await tx.execute(
          'INSERT INTO administrative_requests(id,request_number,kind,employee_id,created_by,state,values_json,steps_json,step_index,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          [
            id,
            `HR-${now.slice(0, 10).replaceAll('-', '')}-${id.slice(0, 6).toUpperCase()}`,
            kind,
            employeeId,
            actor.id,
            initial,
            protectFormValues(values, form.fields, `admin-request:${id}:values`),
            JSON.stringify(steps),
            0,
            now,
            now,
          ],
        );
        await appendEvent(
          tx,
          actor,
          'request',
          id,
          b.submit ? 'submitted' : 'request_created',
          null,
          { kind },
          1,
          now,
        );
        if (b.submit) {
          await notifyRequestTransition(
            tx,
            actor,
            {
              id,
              request_number: `HR-${now.slice(0, 10).replaceAll('-', '')}-${id.slice(0, 6).toUpperCase()}`,
              kind,
              employee_id: employeeId,
              created_by: actor.id,
            },
            initial,
          );
        }
        return { marker: { type: 'request', id }, result: await getRequest(tx, actor, id) };
      },
    );
    res.status(201).json({ request });
  });
  routeWithActor(app, 'patch', '/api/admin/requests/:id', requireActor, async (req, res, actor) => {
    const requestId = param(req, 'id');
    const b = requireRecord(req.body);
    const version = versionValue(b.version);
    const row = (
      await db.read<any>('SELECT * FROM administrative_requests WHERE id=?', [requestId])
    )[0];
    if (!row) throw fault(404, 'REQUEST_NOT_FOUND', 'الطلب غير موجود.');
    const form = formByKind[row.kind as RequestKind];
    const values = validateValues(form.fields, b.values, { partial: true });
    const request = await idempotent(
      db,
      actor,
      `request:update:${row.id}`,
      req.get('Idempotency-Key') ?? undefined,
      { version, values },
      async (tx, m) => getRequest(tx, actor, m.id),
      async (tx) => {
        const current = (
          await tx.read<any>('SELECT * FROM administrative_requests WHERE id=?', [row.id])
        )[0];
        if (
          !current ||
          current.created_by !== actor.id ||
          !['draft', 'returned'].includes(current.state)
        )
          throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية تعديل هذا الطلب.');
        if (Number(current.version) !== version) throw fault(409, 'STALE_VERSION', 'تغير الطلب.');
        const merged = {
          ...readProtectedFormValues(current.values_json, `admin-request:${row.id}:values`),
          ...values,
        } as FormValues;
        validateFormRelationships(row.kind as RequestKind, merged);
        const now = at();
        const changed = await tx.execute(
          'UPDATE administrative_requests SET values_json=?,version=version+1,updated_at=? WHERE id=? AND version=?',
          [
            protectFormValues(merged, form.fields, `admin-request:${row.id}:values`),
            now,
            row.id,
            version,
          ],
        );
        if (changed.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغير الطلب.');
        await appendEvent(
          tx,
          actor,
          'request',
          row.id,
          'request_updated',
          null,
          { fields: Object.keys(values) },
          version + 1,
          now,
        );
        return {
          marker: { type: 'request', id: row.id },
          result: await getRequest(tx, actor, row.id),
        };
      },
    );
    res.json({ request });
  });
  routeWithActor(
    app,
    'post',
    '/api/admin/requests/:id/actions',
    requireActor,
    async (req, res, actor) => {
      const requestId = param(req, 'id');
      const b = requireRecord(req.body);
      const version = versionValue(b.version);
      const action = requiredString(b.action, 'INVALID_ACTION', 'الإجراء غير صالح.', 20);
      if (!['submit', 'approve', 'reject', 'return', 'cancel'].includes(action))
        throw fault(400, 'INVALID_ACTION', 'الإجراء غير صالح.');
      const reason = typeof b.reason === 'string' ? b.reason : '';
      if (['reject', 'return'].includes(action) && !reason.trim())
        throw fault(400, 'REASON_REQUIRED', 'أدخل سبب القرار.');
      const request = await idempotent(
        db,
        actor,
        `request:action:${requestId}`,
        req.get('Idempotency-Key') ?? undefined,
        { version, action, reason },
        async (tx, m) => getRequest(tx, actor, m.id),
        async (tx) => {
          const row = (
            await tx.read<any>('SELECT * FROM administrative_requests WHERE id=?', [requestId])
          )[0];
          if (!row) throw fault(404, 'REQUEST_NOT_FOUND', 'الطلب غير موجود.');
          if (Number(row.version) !== version) throw fault(409, 'STALE_VERSION', 'تغير الطلب.');
          if (
            ['approve', 'reject', 'return'].includes(action) &&
            (row.created_by === actor.id || row.employee_id === actor.id)
          )
            throw fault(403, 'SELF_APPROVAL', 'لا يمكن لمنشئ الطلب أو صاحبه اتخاذ قرار عليه.');
          const steps = JSON.parse(row.steps_json) as Role[];
          let nextState: RequestState;
          let nextIndex = Number(row.step_index);
          if (action === 'cancel') {
            if (
              actor.id !== row.created_by ||
              ![
                'draft',
                'returned',
                'pending_manager',
                'pending_hr',
                'pending_finance',
                'pending_approver',
              ].includes(row.state)
            )
              throw fault(403, 'FORBIDDEN', 'لا يمكن إلغاء الطلب في هذه المرحلة.');
            nextState = 'cancelled';
          } else if (action === 'submit') {
            if (actor.id !== row.created_by || !['draft', 'returned'].includes(row.state))
              throw fault(403, 'FORBIDDEN', 'لا يمكن إرسال الطلب.');
            const form = formByKind[row.kind as RequestKind];
            validateValues(
              form.fields,
              readProtectedFormValues(row.values_json, `admin-request:${row.id}:values`),
            );
            validateFormRelationships(
              row.kind as RequestKind,
              readProtectedFormValues(row.values_json, `admin-request:${row.id}:values`),
            );
            await ensureWorkflowAvailable(tx, actor, row.employee_id, steps);
            nextIndex = 0;
            nextState = workflowState(steps, 0);
          } else {
            const expected = roleFromState(row.state);
            const owner = await readEmployee(tx, row.employee_id);
            if (
              !expected ||
              actor.role !== expected ||
              (actor.role === 'manager' && owner?.manager_id !== actor.id)
            )
              throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية القرار في هذه المرحلة.');
            if (action === 'approve') {
              nextIndex++;
              nextState = workflowState(steps, nextIndex);
            } else nextState = action === 'reject' ? 'rejected' : 'returned';
          }
          const now = at();
          const changed = await tx.execute(
            'UPDATE administrative_requests SET state=?,step_index=?,version=version+1,updated_at=?,closed_at=? WHERE id=? AND version=?',
            [
              nextState,
              nextIndex,
              now,
              ['approved', 'rejected', 'cancelled'].includes(nextState) ? now : null,
              row.id,
              version,
            ],
          );
          if (changed.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغير الطلب.');
          if (nextState === 'approved') {
            await applyApprovedSideEffect(tx, actor, row, reason);
            const form = formByKind[row.kind as RequestKind];
            if (form?.printable) {
              const values = readProtectedFormValues(
                row.values_json,
                `admin-request:${row.id}:values`,
              );
              const issued = await createIssuedDocument(
                tx,
                {
                  id: row.id,
                  number: row.request_number,
                  kind: row.kind,
                  employeeId: row.employee_id,
                  values,
                },
                actor,
              );
              await tx.execute(
                'UPDATE administrative_requests SET issued_document_json=? WHERE id=?',
                [encryptSensitive(JSON.stringify(issued), `issued-document:${row.id}`), row.id],
              );
            }
          }
          await appendEvent(
            tx,
            actor,
            'request',
            row.id,
            action,
            reason || null,
            {},
            version + 1,
            now,
          );
          await notifyRequestTransition(tx, actor, row, nextState);
          return {
            marker: { type: 'request', id: row.id },
            result: await getRequest(tx, actor, row.id),
          };
        },
      );
      res.json({ request });
    },
  );

  registerDocumentRoutes(app, { db, requireActor });
  registerAttendanceRoutes(app, { db, requireActor });
  registerPolicyRoutes(app, { db, requireActor });
  registerReportRoutes(app, { db, requireActor });
}

async function applyApprovedSideEffect(tx: AsyncDb, actor: Actor, row: any, reason: string) {
  const values = readProtectedFormValues(row.values_json, `admin-request:${row.id}:values`);
  const now = at();
  if (row.kind === 'leave_adjustment') {
    const days = Number(values.days);
    const effectiveAt =
      typeof values.effectiveDate === 'string' ? values.effectiveDate : now.slice(0, 10);
    if (
      !Number.isInteger(days) ||
      days === 0 ||
      Math.abs(days) > 365 ||
      !validIsoDate(effectiveAt) ||
      effectiveAt > todayInRiyadh()
    )
      throw fault(
        400,
        'INVALID_ADJUSTMENT',
        'تسوية الرصيد يجب أن تكون عدد أيامًا صالحًا وسارية حتى اليوم.',
      );
    if (days < 0) {
      const sums = await tx.read<any>(
        'SELECT kind,SUM(days) days FROM leave_ledger WHERE employee_id=? GROUP BY kind',
        [row.employee_id],
      );
      const amount = (kind: string) => Number(sums.find((x: any) => x.kind === kind)?.days ?? 0);
      const available =
        amount('allocation') - (amount('reserve') + amount('release')) + amount('consume');
      if (available < -days)
        throw fault(409, 'INSUFFICIENT_BALANCE', 'لا يمكن خفض الرصيد إلى أقل من صفر.');
    }
    await tx.execute(
      'INSERT INTO leave_balance_adjustments(id,employee_id,request_id,days,effective_at,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        newId(),
        row.employee_id,
        row.id,
        days,
        effectiveAt,
        encryptSensitive(
          reason || 'Synthetic approved adjustment',
          `leave-adjustment:${row.id}:reason`,
        ),
        actor.id,
        now,
      ],
    );
    await tx.execute(
      'INSERT INTO leave_ledger(employee_id,kind,days,created_at,actor_id) VALUES(?,?,?,?,?)',
      [row.employee_id, days > 0 ? 'allocation' : 'consume', days, now, actor.id],
    );
  }
  if (['data_change', 'bank_change', 'transfer', 'contract', 'separation'].includes(row.kind)) {
    const owner = await readEmployee(tx, row.employee_id);
    if (!owner) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
    const effectiveAt =
      typeof values.effectiveDate === 'string' ? values.effectiveDate : now.slice(0, 10);
    if (row.kind === 'data_change') {
      const fieldName = String(values.fieldName ?? '');
      const permitted = ['mobile', 'nationalAddress', 'qualification', 'emergencyMobile'];
      if (!permitted.includes(fieldName) || typeof values.newValue !== 'string')
        throw fault(400, 'INVALID_CHANGE', 'طلب تحديث البيانات غير صالح.');
      await saveProfileValues(
        tx,
        actor,
        row.employee_id,
        { [fieldName]: values.newValue },
        reason || String(values.reason ?? 'Approved synthetic data change'),
        effectiveAt,
        owner.record_version,
        true,
      );
    }
    if (row.kind === 'bank_change')
      await saveProfileValues(
        tx,
        actor,
        row.employee_id,
        { bankName: values.bankName, iban: values.iban },
        reason || String(values.reason ?? 'Approved synthetic bank change'),
        effectiveAt,
        owner.record_version,
        true,
      );
    if (row.kind === 'transfer') {
      const changes: FormValues = {};
      for (const key of ['department', 'title', 'managerId']) {
        if (typeof values[key] === 'string') changes[key] = values[key];
      }
      await saveProfileValues(
        tx,
        actor,
        row.employee_id,
        changes,
        reason || String(values.reason ?? 'Approved synthetic transfer'),
        String(values.effectiveDate ?? ''),
        owner.record_version,
        true,
      );
    }
    if (row.kind === 'contract') {
      if (values.endDate && String(values.endDate) < String(values.startDate))
        throw fault(400, 'INVALID_CONTRACT_DATES', 'نهاية العقد تسبق بدايته.');
      await saveProfileValues(
        tx,
        actor,
        row.employee_id,
        {
          contractType: values.contractType,
          contractStart: values.startDate,
          contractEnd: values.endDate ?? null,
          title: values.title,
          basicSalary: values.basicSalary,
          probationEnd: values.probationEnd ?? null,
          noticeDays: values.noticeDays ?? null,
          qiwaReference: values.qiwaReference ?? null,
        },
        reason || String(values.reason ?? 'Approved synthetic contract'),
        String(values.startDate),
        owner.record_version,
        true,
      );
      // Contract renewal updates the contract history within the same service period.
      // Only rehire starts a new employment period after the previous one has closed.
    }
    if (row.kind === 'separation') {
      const lastDay = String(values.lastDay);
      if (!validIsoDate(lastDay)) throw fault(400, 'INVALID_DATE', 'تاريخ الانتهاء غير صالح.');
      await saveProfileValues(
        tx,
        actor,
        row.employee_id,
        { separationDate: lastDay, separationReason: values.reasonType ?? null },
        reason || 'Approved synthetic separation',
        lastDay,
        owner.record_version,
        true,
      );
      const changed = await tx.execute(
        "UPDATE employees SET employment_status='terminated',record_version=record_version+1 WHERE id=? AND record_version=?",
        [row.employee_id, owner.record_version + 1],
      );
      if (changed.rowCount !== 1)
        throw fault(409, 'STALE_VERSION', 'تغير الملف قبل تطبيق إنهاء العلاقة.');
      await tx.execute(
        'UPDATE employment_periods SET end_date=? WHERE employee_id=? AND end_date IS NULL',
        [lastDay, row.employee_id],
      );
    }
  }
}
function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function registerDocumentRoutes(app: Express, ctx: { db: AsyncDb; requireActor: RequireActor }) {
  const { db, requireActor } = ctx;
  routeWithActor(app, 'get', '/api/admin/documents', requireActor, async (req, res, actor) => {
    if (!['hr', 'auditor', 'finance', 'manager', 'employee'].includes(actor.role))
      throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية الاطلاع على المستندات.');
    const params: unknown[] = [];
    let where = "d.state IN ('active','archived')";
    if (actor.role === 'employee') {
      where += ' AND d.employee_id=?';
      params.push(actor.id);
    } else if (actor.role === 'manager') {
      where += ' AND (d.employee_id=? OR e.manager_id=?)';
      params.push(actor.id, actor.id);
    } else if (typeof req.query.employeeId === 'string') {
      where += ' AND d.employee_id=?';
      params.push(req.query.employeeId);
    }
    const rows = await db.read<any>(
      `SELECT d.*,e.name employee_name,e.manager_id FROM employee_documents d JOIN employee_access e ON e.id=d.employee_id WHERE ${where} ORDER BY d.uploaded_at DESC LIMIT 500`,
      params,
    );
    res.json({
      documents: rows
        .filter(
          (d) =>
            documentCanRead(actor, d.category) &&
            (actor.role !== 'manager' ||
              !documentCategories.find((c) => c.key === d.category)?.sensitive),
        )
        .map((d) => docView(d, actor)),
    });
  });
  app.post(
    '/api/admin/employees/:id/documents',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      const employee = await readEmployee(db, param(req, 'id'));
      if (!employee) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
      if (!mayManageEmployee(actor, employee))
        throw fault(403, 'FORBIDDEN', 'رفع المستندات متاح للشؤون الإدارية.');
      const b = requireRecord(req.body);
      const category = requiredString(b.category, 'INVALID_CATEGORY', 'اختر فئة مستند.', 60);
      const def = documentCategories.find((c) => c.key === category);
      if (!def) throw fault(400, 'INVALID_CATEGORY', 'فئة المستند غير معروفة.');
      const filename = requiredString(
        b.filename,
        'INVALID_FILENAME',
        'اسم الملف مطلوب.',
        160,
      ).replace(/[\\/\u0000-\u001f\u007f]/g, '_');
      const mime = requiredString(b.mimeType, 'INVALID_MIME', 'نوع الملف غير صالح.', 100);
      if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mime))
        throw fault(400, 'INVALID_MIME', 'يسمح بملفات PDF وPNG وJPEG فقط.');
      const base = requiredString(
        b.contentBase64,
        'INVALID_FILE',
        'محتوى الملف غير صالح.',
        3 * 1024 * 1024,
      );
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base))
        throw fault(400, 'INVALID_FILE', 'ترميز الملف غير صالح.');
      const bytes = Buffer.from(base, 'base64');
      if (!bytes.length || bytes.length > 2 * 1024 * 1024)
        throw fault(413, 'FILE_TOO_LARGE', 'الحد الأقصى للملف 2 ميجابايت.');
      const magic =
        mime === 'application/pdf'
          ? bytes.subarray(0, 5).toString() === '%PDF-'
          : mime === 'image/png'
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      if (!magic) throw fault(400, 'FILE_TYPE_MISMATCH', 'امتداد الملف لا يطابق محتواه.');
      const id = newId();
      const now = at();
      const expiresAt = typeof b.expiresAt === 'string' ? b.expiresAt : null;
      if (expiresAt && !validIsoDate(expiresAt))
        throw fault(400, 'INVALID_DATE', 'تاريخ الانتهاء غير صالح.');
      const doc = await idempotent(
        db,
        actor,
        `document:create:${employee.id}`,
        req.get('Idempotency-Key') ?? undefined,
        { category, filename, mime, base, expiresAt },
        async (tx, m) => getDoc(tx, actor, m.id),
        async (tx) => {
          const totals = (
            await tx.read<{ count: number | string; bytes: number | string | null }>(
              'SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM employee_documents',
            )
          )[0];
          if (
            Number(totals?.count ?? 0) >= 30 ||
            Number(totals?.bytes ?? 0) + bytes.length > 6 * 1024 * 1024
          )
            throw fault(
              429,
              'WORKSPACE_DOCUMENT_CAP',
              'وصلت مساحة المعاينة إلى حد المستندات والملفات المسموح.',
            );
          await tx.execute(
            'INSERT INTO employee_documents(id,employee_id,category,filename,mime_type,size_bytes,expires_at,uploaded_at,uploaded_by,checksum,encrypted_content) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            [
              id,
              employee.id,
              category,
              filename,
              mime,
              bytes.length,
              expiresAt,
              now,
              actor.id,
              sha256(bytes),
              encryptSensitive(bytes.toString('base64'), `employee-document:${id}`),
            ],
          );
          await appendEvent(
            tx,
            actor,
            'document',
            id,
            'document_uploaded',
            null,
            { employeeId: employee.id, category, size: bytes.length },
            1,
            now,
          );
          return { marker: { type: 'document', id }, result: await getDoc(tx, actor, id) };
        },
      );
      res.status(201).json({ document: doc });
    }),
  );
  routeWithActor(
    app,
    'get',
    '/api/admin/documents/:id/download',
    requireActor,
    async (req, res, actor) => {
      const row = await getDocRow(db, param(req, 'id'));
      const owner = row ? await readEmployee(db, row.employee_id) : undefined;
      const categorySensitive = documentCategories.find((c) => c.key === row?.category)?.sensitive;
      const permitted =
        !!row &&
        !!owner &&
        (actor.role === 'hr' ||
          (actor.role === 'employee' && actor.id === row.employee_id) ||
          (actor.role === 'manager' && owner.manager_id === actor.id && !categorySensitive) ||
          (actor.role === 'finance' && categorySensitive === 'financial'));
      if (!row || !permitted) throw fault(404, 'DOCUMENT_NOT_FOUND', 'المستند غير موجود.');
      const bytes = Buffer.from(
        decryptSensitive(row.encrypted_content, `employee-document:${row.id}`),
        'base64',
      );
      await db.transaction(async (tx) => {
        await appendEvent(
          tx,
          actor,
          'document',
          row.id,
          'document_downloaded',
          null,
          { category: row.category },
          Number(row.version),
        );
      });
      res.setHeader('Content-Type', row.mime_type);
      res.setHeader('Content-Length', bytes.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(bytes);
    },
  );
  app.post(
    '/api/admin/documents/:id/archive',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      const b = requireRecord(req.body);
      const version = versionValue(b.version);
      const reason = requiredString(b.reason, 'REASON_REQUIRED', 'أدخل سبب الأرشفة.', 1000);
      const doc = await idempotent(
        db,
        actor,
        `document:archive:${param(req, 'id')}`,
        req.get('Idempotency-Key') ?? undefined,
        { version, reason },
        async (tx, m) => getDoc(tx, actor, m.id),
        async (tx) => {
          const row = await getDocRow(tx, param(req, 'id'));
          if (!row) throw fault(404, 'DOCUMENT_NOT_FOUND', 'المستند غير موجود.');
          const e = await readEmployee(tx, row.employee_id);
          if (!e || !mayManageEmployee(actor, e))
            throw fault(403, 'FORBIDDEN', 'أرشفة المستند متاحة للشؤون الإدارية.');
          if (row.version !== version) throw fault(409, 'STALE_VERSION', 'تغير المستند.');
          const archived = await tx.execute(
            "UPDATE employee_documents SET state='archived',version=version+1 WHERE id=? AND version=?",
            [row.id, version],
          );
          if (archived.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغير المستند.');
          await appendEvent(
            tx,
            actor,
            'document',
            row.id,
            'document_archived',
            reason,
            {},
            version + 1,
          );
          return {
            marker: { type: 'document', id: row.id },
            result: await getDoc(tx, actor, row.id),
          };
        },
      );
      res.json({ document: doc });
    }),
  );
}
function documentCanRead(actor: Actor, category: string) {
  const sensitivity = documentCategories.find((c) => c.key === category)?.sensitive;
  if (actor.role === 'hr' || actor.role === 'auditor') return true;
  if (actor.role === 'finance') return sensitivity === 'financial';
  return sensitivity === undefined;
}
async function getDocRow(db: AsyncDb, id: string) {
  return (await db.read<any>('SELECT * FROM employee_documents WHERE id=?', [id]))[0];
}
function docView(row: any, actor: Actor) {
  return {
    id: row.id,
    employeeId: actor.role === 'auditor' ? '' : row.employee_id,
    employeeName: actor.role === 'auditor' ? 'موظف' : row.employee_name,
    category: row.category,
    filename: actor.role === 'auditor' ? 'مستند وظيفي' : row.filename,
    mimeType: row.mime_type,
    size: Number(row.size_bytes),
    expiresAt: row.expires_at,
    uploadedAt: row.uploaded_at,
    uploadedBy: actor.role === 'auditor' ? '' : row.uploaded_by,
    checksum: actor.role === 'auditor' ? '' : row.checksum,
    version: Number(row.version),
    state: row.state,
  };
}
async function getDoc(db: AsyncDb, actor: Actor, id: string) {
  const row = await getDocRow(db, id);
  if (!row) throw fault(404, 'DOCUMENT_NOT_FOUND', 'المستند غير موجود.');
  const e = await readEmployee(db, row.employee_id);
  if (
    !e ||
    !(
      mayReadEmployee(actor, e) ||
      (actor.role === 'finance' && documentCanRead(actor, row.category))
    )
  )
    throw fault(404, 'DOCUMENT_NOT_FOUND', 'المستند غير موجود.');
  return docView({ ...row, employee_name: e.name }, actor);
}

function registerAttendanceRoutes(app: Express, ctx: { db: AsyncDb; requireActor: RequireActor }) {
  const { db, requireActor } = ctx;
  routeWithActor(app, 'get', '/api/admin/attendance', requireActor, async (_req, res, actor) => {
    const rows = await db.read<any>(
      'SELECT a.*,e.name employee_name FROM attendance_records a JOIN employee_access e ON e.id=a.employee_id ORDER BY a.work_date DESC LIMIT 500',
    );
    const records = [];
    for (const r of rows) {
      const e = await readEmployee(db, r.employee_id);
      if (
        !e ||
        !(
          actor.role === 'hr' ||
          actor.role === 'auditor' ||
          (actor.role === 'manager' && e.manager_id === actor.id) ||
          actor.id === e.id
        )
      )
        continue;
      records.push(await attendanceView(db, actor, r));
    }
    res.json({ records });
  });
  routeWithActor(app, 'post', '/api/admin/attendance', requireActor, async (req, res, actor) => {
    const b = requireRecord(req.body);
    const employeeId = requiredString(b.employeeId, 'EMPLOYEE_REQUIRED', 'حدد الموظف.', 120);
    const date = requiredString(b.date, 'INVALID_DATE', 'التاريخ مطلوب.', 10);
    const checkIn = requiredString(b.checkIn, 'INVALID_TIME', 'وقت الحضور مطلوب.', 5);
    const checkOut = requiredString(b.checkOut, 'INVALID_TIME', 'وقت الانصراف مطلوب.', 5);
    const mode = requiredString(b.workMode, 'INVALID_MODE', 'حدد نمط العمل.', 20);
    const note = typeof b.note === 'string' ? b.note : '';
    if (
      !validIsoDate(date) ||
      !/^\d{2}:\d{2}$/.test(checkIn) ||
      !/^\d{2}:\d{2}$/.test(checkOut) ||
      !['office', 'remote', 'field'].includes(mode) ||
      note.length > 1000
    )
      throw fault(400, 'INVALID_INPUT', 'تحقق من بيانات الحضور.');
    const start = minutes(checkIn);
    const end = minutes(checkOut);
    if (start === null || end === null || end <= start)
      throw fault(400, 'INVALID_TIME', 'وقت الانصراف يجب أن يلي الحضور في اليوم نفسه.');
    const employee = await readEmployee(db, employeeId);
    if (!employee) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
    if (actor.role !== 'hr' && actor.id !== employeeId)
      throw fault(403, 'FORBIDDEN', 'يمكنك تسجيل حضورك فقط.');
    const body = { employeeId, date, checkIn, checkOut, workMode: mode, note };
    const rec = await idempotent(
      db,
      actor,
      'attendance:create',
      req.get('Idempotency-Key') ?? undefined,
      body,
      async (tx, m) => getAttendance(tx, actor, m.id),
      async (tx) => {
        const id = newId();
        const now = at();
        await tx.execute(
          "INSERT INTO attendance_records(id,employee_id,work_date,check_in,check_out,minutes,work_mode,encrypted_note,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'submitted',?,?)",
          [
            id,
            employeeId,
            date,
            checkIn,
            checkOut,
            end - start,
            mode,
            encryptSensitive(note, `attendance:${id}:note`),
            now,
            now,
          ],
        );
        await appendEvent(tx, actor, 'attendance', id, 'attendance_submitted', null, {}, 1, now);
        return { marker: { type: 'attendance', id }, result: await getAttendance(tx, actor, id) };
      },
    );
    res.status(201).json({ record: rec });
  });
  app.post(
    '/api/admin/attendance/:id/decision',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      const b = requireRecord(req.body);
      const version = versionValue(b.version);
      const decision = requiredString(b.decision, 'INVALID_DECISION', 'حدد القرار.', 20);
      const reason = typeof b.reason === 'string' ? b.reason : '';
      if (!['approve', 'reject'].includes(decision) || (decision === 'reject' && !reason.trim()))
        throw fault(400, 'INVALID_DECISION', 'حدد قرارًا صالحًا وسبب الرفض.');
      const rec = await idempotent(
        db,
        actor,
        `attendance:decision:${param(req, 'id')}`,
        req.get('Idempotency-Key') ?? undefined,
        { version, decision, reason },
        async (tx, m) => getAttendance(tx, actor, m.id),
        async (tx) => {
          const row = (
            await tx.read<any>('SELECT * FROM attendance_records WHERE id=?', [param(req, 'id')])
          )[0];
          if (!row) throw fault(404, 'ATTENDANCE_NOT_FOUND', 'السجل غير موجود.');
          const employee = await readEmployee(tx, row.employee_id);
          if (actor.id === row.employee_id)
            throw fault(403, 'SELF_APPROVAL', 'لا تعتمد سجلك بنفسك.');
          if (row.version !== version) throw fault(409, 'STALE_VERSION', 'تغير السجل.');
          if (
            row.state !== 'submitted' ||
            !(
              actor.role === 'hr' ||
              (actor.role === 'manager' && employee?.manager_id === actor.id)
            )
          )
            throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية المراجعة.');
          // Maker-checker: whoever entered the record (e.g. HR on an employee's behalf)
          // cannot also approve or reject it. The submitter is read from the append-only log.
          const submitter = (
            await tx.read<{ actor_id: string }>(
              "SELECT actor_id FROM administration_events WHERE resource_type='attendance' AND resource_id=? AND action='attendance_submitted' ORDER BY created_at,id LIMIT 1",
              [row.id],
            )
          )[0];
          if (submitter?.actor_id === actor.id)
            throw fault(403, 'SELF_APPROVAL', 'لا تعتمد سجل حضور أدخلته بنفسك؛ يراجعه مختص آخر.');
          const now = at();
          const changed = await tx.execute(
            'UPDATE attendance_records SET state=?,version=version+1,reviewed_by=?,encrypted_reason=?,updated_at=? WHERE id=? AND version=?',
            [
              decision === 'approve' ? 'approved' : 'rejected',
              actor.id,
              reason ? encryptSensitive(reason, `attendance:${row.id}:reason`) : null,
              now,
              row.id,
              version,
            ],
          );
          if (changed.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغير سجل الحضور.');
          await appendEvent(
            tx,
            actor,
            'attendance',
            row.id,
            `attendance_${decision}`,
            reason || null,
            {},
            version + 1,
            now,
          );
          return {
            marker: { type: 'attendance', id: row.id },
            result: await getAttendance(tx, actor, row.id),
          };
        },
      );
      res.json({ record: rec });
    }),
  );
}
function minutes(t: string): number | null {
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]),
    n = Number(m[2]);
  return h < 24 && n < 60 ? h * 60 + n : null;
}
async function getAttendance(db: AsyncDb, actor: Actor, id: string) {
  const r = (
    await db.read<any>(
      'SELECT a.*,e.name employee_name FROM attendance_records a JOIN employee_access e ON e.id=a.employee_id WHERE a.id=?',
      [id],
    )
  )[0];
  if (!r) throw fault(404, 'ATTENDANCE_NOT_FOUND', 'السجل غير موجود.');
  const e = await readEmployee(db, r.employee_id);
  if (!(
    actor.role === 'hr' ||
    actor.role === 'auditor' ||
    (actor.role === 'manager' && e?.manager_id === actor.id) ||
    actor.id === r.employee_id
  ))
    throw fault(404, 'ATTENDANCE_NOT_FOUND', 'السجل غير موجود.');
  return attendanceView(db, actor, r);
}
async function attendanceView(_db: AsyncDb, actor: Actor, r: any) {
  let note = '';
  let reason: string | null = null;
  try {
    if (r.encrypted_note && (actor.id === r.employee_id || actor.role === 'hr'))
      note = decryptSensitive(r.encrypted_note, `attendance:${r.id}:note`);
    if (r.encrypted_reason && (actor.id === r.employee_id || actor.role === 'hr'))
      reason = decryptSensitive(r.encrypted_reason, `attendance:${r.id}:reason`);
  } catch {}
  return {
    id: r.id,
    employeeId: actor.role === 'auditor' ? '' : r.employee_id,
    employeeName: actor.role === 'auditor' ? 'موظف' : r.employee_name,
    date: r.work_date,
    checkIn: r.check_in,
    checkOut: r.check_out,
    minutes: Number(r.minutes),
    workMode: r.work_mode,
    note,
    state: r.state,
    version: Number(r.version),
    reviewedBy: actor.role === 'auditor' ? '' : r.reviewed_by,
    reason,
    canReview: actor.role === 'hr' || (actor.role === 'manager' && r.state === 'submitted'),
  };
}

function registerPolicyRoutes(app: Express, ctx: { db: AsyncDb; requireActor: RequireActor }) {
  const { db, requireActor } = ctx;
  routeWithActor(app, 'get', '/api/admin/policies', requireActor, async (_req, res, actor) => {
    if (!['hr', 'approver', 'finance', 'auditor'].includes(actor.role))
      throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية الاطلاع على القواعد.');
    const rows = await db.read<any>(
      'SELECT * FROM administrative_policies ORDER BY policy_key,version DESC',
    );
    res.json({
      policies: rows.map((p) => ({
        id: p.id,
        key: p.policy_key,
        name: p.name,
        version: Number(p.version),
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        source: p.source,
        state: p.state,
        values: actor.role === 'auditor' ? {} : JSON.parse(p.values_json),
        createdBy: actor.role === 'auditor' ? '' : p.created_by,
        approvedBy: actor.role === 'auditor' ? '' : p.approved_by,
      })),
    });
  });
  routeWithActor(app, 'post', '/api/admin/policies', requireActor, async (req, res, actor) => {
    if (actor.role !== 'hr') throw fault(403, 'FORBIDDEN', 'إنشاء القواعد متاح للشؤون الإدارية.');
    const b = requireRecord(req.body);
    const key = requiredString(b.key, 'INVALID_POLICY', 'المعرف مطلوب.', 80);
    const name = requiredString(b.name, 'INVALID_POLICY', 'الاسم مطلوب.', 200);
    const effectiveFrom = requiredString(
      b.effectiveFrom,
      'INVALID_DATE',
      'تاريخ السريان مطلوب.',
      10,
    );
    const effectiveTo = typeof b.effectiveTo === 'string' ? b.effectiveTo : null;
    const source = requiredString(b.source, 'SOURCE_REQUIRED', 'اذكر مصدر القاعدة وحالتها.', 500);
    const values = requireRecord(b.values);
    if (
      !validIsoDate(effectiveFrom) ||
      (effectiveTo && !validIsoDate(effectiveTo)) ||
      (effectiveTo && effectiveTo < effectiveFrom)
    )
      throw fault(400, 'INVALID_DATE', 'فترة السريان غير صالحة.');
    const id = newId();
    const policy = await idempotent(
      db,
      actor,
      'policy:create',
      req.get('Idempotency-Key') ?? undefined,
      { key, name, effectiveFrom, effectiveTo, source, values },
      async (tx, m) => getPolicy(tx, m.id),
      async (tx) => {
        const max = (
          await tx.read<any>(
            'SELECT MAX(version) AS v FROM administrative_policies WHERE policy_key=?',
            [key],
          )
        )[0]?.v;
        const version = Number(max ?? 0) + 1;
        const now = at();
        await tx.execute(
          "INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,effective_to,source,state,values_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,'draft',?,?,?)",
          [
            id,
            key,
            version,
            name,
            effectiveFrom,
            effectiveTo,
            `Synthetic: ${source}`,
            JSON.stringify(values),
            actor.id,
            now,
          ],
        );
        await appendEvent(
          tx,
          actor,
          'policy',
          id,
          'policy_created',
          source,
          { version },
          version,
          now,
        );
        return { marker: { type: 'policy', id }, result: await getPolicy(tx, id) };
      },
    );
    res.status(201).json({ policy });
  });
  app.post(
    '/api/admin/policies/:id/actions',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      const b = requireRecord(req.body);
      const version = versionValue(b.version);
      const action = requiredString(b.action, 'INVALID_ACTION', 'الإجراء مطلوب.', 20);
      const reason = requiredString(b.reason, 'REASON_REQUIRED', 'أدخل سبب الإجراء.', 1000);
      if (!['approve', 'retire'].includes(action))
        throw fault(400, 'INVALID_ACTION', 'الإجراء غير صالح.');
      const policy = await idempotent(
        db,
        actor,
        `policy:action:${param(req, 'id')}`,
        req.get('Idempotency-Key') ?? undefined,
        { version, action, reason },
        async (tx, m) => getPolicy(tx, m.id),
        async (tx) => {
          const row = (
            await tx.read<any>('SELECT * FROM administrative_policies WHERE id=?', [
              param(req, 'id'),
            ])
          )[0];
          if (!row) throw fault(404, 'POLICY_NOT_FOUND', 'القاعدة غير موجودة.');
          if (Number(row.version) !== version) throw fault(409, 'STALE_VERSION', 'تغيرت القاعدة.');
          if (action === 'approve' && row.created_by === actor.id)
            throw fault(403, 'SELF_APPROVAL', 'لا تعتمد القاعدة التي أنشأتها.');
          if (
            action === 'approve'
              ? actor.role !== 'approver' || row.state !== 'draft'
              : actor.role !== 'hr' || row.state !== 'synthetic_approved'
          )
            throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية الإجراء في هذه المرحلة.');
          const state = action === 'approve' ? 'synthetic_approved' : 'retired';
          const changed = await tx.execute(
            'UPDATE administrative_policies SET state=?,approved_by=? WHERE id=? AND version=? AND state=?',
            [state, action === 'approve' ? actor.id : row.approved_by, row.id, version, row.state],
          );
          if (changed.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغيرت القاعدة.');
          await appendEvent(
            tx,
            actor,
            'policy',
            row.id,
            `policy_${action}`,
            reason,
            {},
            row.version,
          );
          return { marker: { type: 'policy', id: row.id }, result: await getPolicy(tx, row.id) };
        },
      );
      res.json({ policy });
    }),
  );
}
async function getPolicy(db: AsyncDb, id: string) {
  const p = (await db.read<any>('SELECT * FROM administrative_policies WHERE id=?', [id]))[0];
  if (!p) throw fault(404, 'POLICY_NOT_FOUND', 'القاعدة غير موجودة.');
  return {
    id: p.id,
    key: p.policy_key,
    name: p.name,
    version: Number(p.version),
    effectiveFrom: p.effective_from,
    effectiveTo: p.effective_to,
    source: p.source,
    state: p.state,
    values: JSON.parse(p.values_json),
    createdBy: p.created_by,
    approvedBy: p.approved_by,
  };
}

function registerReportRoutes(app: Express, ctx: { db: AsyncDb; requireActor: RequireActor }) {
  const { db, requireActor } = ctx;
  routeWithActor(app, 'get', '/api/admin/reports', requireActor, async (_req, res, actor) => {
    if (!['hr', 'finance', 'auditor'].includes(actor.role))
      throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية التقارير.');
    const headcount = await db.read<any>(
      'SELECT department,COUNT(*) AS count FROM employee_access WHERE status=? GROUP BY department ORDER BY department',
      ['active'],
    );
    const requestCounts = await db.read<any>(
      'SELECT state,COUNT(*) AS count FROM administrative_requests GROUP BY state ORDER BY state',
    );
    const attendance = await db.read<any>(
      "SELECT work_date AS date,SUM(CASE WHEN state='approved' THEN 1 ELSE 0 END) AS approved,SUM(CASE WHEN state='submitted' THEN 1 ELSE 0 END) AS submitted,SUM(CASE WHEN state='rejected' THEN 1 ELSE 0 END) AS rejected FROM attendance_records GROUP BY work_date ORDER BY work_date DESC LIMIT 90",
    );
    const overview = await buildAdministrativeOverview(db, actor);
    res.json({
      overview,
      headcount:
        actor.role === 'auditor'
          ? headcount.map((r) => ({ department: 'محجوب', count: Number(r.count) }))
          : headcount.map((r) => ({ department: r.department, count: Number(r.count) })),
      requestCounts: requestCounts.map((r) => ({ state: r.state, count: Number(r.count) })),
      attendance: attendance.map((r) => ({
        date: r.date,
        approved: Number(r.approved),
        submitted: Number(r.submitted),
        rejected: Number(r.rejected),
      })),
    });
  });
  routeWithActor(app, 'get', '/api/admin/reports/export', requireActor, async (req, res, actor) => {
    if (!['hr', 'finance', 'auditor'].includes(actor.role))
      throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية التصدير.');
    const type = String(req.query.type ?? '');
    if (!['employees', 'requests', 'attendance'].includes(type))
      throw fault(400, 'INVALID_EXPORT', 'حدد نوع تقرير صالحًا.');
    let csv = '';
    if (type === 'employees') {
      if (actor.role !== 'hr' && actor.role !== 'auditor')
        throw fault(403, 'FORBIDDEN', 'تصدير ملفات الموظفين متاح للشؤون الإدارية أو المراجع.');
      const rows = await db.read<any>(
        'SELECT employee_number,name,title,department,status FROM employee_access ORDER BY employee_number',
      );
      csv = [
        'employee_number,name,title,department,status',
        ...rows.map((r) =>
          [
            r.employee_number,
            actor.role === 'auditor' ? 'موظف' : r.name,
            r.title,
            actor.role === 'auditor' ? 'محجوب' : r.department,
            r.status,
          ]
            .map(csvCell)
            .join(','),
        ),
      ].join('\r\n');
    } else if (type === 'requests') {
      const rows = await db.read<any>(
        'SELECT request_number,kind,state,created_at,updated_at FROM administrative_requests ORDER BY created_at',
      );
      csv = [
        'number,kind,state,created_at,updated_at',
        ...rows.map((r) =>
          [r.request_number, r.kind, r.state, r.created_at, r.updated_at].map(csvCell).join(','),
        ),
      ].join('\r\n');
    } else {
      const rows = await db.read<any>(
        'SELECT work_date,state,COUNT(*) AS count FROM attendance_records GROUP BY work_date,state ORDER BY work_date',
      );
      csv = [
        'date,state,count',
        ...rows.map((r) => [r.work_date, r.state, r.count].map(csvCell).join(',')),
      ].join('\r\n');
    }
    res
      .type('text/csv; charset=utf-8')
      .attachment(`${type}.csv`)
      .send('\uFEFF' + csv);
  });
  routeWithActor(app, 'get', '/api/admin/audit', requireActor, async (_req, res, actor) => {
    if (!['hr', 'auditor'].includes(actor.role))
      throw fault(403, 'FORBIDDEN', 'سجل التدقيق متاح للشؤون الإدارية والمراجع.');
    const rows = await db.read<any>(
      'SELECT * FROM administration_events ORDER BY created_at DESC LIMIT 500',
    );
    const events = [];
    for (const r of rows) {
      let reason = null;
      if (r.reason && actor.role === 'hr') {
        try {
          reason = decryptSensitive(r.reason, `administration-event:${r.id}:reason`);
        } catch {
          reason = '[معلومة محمية]';
        }
      }
      events.push({
        id: r.id,
        actorName:
          actor.role === 'auditor'
            ? 'مستخدم'
            : ((await readEmployee(db, r.actor_id))?.name ?? 'مستخدم'),
        actorRole: r.actor_role,
        action: r.action,
        resourceId: actor.role === 'auditor' ? '' : r.resource_id,
        reason,
        createdAt: r.created_at,
      });
    }
    res.json({ events });
  });
}
