import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Employee, LeaveRequest, Role } from '../shared/contracts.js';
import {
  createDatabase,
  DEMO_POLICY_ID,
  scheduleIdFor,
  todayInRiyadh,
  type AsyncDb,
  type Db,
} from './database.js';
import { registerAdministration } from './administration/routes.js';
import { createAccountAccess } from './access/index.js';
import { registerPilotStatus } from './pilot-status.js';
import { currentPolicy, leaveChangesFor, registerLeaveRoutes } from './leave/routes.js';
import { annualLeaveDays } from '../shared/leave.js';

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
  status: Employee['status'];
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
  calculation_snapshot_json?: string | null;
  current_flag?: number;
  parent_leave_id?: string | null;
  change_id?: string | null;
};
export type Actor = { id: string; role: Role };
export type RequireActor = (req: Request) => Promise<Actor>;
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
async function getEmployee(
  db: Db,
  id: string,
  query: AsyncDb = db,
): Promise<EmployeeRow | undefined> {
  return (await query.read<EmployeeRow>('SELECT * FROM employee_access WHERE id=?', [id]))[0];
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
    status: row.status,
  };
}
async function toLeave(db: Db, row: LeaveRow, query: AsyncDb = db): Promise<LeaveRequest> {
  const employee = (await getEmployee(db, row.employee_id, query))!;
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
    policyVersionId: row.policy_version_id,
    snapshot: row.calculation_snapshot_json ? JSON.parse(row.calculation_snapshot_json) : undefined,
    current: row.current_flag !== 0,
    parentLeaveId: row.parent_leave_id ?? null,
    changeId: row.change_id ?? null,
  };
}
async function scopedLeave(
  db: Db,
  row: LeaveRow,
  actor: Actor,
  query: AsyncDb = db,
): Promise<LeaveRequest> {
  const value = await toLeave(db, row, query);
  value.changeHistory = await leaveChangesFor(db, row.id, actor, query);
  if (actor.role === 'manager' && row.employee_id !== actor.id) value.note = '';
  return value;
}
async function balance(db: Db, employeeId: string, query: AsyncDb = db) {
  const rows = await query.read<{ kind: string; days: number }>(
    'SELECT kind, SUM(days) AS days FROM leave_ledger WHERE employee_id=? GROUP BY kind',
    [employeeId],
  );
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
async function demoRules(
  db: Db,
  employeeId: string,
  policyVersion = DEMO_POLICY_ID,
  scheduleId = scheduleIdFor(employeeId),
  query: AsyncDb = db,
): Promise<DemoRules> {
  const policy = (
    await query.read('SELECT * FROM policy_versions WHERE id=?', [policyVersion])
  )[0] as
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
  const schedule = (
    await query.read('SELECT * FROM work_schedules WHERE id=?', [scheduleId])
  )[0] as
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

export function createApp(
  database: Db,
  options: { sessionTtlMs?: number; publicOrigin?: string; authMode?: 'demo' | 'accounts' } = {},
) {
  const db = database;
  const authMode = options.authMode ?? 'demo';
  const app = express();
  const sessions = new Map<string, Session>();
  const sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  const pinnedOrigin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (
    pinnedOrigin &&
    (pinnedOrigin.protocol !== 'https:' ||
      pinnedOrigin.pathname !== '/' ||
      pinnedOrigin.search ||
      pinnedOrigin.hash ||
      pinnedOrigin.username ||
      pinnedOrigin.password)
  )
    throw new Error('publicOrigin must be an HTTPS origin without a path or credentials');
  const cookieName = pinnedOrigin ? '__Host-sabq_hr_demo' : COOKIE;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    next();
  });
  app.use((req, res, next) => {
    const host = req.get('host')?.toLowerCase();
    if (pinnedOrigin ? host !== pinnedOrigin.host.toLowerCase() : !safeHost(host))
      return jsonError(
        res,
        fault(403, 'LOCAL_HOST_REQUIRED', 'يُسمح بالوصول عبر المضيف المحدد فقط.'),
      );
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
          pinnedOrigin
            ? origin !== pinnedOrigin.origin ||
              source.origin !== pinnedOrigin.origin ||
              source.host.toLowerCase() !== req.get('host')?.toLowerCase()
            : source.protocol !== 'http:' ||
              source.host.toLowerCase() !== req.get('host')?.toLowerCase() ||
              !safeHost(source.host)
        )
          throw new Error();
      } catch {
        return jsonError(res, fault(403, 'ORIGIN_MISMATCH', 'مصدر الطلب غير مطابق للمضيف المحلي.'));
      }
      const hasBody =
        Number(req.get('content-length') ?? 0) > 0 || Boolean(req.get('transfer-encoding'));
      if (hasBody && !req.is('application/json'))
        return jsonError(res, fault(415, 'JSON_REQUIRED', 'أرسل البيانات بصيغة JSON.'));
    }
    next();
  });
  app.use(
    ['/api/admin/employees/:id/documents', '/api/admin/imports/employees/preview'],
    express.json({ limit: '3mb' }),
  );
  app.use('/api/admin/imports/employees/commit', express.json({ limit: '512kb' }));
  app.use(express.json({ limit: '64kb' }));
  const accountAccess =
    authMode === 'accounts' ? createAccountAccess(db, { secure: !!pinnedOrigin }) : undefined;
  accountAccess?.register(app);
  const demoIds = ['emp-noura', 'emp-omar', 'emp-sara', 'emp-reem', 'emp-abdullah', 'emp-hind'];
  const personaRows = async () =>
    authMode === 'accounts'
      ? []
      : db.read<EmployeeRow>(
          `SELECT * FROM employee_access WHERE id IN (${demoIds.map((_, i) => `?`).join(',')}) ORDER BY id`,
          demoIds,
        );
  const tokenFor = (req: Request) => {
    const value = (req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName}=`));
    return value?.slice(cookieName.length + 1);
  };
  const actorFor = async (req: Request): Promise<Actor | undefined> => {
    if (accountAccess) return accountAccess.actorFor(req);
    const token = tokenFor(req);
    if (!token) return undefined;
    const session = sessions.get(token);
    if (!session) return undefined;
    if (Date.now() >= session.expiresAt) {
      sessions.delete(token);
      return undefined;
    }
    const employee = await getEmployee(db, session.id);
    if (!employee || employee.status === 'suspended' || employee.status === 'terminated') {
      sessions.delete(token);
      return undefined;
    }
    return { id: employee.id, role: employee.role };
  };
  const requireActor: RequireActor = async (req) => {
    const actor = await actorFor(req);
    if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول إلى مساحة الفريق.');
    return actor;
  };
  const addAudit = async (
    query: AsyncDb,
    actor: Actor,
    action: string,
    id: string,
    version: number | null,
    reason: string | null,
  ) =>
    query.execute(
      'INSERT INTO audit_events(actor_id,actor_role,action,resource_id,resource_version,reason,created_at) VALUES(?,?,?,?,?,?,?)',
      [actor.id, actor.role, action, id, version, reason, new Date().toISOString()],
    );
  const enqueue = async (
    query: AsyncDb,
    recipient: string,
    title: string,
    body: string,
    leaveId: string | null,
  ) =>
    query.execute(
      'INSERT INTO outbox(recipient_id,title,body,leave_id,created_at) VALUES(?,?,?,?,?)',
      [recipient, title, body, leaveId, new Date().toISOString()],
    );
  const idempotent = async (
    actor: Actor,
    action: string,
    key: string,
    payload: unknown,
    operation: (tx: AsyncDb) => Promise<LeaveRequest>,
  ): Promise<LeaveRequest> => {
    if (!key || key.length > 200)
      throw fault(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع التكرار.');
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return db.transaction(async (tx) => {
      if (action.startsWith('decision:')) {
        const scope = (
          await tx.read<{ employee_id: string; manager_id: string | null }>(
            'SELECT l.employee_id,e.manager_id FROM leave_requests l JOIN employee_access e ON e.id=l.employee_id WHERE l.id=?',
            [action.slice('decision:'.length)],
          )
        )[0];
        if (!scope) throw fault(404, 'NOT_FOUND', 'الطلب غير موجود.');
        if (scope.employee_id === actor.id)
          throw fault(403, 'SELF_APPROVAL', 'لا يمكن اعتماد طلبك أو رفضه.');
        if (!(actor.role === 'hr' || (actor.role === 'manager' && scope.manager_id === actor.id)))
          throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية مراجعة هذا الطلب حاليًا.');
      }
      const prior = (
        await tx.read<{ payload_hash: string; response_json: string }>(
          'SELECT payload_hash,response_json FROM idempotency WHERE actor_id=? AND action=? AND key=?',
          [actor.id, action, key],
        )
      )[0];
      if (prior) {
        if (prior.payload_hash !== hash)
          throw fault(409, 'IDEMPOTENCY_CONFLICT', 'استُخدم المفتاح نفسه لطلب مختلف.');
        return JSON.parse(prior.response_json) as LeaveRequest;
      }
      const value = await operation(tx);
      await tx.execute(
        'INSERT INTO idempotency(actor_id,action,key,payload_hash,response_json) VALUES(?,?,?,?,?)',
        [actor.id, action, key, hash, JSON.stringify(value)],
      );
      return value;
    });
  };
  const runtimeMode =
    authMode === 'accounts' ? 'operational' : pinnedOrigin ? 'synthetic-hosted' : 'synthetic-local';
  app.get('/api/health', async (_req, res) => {
    try {
      await db.read('SELECT 1 AS healthy');
      res.json({ status: 'ok', mode: runtimeMode });
    } catch {
      res.status(503).json({ status: 'unavailable', mode: runtimeMode });
    }
  });
  app.get('/api/session', async (req, res) => {
    try {
      const actor = await actorFor(req);
      const employee = actor ? await getEmployee(db, actor.id) : undefined;
      const personas = (await personaRows())
        .filter((e) => e.status !== 'suspended' && e.status !== 'terminated')
        .map((e) => ({ id: e.id, name: e.name, role: e.role, title: e.title }));
      res.json({
        me: employee ? toEmployee(employee) : null,
        personas,
        mode: runtimeMode,
      });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.post('/api/demo/session', async (req, res) => {
    try {
      if (accountAccess) throw fault(404, 'NOT_FOUND', 'المسار غير موجود.');
      const id = req.body?.employeeId;
      if (!demoIds.includes(id))
        throw fault(400, 'INVALID_PERSONA', 'اختر إحدى شخصيات التجربة المتاحة.');
      const employee = await getEmployee(db, id);
      if (!employee || employee.status === 'suspended' || employee.status === 'terminated')
        throw fault(400, 'INVALID_PERSONA', 'الشخصية التجريبية غير متاحة.');
      const old = tokenFor(req);
      if (old) sessions.delete(old);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, {
        id: employee.id,
        role: employee.role,
        expiresAt: Date.now() + sessionTtlMs,
      });
      res.cookie(cookieName, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: !!pinnedOrigin,
        path: '/',
        maxAge: sessionTtlMs,
      });
      res.json({ me: toEmployee(employee) });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.delete('/api/session', async (req, res) => {
    if (accountAccess) {
      try {
        await accountAccess.logout(req, res);
        res.status(204).end();
      } catch {
        jsonError(res, fault(503, 'LOGOUT_UNAVAILABLE', 'تعذر إنهاء الجلسة. أعد المحاولة.'));
      }
      return;
    }
    const token = tokenFor(req);
    if (token) sessions.delete(token);
    res.clearCookie(cookieName, {
      httpOnly: true,
      sameSite: 'strict',
      secure: !!pinnedOrigin,
      path: '/',
    });
    res.status(204).end();
  });
  app.get('/api/bootstrap', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const me = (await getEmployee(db, actor.id))!;
      const all = await db.read<EmployeeRow>('SELECT * FROM employee_access ORDER BY id');
      const visible =
        actor.role === 'hr'
          ? all
          : actor.role === 'manager'
            ? all.filter((e) => e.id === actor.id || e.manager_id === actor.id)
            : [me];
      const ids = new Set(visible.map((e) => e.id));
      const rows = await db.read<LeaveRow>(
        'SELECT * FROM leave_requests ORDER BY created_at DESC,id',
      );
      const leaves: LeaveRequest[] = [];
      for (const row of rows)
        if (ids.has(row.employee_id)) leaves.push(await scopedLeave(db, row, actor));
      const notifications = await db.read<{
        id: number | string;
        title: string;
        body: string;
        created_at: string;
        read_at: string | null;
        leave_id: string | null;
        request_id?: string | null;
      }>('SELECT * FROM outbox WHERE recipient_id=? ORDER BY created_at DESC,id DESC', [actor.id]);
      let policyConfigured = false;
      let policySummary = {
        name: 'سياسة الإجازة السنوية غير مسندة',
        version: 'غير متاحة',
        description: 'يجب اعتماد سياسة وإسنادها قبل طلب الإجازة.',
        workingDays: [] as number[],
        holidayDates: [] as string[],
      };
      if (authMode === 'demo') {
        const rules = await demoRules(db, actor.id);
        policyConfigured = true;
        policySummary = {
          name: 'سياسة الإجازة السنوية التجريبية',
          version: rules.version,
          description: `قاعدة محلية اصطناعية فقط؛ ${rules.source}`,
          workingDays: rules.workingDays,
          holidayDates: [],
        };
      }
      if (authMode === 'accounts') {
        const assigned = await db.read<any>(
          `SELECT p.* FROM leave_policy_assignments a JOIN policy_versions p ON p.id=a.policy_version_id
          WHERE a.employee_id=? AND a.approval_status='approved' AND a.effective_from<=? AND (a.effective_to IS NULL OR a.effective_to>=?) AND p.approval_status='approved' AND p.effective_from<=? AND (p.effective_to IS NULL OR p.effective_to>=?) ORDER BY a.effective_from DESC LIMIT 1`,
          [actor.id, todayInRiyadh(), todayInRiyadh(), todayInRiyadh(), todayInRiyadh()],
        );
        policyConfigured = !!assigned[0];
        policySummary = assigned[0]
          ? {
              name: 'سياسة الإجازة السنوية المعتمدة',
              version: assigned[0].version,
              description: assigned[0].source,
              workingDays: JSON.parse(assigned[0].working_days_json),
              holidayDates: JSON.parse(assigned[0].holiday_dates_json ?? '[]'),
            }
          : {
              name: 'لا توجد سياسة مسندة',
              version: 'غير متاحة',
              description: 'اطلب من الموارد البشرية اعتماد سياسة وإسنادها مع رصيد افتتاحي معتمد.',
              workingDays: [],
              holidayDates: [],
            };
      }
      res.json({
        me: toEmployee(me),
        employees: visible.map(toEmployee),
        leaves,
        balance: await balance(db, actor.id),
        notifications: notifications.map((n) => ({
          id: String(n.id),
          title: n.title,
          body: n.body,
          createdAt: n.created_at,
          read: !!n.read_at,
          leaveId: n.leave_id,
          requestId: n.request_id ?? null,
        })),
        personas: (await personaRows()).map((e) => ({
          id: e.id,
          name: e.name,
          role: e.role,
          title: e.title,
        })),
        policy: policySummary,
        policyConfigured,
        authMode,
        today: todayInRiyadh(),
      });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.get('/api/employees/:id', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const target = await getEmployee(db, req.params.id);
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
  app.post('/api/leaves', async (req, res) => {
    try {
      const actor = await requireActor(req);
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
      const owner = (await getEmployee(db, actor.id))!;
      const manager = owner.manager_id ? await getEmployee(db, owner.manager_id) : undefined;
      const hrs = await db.read<{ id: string }>(
        'SELECT id FROM employee_access WHERE role=? AND id<>? AND status NOT IN (?,?) LIMIT 1',
        ['hr', actor.id, 'suspended', 'terminated'],
      );
      if (!manager || manager.role !== 'manager' || manager.id === owner.id || !hrs[0])
        throw fault(
          409,
          'APPROVAL_ROUTE_UNCONFIGURED',
          'تعذر إرسال الطلب: مسار الاعتماد غير مكتمل أو لا يتضمن معتمدًا مستقلًا. سجّل المسار الناقص لدى مالك النظام قبل المتابعة.',
        );
      const rules =
        authMode === 'demo'
          ? await demoRules(db, actor.id)
          : await currentPolicy(db, actor.id, startDate, authMode);
      if (
        authMode === 'demo' &&
        (startDate < rules.effectiveFrom ||
          (rules.effectiveTo !== null && endDate > rules.effectiveTo))
      )
        throw fault(
          503,
          'DEMO_POLICY_CONFIGURATION_INVALID',
          'تعذر إرسال الطلب: السياسة التجريبية لا تغطي الفترة المحددة.',
        );
      if (startDate < rules.effectiveFrom || (rules.effectiveTo && endDate > rules.effectiveTo))
        throw fault(
          409,
          'LEAVE_POLICY_DATE_RANGE',
          'فترة الإجازة خارج مدة سريان السياسة المسندة؛ راجع HR.',
        );
      const holidays = 'holidayDates' in rules ? rules.holidayDates : [];
      const days = annualLeaveDays(startDate, endDate, rules.workingDays, holidays);
      if (!days) throw fault(400, 'NO_WORK_DAYS', 'الفترة لا تحتوي على أيام عمل وفق جدول التجربة.');
      const leave = await idempotent(
        actor,
        'create_leave',
        req.get('idempotency-key') ?? '',
        { startDate, endDate, note },
        async (tx) => {
          const current = await balance(db, actor.id, tx);
          if (current.available < days)
            throw fault(409, 'INSUFFICIENT_BALANCE', 'الرصيد المتاح لا يكفي للفترة المحددة.');
          const overlap = (
            await tx.read<{ id: string }>(
              "SELECT id FROM leave_requests WHERE employee_id=? AND current_flag=1 AND status IN ('pending_manager','pending_hr','approved') AND NOT(end_date<? OR start_date>?) LIMIT 1",
              [actor.id, startDate, endDate],
            )
          )[0];
          if (overlap) throw fault(409, 'LEAVE_OVERLAP', 'تتداخل الفترة مع طلب قائم.');
          const pendingChanges = await tx.read(
            "SELECT id FROM leave_change_requests WHERE employee_id=? AND kind<>'cancel' AND status IN ('pending_manager','pending_hr') AND NOT(proposed_end_date<? OR proposed_start_date>?) LIMIT 1",
            [actor.id, startDate, endDate],
          );
          if (pendingChanges.length)
            throw fault(409, 'LEAVE_OVERLAP', 'تتداخل الفترة مع تعديل إجازة قيد المراجعة.');
          const id = randomUUID();
          const createdAt = new Date().toISOString();
          const policyId =
            authMode === 'demo'
              ? (rules as DemoRules).policyVersion
              : (rules as Awaited<ReturnType<typeof currentPolicy>>).id;
          const snapshot = {
            startDate,
            endDate,
            days,
            policyVersionId: policyId,
            policyVersion: rules.version,
            policySource: rules.source,
            workingDays: rules.workingDays,
            holidayDates: holidays,
            effectiveFrom: rules.effectiveFrom,
            effectiveTo: rules.effectiveTo,
            calculatedAt: createdAt,
          };
          await tx.execute(
            'INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,note,status,created_at,policy_version_id,work_schedule_id,calculation_snapshot_json) VALUES(?,?,?,?,?, ?,?, ?,?,?,?)',
            [
              id,
              actor.id,
              startDate,
              endDate,
              days,
              note,
              'pending_manager',
              createdAt,
              authMode === 'demo'
                ? (rules as DemoRules).policyVersion
                : (rules as Awaited<ReturnType<typeof currentPolicy>>).id,
              authMode === 'demo' ? (rules as DemoRules).scheduleId : null,
              JSON.stringify(snapshot),
            ],
          );
          await tx.execute(
            'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,?,?,?,?)',
            [actor.id, id, 'reserve', days, createdAt, actor.id],
          );
          await addAudit(tx, actor, 'leave_submitted', id, 1, null);
          await enqueue(
            tx,
            manager.id,
            'طلب إجازة جديد',
            `${owner.name} أرسل طلب إجازة للمراجعة.`,
            id,
          );
          const row = (await tx.read<LeaveRow>('SELECT * FROM leave_requests WHERE id=?', [id]))[0];
          return scopedLeave(db, row, actor, tx);
        },
      );
      res.status(201).json({ leave });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.post('/api/leaves/:id/decision', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const { decision, version, reason = '' } = req.body ?? {};
      if (
        !['approve', 'reject'].includes(decision) ||
        !Number.isInteger(version) ||
        typeof reason !== 'string' ||
        reason.length > 1000 ||
        (decision === 'reject' && !reason.trim())
      )
        throw fault(400, 'INVALID_INPUT', 'تحقق من القرار والنسخة وسبب الرفض.');
      const id = req.params.id;
      const leave = await idempotent(
        actor,
        `decision:${id}`,
        req.get('idempotency-key') ?? '',
        { decision, version, reason },
        async (tx) => {
          const row = (await tx.read<LeaveRow>('SELECT * FROM leave_requests WHERE id=?', [id]))[0];
          if (!row) throw fault(404, 'NOT_FOUND', 'الطلب غير موجود.');
          if (row.employee_id === actor.id)
            throw fault(403, 'SELF_APPROVAL', 'لا يمكن اعتماد طلبك أو رفضه.');
          if (row.version !== version)
            throw fault(409, 'STALE_VERSION', 'تغير الطلب؛ حدّث البيانات ثم أعد المحاولة.');
          const owner = (await getEmployee(db, row.employee_id, tx))!;
          const managerStep =
            actor.role === 'manager' &&
            owner.manager_id === actor.id &&
            row.status === 'pending_manager';
          const hrStep = actor.role === 'hr' && row.status === 'pending_hr';
          if (!managerStep && !hrStep)
            throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية اتخاذ هذا القرار في هذه المرحلة.');
          if (decision === 'approve' && !row.calculation_snapshot_json)
            throw fault(
              409,
              'SNAPSHOT_MISSING',
              'تعذر القرار: لا توجد لقطة حساب محفوظة لهذا الطلب.',
            );
          const now = new Date().toISOString();
          const next = decision === 'reject' ? 'rejected' : managerStep ? 'pending_hr' : 'approved';
          await tx.execute(
            'UPDATE leave_requests SET status=?,version=version+1,manager_decision_at=?,decision_reason=? WHERE id=? AND version=?',
            [
              next,
              managerStep ? now : row.manager_decision_at,
              decision === 'reject' ? reason : null,
              id,
              version,
            ],
          );
          if (!managerStep)
            await tx.execute('UPDATE leave_requests SET hr_decision_at=? WHERE id=?', [now, id]);
          if (decision === 'reject')
            await tx.execute(
              'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,?,?,?,?)',
              [owner.id, id, 'release', -row.days, now, actor.id],
            );
          if (next === 'approved') {
            await tx.execute(
              'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,?,?,?,?),(?,?,?,?,?,?)',
              [
                owner.id,
                id,
                'release',
                -row.days,
                now,
                actor.id,
                owner.id,
                id,
                'consume',
                -row.days,
                now,
                actor.id,
              ],
            );
          }
          await addAudit(
            tx,
            actor,
            `${decision === 'approve' ? 'leave_approved' : 'leave_rejected'}_${managerStep ? 'manager' : 'hr'}`,
            id,
            version + 1,
            decision === 'reject' ? reason : null,
          );
          if (next === 'pending_hr') {
            const reviewers = await tx.read<{ id: string }>(
              "SELECT id FROM employee_access WHERE role='hr' AND status IN ('active','on_leave') AND id<>?",
              [owner.id],
            );
            if (!reviewers.length)
              throw fault(
                409,
                'NEXT_APPROVER_UNAVAILABLE',
                'يلزم مراجع موارد بشرية مستقل قبل إحالة الطلب.',
              );
            for (const reviewer of reviewers)
              await enqueue(
                tx,
                reviewer.id,
                'طلب بانتظار الموارد البشرية',
                'لديك طلب إجازة بانتظار المراجعة.',
                id,
              );
          } else
            await enqueue(
              tx,
              owner.id,
              decision === 'approve' ? 'تم اعتماد طلب الإجازة' : 'تم رفض طلب الإجازة',
              decision === 'reject' ? reason : 'اكتملت مراجعة طلب الإجازة.',
              id,
            );
          return scopedLeave(
            db,
            (await tx.read<LeaveRow>('SELECT * FROM leave_requests WHERE id=?', [id]))[0],
            actor,
            tx,
          );
        },
      );
      res.json({ leave });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  app.post('/api/leaves/:id/cancel', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const { version } = req.body ?? {};
      if (!Number.isInteger(version)) throw fault(400, 'INVALID_INPUT', 'أرسل رقم نسخة الطلب.');
      const id = req.params.id;
      const leave = await idempotent(
        actor,
        `cancel:${id}`,
        req.get('idempotency-key') ?? '',
        { version },
        async (tx) => {
          const row = (await tx.read<LeaveRow>('SELECT * FROM leave_requests WHERE id=?', [id]))[0];
          if (!row) throw fault(404, 'NOT_FOUND', 'الطلب غير موجود.');
          if (row.employee_id !== actor.id)
            throw fault(403, 'FORBIDDEN', 'يمكن لصاحب الطلب إلغاء طلبه فقط.');
          if (row.version !== version)
            throw fault(409, 'STALE_VERSION', 'تغير الطلب؛ حدّث البيانات ثم أعد المحاولة.');
          if (row.status !== 'pending_manager' && row.status !== 'pending_hr')
            throw fault(409, 'CANNOT_CANCEL', 'يمكن إلغاء الطلب أثناء المراجعة فقط.');
          const now = new Date().toISOString();
          await tx.execute(
            'UPDATE leave_requests SET status=?,version=version+1 WHERE id=? AND version=?',
            ['cancelled', id, version],
          );
          await tx.execute(
            'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at,actor_id) VALUES(?,?,?,?,?,?)',
            [actor.id, id, 'release', -row.days, now, actor.id],
          );
          await addAudit(tx, actor, 'leave_cancelled', id, version + 1, null);
          const employee = (await getEmployee(db, actor.id, tx))!;
          if (employee.manager_id)
            await enqueue(
              tx,
              employee.manager_id,
              'أُلغي طلب الإجازة',
              `${employee.name} ألغى طلبًا قيد المراجعة.`,
              id,
            );
          return scopedLeave(
            db,
            (await tx.read<LeaveRow>('SELECT * FROM leave_requests WHERE id=?', [id]))[0],
            actor,
            tx,
          );
        },
      );
      res.json({ leave });
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  registerLeaveRoutes(app, { db, requireActor, authMode });
  app.post('/api/notifications/read', async (req, res) => {
    try {
      const actor = await requireActor(req);
      await db.execute('UPDATE outbox SET read_at=? WHERE recipient_id=? AND read_at IS NULL', [
        new Date().toISOString(),
        actor.id,
      ]);
      res.status(204).end();
    } catch (e) {
      jsonError(res, e as ApiFault);
    }
  });
  if (accountAccess) {
    registerPilotStatus(app, db, requireActor);
    // Account pilot approval covers employee files and annual leave. The financial
    // preview must never become an operational calculator merely by changing auth.
    app.use('/api/admin/payroll', async (req, res) => {
      try {
        await requireActor(req);
        jsonError(
          res,
          fault(
            409,
            'PAYROLL_NOT_ACTIVATED',
            'تشغيل الرواتب يحتاج اعتماد قواعده ومطابقته مع المالية.',
          ),
        );
      } catch (error) {
        jsonError(res, error as ApiFault);
      }
    });
  }
  registerAdministration(app, { db, requireActor });
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/'))
      return jsonError(res, fault(404, 'NOT_FOUND', 'المسار غير موجود.'));
    next();
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const value = err as { type?: string };
    if (value?.type === 'entity.parse.failed')
      return jsonError(res, fault(400, 'INVALID_JSON', 'صيغة JSON غير صالحة.'));
    if (value?.type === 'entity.too.large')
      return jsonError(res, fault(413, 'BODY_TOO_LARGE', 'حجم البيانات أكبر من الحد المسموح.'));
    jsonError(res, fault(500, 'INTERNAL_ERROR', 'تعذر إكمال الطلب.'));
  });
  return app;
}
