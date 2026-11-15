import { createHash, randomUUID } from 'node:crypto';
import { actsAsApprover } from '../system-owner.js';
import type { Express, Request, Response } from 'express';
import type { LeaveChangeRequest, LeavePolicy, LeaveSnapshot } from '../../shared/contracts.js';
import { annualLeaveDays, isIsoDate } from '../../shared/leave.js';
import { todayInRiyadh, type AsyncDb, type Db } from '../database.js';
import type { Actor, RequireActor } from '../app.js';

type Fault = Error & { status: number; code: string };
const fail = (status: number, code: string, message: string): Fault =>
  Object.assign(new Error(message), { status, code });
const sendError = (res: Response, error: unknown) => {
  const e = error as Fault;
  res.status(e.status ?? 500).json({
    error: {
      code: e.status ? e.code : 'INTERNAL',
      message: e.status ? e.message : 'تعذر إكمال العملية.',
    },
  });
};
const daysJson = (input: unknown): input is number[] =>
  Array.isArray(input) &&
  input.length > 0 &&
  input.length <= 7 &&
  input.every((x) => Number.isInteger(x) && x >= 0 && x <= 6) &&
  new Set(input).size === input.length;
const datesJson = (input: unknown): input is string[] =>
  Array.isArray(input) &&
  input.length <= 400 &&
  input.every(isIsoDate) &&
  new Set(input).size === input.length;

function mapPolicy(row: any): LeavePolicy {
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    approvalStatus: row.approval_status,
    source: row.source,
    sourceReference: row.source_reference ?? '',
    approvalReference: row.approval_reference ?? null,
    allocatedDays: Number(row.allocated_days),
    workingDays: JSON.parse(row.working_days_json),
    holidayDates: JSON.parse(row.holiday_dates_json ?? '[]'),
  };
}
function mapChange(row: any): LeaveChangeRequest {
  return {
    id: row.id,
    leaveId: row.leave_id,
    employeeId: row.employee_id,
    kind: row.kind,
    status: row.status,
    version: row.version,
    originalVersion: row.original_version,
    original: JSON.parse(row.original_snapshot_json),
    proposed: JSON.parse(row.proposed_snapshot_json),
    reason: row.reason,
    createdAt: row.created_at,
    managerDecisionAt: row.manager_decision_at,
    hrDecisionAt: row.hr_decision_at,
    decisionReason: row.decision_reason,
    reserveDays: row.reserve_days,
    replacementLeaveId: row.replacement_leave_id,
  };
}
async function actorEmployee(db: Db, id: string, tx: AsyncDb = db) {
  return (await tx.read<any>('SELECT * FROM employee_access WHERE id=?', [id]))[0];
}
async function assertOpeningAvailable(tx: AsyncDb, employeeId: string, opening: number) {
  // Zero attaches a policy without adding days. Positive openings must be unique
  // across both the employee-file workflow and the policy-assignment workflow.
  if (opening === 0) return;
  const existing = await tx.read(
    `SELECT 1 AS found FROM leave_balance_openings WHERE employee_id=?
     UNION ALL SELECT 1 FROM leave_ledger WHERE employee_id=?
     UNION ALL SELECT 1 FROM leave_policy_assignments WHERE employee_id=? AND approval_status='approved'
     LIMIT 1`,
    [employeeId, employeeId, employeeId],
  );
  if (existing.length)
    throw fail(
      409,
      'OPENING_BALANCE_ALREADY_EXISTS',
      'يوجد رصيد افتتاحي أو حركة سابقة؛ أسند السياسة برصيد إضافي صفر، واستخدم تسوية مستقلة لتصحيح الرصيد.',
    );
}
async function policyForEmployee(db: Db, employeeId: string, date: string, tx: AsyncDb = db) {
  return (
    await tx.read<any>(
      `SELECT p.*,a.effective_from AS assignment_from,a.effective_to AS assignment_to,a.opening_balance
    FROM leave_policy_assignments a JOIN policy_versions p ON p.id=a.policy_version_id
    WHERE a.employee_id=? AND a.effective_from<=? AND (a.effective_to IS NULL OR a.effective_to>=?)
      AND p.approval_status='approved' AND a.approval_status='approved' ORDER BY a.effective_from DESC LIMIT 1`,
      [employeeId, date, date],
    )
  )[0];
}
function snapshotFrom(
  row: any,
  startDate: string,
  endDate: string,
  days: number,
  calculatedAt: string,
): LeaveSnapshot {
  return {
    startDate,
    endDate,
    days,
    policyVersionId: row.policy_version_id,
    policyVersion: row.version,
    policySource: row.source,
    workingDays: JSON.parse(row.working_days_json),
    holidayDates: JSON.parse(row.holiday_dates_json ?? '[]'),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to ?? null,
    calculatedAt,
  };
}
async function addAudit(
  tx: AsyncDb,
  actor: Actor,
  action: string,
  resource: string,
  version: number | null,
  reason: string | null,
) {
  await tx.execute(
    'INSERT INTO audit_events(actor_id,actor_role,action,resource_id,resource_version,reason,created_at) VALUES(?,?,?,?,?,?,?)',
    [actor.id, actor.role, action, resource, version, reason, new Date().toISOString()],
  );
}
async function idem<T>(
  db: Db,
  actor: Actor,
  action: string,
  key: string,
  body: unknown,
  operation: (tx: AsyncDb) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200)
    throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع التكرار.');
  const hash = createHash('sha256').update(canonical(body)).digest('hex');
  return db.transaction(async (tx) => {
    // A saved response is not an authorization grant after a role/team change.
    if (action.startsWith('leave_change_decision:')) {
      const scope = (
        await tx.read<{ employee_id: string; manager_id: string | null }>(
          'SELECT c.employee_id,e.manager_id FROM leave_change_requests c JOIN employee_access e ON e.id=c.employee_id WHERE c.id=?',
          [action.slice('leave_change_decision:'.length)],
        )
      )[0];
      if (
        !scope ||
        scope.employee_id === actor.id ||
        !(actor.role === 'hr' || (actor.role === 'manager' && scope.manager_id === actor.id))
      )
        throw fail(403, 'FORBIDDEN', 'لا تملك صلاحية مراجعة هذا الطلب حاليًا.');
    }
    const prior = (
      await tx.read<any>(
        'SELECT payload_hash,response_json FROM idempotency WHERE actor_id=? AND action=? AND key=?',
        [actor.id, action, key],
      )
    )[0];
    if (prior) {
      if (prior.payload_hash !== hash)
        throw fail(409, 'IDEMPOTENCY_CONFLICT', 'استُخدم المفتاح نفسه لطلب مختلف.');
      return JSON.parse(prior.response_json) as T;
    }
    const response = await operation(tx);
    await tx.execute(
      'INSERT INTO idempotency(actor_id,action,key,payload_hash,response_json) VALUES(?,?,?,?,?)',
      [actor.id, action, key, hash, JSON.stringify(response)],
    );
    return response;
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function overlap(a: string, b: string, c: string, d: string) {
  return !(b < c || a > d);
}

export function registerLeaveRoutes(
  app: Express,
  {
    db,
    requireActor,
    authMode,
  }: { db: Db; requireActor: RequireActor; authMode: 'demo' | 'accounts' },
) {
  app.get('/api/leave-policies', async (req, res) => {
    try {
      const actor = await requireActor(req);
      if (!['hr', 'approver', 'auditor'].includes(actor.role))
        throw fail(403, 'FORBIDDEN', 'عرض السياسات متاح للموارد البشرية والمعتمد والمدقق.');
      const rows = await db.read<any>(
        'SELECT * FROM policy_versions WHERE policy_key=? ORDER BY created_at DESC',
        ['annual-leave'],
      );
      res.json({ policies: rows.map(mapPolicy) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leave-policies', async (req, res) => {
    try {
      const actor = await requireActor(req);
      if (actor.role !== 'hr')
        throw fail(403, 'FORBIDDEN', 'إنشاء مسودة السياسة متاح للموارد البشرية فقط.');
      const b = req.body ?? {};
      if (
        typeof b.version !== 'string' ||
        !/^[\w.-]{1,40}$/.test(b.version) ||
        !isIsoDate(b.effectiveFrom) ||
        (b.effectiveTo !== null && b.effectiveTo !== undefined && !isIsoDate(b.effectiveTo)) ||
        (b.effectiveTo && b.effectiveTo < b.effectiveFrom) ||
        !Number.isInteger(b.allocatedDays) ||
        b.allocatedDays < 0 ||
        b.allocatedDays > 366 ||
        !daysJson(b.workingDays) ||
        !datesJson(b.holidayDates ?? []) ||
        typeof b.source !== 'string' ||
        !b.source.trim() ||
        b.source.length > 500 ||
        typeof b.sourceReference !== 'string' ||
        !b.sourceReference.trim() ||
        b.sourceReference.length > 500
      )
        throw fail(
          400,
          'INVALID_POLICY',
          'أكمل الإصدار والتواريخ والمدة وأيام العمل والعطل ومصدر القاعدة ومرجعه.',
        );
      const policy = await idem(
        db,
        actor,
        'leave_policy_draft',
        req.get('idempotency-key') ?? '',
        b,
        async (tx) => {
          const duplicate = (
            await tx.read<any>('SELECT id FROM policy_versions WHERE policy_key=? AND version=?', [
              'annual-leave',
              b.version,
            ])
          )[0];
          if (duplicate)
            throw fail(409, 'POLICY_VERSION_EXISTS', 'رقم الإصدار مستخدم؛ اختر إصدارًا جديدًا.');
          const id = randomUUID();
          const now = new Date().toISOString();
          await tx.execute(
            `INSERT INTO policy_versions(id,policy_key,version,effective_from,effective_to,approval_status,source,allocated_days,created_at,working_days_json,source_reference,holiday_dates_json,created_by)
          VALUES(?, 'annual-leave', ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              b.version,
              b.effectiveFrom,
              b.effectiveTo ?? null,
              b.source.trim(),
              b.allocatedDays,
              now,
              JSON.stringify(b.workingDays),
              b.sourceReference.trim(),
              JSON.stringify(b.holidayDates ?? []),
              actor.id,
            ],
          );
          await addAudit(tx, actor, 'leave_policy_drafted', id, null, b.sourceReference.trim());
          return mapPolicy(
            (await tx.read<any>('SELECT * FROM policy_versions WHERE id=?', [id]))[0],
          );
        },
      );
      res.status(201).json({ policy });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leave-policies/:id/approve', async (req, res) => {
    try {
      const actor = await requireActor(req);
      if (!actsAsApprover(actor))
        throw fail(403, 'FORBIDDEN', 'اعتماد السياسة متاح لصاحب صلاحية اعتماد مستقل.');
      const result = await db.transaction(async (tx) => {
        const row = (
          await tx.read<any>('SELECT * FROM policy_versions WHERE id=?', [req.params.id])
        )[0];
        if (!row) throw fail(404, 'NOT_FOUND', 'نسخة السياسة غير موجودة.');
        if (row.approval_status !== 'draft')
          throw fail(409, 'POLICY_NOT_DRAFT', 'هذه النسخة ليست مسودة.');
        if (row.created_by === actor.id)
          throw fail(403, 'SELF_APPROVAL', 'لا يجوز لمنشئ السياسة اعتمادها.');
        const ref = req.body?.approvalReference;
        if (typeof ref !== 'string' || !ref.trim() || ref.length > 200)
          throw fail(400, 'APPROVAL_REFERENCE_REQUIRED', 'أدخل مرجع الاعتماد الداخلي.');
        const now = new Date().toISOString();
        await tx.execute(
          "UPDATE policy_versions SET approval_status='approved',approval_reference=?,approved_by=?,approved_at=? WHERE id=? AND approval_status='draft'",
          [ref.trim(), actor.id, now, row.id],
        );
        await addAudit(tx, actor, 'leave_policy_approved', row.id, null, ref.trim());
        return (await tx.read<any>('SELECT * FROM policy_versions WHERE id=?', [row.id]))[0];
      });
      res.json({ policy: mapPolicy(result) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leave-policies/:id/assign', async (req, res) => {
    try {
      const actor = await requireActor(req);
      if (actor.role !== 'hr')
        throw fail(403, 'FORBIDDEN', 'إسناد السياسة متاح للموارد البشرية فقط.');
      const b = req.body ?? {};
      if (
        typeof b.employeeId !== 'string' ||
        !isIsoDate(b.effectiveFrom) ||
        (b.effectiveTo !== null && b.effectiveTo !== undefined && !isIsoDate(b.effectiveTo)) ||
        (b.effectiveTo && b.effectiveTo < b.effectiveFrom) ||
        !Number.isInteger(b.openingBalance) ||
        b.openingBalance < 0 ||
        b.openingBalance > 366 ||
        typeof b.approvalReference !== 'string' ||
        !b.approvalReference.trim()
      )
        throw fail(
          400,
          'INVALID_ASSIGNMENT',
          'حدد الموظف وفترة السريان والرصيد الافتتاحي المعتمد ومرجع اعتماده.',
        );
      await db.transaction(async (tx) => {
        const policy = (
          await tx.read<any>('SELECT * FROM policy_versions WHERE id=?', [req.params.id])
        )[0];
        if (!policy || policy.approval_status !== 'approved')
          throw fail(409, 'POLICY_NOT_APPROVED', 'لا يمكن إسناد سياسة قبل اعتمادها.');
        const employee = await actorEmployee(db, b.employeeId, tx);
        if (!employee || employee.status === 'suspended' || employee.status === 'terminated')
          throw fail(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير متاح.');
        if (
          b.effectiveFrom < policy.effective_from ||
          (policy.effective_to && (!b.effectiveTo || b.effectiveTo > policy.effective_to)) ||
          (b.effectiveTo && b.effectiveTo < policy.effective_from)
        )
          throw fail(
            409,
            'ASSIGNMENT_POLICY_RANGE',
            'مدة الإسناد يجب أن تقع بالكامل ضمن مدة سريان السياسة المعتمدة.',
          );
        const conflict = (
          await tx.read<any>(
            `SELECT id FROM leave_policy_assignments WHERE employee_id=? AND approval_status IN ('pending','approved') AND NOT(COALESCE(effective_to,'9999-12-31')<? OR effective_from>?) LIMIT 1`,
            [b.employeeId, b.effectiveFrom, b.effectiveTo ?? '9999-12-31'],
          )
        )[0];
        if (conflict)
          throw fail(409, 'ASSIGNMENT_OVERLAP', 'تتداخل فترة الإسناد مع سياسة أخرى للموظف.');
        await assertOpeningAvailable(tx, b.employeeId, b.openingBalance);
        const id = randomUUID();
        const now = new Date().toISOString();
        await tx.execute(
          'INSERT INTO leave_policy_assignments(id,employee_id,policy_version_id,effective_from,effective_to,opening_balance,approval_reference,assigned_by,assigned_at) VALUES(?,?,?,?,?,?,?,?,?)',
          [
            id,
            b.employeeId,
            policy.id,
            b.effectiveFrom,
            b.effectiveTo ?? null,
            b.openingBalance,
            b.approvalReference.trim(),
            actor.id,
            now,
          ],
        );
        await addAudit(
          tx,
          actor,
          'leave_policy_assigned',
          id,
          null,
          `${b.approvalReference.trim()} | ${b.openingBalance}`,
        );
        const approvers = await tx.read<any>(
          "SELECT id FROM employee_access WHERE role='approver' AND id<>? AND status NOT IN ('suspended','terminated') ORDER BY id",
          [actor.id],
        );
        for (const approver of approvers)
          await tx.execute(
            'INSERT INTO outbox(recipient_id,title,body,leave_id,created_at) VALUES(?,?,?,?,?)',
            [
              approver.id,
              'إسناد سياسة بانتظار الاعتماد',
              `إسناد سياسة ورصيد افتتاحي للموظف ${employee.name} بانتظار قرارك.`,
              null,
              now,
            ],
          );
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/leave-policy-assignments', async (req, res) => {
    try {
      const actor = await requireActor(req);
      if (!['hr', 'approver', 'auditor'].includes(actor.role))
        throw fail(403, 'FORBIDDEN', 'عرض الإسنادات متاح للموارد البشرية والمعتمد والمدقق.');
      const rows =
        await db.read<any>(`SELECT a.*,e.name AS employee_name,p.version AS policy_version FROM leave_policy_assignments a
        JOIN employee_access e ON e.id=a.employee_id JOIN policy_versions p ON p.id=a.policy_version_id ORDER BY a.assigned_at DESC`);
      res.json({ assignments: rows });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leave-policy-assignments/:id/approve', async (req, res) => {
    try {
      const actor = await requireActor(req);
      if (!actsAsApprover(actor))
        throw fail(403, 'FORBIDDEN', 'اعتماد الرصيد الافتتاحي متاح لصاحب صلاحية اعتماد مستقل.');
      await idem(
        db,
        actor,
        `leave_assignment_approve:${req.params.id}`,
        req.get('idempotency-key') ?? '',
        { approvalReference: req.body?.approvalReference },
        async (tx) => {
          const row = (
            await tx.read<any>('SELECT * FROM leave_policy_assignments WHERE id=?', [req.params.id])
          )[0];
          if (!row) throw fail(404, 'NOT_FOUND', 'إسناد السياسة غير موجود.');
          if (row.assigned_by === actor.id || row.employee_id === actor.id)
            throw fail(
              403,
              'SELF_APPROVAL',
              'لا يجوز لمُعدّ الإسناد أو المستفيد اعتماد الرصيد الافتتاحي.',
            );
          if (row.approval_status !== 'pending')
            throw fail(409, 'ASSIGNMENT_NOT_PENDING', 'الإسناد ليس بانتظار الاعتماد.');
          const today = todayInRiyadh();
          if (today < row.effective_from)
            throw fail(
              409,
              'FUTURE_EFFECTIVE_DATE',
              'لا يمكن اعتماد رصيد مستقبلي قبل تاريخ سريان الإسناد؛ أعد المحاولة في ذلك اليوم.',
            );
          if (row.effective_to && today > row.effective_to)
            throw fail(
              409,
              'ASSIGNMENT_EXPIRED',
              'انتهى تاريخ الإسناد؛ أنشئ إسنادًا جديدًا بعد مراجعة HR.',
            );
          const reference = req.body?.approvalReference;
          if (typeof reference !== 'string' || !reference.trim() || reference.length > 200)
            throw fail(400, 'APPROVAL_REFERENCE_REQUIRED', 'أدخل مرجع اعتماد الرصيد الافتتاحي.');
          await assertOpeningAvailable(tx, row.employee_id, row.opening_balance);
          const now = new Date().toISOString();
          const updated = await tx.execute(
            "UPDATE leave_policy_assignments SET approval_status='approved',approved_by=?,approved_at=? WHERE id=? AND approval_status='pending'",
            [actor.id, now, row.id],
          );
          if (updated.rowCount !== 1)
            throw fail(409, 'ASSIGNMENT_CHANGED', 'تغير الإسناد؛ حدّث الصفحة.');
          if (row.opening_balance > 0)
            await tx.execute(
              'INSERT INTO leave_ledger(employee_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?)',
              [
                row.employee_id,
                'allocation',
                row.opening_balance,
                now,
                actor.id,
                `policy-assignment:${row.id}:allocation`,
              ],
            );
          await addAudit(
            tx,
            actor,
            'leave_policy_assignment_approved',
            row.id,
            null,
            reference.trim(),
          );
          return { ok: true };
        },
      );
      res.json({ ok: true });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leave-policy-assignments/:id/decision', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const { decision, reason = '' } = req.body ?? {};
      if (
        !['reject', 'cancel'].includes(decision) ||
        typeof reason !== 'string' ||
        !reason.trim() ||
        reason.length > 1000
      )
        throw fail(400, 'INVALID_INPUT', 'حدد سبب رفض الإسناد أو سحبه.');
      const result = await idem(
        db,
        actor,
        `leave_assignment_${decision}:${req.params.id}`,
        req.get('idempotency-key') ?? '',
        { decision, reason },
        async (tx) => {
          const row = (
            await tx.read<any>('SELECT * FROM leave_policy_assignments WHERE id=?', [req.params.id])
          )[0];
          if (!row) throw fail(404, 'NOT_FOUND', 'إسناد السياسة غير موجود.');
          if (row.approval_status !== 'pending')
            throw fail(409, 'ASSIGNMENT_NOT_PENDING', 'الإسناد ليس بانتظار القرار.');
          if (decision === 'reject') {
            if (!actsAsApprover(actor))
              throw fail(403, 'FORBIDDEN', 'رفض الإسناد متاح لصاحب صلاحية اعتماد مستقل.');
            if (row.assigned_by === actor.id || row.employee_id === actor.id)
              throw fail(403, 'SELF_APPROVAL', 'لا يجوز لمُعدّ الإسناد أو المستفيد اتخاذ القرار.');
          } else {
            if (actor.role !== 'hr' || row.assigned_by !== actor.id)
              throw fail(403, 'FORBIDDEN', 'سحب الإسناد متاح لمستخدم HR الذي أعدّه فقط.');
          }
          const status = decision === 'reject' ? 'rejected' : 'cancelled';
          const now = new Date().toISOString();
          const changed = await tx.execute(
            "UPDATE leave_policy_assignments SET approval_status=?,decided_by=?,decision_reason=? WHERE id=? AND approval_status='pending'",
            [status, actor.id, reason.trim(), row.id],
          );
          if (changed.rowCount !== 1)
            throw fail(409, 'ASSIGNMENT_CHANGED', 'تغير الإسناد؛ حدّث الصفحة.');
          await addAudit(
            tx,
            actor,
            `leave_policy_assignment_${status}`,
            row.id,
            null,
            reason.trim(),
          );
          return { ok: true, status };
        },
      );
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leaves/:id/changes', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const b = req.body ?? {};
      if (
        !['cancel', 'extend', 'early_return', 'amend'].includes(b.kind) ||
        !Number.isInteger(b.version) ||
        typeof b.reason !== 'string' ||
        !b.reason.trim() ||
        b.reason.length > 1000
      )
        throw fail(400, 'INVALID_CHANGE', 'حدد نوع التعديل ورقم النسخة وسببًا واضحًا.');
      const change = await idem(
        db,
        actor,
        `leave_change:${req.params.id}`,
        req.get('idempotency-key') ?? '',
        b,
        async (tx) => {
          const row = (
            await tx.read<any>('SELECT * FROM leave_requests WHERE id=?', [req.params.id])
          )[0];
          if (!row) throw fail(404, 'NOT_FOUND', 'طلب الإجازة غير موجود.');
          if (row.employee_id !== actor.id)
            throw fail(403, 'FORBIDDEN', 'يمكن لصاحب الإجازة تقديم طلب تغييرها فقط.');
          if (row.status !== 'approved' || row.current_flag === 0)
            throw fail(409, 'LEAVE_NOT_CURRENT', 'لا يمكن تغيير إجازة غير معتمدة أو مستبدلة.');
          if (row.version !== b.version)
            throw fail(409, 'STALE_VERSION', 'تغير الطلب؛ حدّث الصفحة ثم أعد المحاولة.');
          const open = (
            await tx.read<any>(
              "SELECT id FROM leave_change_requests WHERE leave_id=? AND status IN ('pending_manager','pending_hr') LIMIT 1",
              [row.id],
            )
          )[0];
          if (open) throw fail(409, 'CHANGE_PENDING', 'يوجد طلب تغيير آخر قيد المراجعة.');
          const snap = row.calculation_snapshot_json
            ? (JSON.parse(row.calculation_snapshot_json) as LeaveSnapshot)
            : null;
          if (!snap)
            throw fail(
              409,
              'SNAPSHOT_MISSING',
              'لا تتوفر لقطة الحساب التاريخية؛ اطلب مراجعة HR قبل التغيير.',
            );
          let startDate = b.startDate ?? row.start_date,
            endDate = b.endDate ?? row.end_date;
          if (b.kind === 'cancel') {
            startDate = row.start_date;
            endDate = row.end_date;
          }
          if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate)
            throw fail(400, 'INVALID_DATES', 'تواريخ التعديل غير صالحة.');
          if (
            (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 >
            365
          )
            throw fail(400, 'INVALID_DATES', 'الفترة المعدلة لا يمكن أن تتجاوز 366 يومًا.');
          if (
            (snap.effectiveFrom && startDate < snap.effectiveFrom) ||
            (snap.effectiveTo && endDate > snap.effectiveTo)
          )
            throw fail(
              409,
              'LEAVE_POLICY_DATE_RANGE',
              'الفترة المقترحة تتجاوز مدة سريان السياسة المثبتة في الطلب الأصلي.',
            );
          if (b.kind === 'extend' && (startDate !== row.start_date || endDate <= row.end_date))
            throw fail(
              400,
              'INVALID_EXTENSION',
              'للتمديد أبقِ تاريخ البداية وأدخل تاريخ نهاية لاحقًا.',
            );
          if (
            b.kind === 'early_return' &&
            (startDate !== row.start_date || endDate < row.start_date || endDate >= row.end_date)
          )
            throw fail(
              400,
              'INVALID_EARLY_RETURN',
              'للعودة المبكرة أبقِ البداية وحدد نهاية قبل نهاية الإجازة.',
            );
          if (b.kind === 'amend' && startDate === row.start_date && endDate === row.end_date)
            throw fail(400, 'NO_CHANGE', 'غيّر أحد التاريخين حتى يُسجّل تعديل فعلي.');
          const days =
            b.kind === 'cancel'
              ? 0
              : annualLeaveDays(startDate, endDate, snap.workingDays, snap.holidayDates);
          if (b.kind !== 'cancel' && !days)
            throw fail(400, 'NO_WORK_DAYS', 'الفترة المعدلة لا تحتوي أيام عمل.');
          if (b.kind !== 'cancel') {
            const conflict = (
              await tx.read<any>(
                `SELECT id FROM leave_requests WHERE employee_id=? AND id<>? AND current_flag=1 AND status IN ('pending_manager','pending_hr','approved') AND NOT(end_date<? OR start_date>?) LIMIT 1`,
                [actor.id, row.id, startDate, endDate],
              )
            )[0];
            if (conflict)
              throw fail(409, 'LEAVE_OVERLAP', 'الفترة المقترحة تتداخل مع طلب إجازة آخر.');
            const otherChange = (
              await tx.read(
                'SELECT id FROM leave_change_requests WHERE employee_id=? AND kind<>? AND status IN (?,?) AND NOT(proposed_end_date<? OR proposed_start_date>?) LIMIT 1',
                [actor.id, 'cancel', 'pending_manager', 'pending_hr', startDate, endDate],
              )
            )[0];
            if (otherChange)
              throw fail(
                409,
                'LEAVE_OVERLAP',
                'الفترة المقترحة تتداخل مع تعديل إجازة آخر قيد المراجعة.',
              );
          }
          const reserveDays = Math.max(0, days - row.days);
          const current = await tx.read<any>(
            'SELECT kind,SUM(days) AS days FROM leave_ledger WHERE employee_id=? GROUP BY kind',
            [actor.id],
          );
          const sums = (kind: string) =>
            Number(current.find((x: any) => x.kind === kind)?.days ?? 0);
          const available =
            sums('allocation') - sums('reserve') - sums('release') + sums('consume');
          if (available < reserveDays)
            throw fail(
              409,
              'INSUFFICIENT_BALANCE',
              'الرصيد المتاح لا يكفي للأيام الإضافية المطلوبة.',
            );
          const now = new Date().toISOString();
          const proposed = { ...snap, startDate, endDate, days, calculatedAt: now };
          const id = randomUUID();
          await tx.execute(
            `INSERT INTO leave_change_requests(id,leave_id,employee_id,kind,status,version,original_version,original_snapshot_json,proposed_snapshot_json,proposed_start_date,proposed_end_date,reason,reserve_days,created_at)
          VALUES(?,?,?,?,'pending_manager',1,?,?,?,?,?,?,?,?)`,
            [
              id,
              row.id,
              actor.id,
              b.kind,
              row.version,
              JSON.stringify(snap),
              JSON.stringify(proposed),
              startDate,
              endDate,
              b.reason.trim(),
              reserveDays,
              now,
            ],
          );
          if (reserveDays)
            await tx.execute(
              'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?,?)',
              [
                actor.id,
                row.id,
                'reserve',
                reserveDays,
                now,
                actor.id,
                `leave-change:${id}:reserve`,
              ],
            );
          const owner = await actorEmployee(db, actor.id, tx);
          if (owner?.manager_id)
            await tx.execute(
              'INSERT INTO outbox(recipient_id,title,body,leave_id,created_at) VALUES(?,?,?,?,?)',
              [
                owner.manager_id,
                'طلب تغيير إجازة',
                'يوجد طلب تغيير إجازة بانتظار مراجعتك.',
                row.id,
                now,
              ],
            );
          await addAudit(tx, actor, 'leave_change_submitted', id, 1, b.reason.trim());
          return mapChange(
            (await tx.read<any>('SELECT * FROM leave_change_requests WHERE id=?', [id]))[0],
          );
        },
      );
      res.status(201).json({ change });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leave-changes/:id/decision', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const b = req.body ?? {};
      const reason = typeof b.reason === 'string' ? b.reason : '';
      if (
        !['approve', 'reject'].includes(b.decision) ||
        !Number.isInteger(b.version) ||
        reason.length > 1000 ||
        (b.decision === 'reject' && !reason.trim())
      )
        throw fail(400, 'INVALID_INPUT', 'تحقق من القرار والنسخة وسبب الرفض.');
      const payload = { decision: b.decision, version: b.version, reason };
      const change = await idem(
        db,
        actor,
        `leave_change_decision:${req.params.id}`,
        req.get('idempotency-key') ?? '',
        payload,
        async (tx) => {
          const c = (
            await tx.read<any>('SELECT * FROM leave_change_requests WHERE id=?', [req.params.id])
          )[0];
          if (!c) throw fail(404, 'NOT_FOUND', 'طلب التغيير غير موجود.');
          if (c.employee_id === actor.id)
            throw fail(403, 'SELF_APPROVAL', 'لا يمكن اعتماد طلب تغييرك.');
          if (c.version !== b.version)
            throw fail(409, 'STALE_VERSION', 'تغير طلب التغيير؛ حدّث الصفحة وأعد المحاولة.');
          const leave = (
            await tx.read<any>('SELECT * FROM leave_requests WHERE id=?', [c.leave_id])
          )[0];
          if (!leave || leave.current_flag === 0 || leave.version !== c.original_version)
            throw fail(409, 'ORIGINAL_CHANGED', 'تغيرت الإجازة الأصلية أو استُبدلت؛ أُوقف القرار.');
          const owner = await actorEmployee(db, c.employee_id, tx);
          const managerStep =
            actor.role === 'manager' &&
            owner?.manager_id === actor.id &&
            c.status === 'pending_manager';
          const hrStep =
            actor.role === 'hr' && c.status === 'pending_hr' && c.manager_decided_by !== actor.id;
          if (!managerStep && !hrStep)
            throw fail(
              403,
              'FORBIDDEN',
              'لا تملك صلاحية اتخاذ القرار في هذه المرحلة أو يلزم معتمد مستقل.',
            );
          const now = new Date().toISOString();
          const reject = b.decision === 'reject';
          const next = reject ? 'rejected' : managerStep ? 'pending_hr' : 'approved';
          await tx.execute(
            'UPDATE leave_change_requests SET status=?,version=version+1,manager_decision_at=?,manager_decided_by=?,hr_decision_at=?,hr_decided_by=?,decision_reason=? WHERE id=? AND version=?',
            [
              next,
              managerStep ? now : c.manager_decision_at,
              managerStep ? actor.id : c.manager_decided_by,
              hrStep ? now : c.hr_decision_at,
              hrStep ? actor.id : c.hr_decided_by,
              reject ? reason.trim() : null,
              c.id,
              b.version,
            ],
          );
          const original = JSON.parse(c.original_snapshot_json) as LeaveSnapshot;
          const proposed = JSON.parse(c.proposed_snapshot_json) as LeaveSnapshot;
          if (reject) {
            if (c.reserve_days)
              await tx.execute(
                'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?,?)',
                [
                  c.employee_id,
                  c.leave_id,
                  'release',
                  -c.reserve_days,
                  now,
                  actor.id,
                  `leave-change:${c.id}:release-reject`,
                ],
              );
          } else if (next === 'approved') {
            if (c.reserve_days)
              await tx.execute(
                'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?,?)',
                [
                  c.employee_id,
                  c.leave_id,
                  'release',
                  -c.reserve_days,
                  now,
                  actor.id,
                  `leave-change:${c.id}:release-approve`,
                ],
              );
            const replacementId = randomUUID();
            const targetStatus = c.kind === 'cancel' ? 'cancelled' : 'approved';
            await tx.execute(
              `INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,note,status,version,created_at,policy_version_id,work_schedule_id,calculation_snapshot_json,current_flag,parent_leave_id,change_id)
            VALUES(?,?,?,?,?,?,?,1,?,?,?,?,1,?,?)`,
              [
                replacementId,
                c.employee_id,
                proposed.startDate,
                proposed.endDate,
                c.kind === 'cancel' ? original.days : proposed.days,
                `تغيير مرتبط بالإجازة ${leave.id}: ${c.kind}`,
                targetStatus,
                now,
                original.policyVersionId,
                leave.work_schedule_id,
                JSON.stringify(proposed),
                leave.id,
                c.id,
              ],
            );
            await tx.execute(
              'UPDATE leave_requests SET current_flag=0 WHERE id=? AND current_flag=1',
              [leave.id],
            );
            await tx.execute('UPDATE leave_change_requests SET replacement_leave_id=? WHERE id=?', [
              replacementId,
              c.id,
            ]);
            await tx.execute(
              'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?,?)',
              [
                c.employee_id,
                leave.id,
                'consume',
                original.days,
                now,
                actor.id,
                `leave-change:${c.id}:reverse-consume`,
              ],
            );
            if (proposed.days > 0)
              await tx.execute(
                'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?,?)',
                [
                  c.employee_id,
                  replacementId,
                  'consume',
                  -proposed.days,
                  now,
                  actor.id,
                  `leave-change:${c.id}:replacement-consume`,
                ],
              );
            const overlapRow = (
              await tx.read<any>(
                `SELECT id FROM leave_requests WHERE employee_id=? AND id NOT IN (?,?) AND current_flag=1 AND status IN ('pending_manager','pending_hr','approved') AND NOT(end_date<? OR start_date>?) LIMIT 1`,
                [c.employee_id, leave.id, replacementId, proposed.startDate, proposed.endDate],
              )
            )[0];
            if (proposed.days > 0 && overlapRow)
              throw fail(
                409,
                'LEAVE_OVERLAP',
                'تتداخل الفترة المعدلة مع إجازة أخرى؛ لم يُحفظ القرار.',
              );
          }
          await addAudit(
            tx,
            actor,
            `leave_change_${next}`,
            c.id,
            c.version + 1,
            reject ? reason.trim() : null,
          );
          if (next === 'pending_hr') {
            const reviewers = await tx.read<any>(
              "SELECT id FROM employee_access WHERE role='hr' AND id NOT IN (?,?) AND status NOT IN ('suspended','terminated') ORDER BY id",
              [actor.id, c.employee_id],
            );
            if (!reviewers.length)
              throw fail(
                409,
                'NEXT_APPROVER_UNAVAILABLE',
                'يلزم مراجع موارد بشرية مستقل قبل إحالة الطلب.',
              );
            for (const reviewer of reviewers)
              await tx.execute(
                'INSERT INTO outbox(recipient_id,title,body,leave_id,created_at) VALUES(?,?,?,?,?)',
                [
                  reviewer.id,
                  'طلب تغيير بانتظار الموارد البشرية',
                  'يوجد تغيير إجازة بانتظار مراجعتك.',
                  c.leave_id,
                  now,
                ],
              );
          }
          return mapChange(
            (await tx.read<any>('SELECT * FROM leave_change_requests WHERE id=?', [c.id]))[0],
          );
        },
      );
      res.json({ change });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/leave-changes/:id/cancel', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const { version } = req.body ?? {};
      const change = await idem(
        db,
        actor,
        `leave_change_cancel:${req.params.id}`,
        req.get('idempotency-key') ?? '',
        { version },
        async (tx) => {
          const c = (
            await tx.read<any>('SELECT * FROM leave_change_requests WHERE id=?', [req.params.id])
          )[0];
          if (!c) throw fail(404, 'NOT_FOUND', 'طلب التغيير غير موجود.');
          if (c.employee_id !== actor.id)
            throw fail(403, 'FORBIDDEN', 'يمكن لصاحب الطلب سحب طلبه فقط.');
          if (c.version !== version) throw fail(409, 'STALE_VERSION', 'تغير طلب التغيير.');
          if (!['pending_manager', 'pending_hr'].includes(c.status))
            throw fail(409, 'CANNOT_CANCEL', 'يمكن سحب طلب التغيير أثناء المراجعة فقط.');
          const now = new Date().toISOString();
          await tx.execute(
            "UPDATE leave_change_requests SET status='cancelled',version=version+1 WHERE id=? AND version=?",
            [c.id, version],
          );
          if (c.reserve_days)
            await tx.execute(
              'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?,?)',
              [
                actor.id,
                c.leave_id,
                'release',
                -c.reserve_days,
                now,
                actor.id,
                `leave-change:${c.id}:release-cancel`,
              ],
            );
          await addAudit(tx, actor, 'leave_change_cancelled', c.id, version + 1, null);
          return mapChange(
            (await tx.read<any>('SELECT * FROM leave_change_requests WHERE id=?', [c.id]))[0],
          );
        },
      );
      res.json({ change });
    } catch (e) {
      sendError(res, e);
    }
  });

  void authMode;
}

export async function leaveChangesFor(
  db: Db,
  leaveId: string,
  actor: Actor,
  query: AsyncDb = db,
): Promise<LeaveChangeRequest[]> {
  const rows = await query.read<any>(
    'SELECT * FROM leave_change_requests WHERE leave_id=? ORDER BY created_at,id',
    [leaveId],
  );
  const owner = actor.role === 'manager' ? await actorEmployee(db, actor.id, query) : undefined;
  const managerOwnerIds = owner
    ? (await query.read<any>('SELECT id FROM employee_access WHERE manager_id=?', [actor.id])).map(
        (r: any) => r.id,
      )
    : [];
  return rows
    .filter(
      (r: any) =>
        r.employee_id === actor.id ||
        actor.role === 'hr' ||
        (actor.role === 'manager' && managerOwnerIds.includes(r.employee_id)),
    )
    .map(mapChange);
}

export async function currentPolicy(
  db: Db,
  employeeId: string,
  date: string,
  authMode: 'demo' | 'accounts',
  tx: AsyncDb = db,
): Promise<LeavePolicy & { workScheduleId?: string }> {
  if (authMode === 'accounts') {
    const row = await policyForEmployee(db, employeeId, date, tx);
    if (!row)
      throw fail(
        409,
        'LEAVE_POLICY_REQUIRED',
        'لا يمكن احتساب الإجازة: لا توجد سياسة سنوية معتمدة وسارية مسندة للموظف. اطلب من HR اعتماد السياسة وإسنادها مع رصيد افتتاحي معتمد.',
      );
    const value = mapPolicy(row);
    value.effectiveFrom =
      row.assignment_from > value.effectiveFrom ? row.assignment_from : value.effectiveFrom;
    value.effectiveTo = !value.effectiveTo
      ? row.assignment_to
      : !row.assignment_to
        ? value.effectiveTo
        : row.assignment_to < value.effectiveTo
          ? row.assignment_to
          : value.effectiveTo;
    return { ...value, workScheduleId: undefined };
  }
  const row = (
    await tx.read<any>('SELECT * FROM policy_versions WHERE id=?', ['policy-demo-annual-v1'])
  )[0];
  if (!row)
    throw fail(503, 'DEMO_POLICY_CONFIGURATION_INVALID', 'نسخة سياسة العرض التجريبية غير متاحة.');
  return mapPolicy(row);
}
