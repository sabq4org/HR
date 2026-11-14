// Annual leave entitlement and leave encashment on separation (decision 015).
//
// - The rule is an administrative_policies version (policy_key 'annual-leave-entitlement'):
//   HR drafts it, the approver or the system owner approves it, never its creator.
// - Accrual: HR posts accrual "through" a date. Each calendar day earns the rule's yearly days
//   divided by its year length; the senior rate applies from the service anniversary. Whole days
//   go to leave_ledger as 'allocation'; the fraction stays in leave_accrual_postings.
// - Encashment (art. 111): HR prepares from the ledger and the employee's profile wage, finance
//   reviews, the approver or system owner approves. Approval consumes the remaining ledger
//   balance; nobody acts twice and nobody acts on their own settlement.
import { randomUUID, createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  LEAVE_ENTITLEMENT_POLICY_KEY,
  LEAVE_WAGE_COMPONENTS,
  accrueLeave,
  addDays,
  anniversary,
  completedServiceYears,
  encashmentAmount,
  parseLeaveEntitlementValues,
  type LeaveEntitlementRule,
  type LeaveWageComponent,
} from '../../shared/leave-entitlement.js';
import { isIsoDate } from '../../shared/leave.js';
import { todayInRiyadh, type AsyncDb, type Db } from '../database.js';
import type { Actor, RequireActor } from '../app.js';
import { getProfileValues } from '../administration/service.js';
import { decryptSensitive, encryptSensitive } from '../administration/security.js';
import { approvesPayroll } from '../system-owner.js';

type Row = Record<string, any>;
type Fault = Error & { status: number; code: string };
const fail = (status: number, code: string, message: string): Fault =>
  Object.assign(new Error(message), { status, code });
const now = () => new Date().toISOString();

function decimalRiyalToMinor(value: unknown): number | null {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

export const SETTLEMENT_REASONS = {
  resignation: 'استقالة',
  contract_end: 'انتهاء العقد',
  employer: 'إنهاء من صاحب العمل',
  mutual: 'اتفاق الطرفين',
  other: 'سبب آخر',
} as const;

/** Approved entitlement rule versions, oldest first. */
export async function approvedEntitlementRules(q: AsyncDb): Promise<LeaveEntitlementRule[]> {
  const rows = await q.read<Row>(
    "SELECT * FROM administrative_policies WHERE policy_key=? AND state='synthetic_approved' ORDER BY effective_from,version",
    [LEAVE_ENTITLEMENT_POLICY_KEY],
  );
  const rules: LeaveEntitlementRule[] = [];
  for (const row of rows) {
    const parsed = parseLeaveEntitlementValues(JSON.parse(row.values_json));
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

async function ledgerTotals(q: AsyncDb, employeeId: string) {
  const rows = await q.read<{ kind: string; days: number }>(
    'SELECT kind,SUM(days) AS days FROM leave_ledger WHERE employee_id=? GROUP BY kind',
    [employeeId],
  );
  const sum = (k: string) => Number(rows.find((r) => r.kind === k)?.days ?? 0);
  const allocated = sum('allocation');
  const reserved = sum('reserve') + sum('release');
  const used = -sum('consume');
  return { allocated, reserved, used, available: allocated - reserved - used };
}

/** The last date an opening balance covers, or null when the employee has none. */
async function openingDate(q: AsyncDb, employeeId: string): Promise<string | null> {
  const rows = await q.read<{ d: string }>(
    `SELECT effective_at AS d FROM leave_balance_openings WHERE employee_id=?
     UNION ALL SELECT effective_from AS d FROM leave_policy_assignments WHERE employee_id=? AND approval_status='approved' AND opening_balance>0`,
    [employeeId, employeeId],
  );
  const dates = rows.map((r) => String(r.d).slice(0, 10)).sort();
  return dates.length ? dates[dates.length - 1]! : null;
}

export interface EntitlementStatement {
  employeeId: string;
  employeeName: string;
  eligible: boolean;
  problem: string | null;
  joinDate: string | null;
  asOf: string;
  serviceYears: number;
  currentDaysPerYear: number | null;
  seniorFrom: string | null;
  accrualStart: string | null;
  openingThrough: string | null;
  /** Accrued exactly from accrualStart to asOf, in thousandths of a day. */
  accruedMilli: number;
  /** Accrual already posted to the ledger: cumulative whole days and the date covered. */
  postedDays: number;
  postedThrough: string | null;
  postedMilli: number;
  ledger: { allocated: number; reserved: number; used: number; available: number };
  /** Ledger balance with posted whole accrual days replaced by the exact accrual to asOf. */
  exactBalanceMilli: number;
  segments: ReturnType<typeof accrueLeave>['segments'];
}

const PROBLEMS: Record<string, string> = {
  no_rule: 'لا توجد قاعدة استحقاق معتمدة.',
  join_date_missing: 'تاريخ المباشرة غير مدخل في الملف.',
  contractor: 'متعاون بمبلغ مقطوع؛ القاعدة لا تمنحه استحقاقًا.',
  employment_type_missing: 'نوع الارتباط (رسمي أو متعاون) غير محدد في الملف.',
  before_start: 'التاريخ قبل بداية الاستحقاق.',
};

export async function entitlementStatement(
  q: AsyncDb,
  employeeId: string,
  asOf: string,
  rules?: LeaveEntitlementRule[],
): Promise<EntitlementStatement> {
  const employee = (
    await q.read<Row>('SELECT id,name,join_date FROM employee_access WHERE id=?', [employeeId])
  )[0];
  if (!employee) throw fail(404, 'NOT_FOUND', 'الموظف غير موجود.');
  rules ??= await approvedEntitlementRules(q);
  const profile = await getProfileValues(q, employeeId);
  const ledger = await ledgerTotals(q, employeeId);
  const posted = (
    await q.read<Row>(
      'SELECT * FROM leave_accrual_postings WHERE employee_id=? ORDER BY through_date DESC LIMIT 1',
      [employeeId],
    )
  )[0];
  const joinRaw = String(employee.join_date ?? '').slice(0, 10);
  const joinDate = isIsoDate(joinRaw) ? joinRaw : null;
  const opening = await openingDate(q, employeeId);
  const base: EntitlementStatement = {
    employeeId,
    employeeName: employee.name,
    eligible: false,
    problem: null,
    joinDate,
    asOf,
    serviceYears: joinDate ? completedServiceYears(joinDate, asOf) : 0,
    currentDaysPerYear: null,
    seniorFrom: null,
    accrualStart: null,
    openingThrough: opening,
    accruedMilli: 0,
    postedDays: Number(posted?.posted_days ?? 0),
    postedThrough: posted?.through_date ?? null,
    postedMilli: Number(posted?.accrued_milli ?? 0),
    ledger,
    exactBalanceMilli: ledger.available * 1000,
    segments: [],
  };
  const type = String(profile.payrollEmploymentType ?? '').trim();
  const applicable = rulesForEmploymentType(rules, type);
  const firstRule = applicable[0];
  const problem = !rules.length
    ? 'no_rule'
    : !joinDate
      ? 'join_date_missing'
      : type === '' && rules.some((r) => r.values.excludeContractors)
        ? 'employment_type_missing'
        : !firstRule
          ? 'contractor'
          : null;
  if (problem) return { ...base, problem: PROBLEMS[problem]! };
  const ruleNow =
    ruleCovering(applicable, asOf) ??
    applicable.filter((r) => r.effectiveFrom <= asOf).pop() ??
    firstRule!;
  const seniorFrom = anniversary(joinDate!, ruleNow.values.seniorAfterYears);
  const starts = [joinDate!, firstRule!.effectiveFrom];
  if (opening) starts.push(addDays(opening, 1));
  const accrualStart = starts.sort().pop()!;
  const accrual = accrueLeave(joinDate!, accrualStart, asOf, applicable);
  return {
    ...base,
    eligible: true,
    problem: asOf < accrualStart ? PROBLEMS.before_start! : null,
    currentDaysPerYear: asOf >= seniorFrom ? ruleNow.values.seniorDays : ruleNow.values.baseDays,
    seniorFrom,
    accrualStart,
    accruedMilli: accrual.milli,
    exactBalanceMilli: ledger.available * 1000 - base.postedDays * 1000 + accrual.milli,
    segments: accrual.segments,
  };
}

/** Versions that apply to this employment type: a version excluding contractors grants them nothing. */
export function rulesForEmploymentType(rules: LeaveEntitlementRule[], type: string) {
  return type === 'contractor' ? rules.filter((r) => !r.values.excludeContractors) : rules;
}
const ruleCovering = (rules: LeaveEntitlementRule[], day: string) =>
  rules.filter((r) => r.effectiveFrom <= day && (!r.effectiveTo || r.effectiveTo >= day)).pop() ??
  null;

/** Posts accrual through `through` for every on-duty eligible employee. Idempotent per date. */
export async function postAccruals(tx: AsyncDb, actor: Actor, through: string) {
  const rules = await approvedEntitlementRules(tx);
  if (!rules.length)
    throw fail(409, 'NO_ENTITLEMENT_RULE', 'لا توجد قاعدة استحقاق معتمدة؛ اعتمدها أولًا.');
  const people = await tx.read<Row>(
    "SELECT id FROM employee_access WHERE status='active' ORDER BY id",
  );
  const results: { employeeId: string; addedDays: number; skipped: string | null }[] = [];
  for (const person of people) {
    const s = await entitlementStatement(tx, person.id, through, rules);
    if (!s.eligible || !s.accrualStart || through < s.accrualStart) {
      results.push({ employeeId: person.id, addedDays: 0, skipped: s.problem ?? 'غير مؤهل' });
      continue;
    }
    if (s.postedThrough && s.postedThrough >= through) {
      results.push({ employeeId: person.id, addedDays: 0, skipped: 'مرحّل مسبقًا حتى هذا التاريخ' });
      continue;
    }
    const open = await tx.read(
      "SELECT 1 FROM leave_settlements WHERE employee_id=? AND state IN ('pending_finance','pending_approver','approved') LIMIT 1",
      [person.id],
    );
    if (open.length) {
      results.push({ employeeId: person.id, addedDays: 0, skipped: 'لديه تصفية رصيد' });
      continue;
    }
    const whole = Math.floor(s.accruedMilli / 1000);
    const delta = whole - s.postedDays;
    const created = now();
    let ledgerId: number | null = null;
    if (delta > 0) {
      const ref = `leave-accrual:${person.id}:${through}`;
      await tx.execute(
        'INSERT INTO leave_ledger(employee_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?)',
        [person.id, 'allocation', delta, created, actor.id, ref],
      );
      ledgerId = Number(
        (await tx.read<Row>('SELECT id FROM leave_ledger WHERE operation_ref=?', [ref]))[0]?.id,
      );
    }
    await tx.execute(
      'INSERT INTO leave_accrual_postings(id,employee_id,accrual_start,through_date,accrued_milli,posted_days,ledger_id,rule_ids,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        randomUUID(),
        person.id,
        s.accrualStart,
        through,
        s.accruedMilli,
        Math.max(whole, s.postedDays),
        ledgerId,
        JSON.stringify([...new Set(s.segments.map((x) => x.ruleId).filter(Boolean))]),
        actor.id,
        created,
      ],
    );
    results.push({ employeeId: person.id, addedDays: Math.max(0, delta), skipped: null });
  }
  return results;
}

export interface SettlementCalculation {
  employeeName: string;
  joinDate: string;
  lastDay: string;
  serviceYears: number;
  ruleId: string;
  ruleVersion: number;
  sourceKind: 'official' | 'secondary';
  components: { key: LeaveWageComponent; label: string; minor: number }[];
  monthlyWageMinor: number;
  divisor: number;
  dailyMinor: number;
  ledgerAvailable: number;
  postedDays: number;
  accruedMilli: number;
  balanceMilli: number;
  amountMinor: number;
}

export async function calculateSettlement(
  q: AsyncDb,
  employeeId: string,
  lastDay: string,
): Promise<SettlementCalculation> {
  const rules = await approvedEntitlementRules(q);
  const s = await entitlementStatement(q, employeeId, lastDay, rules);
  if (!s.eligible || !s.joinDate || !s.accrualStart)
    throw fail(409, 'NOT_ELIGIBLE', s.problem ?? 'لا يمكن احتساب التصفية لهذا الموظف.');
  if (lastDay < s.accrualStart)
    throw fail(409, 'BEFORE_ACCRUAL_START', 'آخر يوم عمل قبل بداية الاستحقاق.');
  if (s.ledger.reserved > 0)
    throw fail(409, 'PENDING_LEAVE', 'لدى الموظف طلب إجازة قيد الاعتماد؛ احسمه قبل التصفية.');
  const future = await q.read(
    "SELECT 1 FROM leave_requests WHERE employee_id=? AND status='approved' AND current_flag=1 AND end_date>? LIMIT 1",
    [employeeId, lastDay],
  );
  if (future.length)
    throw fail(
      409,
      'LEAVE_AFTER_LAST_DAY',
      'توجد إجازة معتمدة تمتد بعد آخر يوم عمل؛ عدّلها أو ألغها قبل التصفية.',
    );
  const profile = await getProfileValues(q, employeeId);
  const rule = ruleCovering(
    rulesForEmploymentType(rules, String(profile.payrollEmploymentType ?? '').trim()),
    lastDay,
  );
  if (!rule)
    throw fail(
      409,
      'NO_RULE_ON_LAST_DAY',
      'لا يوجد إصدار قاعدة معتمد يسري في آخر يوم عمل؛ اعتمد إصدارًا يغطيه قبل التصفية.',
    );
  const components = rule.values.wageComponents.map((key) => {
    const raw = profile[key];
    const blank = raw === undefined || raw === null || String(raw).trim() === '';
    const minor = blank && key !== 'basicSalary' ? 0 : decimalRiyalToMinor(raw);
    if (minor === null || (key === 'basicSalary' && !minor))
      throw fail(
        409,
        'WAGE_INCOMPLETE',
        `«${LEAVE_WAGE_COMPONENTS[key]}» غير مدخل أو غير صالح في الملف.`,
      );
    return { key, label: LEAVE_WAGE_COMPONENTS[key], minor };
  });
  const monthlyWageMinor = components.reduce((a, c) => a + c.minor, 0);
  const balanceMilli = Math.max(0, s.exactBalanceMilli);
  const { dailyMinor, amountMinor } = encashmentAmount(
    monthlyWageMinor,
    rule.values.dailyRateDivisor,
    balanceMilli,
  );
  return {
    employeeName: s.employeeName,
    joinDate: s.joinDate,
    lastDay,
    serviceYears: s.serviceYears,
    ruleId: rule.id,
    ruleVersion: rule.version,
    sourceKind: rule.values.sourceKind,
    components,
    monthlyWageMinor,
    divisor: rule.values.dailyRateDivisor,
    dailyMinor,
    ledgerAvailable: s.ledger.available,
    postedDays: s.postedDays,
    accruedMilli: s.accruedMilli,
    balanceMilli,
    amountMinor,
  };
}

const MONEY_ROLES = ['hr', 'finance', 'approver'];
function mapSettlement(row: Row, actor: Actor, events: Row[] = []) {
  const calc = JSON.parse(
    decryptSensitive(row.calculation_ciphertext, `leave-settlement:${row.id}`),
  ) as SettlementCalculation;
  const money = MONEY_ROLES.includes(actor.role) || actor.owner === true;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: calc.employeeName,
    state: row.state,
    version: Number(row.version),
    lastDay: row.last_day,
    reasonType: row.reason_type,
    balanceMilli: Number(row.balance_milli),
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
function canAct(row: Row, actor: Actor): boolean {
  if (actor.id === row.employee_id) return false;
  if (row.state === 'pending_finance')
    return actor.role === 'finance' && actor.id !== row.prepared_by;
  if (row.state === 'pending_approver')
    return approvesPayroll(actor) && ![row.prepared_by, row.reviewed_by].includes(actor.id);
  return false;
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
    'INSERT INTO leave_settlement_events(id,settlement_id,actor_id,actor_role,action,reason,version,created_at) VALUES(?,?,?,?,?,?,?,?)',
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
    [actor.id, actor.role, `leave_settlement_${action}`, id, version, reason, now()],
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
/**
 * Idempotent command. The cached response must hold no decrypted wage data, so settlement
 * commands cache only `{ settlementId }` and rebuild the caller's view on every reply.
 */
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
async function settlementView(q: AsyncDb, id: string, actor: Actor) {
  const row = (await q.read<Row>('SELECT * FROM leave_settlements WHERE id=?', [id]))[0];
  if (!row) throw fail(404, 'NOT_FOUND', 'التصفية غير موجودة.');
  return mapSettlement(row, actor);
}

export function registerEntitlementRoutes(
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
  const asOfParam = (req: Request) => {
    const v = typeof req.query.asOf === 'string' ? req.query.asOf : todayInRiyadh();
    if (!isIsoDate(v)) throw fail(400, 'INVALID_DATE', 'التاريخ غير صالح.');
    return v;
  };
  const hrOnly = (actor: Actor) => {
    if (actor.role !== 'hr') throw fail(403, 'FORBIDDEN', 'هذا الإجراء للموارد البشرية.');
  };

  app.get(
    '/api/leave-entitlement/rules',
    route(async () => ({
      rules: await approvedEntitlementRules(db),
      components: LEAVE_WAGE_COMPONENTS,
    })),
  );

  // HR overview: one row per on-duty employee.
  app.get(
    '/api/leave-entitlement/overview',
    route(async (req, actor) => {
      hrOnly(actor);
      const asOf = asOfParam(req);
      const rules = await approvedEntitlementRules(db);
      const people = await db.read<Row>(
        "SELECT id FROM employee_access WHERE status='active' ORDER BY name",
      );
      const rows = [];
      for (const p of people) {
        const s = await entitlementStatement(db, p.id, asOf, rules);
        rows.push({ ...s, segments: undefined });
      }
      const lastPosting = (
        await db.read<Row>('SELECT MAX(through_date) AS d FROM leave_accrual_postings')
      )[0]?.d;
      return { asOf, rules, rows, lastPostedThrough: lastPosting ?? null };
    }),
  );

  // One employee's statement: the employee, HR, or the approver/owner and finance.
  app.get(
    '/api/leave-entitlement/employees/:id',
    route(async (req, actor) => {
      const id = String(req.params.id);
      if (actor.id !== id && !['hr', 'finance', 'approver'].includes(actor.role))
        throw fail(403, 'FORBIDDEN', 'لا تملك صلاحية الاطلاع على هذا الاستحقاق.');
      return { statement: await entitlementStatement(db, id, asOfParam(req)) };
    }),
  );

  app.post(
    '/api/leave-entitlement/accruals',
    route(async (req, actor) => {
      hrOnly(actor);
      const through = req.body?.throughDate;
      if (!isIsoDate(through) || through > todayInRiyadh())
        throw fail(400, 'INVALID_DATE', 'تاريخ الترحيل يجب أن يكون اليوم أو قبله.');
      const results = await idem(db, actor, 'leave_accrual_post', req, { through }, async (tx) => {
        const r = await postAccruals(tx, actor, through);
        await tx.execute(
          'INSERT INTO audit_events(actor_id,actor_role,action,resource_id,resource_version,reason,created_at) VALUES(?,?,?,?,?,?,?)',
          [actor.id, actor.role, 'leave_accrual_posted', `through:${through}`, null, null, now()],
        );
        return r;
      });
      return { results };
    }),
  );

  // Preview without saving (HR): lets HR see the figures before creating the draft.
  app.get(
    '/api/leave-settlements/preview',
    route(async (req, actor) => {
      hrOnly(actor);
      const employeeId = String(req.query.employeeId ?? '');
      const lastDay = String(req.query.lastDay ?? '');
      if (!isIsoDate(lastDay)) throw fail(400, 'INVALID_DATE', 'آخر يوم عمل غير صالح.');
      return { calculation: await calculateSettlement(db, employeeId, lastDay) };
    }),
  );

  app.get(
    '/api/leave-settlements',
    route(async (_req, actor) => {
      if (!['hr', 'finance', 'approver'].includes(actor.role))
        throw fail(403, 'FORBIDDEN', 'تصفيات الإجازة متاحة للموارد البشرية والمالية والاعتماد.');
      const rows = await db.read<Row>(
        actor.role === 'approver'
          ? "SELECT * FROM leave_settlements WHERE state IN ('pending_approver','approved','rejected') ORDER BY created_at DESC"
          : actor.role === 'finance'
            ? "SELECT * FROM leave_settlements WHERE state<>'draft' ORDER BY created_at DESC"
            : 'SELECT * FROM leave_settlements ORDER BY created_at DESC',
      );
      return { settlements: rows.map((r) => mapSettlement(r, actor)) };
    }),
  );

  app.get(
    '/api/leave-settlements/:id',
    route(async (req, actor) => {
      if (!['hr', 'finance', 'approver'].includes(actor.role))
        throw fail(403, 'FORBIDDEN', 'لا تملك صلاحية الاطلاع.');
      const row = (
        await db.read<Row>('SELECT * FROM leave_settlements WHERE id=?', [String(req.params.id)])
      )[0];
      if (!row) throw fail(404, 'NOT_FOUND', 'التصفية غير موجودة.');
      const events = await db.read<Row>(
        'SELECT * FROM leave_settlement_events WHERE settlement_id=? ORDER BY created_at',
        [row.id],
      );
      return { settlement: mapSettlement(row, actor, events) };
    }),
  );

  app.post(
    '/api/leave-settlements',
    route(async (req, actor) => {
      hrOnly(actor);
      const b = req.body ?? {};
      if (
        typeof b.employeeId !== 'string' ||
        !isIsoDate(b.lastDay) ||
        !(b.reasonType in SETTLEMENT_REASONS)
      )
        throw fail(400, 'INVALID_INPUT', 'حدد الموظف وآخر يوم عمل وسبب انتهاء الخدمة.');
      if (b.employeeId === actor.id)
        throw fail(403, 'SELF_SETTLEMENT', 'لا تعدّ تصفية رصيدك بنفسك.');
      const body = { employeeId: b.employeeId, lastDay: b.lastDay, reasonType: b.reasonType };
      const settlement = await idem(db, actor, 'leave_settlement_create', req, body, async (tx) => {
        const open = await tx.read(
          "SELECT 1 FROM leave_settlements WHERE employee_id=? AND state IN ('draft','pending_finance','pending_approver','approved') LIMIT 1",
          [b.employeeId],
        );
        if (open.length)
          throw fail(409, 'SETTLEMENT_EXISTS', 'توجد تصفية قائمة أو معتمدة لهذا الموظف.');
        const calc = await calculateSettlement(tx, b.employeeId, b.lastDay);
        const id = randomUUID();
        const created = now();
        await tx.execute(
          `INSERT INTO leave_settlements(id,employee_id,state,version,last_day,reason_type,calculation_ciphertext,balance_milli,amount_minor,prepared_by,created_at,updated_at)
           VALUES(?,?,'pending_finance',1,?,?,?,?,?,?,?,?)`,
          [
            id,
            b.employeeId,
            b.lastDay,
            b.reasonType,
            encryptSensitive(JSON.stringify(calc), `leave-settlement:${id}`),
            calc.balanceMilli,
            calc.amountMinor,
            actor.id,
            created,
            created,
          ],
        );
        await addEvent(tx, actor, id, 'prepared', null, 1);
        return { settlementId: id };
      });
      return { settlement: await settlementView(db, settlement.settlementId, actor) };
    }, 201),
  );

  app.post(
    '/api/leave-settlements/:id/actions',
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
      const settlement = await idem(
        db,
        actor,
        `leave_settlement_action:${id}`,
        req,
        { action: b.action, version: b.version, reason },
        async (tx) => {
          const row = (await tx.read<Row>('SELECT * FROM leave_settlements WHERE id=?', [id]))[0];
          if (!row) throw fail(404, 'NOT_FOUND', 'التصفية غير موجودة.');
          if (Number(row.version) !== b.version)
            throw fail(409, 'STALE_VERSION', 'تغيرت التصفية؛ حدّث الصفحة.');
          const t = now();
          if (b.action === 'cancel') {
            if (
              actor.id !== row.prepared_by ||
              !['pending_finance', 'pending_approver'].includes(row.state)
            )
              throw fail(403, 'FORBIDDEN', 'يلغي المعدّ التصفية قبل اعتمادها فقط.');
            await tx.execute(
              "UPDATE leave_settlements SET state='cancelled',version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?",
              [t, t, id, b.version],
            );
          } else {
            if (row.employee_id === actor.id)
              throw fail(403, 'SELF_APPROVAL', 'لا تتخذ قرارًا في تصفية رصيدك.');
            if (!canAct(row, actor))
              throw fail(
                403,
                'FORBIDDEN',
                'لا تملك صلاحية القرار في هذه المرحلة أو سبق أن أعددتها أو راجعتها.',
              );
            const reject = b.action === 'reject';
            if (row.state === 'pending_finance') {
              await tx.execute(
                'UPDATE leave_settlements SET state=?,reviewed_by=?,version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?',
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
                "UPDATE leave_settlements SET state='rejected',approved_by=?,version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?",
                [actor.id, t, t, id, b.version],
              );
            } else {
              // Recompute: if leave was taken or adjusted since preparation, stop.
              const fresh = await calculateSettlement(tx, row.employee_id, row.last_day);
              if (
                fresh.balanceMilli !== Number(row.balance_milli) ||
                fresh.amountMinor !== Number(row.amount_minor)
              )
                throw fail(
                  409,
                  'CALCULATION_CHANGED',
                  'تغير الرصيد أو الأجر منذ الإعداد؛ ارفض التصفية ليعدّها الموارد البشرية من جديد.',
                );
              let ledgerId: number | null = null;
              if (fresh.ledgerAvailable > 0) {
                const ref = `leave-settlement:${id}:encash`;
                await tx.execute(
                  'INSERT INTO leave_ledger(employee_id,kind,days,created_at,actor_id,operation_ref) VALUES(?,?,?,?,?,?)',
                  [row.employee_id, 'consume', -fresh.ledgerAvailable, t, actor.id, ref],
                );
                ledgerId = Number(
                  (
                    await tx.read<Row>('SELECT id FROM leave_ledger WHERE operation_ref=?', [ref])
                  )[0]?.id,
                );
              }
              await tx.execute(
                "UPDATE leave_settlements SET state='approved',approved_by=?,ledger_id=?,version=version+1,updated_at=?,decided_at=? WHERE id=? AND version=?",
                [actor.id, ledgerId, t, t, id, b.version],
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
      return { settlement: await settlementView(db, settlement.settlementId, actor) };
    }),
  );
}
