import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Employee, LeaveRequest, Role } from '../shared/contracts.js';
import {
  createDatabase,
  DEMO_POLICY_ID,
  scheduleIdFor,
  todayInRiyadh,
  type Db,
} from './database.js';

type Session = Actor & { expiresAt: number };
type EmployeeRow = {
  id: string;
  employee_number: string;
  name: string;
  initials: string;
  title: string;
  department: string;
  email: string;
  location: string;
  manager_id: string | null;
  join_date: string;
  role: Role;
  color: string;
  status: 'active';
};
type LeaveRow = {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  days: number;
  note: string;
  status: LeaveRequest['status'];
  version: number;
  created_at: string;
  manager_decision_at: string | null;
  hr_decision_at: string | null;
  decision_reason: string | null;
  policy_version_id: string | null;
  work_schedule_id: string | null;
};
type Actor = { id: string; role: Role };
type ApiFault = Error & { status: number; code: string };
type DemoRules = {
  policyVersion: string;
  version: string;
  scheduleId: string;
  allocatedDays: number;
  workingDays: number[];
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
};
const COOKIE = 'sabq_hr_demo';

function fault(status: number, code: string, message: string): ApiFault {
  return Object.assign(new Error(message), { status, code });
}
function jsonError(res: Response, error: ApiFault): void {
  res.status(error.status).json({ error: { code: error.code, message: error.message } });
}
function safeHost(hostHeader: string | undefined): boolean {
  if (!hostHeader || /[\s/@\\]/.test(hostHeader)) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}
function getEmployee(db: Db, id: string): EmployeeRow | undefined {
  return db.prepare('SELECT * FROM employees WHERE id=?').get(id) as EmployeeRow | undefined;
}
function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    employeeNumber: row.employee_number,
    name: row.name,
    initials: row.initials,
    title: row.title,
    department: row.department,
    email: row.email,
    location: row.location,
    managerId: row.manager_id,
    joinDate: row.join_date,
    role: row.role,
    color: row.color,
    status: 'active',
  };
}
function toLeave(db: Db, row: LeaveRow): LeaveRequest {
  const employee = getEmployee(db, row.employee_id)!;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: employee.name,
    employeeTitle: employee.title,
    department: employee.department,
    initials: employee.initials,
    color: employee.color,
    type: 'annual',
    startDate: row.start_date,
    endDate: row.end_date,
    days: row.days,
    note: row.note,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    managerDecisionAt: row.manager_decision_at,
    hrDecisionAt: row.hr_decision_at,
    decisionReason: row.decision_reason,
  };
}
function scopedLeave(db: Db, row: LeaveRow, actor: Actor): LeaveRequest {
  const value = toLeave(db, row);
  if (actor.role === 'manager' && row.employee_id !== actor.id) value.note = '';
  return value;
}
function balance(db: Db, employeeId: string) {
  const rows = db
    .prepare('SELECT kind, SUM(days) AS days FROM leave_ledger WHERE employee_id=? GROUP BY kind')
    .all(employeeId) as { kind: string; days: number }[];
  const amount = (kind: string) => Number(rows.find((r) => r.kind === kind)?.days ?? 0);
  const allocated = amount('allocation');
  const reserved = amount('reserve') + amount('release');
  const used = -amount('consume');
  return { allocated, available: allocated - reserved - used, reserved, used };
}
function workDays(start: string, end: string, workingDays: number[]): number {
  const workdaySet = new Set(workingDays);
  let count = 0;
  const d = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (d <= last) {
    if (workdaySet.has(d.getUTCDay())) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function dateDistance(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
}
function tx<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
function demoRules(
  db: Db,
  employeeId: string,
  policyVersion = DEMO_POLICY_ID,
  scheduleId = scheduleIdFor(employeeId),
): DemoRules {
  const policy = db.prepare('SELECT * FROM policy_versions WHERE id=?').get(policyVersion) as
    | {
        id: string;
        version: string;
        effective_from: string;
        effective_to: string | null;
        approval_status: string;
        source: string;
        allocated_days: number;
        working_days_json: string;
      }
    | undefined;
  const schedule = db.prepare('SELECT * FROM work_schedules WHERE id=?').get(scheduleId) as
    | {
        id: string;
        employee_id: string;
        timezone: string;
        working_days_json: string;
        source: string;
      }
    | undefined;
  if (
    !policy ||
    !schedule ||
    policy.id !== DEMO_POLICY_ID ||
    policy.approval_status !== 'synthetic-demo-only' ||
    !policy.source.includes('Synthetic demo fixture') ||
    schedule.employee_id !== employeeId ||
    schedule.timezone !== 'Asia/Riyadh' ||
    !schedule.source.includes('Synthetic demo fixture')
  ) {
    throw fault(
      503,
      'DEMO_POLICY_CONFIGURATION_INVALID',
      'تعذر الاحتساب: نسخة السياسة أو جدول الدوام التجريبي مفقود أو غير معتمد للتجربة.',
    );
  }
  let policyDays: number[];
  let scheduleDays: number[];
  try {
    policyDays = JSON.parse(policy.working_days_json);
    scheduleDays = JSON.parse(schedule.working_days_json);
  } catch {
    throw fault(
      503,
      'DEMO_POLICY_CONFIGURATION_INVALID',
      'تعذر الاحتساب: صيغة أيام العمل في سياسة أو جدول التجربة غير صالحة.',
    );
  }
  const validDays = (days: unknown): days is number[] =>
    Array.isArray(days) &&
    days.length > 0 &&
    days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    new Set(days).size === days.length;
  if (
    !validDays(policyDays) ||
    !validDays(scheduleDays) ||
    [...policyDays].sort().join(',') !== [...scheduleDays].sort().join(',') ||
    policy.allocated_days !== 24
  ) {
    throw fault(
      503,
      'DEMO_POLICY_CONFIGURATION_INVALID',
      'تعذر الاحتساب: سياسة وجدول التجربة غير متطابقين أو لا يطابقان نسخة العرض المعتمدة.',
    );
  }
  return {
    policyVersion: policy.id,
    version: policy.version,
    scheduleId: schedule.id,
    allocatedDays: policy.allocated_days,
    workingDays: scheduleDays,
    effectiveFrom: policy.effective_from,
    effectiveTo: policy.effective_to,
    source: policy.source,
  };
}

export function createApp(database?: Db, options: { sessionTtlMs?: number } = {}) {
  const db = database ?? createDatabase();
  const app = express();
  const sessions = new Map<string, Session>();
  const sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    if (!safeHost(req.headers.host))
      return jsonError(res, fault(403, 'LOCAL_HOST_REQUIRED', 'يُسمح بالوصول عبر هذا الجهاز فقط.'));
    next();
  });
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      if (!origin)
        return jsonError(res, fault(403, 'ORIGIN_REQUIRED', 'يلزم طلب من المصدر المحلي نفسه.'));
      try {
        const source = new URL(origin);
        if (
          source.protocol !== 'http:' ||
          source.host.toLowerCase() !== req.get('host')?.toLowerCase() ||
          !safeHost(source.host)
        )
          throw new Error();
      } catch {
        return jsonError(res, fault(403, 'ORIGIN_MISMATCH', 'مصدر الطلب غير مطابق للمضيف المحلي.'));
      }
    }
    next();
  });
  const personaRows = () =>
    db
      .prepare(
        "SELECT * FROM employees WHERE id IN ('emp-noura','emp-omar','emp-sara') ORDER BY CASE id WHEN 'emp-noura' THEN 1 WHEN 'emp-omar' THEN 2 ELSE 3 END",
      )
      .all() as EmployeeRow[];
  const tokenFor = (req: Request) => {
    const value = (req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${COOKIE}=`));
    return value?.slice(COOKIE.length + 1);
  };
  const actorFor = (req: Request): Actor | undefined => {
    const token = tokenFor(req);
    if (!token) return undefined;
    const session = sessions.get(token);
    if (!session) return undefined;
    if (Date.now() >= session.expiresAt) {
      sessions.delete(token);
      return undefined;
    }
    return { id: session.id, role: session.role };
  };
  const requireActor = (req: Request): Actor => {
    const actor = actorFor(req);
    if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول إلى مساحة التجربة.');
    return actor;
  };
  const addAudit = (
    actor: Actor,
    action: string,
    id: string,
    version: number | null,
    reason: string | null,
  ) =>
    db
      .prepare(
        'INSERT INTO audit_events(actor_id,actor_role,action,resource_id,resource_version,reason,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(actor.id, actor.role, action, id, version, reason, new Date().toISOString());
  const enqueue = (recipient: string, title: string, body: string, leaveId: string | null) =>
    db
      .prepare('INSERT INTO outbox(recipient_id,title,body,leave_id,created_at) VALUES(?,?,?,?,?)')
      .run(recipient, title, body, leaveId, new Date().toISOString());
  const idempotent = (
    actor: Actor,
    action: string,
    key: string,
    payload: unknown,
    operation: () => LeaveRequest,
  ): LeaveRequest => {
    if (!key || key.length > 200)
      throw fault(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع التكرار.');
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return tx(db, () => {
      const prior = db
        .prepare(
          'SELECT payload_hash,response_json FROM idempotency WHERE actor_id=? AND action=? AND key=?',
        )
        .get(actor.id, action, key) as { payload_hash: string; response_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== hash)
          throw fault(409, 'IDEMPOTENCY_CONFLICT', 'استُخدم المفتاح نفسه لطلب مختلف.');
        return JSON.parse(prior.response_json) as LeaveRequest;
      }
      const value = operation();
      db.prepare(
        'INSERT INTO idempotency(actor_id,action,key,payload_hash,response_json) VALUES(?,?,?,?,?)',
      ).run(actor.id, action, key, hash, JSON.stringify(value));
      return value;
    });
  };
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: 'synthetic-local' }));
  app.get('/api/session', (req, res) => {
    const actor = actorFor(req);
    res.json({
      me: actor ? toEmployee(getEmployee(db, actor.id)!) : null,
      personas: personaRows()
        .map(toEmployee)
        .map(({ id, name, role, title }) => ({ id, name, role, title })),
    });
  });
  app.post('/api/demo/session', (req, res) => {
    const id = req.body?.employeeId;
    if (!['emp-noura', 'emp-omar', 'emp-sara'].includes(id))
      return jsonError(res, fault(400, 'INVALID_PERSONA', 'اختر إحدى شخصيات التجربة المتاحة.'));
    const previous = tokenFor(req);
    if (previous) sessions.delete(previous);
    const employee = getEmployee(db, id)!;
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, {
      id: employee.id,
      role: employee.role,
      expiresAt: Date.now() + sessionTtlMs,
    });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/',
      maxAge: sessionTtlMs,
    });
    res.json({ me: toEmployee(employee) });
  });
  app.delete('/api/session', (req, res) => {
    const token = tokenFor(req);
    if (token) sessions.delete(token);
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.status(204).end();
  });
  app.get('/api/bootstrap', (req, res) => {
    try {
      const actor = requireActor(req);
      const me = getEmployee(db, actor.id)!;
      const allEmployees = db.prepare('SELECT * FROM employees ORDER BY id').all() as EmployeeRow[];
      const visibleEmployees =
        actor.role === 'hr'
          ? allEmployees
          : actor.role === 'manager'
            ? allEmployees.filter((e) => e.id === actor.id || e.manager_id === actor.id)
            : [me];
      const rules = demoRules(db, actor.id);
      const visibleIds = visibleEmployees.map((e) => e.id);
      const leavesAll = db
        .prepare('SELECT * FROM leave_requests ORDER BY created_at DESC,id')
        .all() as LeaveRow[];
      const leaves = leavesAll
        .filter((l) => visibleIds.includes(l.employee_id))
        .map((l) => scopedLeave(db, l, actor));
      const notifications = db
        .prepare('SELECT * FROM outbox WHERE recipient_id=? ORDER BY created_at DESC,id DESC')
        .all(actor.id) as {
        id: number;
        title: string;
        body: string;
        created_at: string;
        read_at: string | null;
        leave_id: string | null;
      }[];
      const personas = personaRows().map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role,
        title: e.title,
      }));
      res.json({
        me: toEmployee(me),
        employees: visibleEmployees.map(toEmployee),
        leaves,
        balance: balance(db, actor.id),
        notifications: notifications.map((n) => ({
          id: String(n.id),
          title: n.title,
          body: n.body,
          createdAt: n.created_at,
          read: !!n.read_at,
          leaveId: n.leave_id,
        })),
        personas,
        policy: {
          name: 'سياسة الإجازة السنوية التجريبية',
          version: rules.version,
          description: `قاعدة محلية اصطناعية فقط؛ ${rules.source}`,
          workingDays: rules.workingDays,
        },
        today: todayInRiyadh(),
      });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.get('/api/employees/:id', (req, res) => {
    try {
      const actor = requireActor(req);
      const target = getEmployee(db, req.params.id);
      if (!target) throw fault(404, 'NOT_FOUND', 'الموظف غير موجود.');
      if (
        actor.role !== 'hr' &&
        target.id !== actor.id &&
        !(actor.role === 'manager' && target.manager_id === actor.id)
      )
        throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية الاطلاع على هذا الملف.');
      res.json({ employee: toEmployee(target) });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.post('/api/leaves', (req, res) => {
    try {
      const actor = requireActor(req);
      const { startDate, endDate, note } = req.body ?? {};
      if (
        !validDate(startDate) ||
        !validDate(endDate) ||
        typeof note !== 'string' ||
        note.length > 1000
      )
        throw fault(400, 'INVALID_INPUT', 'تحقق من تاريخ البداية والنهاية والملاحظة.');
      if (
        endDate < startDate ||
        dateDistance(startDate, endDate) > 365 ||
        startDate < todayInRiyadh()
      )
        throw fault(400, 'INVALID_DATES', 'الفترة يجب أن تبدأ اليوم أو بعده وألا تتجاوز 366 يومًا.');
      const owner = getEmployee(db, actor.id)!;
      const manager = owner.manager_id ? getEmployee(db, owner.manager_id) : undefined;
      const independentHr = db
        .prepare("SELECT id FROM employees WHERE role='hr' AND id<>? LIMIT 1")
        .get(actor.id) as { id: string } | undefined;
      if (!manager || manager.role !== 'manager' || manager.id === owner.id || !independentHr)
        throw fault(
          409,
          'APPROVAL_ROUTE_UNCONFIGURED',
          'تعذر إرسال الطلب: مسار الاعتماد غير مكتمل أو لا يتضمن معتمدًا مستقلًا. سجّل المسار الناقص لدى مالك النظام قبل المتابعة.',
        );
      const rules = demoRules(db, actor.id);
      if (
        startDate < rules.effectiveFrom ||
        (rules.effectiveTo !== null && endDate > rules.effectiveTo)
      )
        throw fault(
          503,
          'DEMO_POLICY_CONFIGURATION_INVALID',
          'تعذر إرسال الطلب: السياسة التجريبية لا تغطي الفترة المحددة.',
        );
      const days = workDays(startDate, endDate, rules.workingDays);
      if (days === 0)
        throw fault(400, 'NO_WORK_DAYS', 'الفترة لا تحتوي على أيام عمل وفق جدول التجربة.');
      const payload = { startDate, endDate, note };
      const leave = idempotent(
        actor,
        'create_leave',
        req.get('idempotency-key') ?? '',
        payload,
        () => {
          const current = balance(db, actor.id);
          if (current.available < days)
            throw fault(409, 'INSUFFICIENT_BALANCE', 'الرصيد المتاح لا يكفي للفترة المحددة.');
          const overlap = db
            .prepare(
              "SELECT id FROM leave_requests WHERE employee_id=? AND status IN ('pending_manager','pending_hr','approved') AND NOT(end_date<? OR start_date>?) LIMIT 1",
            )
            .get(actor.id, startDate, endDate);
          if (overlap) throw fault(409, 'LEAVE_OVERLAP', 'تتداخل الفترة مع طلب قائم.');
          const id = randomUUID();
          const createdAt = new Date().toISOString();
          db.prepare(
            "INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,note,status,created_at,policy_version_id,work_schedule_id) VALUES(?,?,?,?,?,?,'pending_manager',?,?,?)",
          ).run(
            id,
            actor.id,
            startDate,
            endDate,
            days,
            note,
            createdAt,
            rules.policyVersion,
            rules.scheduleId,
          );
          db.prepare(
            "INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,'reserve',?,?,?)",
          ).run(actor.id, id, days, createdAt, actor.id);
          addAudit(actor, 'leave_submitted', id, 1, null);
          enqueue(manager.id, 'طلب إجازة جديد', `${owner.name} أرسل طلب إجازة للمراجعة.`, id);
          return scopedLeave(
            db,
            db.prepare('SELECT * FROM leave_requests WHERE id=?').get(id) as LeaveRow,
            actor,
          );
        },
      );
      res.status(201).json({ leave });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.post('/api/leaves/:id/decision', (req, res) => {
    try {
      const actor = requireActor(req);
      const { decision, version, reason = '' } = req.body ?? {};
      if (
        !['approve', 'reject'].includes(decision) ||
        !Number.isInteger(version) ||
        typeof reason !== 'string' ||
        reason.length > 1000 ||
        (decision === 'reject' && !reason.trim())
      )
        throw fault(400, 'INVALID_INPUT', 'تحقق من القرار والنسخة وسبب الرفض.');
      const action = `decision:${req.params.id}`;
      const payload = { decision, version, reason };
      const leave = idempotent(actor, action, req.get('idempotency-key') ?? '', payload, () => {
        const row = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id) as
          LeaveRow | undefined;
        if (!row) throw fault(404, 'NOT_FOUND', 'الطلب غير موجود.');
        if (row.employee_id === actor.id)
          throw fault(403, 'SELF_APPROVAL', 'لا يمكن اعتماد طلبك أو رفضه.');
        if (row.version !== version)
          throw fault(409, 'STALE_VERSION', 'تغير الطلب؛ حدّث البيانات ثم أعد المحاولة.');
        const owner = getEmployee(db, row.employee_id)!;
        const managerStep =
          actor.role === 'manager' &&
          owner.manager_id === actor.id &&
          row.status === 'pending_manager';
        const hrStep = actor.role === 'hr' && row.status === 'pending_hr';
        if (!managerStep && !hrStep)
          throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية اتخاذ هذا القرار في هذه المرحلة.');
        const rules = demoRules(
          db,
          row.employee_id,
          row.policy_version_id ?? undefined,
          row.work_schedule_id ?? undefined,
        );
        if (
          row.start_date < rules.effectiveFrom ||
          (rules.effectiveTo !== null && row.end_date > rules.effectiveTo)
        )
          throw fault(
            503,
            'DEMO_POLICY_CONFIGURATION_INVALID',
            'تعذر اعتماد الطلب: نسخة السياسة المثبتة لا تغطي الفترة المحددة.',
          );
        const now = new Date().toISOString();
        const nextStatus =
          decision === 'reject' ? 'rejected' : managerStep ? 'pending_hr' : 'approved';
        if (managerStep)
          db.prepare(
            'UPDATE leave_requests SET status=?,version=version+1,manager_decision_at=?,decision_reason=? WHERE id=? AND version=?',
          ).run(nextStatus, now, decision === 'reject' ? reason : null, row.id, version);
        else
          db.prepare(
            'UPDATE leave_requests SET status=?,version=version+1,hr_decision_at=?,decision_reason=? WHERE id=? AND version=?',
          ).run(nextStatus, now, decision === 'reject' ? reason : null, row.id, version);
        if (decision === 'reject')
          db.prepare(
            "INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,'release',?,?,?)",
          ).run(owner.id, row.id, -row.days, now, actor.id);
        if (nextStatus === 'approved')
          db.prepare(
            "INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,'release',?,?,?),(?,?,'consume',?,?,?)",
          ).run(
            owner.id,
            row.id,
            -row.days,
            now,
            actor.id,
            owner.id,
            row.id,
            -row.days,
            now,
            actor.id,
          );
        addAudit(
          actor,
          `${decision === 'approve' ? 'leave_approved' : 'leave_rejected'}_${managerStep ? 'manager' : 'hr'}`,
          row.id,
          version + 1,
          decision === 'reject' ? reason : null,
        );
        if (nextStatus === 'pending_hr')
          enqueue(
            'emp-noura',
            'طلب بانتظار الموارد البشرية',
            `${owner.name} لديه طلب إجازة بانتظار المراجعة.`,
            row.id,
          );
        else
          enqueue(
            owner.id,
            decision === 'approve' ? 'تم اعتماد طلب الإجازة' : 'تم رفض طلب الإجازة',
            decision === 'reject' ? reason : 'اكتملت مراجعة طلب الإجازة.',
            row.id,
          );
        return scopedLeave(
          db,
          db.prepare('SELECT * FROM leave_requests WHERE id=?').get(row.id) as LeaveRow,
          actor,
        );
      });
      res.json({ leave });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.post('/api/leaves/:id/cancel', (req, res) => {
    try {
      const actor = requireActor(req);
      const { version } = req.body ?? {};
      if (!Number.isInteger(version)) throw fault(400, 'INVALID_INPUT', 'أرسل رقم نسخة الطلب.');
      const action = `cancel:${req.params.id}`;
      const leave = idempotent(actor, action, req.get('idempotency-key') ?? '', { version }, () => {
        const row = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id) as
          LeaveRow | undefined;
        if (!row) throw fault(404, 'NOT_FOUND', 'الطلب غير موجود.');
        if (row.employee_id !== actor.id)
          throw fault(403, 'FORBIDDEN', 'يمكن لصاحب الطلب إلغاء طلبه فقط.');
        if (row.version !== version)
          throw fault(409, 'STALE_VERSION', 'تغير الطلب؛ حدّث البيانات ثم أعد المحاولة.');
        if (row.status !== 'pending_manager' && row.status !== 'pending_hr')
          throw fault(409, 'CANNOT_CANCEL', 'يمكن إلغاء الطلب أثناء المراجعة فقط.');
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE leave_requests SET status='cancelled',version=version+1 WHERE id=? AND version=?",
        ).run(row.id, version);
        db.prepare(
          "INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,'release',?,?,?)",
        ).run(actor.id, row.id, -row.days, now, actor.id);
        addAudit(actor, 'leave_cancelled', row.id, version + 1, null);
        const employee = getEmployee(db, actor.id)!;
        if (employee.manager_id)
          enqueue(
            employee.manager_id,
            'أُلغي طلب الإجازة',
            `${employee.name} ألغى طلبًا قيد المراجعة.`,
            row.id,
          );
        return scopedLeave(
          db,
          db.prepare('SELECT * FROM leave_requests WHERE id=?').get(row.id) as LeaveRow,
          actor,
        );
      });
      res.json({ leave });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.post('/api/notifications/read', (req, res) => {
    try {
      const actor = requireActor(req);
      db.prepare('UPDATE outbox SET read_at=? WHERE recipient_id=? AND read_at IS NULL').run(
        new Date().toISOString(),
        actor.id,
      );
      res.status(204).end();
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/'))
      return jsonError(res, fault(404, 'NOT_FOUND', 'المسار غير موجود.'));
    next();
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const value = err as { status?: number; type?: string };
    if (value?.type === 'entity.parse.failed')
      return jsonError(res, fault(400, 'INVALID_JSON', 'صيغة JSON غير صالحة.'));
    jsonError(res, fault(500, 'INTERNAL_ERROR', 'تعذر إكمال الطلب.'));
  });
  return app;
}
