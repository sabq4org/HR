// Verified service periods and the end-of-service award (decision 016).
//
// - Service periods: HR records a period with the source it checked, may correct it while it is
//   pending review, then verifies it. A verified period is not edited again. Every step is an
//   append-only employment_period_events row. Nobody records or verifies their own service.
// - The award rule is an administrative_policies version (policy_key 'end-of-service-award'):
//   HR drafts it, the approver or system owner approves it, never its creator. Nothing is
//   computed before a version covering the last working day is approved.
// - Settlement: HR prepares from verified periods and the profile wage, finance reviews, the
//   approver or system owner approves. Approval recomputes and stops if anything changed. The
//   system records the approved amount only; it pays nothing.
import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  EOS_POLICY_KEY,
  EOS_REASONS,
  EOS_WAGE_COMPONENTS,
  eosAward,
  parseEosValues,
  serviceDays,
  type EosAward,
  type EosReason,
  type EosRule,
  type EosTreatment,
  type EosWageComponent,
} from '../../shared/end-of-service.js';
import { isIsoDate } from '../../shared/leave.js';
import { todayInRiyadh, type AsyncDb, type Db } from '../database.js';
import type { Actor, RequireActor } from '../app.js';
import { getProfileValues } from '../administration/service.js';
import { decryptSensitive, encryptSensitive } from '../administration/security.js';
import { approvesPayroll } from '../system-owner.js';
import { payrollEmploymentTypeOf } from '../payroll/index.js';

type Row = Record<string, any>;
type Fault = Error & { status: number; code: string };
const fail = (status: number, code: string, message: string): Fault =>
  Object.assign(new Error(message), { status, code });
const now = () => new Date().toISOString();
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max + 1) : '');

function decimalRiyalToMinor(value: unknown): number | null {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

export async function approvedEosRules(q: AsyncDb): Promise<EosRule[]> {
  const rows = await q.read<Row>(
    "SELECT * FROM administrative_policies WHERE policy_key=? AND state='synthetic_approved' ORDER BY effective_from,version",
    [EOS_POLICY_KEY],
  );
  const rules: EosRule[] = [];
  for (const row of rows) {
    const parsed = parseEosValues(JSON.parse(row.values_json));
    if (!parsed.ok) continue;
    rules.push({
      id: row.id,
      version: Number(row.version),
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to ?? null,
      values: parsed.values,
    });
  }
  return rules;
}
const ruleCovering = (rules: EosRule[], day: string) =>
  rules.filter((r) => r.effectiveFrom <= day && (!r.effectiveTo || r.effectiveTo >= day)).pop() ??
  null;

// ---------- Service periods ----------

const PERIOD_LABEL: Record<string, string> = {
  verified: 'متحقق منها',
  'pending-review': 'بانتظار التحقق',
  'synthetic-demo-only': 'بيانات اصطناعية',
};
function mapPeriod(row: Row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    relationshipType: row.relationship_type,
    source: row.source,
    status: row.status,
    statusLabel: PERIOD_LABEL[row.status] ?? row.status,
    verifiedBy: row.verified_by ?? null,
    verifiedAt: row.verified_at ?? null,
  };
}
async function periodEvent(
  tx: AsyncDb,
  actor: Actor,
  period: Row,
  action: string,
  reason: string | null,
) {
  const t = now();
  await tx.execute(
    'INSERT INTO employment_period_events(id,period_id,employee_id,action,start_date,end_date,source,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [
      randomUUID(),
      period.id,
      period.employee_id,
      action,
      period.start_date,
      period.end_date ?? null,
      period.source,
      reason,
      actor.id,
      t,
    ],
  );
  await tx.execute(
    'INSERT INTO audit_events(actor_id,actor_role,action,resource_id,resource_version,reason,created_at) VALUES(?,?,?,?,?,?,?)',
    [actor.id, actor.role, `employment_period_${action}`, period.id, null, reason, t],
  );
}
function validatePeriodInput(b: Row) {
  const startDate = b.startDate;
  const endDate = b.endDate === '' || b.endDate === undefined ? null : b.endDate;
  const source = text(b.source, 500);
  if (!isIsoDate(startDate) || (endDate !== null && !isIsoDate(endDate)))
    throw fail(400, 'INVALID_DATE', 'تاريخ البداية أو النهاية غير صالح.');
  if (endDate && endDate < startDate) throw fail(400, 'INVALID_DATE', 'نهاية الفترة تسبق بدايتها.');
  if (startDate > todayInRiyadh())
    throw fail(400, 'INVALID_DATE', 'لا تبدأ فترة خدمة في المستقبل.');
  if (!source || source.length > 500)
    throw fail(400, 'SOURCE_REQUIRED', 'اذكر المصدر الذي تحققت منه (العقد، قوى، التأمينات…).');
  const relationshipType = text(b.relationshipType, 80) || 'موظف';
  return { startDate, endDate: endDate as string | null, source, relationshipType };
}
async function assertNoOverlap(
  tx: AsyncDb,
  employeeId: string,
  startDate: string,
  endDate: string | null,
  exceptId: string | null,
) {
  const rows = await tx.read<Row>(
    'SELECT id,start_date,end_date FROM employment_periods WHERE employee_id=?',
    [employeeId],
  );
  for (const r of rows) {
    if (r.id === exceptId) continue;
    const aEnd = endDate ?? '9999-12-31';
    const bEnd = r.end_date ?? '9999-12-31';
    if (!(aEnd < r.start_date || startDate > bEnd))
      throw fail(409, 'PERIOD_OVERLAP', 'تتداخل الفترة مع فترة خدمة مسجلة لهذا الموظف.');
  }
}

// ---------- The award ----------

export interface EosCalculation {
  employeeName: string;
  lastDay: string;
  reasonType: EosReason;
  treatment: EosTreatment;
  ruleId: string;
  ruleVersion: number;
  sourceKind: 'official' | 'secondary';
  periods: { startDate: string; endDate: string | null; source: string }[];
  grossServiceDays: number;
  excludedDays: number;
  excludedReason: string | null;
  components: { key: EosWageComponent; label: string; minor: number }[];
  monthlyWageMinor: number;
  firstTierYears: number;
  firstTierMonthsMilli: number;
  laterMonthsMilli: number;
  yearDays: number;
  award: EosAward;
}

export async function calculateEos(
  q: AsyncDb,
  input: {
    employeeId: string;
    lastDay: string;
    reasonType: EosReason;
    excludedDays: number;
    excludedReason: string | null;
  },
): Promise<EosCalculation> {
  const employee = (
    await q.read<Row>('SELECT id,name FROM employee_access WHERE id=?', [input.employeeId])
  )[0];
  if (!employee) throw fail(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
  const rule = ruleCovering(await approvedEosRules(q), input.lastDay);
  if (!rule)
    throw fail(
      409,
      'NO_RULE_ON_LAST_DAY',
      'لا يوجد إصدار معتمد لقاعدة مكافأة نهاية الخدمة يسري في آخر يوم عمل.',
    );
  const profile = await getProfileValues(q, input.employeeId);
  if (rule.values.excludeContractors && payrollEmploymentTypeOf(profile) === 'contractor')
    throw fail(
      409,
      'CONTRACTOR',
      'المتعاون بمبلغ مقطوع خارج مكافأة نهاية الخدمة وفق القاعدة المعتمدة.',
    );
  const previous = (
    await q.read<Row>(
      "SELECT MAX(last_day) AS d FROM eos_settlements WHERE employee_id=? AND state='approved'",
      [input.employeeId],
    )
  )[0]?.d as string | null;
  if (previous && previous >= input.lastDay)
    throw fail(409, 'ALREADY_SETTLED', 'اعتُمدت مكافأة عن هذه الخدمة أو بعدها.');
  const all = await q.read<Row>(
    'SELECT * FROM employment_periods WHERE employee_id=? ORDER BY start_date',
    [input.employeeId],
  );
  const relevant = all.filter(
    (p) => p.start_date <= input.lastDay && (!previous || !p.end_date || p.end_date > previous),
  );
  if (!relevant.length) throw fail(409, 'NO_PERIODS', 'لا توجد فترة خدمة مسجلة تسبق آخر يوم عمل.');
  if (relevant.some((p) => p.status !== 'verified' && p.status !== 'synthetic-demo-only'))
    throw fail(
      409,
      'PERIODS_UNVERIFIED',
      'توجد فترة خدمة لم يُتحقق منها؛ تحقق منها بمصدرها قبل الاحتساب.',
    );
  const periods = relevant.map((p) => ({
    startDate: previous && p.start_date <= previous ? nextDay(previous) : String(p.start_date),
    endDate: p.end_date ?? null,
    source: String(p.source),
  }));
  const gross = serviceDays(periods, input.lastDay);
  if (input.excludedDays > gross)
    throw fail(400, 'INVALID_EXCLUSION', 'الأيام المستبعدة أكثر من مدة الخدمة.');
  const components = rule.values.wageComponents.map((key) => {
    const raw = profile[key];
    const blank = raw === undefined || raw === null || String(raw).trim() === '';
    const minor = blank && key !== 'basicSalary' ? 0 : decimalRiyalToMinor(raw);
    if (minor === null || (key === 'basicSalary' && !minor))
      throw fail(
        409,
        'WAGE_INCOMPLETE',
        `«${EOS_WAGE_COMPONENTS[key]}» غير مدخل أو غير صالح في الملف.`,
      );
    return { key, label: EOS_WAGE_COMPONENTS[key], minor };
  });
  const monthlyWageMinor = components.reduce((a, c) => a + c.minor, 0);
  const treatment = rule.values.reasonTreatment[input.reasonType];
  const award = eosAward(monthlyWageMinor, gross - input.excludedDays, treatment, rule.values);
  return {
    employeeName: employee.name,
    lastDay: input.lastDay,
    reasonType: input.reasonType,
    treatment,
    ruleId: rule.id,
    ruleVersion: rule.version,
    sourceKind: rule.values.sourceKind,
    periods,
    grossServiceDays: gross,
    excludedDays: input.excludedDays,
    excludedReason: input.excludedReason,
    components,
    monthlyWageMinor,
    firstTierYears: rule.values.firstTierYears,
    firstTierMonthsMilli: rule.values.firstTierMonthsMilli,
    laterMonthsMilli: rule.values.laterMonthsMilli,
    yearDays: rule.values.yearDays,
    award,
  };
}
function nextDay(iso: string) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function readCalcInput(b: Row) {
  const excludedDays =
    b.excludedDays === undefined || b.excludedDays === '' ? 0 : Number(b.excludedDays);
  const excludedReason = text(b.excludedReason, 500) || null;
  if (
    typeof b.employeeId !== 'string' ||
    !isIsoDate(b.lastDay) ||
    typeof b.reasonType !== 'string' ||
    !(b.reasonType in EOS_REASONS)
  )
    throw fail(400, 'INVALID_INPUT', 'حدد الموظف وآخر يوم عمل وسبب انتهاء الخدمة.');
  if (!Number.isInteger(excludedDays) || excludedDays < 0 || excludedDays > 20000)
    throw fail(400, 'INVALID_EXCLUSION', 'الأيام المستبعدة يجب أن تكون عددًا صحيحًا غير سالب.');
  if (excludedDays > 0 && !excludedReason)
    throw fail(400, 'EXCLUSION_REASON_REQUIRED', 'اذكر سبب استبعاد الأيام ومصدره.');
  if (excludedReason && excludedReason.length > 500)
    throw fail(400, 'INVALID_EXCLUSION', 'سبب الاستبعاد طويل جدًا.');
  return {
    employeeId: b.employeeId as string,
    lastDay: b.lastDay as string,
    reasonType: b.reasonType as EosReason,
    excludedDays,
    excludedReason: excludedDays > 0 ? excludedReason : null,
  };
}

const MONEY_ROLES = ['hr', 'finance', 'approver'];
function canAct(row: Row, actor: Actor): boolean {
  if (actor.id === row.employee_id) return false;
  if (row.state === 'pending_finance')
    return actor.role === 'finance' && actor.id !== row.prepared_by;
  if (row.state === 'pending_approver')
    return approvesPayroll(actor) && ![row.prepared_by, row.reviewed_by].includes(actor.id);
  return false;
}
function mapSettlement(row: Row, actor: Actor, events: Row[] = []) {
  const calc = JSON.parse(
    decryptSensitive(row.calculation_ciphertext, `eos-settlement:${row.id}`),
  ) as EosCalculation;
  const money = MONEY_ROLES.includes(actor.role) || actor.owner === true;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: calc.employeeName,
    state: row.state,
    version: Number(row.version),
    lastDay: row.last_day,
    reasonType: row.reason_type,
    serviceDays: Number(row.service_days),
    amountMinor: money ? Number(row.amount_minor) : null,
    calculation: money ? calc : null,
    preparedBy: row.prepared_by,
    reviewedBy: row.reviewed_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    canAct: canAct(row, actor),
    events: events.map((e) => ({
      action: e.action,
      actorId: e.actor_id,
      actorRole: e.actor_role,
      reason: e.reason,
      createdAt: e.created_at,
    })),
  };
}
async function addEvent(
  tx: AsyncDb,
  actor: Actor,
  id: string,
  action: string,
  reason: string | null,
  version: number,
) {
  await tx.execute(
    'INSERT INTO eos_settlement_events(id,settlement_id,actor_id,actor_role,action,reason,version,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [
      randomUUID(),
      id,
      actor.id,
      actor.owner ? 'owner' : actor.role,
      action,
      reason,
      version,
      now(),
    ],
  );
  await tx.execute(
    'INSERT INTO audit_events(actor_id,actor_role,action,resource_id,resource_version,reason,created_at) VALUES(?,?,?,?,?,?,?)',
    [actor.id, actor.role, `eos_settlement_${action}`, id, version, reason, now()],
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Idempotent command; caches only ids, never decrypted wage data. */
async function idem<T>(
  db: Db,
  actor: Actor,
  action: string,
  req: Request,
  body: unknown,
  work: (tx: AsyncDb) => Promise<T>,
): Promise<T> {
  const key = req.get('idempotency-key') ?? '';
  if (!key || key.length > 200)
    throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع التكرار.');
  const hash = createHash('sha256').update(canonical(body)).digest('hex');
  return db.transaction(async (tx) => {
    const prior = (
      await tx.read<Row>(
        'SELECT payload_hash,response_json FROM idempotency WHERE actor_id=? AND action=? AND key=?',
        [actor.id, action, key],
      )
    )[0];
    if (prior) {
      if (prior.payload_hash !== hash)
        throw fail(409, 'IDEMPOTENCY_CONFLICT', 'استُخدم المفتاح نفسه لطلب مختلف.');
      return JSON.parse(prior.response_json) as T;
    }
    const result = await work(tx);
    await tx.execute(
      'INSERT INTO idempotency(actor_id,action,key,payload_hash,response_json) VALUES(?,?,?,?,?)',
      [actor.id, action, key, hash, JSON.stringify(result)],
    );
    return result;
  });
}

export function registerEndOfServiceRoutes(
  app: Express,
  { db, requireActor }: { db: Db; requireActor: RequireActor },
) {
  const route =
    (handler: (req: Request, actor: Actor) => Promise<unknown>, status = 200) =>
    async (req: Request, res: Response) => {
      try {
        const actor = await requireActor(req);
        res.status(status).json(await handler(req, actor));
      } catch (e) {
        const err = e as Fault;
        res.status(err.status ?? 500).json({
          error: {
            code: err.status ? err.code : 'INTERNAL',
            message: err.status ? err.message : 'تعذر إكمال العملية.',
          },
        });
      }
    };
  const hrOnly = (actor: Actor) => {
    if (actor.role !== 'hr') throw fail(403, 'FORBIDDEN', 'هذا الإجراء للموارد البشرية.');
  };
  const staffRoles = (actor: Actor) => {
    if (!MONEY_ROLES.includes(actor.role))
      throw fail(403, 'FORBIDDEN', 'متاح للموارد البشرية والمالية والاعتماد.');
  };

  app.get(
    '/api/eos/rules',
    route(async () => ({
      rules: await approvedEosRules(db),
      reasons: EOS_REASONS,
      components: EOS_WAGE_COMPONENTS,
    })),
  );

  // Service periods of every employee, for HR to see what is missing or unverified.
  app.get(
    '/api/eos/service-periods',
    route(async (_req, actor) => {
      staffRoles(actor);
      const people = await db.read<Row>(
        'SELECT id,name,join_date,status FROM employee_access ORDER BY name',
      );
      const periods = await db.read<Row>(
        'SELECT * FROM employment_periods ORDER BY employee_id,start_date',
      );
      return {
        employees: people.map((p) => {
          const own = periods.filter((x) => x.employee_id === p.id).map(mapPeriod);
          return {
            id: p.id,
            name: p.name,
            joinDate: p.join_date ? String(p.join_date).slice(0, 10) : null,
            status: p.status,
            periods: own,
            verified: own.length > 0 && own.every((x) => x.status === 'verified'),
          };
        }),
      };
    }),
  );

  app.get(
    '/api/eos/service-periods/:employeeId/events',
    route(async (req, actor) => {
      staffRoles(actor);
      const rows = await db.read<Row>(
        'SELECT * FROM employment_period_events WHERE employee_id=? ORDER BY created_at',
        [String(req.params.employeeId)],
      );
      return {
        events: rows.map((e) => ({
          periodId: e.period_id,
          action: e.action,
          startDate: e.start_date,
          endDate: e.end_date,
          source: e.source,
          reason: e.reason,
          actorId: e.actor_id,
          createdAt: e.created_at,
        })),
      };
    }),
  );

  app.post(
    '/api/eos/service-periods',
    route(async (req, actor) => {
      hrOnly(actor);
      const b = req.body ?? {};
      if (typeof b.employeeId !== 'string' || !b.employeeId)
        throw fail(400, 'INVALID_INPUT', 'حدد الموظف.');
      if (b.employeeId === actor.id)
        throw fail(403, 'SELF_SERVICE_RECORD', 'لا تسجل فترة خدمتك بنفسك.');
      const input = validatePeriodInput(b);
      const body = { employeeId: b.employeeId, ...input };
      const out = await idem(db, actor, 'employment_period_create', req, body, async (tx) => {
        const employee = (
          await tx.read<Row>('SELECT id FROM employees WHERE id=?', [b.employeeId])
        )[0];
        if (!employee) throw fail(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
        await assertNoOverlap(tx, b.employeeId, input.startDate, input.endDate, null);
        const id = randomUUID();
        await tx.execute(
          "INSERT INTO employment_periods(id,employee_id,start_date,end_date,relationship_type,source,status,created_at) VALUES(?,?,?,?,?,?,'pending-review',?)",
          [
            id,
            b.employeeId,
            input.startDate,
            input.endDate,
            input.relationshipType,
            input.source,
            now(),
          ],
        );
        const row = (await tx.read<Row>('SELECT * FROM employment_periods WHERE id=?', [id]))[0]!;
        await periodEvent(tx, actor, row, 'recorded', null);
        return { periodId: id };
      });
      const row = (
        await db.read<Row>('SELECT * FROM employment_periods WHERE id=?', [out.periodId])
      )[0]!;
      return { period: mapPeriod(row) };
    }, 201),
  );

  // Correct a period still pending review (dates or source), with a reason.
  app.post(
    '/api/eos/service-periods/:id/correct',
    route(async (req, actor) => {
      hrOnly(actor);
      const b = req.body ?? {};
      const id = String(req.params.id);
      const reason = text(b.reason, 1000);
      if (!reason) throw fail(400, 'REASON_REQUIRED', 'اذكر سبب التصحيح.');
      const input = validatePeriodInput(b);
      await idem(
        db,
        actor,
        `employment_period_correct:${id}`,
        req,
        { ...input, reason },
        async (tx) => {
          const row = (await tx.read<Row>('SELECT * FROM employment_periods WHERE id=?', [id]))[0];
          if (!row) throw fail(404, 'NOT_FOUND', 'الفترة غير موجودة.');
          if (row.employee_id === actor.id)
            throw fail(403, 'SELF_SERVICE_RECORD', 'لا تعدّل فترة خدمتك بنفسك.');
          if (row.status !== 'pending-review')
            throw fail(409, 'PERIOD_LOCKED', 'الفترة المتحقق منها لا تُعدّل؛ سجّل فترة جديدة.');
          await assertNoOverlap(tx, row.employee_id, input.startDate, input.endDate, id);
          await tx.execute(
            'UPDATE employment_periods SET start_date=?,end_date=?,relationship_type=?,source=? WHERE id=?',
            [input.startDate, input.endDate, input.relationshipType, input.source, id],
          );
          const fresh = (
            await tx.read<Row>('SELECT * FROM employment_periods WHERE id=?', [id])
          )[0]!;
          await periodEvent(tx, actor, fresh, 'corrected', reason);
          return { periodId: id };
        },
      );
      const row = (await db.read<Row>('SELECT * FROM employment_periods WHERE id=?', [id]))[0]!;
      return { period: mapPeriod(row) };
    }),
  );

  app.post(
    '/api/eos/service-periods/:id/verify',
    route(async (req, actor) => {
      hrOnly(actor);
      const id = String(req.params.id);
      const reason = text(req.body?.reason, 1000) || null;
      await idem(db, actor, `employment_period_verify:${id}`, req, { reason }, async (tx) => {
        const row = (await tx.read<Row>('SELECT * FROM employment_periods WHERE id=?', [id]))[0];
        if (!row) throw fail(404, 'NOT_FOUND', 'الفترة غير موجودة.');
        if (row.employee_id === actor.id)
          throw fail(403, 'SELF_SERVICE_RECORD', 'لا تتحقق من فترة خدمتك بنفسك.');
        if (row.status !== 'pending-review')
          throw fail(409, 'PERIOD_LOCKED', 'الفترة ليست بانتظار التحقق.');
        if (!String(row.source ?? '').trim() || /synthetic|fictional/i.test(row.source))
          throw fail(409, 'SOURCE_REQUIRED', 'صحّح مصدر الفترة قبل التحقق منها.');
        const t = now();
        const changed = await tx.execute(
          "UPDATE employment_periods SET status='verified',verified_by=?,verified_at=? WHERE id=? AND status='pending-review'",
          [actor.id, t, id],
        );
        if (changed.rowCount !== 1) throw fail(409, 'STALE_VERSION', 'تغيرت الفترة.');
        await periodEvent(tx, actor, row, 'verified', reason);
        return { periodId: id };
      });
      const row = (await db.read<Row>('SELECT * FROM employment_periods WHERE id=?', [id]))[0]!;
      return { period: mapPeriod(row) };
    }),
  );

  app.get(
    '/api/eos/preview',
    route(async (req, actor) => {
      hrOnly(actor);
      const input = readCalcInput(req.query as Row);
      return { calculation: await calculateEos(db, input) };
    }),
  );

  app.get(
    '/api/eos/settlements',
    route(async (_req, actor) => {
      staffRoles(actor);
      const rows = await db.read<Row>(
        actor.role === 'approver'
          ? "SELECT * FROM eos_settlements WHERE state IN ('pending_approver','approved','rejected') ORDER BY created_at DESC"
          : 'SELECT * FROM eos_settlements ORDER BY created_at DESC',
      );
      return { settlements: rows.map((r) => mapSettlement(r, actor)) };
    }),
  );

  app.get(
    '/api/eos/settlements/:id',
    route(async (req, actor) => {
      staffRoles(actor);
      const row = (
        await db.read<Row>('SELECT * FROM eos_settlements WHERE id=?', [String(req.params.id)])
      )[0];
      if (!row) throw fail(404, 'NOT_FOUND', 'التسوية غير موجودة.');
      const events = await db.read<Row>(
        'SELECT * FROM eos_settlement_events WHERE settlement_id=? ORDER BY created_at',
        [row.id],
      );
      return { settlement: mapSettlement(row, actor, events) };
    }),
  );

  app.post(
    '/api/eos/settlements',
    route(async (req, actor) => {
      hrOnly(actor);
      const input = readCalcInput(req.body ?? {});
      if (input.employeeId === actor.id)
        throw fail(403, 'SELF_SETTLEMENT', 'لا تعدّ مكافأة نهاية خدمتك بنفسك.');
      const out = await idem(db, actor, 'eos_settlement_create', req, input, async (tx) => {
        const open = await tx.read(
          "SELECT 1 FROM eos_settlements WHERE employee_id=? AND state IN ('pending_finance','pending_approver') LIMIT 1",
          [input.employeeId],
        );
        if (open.length)
          throw fail(409, 'SETTLEMENT_EXISTS', 'توجد تسوية قيد المراجعة لهذا الموظف.');
        const calc = await calculateEos(tx, input);
        const id = randomUUID();
        const t = now();
        await tx.execute(
          `INSERT INTO eos_settlements(id,employee_id,state,version,last_day,reason_type,calculation_ciphertext,service_days,amount_minor,prepared_by,created_at,updated_at)
           VALUES(?,?,'pending_finance',1,?,?,?,?,?,?,?,?)`,
          [
            id,
            input.employeeId,
            input.lastDay,
            input.reasonType,
            encryptSensitive(JSON.stringify(calc), `eos-settlement:${id}`),
            calc.award.serviceDays,
            calc.award.amountMinor,
            actor.id,
            t,
            t,
          ],
        );
        await addEvent(tx, actor, id, 'prepared', input.excludedReason, 1);
        return { settlementId: id };
      });
      const row = (
        await db.read<Row>('SELECT * FROM eos_settlements WHERE id=?', [out.settlementId])
      )[0]!;
      return { settlement: mapSettlement(row, actor) };
    }, 201),
  );

  app.post(
    '/api/eos/settlements/:id/actions',
    route(async (req, actor) => {
      const b = req.body ?? {};
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (
        !['approve', 'reject', 'cancel'].includes(b.action) ||
        !Number.isInteger(b.version) ||
        reason.length > 1000 ||
        (b.action !== 'approve' && !reason)
      )
        throw fail(
          400,
          'INVALID_INPUT',
          'حدد الإجراء ورقم النسخة، واذكر السبب عند الرفض أو الإلغاء.',
        );
      const id = String(req.params.id);
      await idem(
        db,
        actor,
        `eos_settlement_action:${id}`,
        req,
        { action: b.action, version: b.version, reason },
        async (tx) => {
          const row = (await tx.read<Row>('SELECT * FROM eos_settlements WHERE id=?', [id]))[0];
          if (!row) throw fail(404, 'NOT_FOUND', 'التسوية غير موجودة.');
          if (Number(row.version) !== b.version)
            throw fail(409, 'STALE_VERSION', 'تغيرت التسوية؛ حدّث الصفحة.');
          const t = now();
          if (b.action === 'cancel') {
            if (
              actor.id !== row.prepared_by ||
              !['pending_finance', 'pending_approver'].includes(row.state)
            )
              throw fail(403, 'FORBIDDEN', 'يلغي المعدّ التسوية قبل اعتمادها فقط.');
            await tx.execute(
              "UPDATE eos_settlements SET state='cancelled',version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?",
              [t, t, id, b.version],
            );
          } else {
            if (row.employee_id === actor.id)
              throw fail(403, 'SELF_APPROVAL', 'لا تتخذ قرارًا في مكافأة نهاية خدمتك.');
            if (!canAct(row, actor))
              throw fail(
                403,
                'FORBIDDEN',
                'لا تملك صلاحية القرار في هذه المرحلة أو سبق أن أعددتها أو راجعتها.',
              );
            const reject = b.action === 'reject';
            if (row.state === 'pending_finance') {
              await tx.execute(
                'UPDATE eos_settlements SET state=?,reviewed_by=?,version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?',
                [
                  reject ? 'rejected' : 'pending_approver',
                  actor.id,
                  t,
                  reject ? t : null,
                  id,
                  b.version,
                ],
              );
            } else if (reject) {
              await tx.execute(
                "UPDATE eos_settlements SET state='rejected',approved_by=?,version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?",
                [actor.id, t, t, id, b.version],
              );
            } else {
              const prepared = JSON.parse(
                decryptSensitive(row.calculation_ciphertext, `eos-settlement:${id}`),
              ) as EosCalculation;
              const fresh = await calculateEos(tx, {
                employeeId: row.employee_id,
                lastDay: row.last_day,
                reasonType: row.reason_type,
                excludedDays: prepared.excludedDays,
                excludedReason: prepared.excludedReason,
              });
              if (
                fresh.award.amountMinor !== Number(row.amount_minor) ||
                fresh.award.serviceDays !== Number(row.service_days)
              )
                throw fail(
                  409,
                  'CALCULATION_CHANGED',
                  'تغيرت مدة الخدمة أو الأجر أو القاعدة منذ الإعداد؛ ارفض التسوية ليعدّها الموارد البشرية من جديد.',
                );
              await tx.execute(
                "UPDATE eos_settlements SET state='approved',approved_by=?,version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?",
                [actor.id, t, t, id, b.version],
              );
            }
          }
          const action =
            b.action === 'cancel'
              ? 'cancelled'
              : b.action === 'reject'
                ? 'rejected'
                : row.state === 'pending_finance'
                  ? 'reviewed'
                  : 'approved';
          await addEvent(tx, actor, id, action, reason || null, Number(row.version) + 1);
          return { settlementId: id };
        },
      );
      const row = (await db.read<Row>('SELECT * FROM eos_settlements WHERE id=?', [id]))[0]!;
      return { settlement: mapSettlement(row, actor) };
    }),
  );
}
