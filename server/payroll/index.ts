import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type { AsyncDb } from '../database.js';
import type {
  PayrollLine,
  PayrollPaymentMethod,
  PayrollPolicyOption,
  PayrollRun,
} from '../../shared/administration.js';
import {
  buildPayrollRegister,
  PAYROLL_COMPONENTS,
  registerTable,
} from '../../shared/payroll-register.js';
import {
  GOSI_PROBLEM_LABEL,
  gosiContribution,
  parseGosiRule,
  resolveGosiCategory,
  type GosiCategory,
  type GosiRule,
} from '../../shared/gosi.js';
import {
  appendEvent,
  getApprovedPayrollSource,
  getProfileValues,
  type Actor as AdministrationActor,
} from '../administration/service.js';
import { ensureServiceAccountRow } from '../service-api/service-account.js';
import { decryptSensitive, encryptSensitive } from '../administration/security.js';
import { approvesPayroll } from '../system-owner.js';

type Actor = {
  id: string;
  // 'service' is the «محاسب سبق» key: it may only prepare a draft and submit its own draft.
  role: 'employee' | 'manager' | 'hr' | 'finance' | 'approver' | 'auditor' | 'service';
  /** System owner (decision 014): an HR account that may also approve payroll. */
  owner?: boolean;
};
/** Preparer roles: HR people, and the service key through /api/service/hr/payroll. */
const mayPrepare = (actor: Actor) => actor.role === 'hr' || actor.role === 'service';
type Options = { db: AsyncDb; requireActor: (req: Request) => Actor | Promise<Actor> };
type Row = Record<string, any>;
const now = () => new Date().toISOString();
const fail = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decimalRiyalToMinor(value: unknown): number | null {
  const input = String(value ?? '').trim();
  const match = input.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const minor = whole * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Payroll rule versions the calculator accepts. Both read the components as entered in the
 * employee profile and compute no rate: 'synthetic-profile-components' for the synthetic seed,
 * 'profile-components' for a version HR creates and an independent approver approves.
 */
const PAYROLL_POLICY_KEYS = ['payroll-demo', 'payroll'];
const PAYROLL_CALCULATIONS = ['synthetic-profile-components', 'profile-components'];
function periodBounds(period: string) {
  const start = `${period}-01`;
  const end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  return { start, end };
}
function supportedPolicy(row: Row): boolean {
  try {
    const values = JSON.parse(row.values_json);
    return (
      PAYROLL_POLICY_KEYS.includes(row.policy_key) &&
      values?.currency === 'SAR' &&
      PAYROLL_CALCULATIONS.includes(values?.calculation)
    );
  } catch {
    return false;
  }
}
const policyCovers = (row: Row, period: string) => {
  const { start, end } = periodBounds(period);
  return row.effective_from <= start && (!row.effective_to || row.effective_to >= end);
};
/** Approved payroll rule versions, newest first; optionally only those covering a period. */
export async function approvedPayrollPolicies(
  db: AsyncDb,
  period?: string,
): Promise<PayrollPolicyOption[]> {
  const rows = await db.read<Row>(
    "SELECT * FROM administrative_policies WHERE state='synthetic_approved' ORDER BY effective_from DESC,version DESC,id",
  );
  return rows
    .filter((row) => supportedPolicy(row) && (!period || policyCovers(row, period)))
    .map((row) => ({
      id: row.id,
      name: row.name,
      version: Number(row.version),
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to ?? null,
      source: row.source,
      synthetic: JSON.parse(row.values_json).calculation === 'synthetic-profile-components',
      ...(() => {
        try {
          return { gosi: parseGosiRule(JSON.parse(row.values_json)), gosiInvalid: false };
        } catch {
          return { gosi: null, gosiInvalid: true };
        }
      })(),
    }));
}
const COMPONENT_BY_FIELD: Record<string, string> = {
  basicSalary: PAYROLL_COMPONENTS.basic,
  housingAllowance: PAYROLL_COMPONENTS.housing,
  transportAllowance: PAYROLL_COMPONENTS.transport,
  otherAllowance: PAYROLL_COMPONENTS.other,
};
async function policyGosi(db: AsyncDb, policyId: string): Promise<GosiRule | null> {
  const row = (
    await db.read<Row>('SELECT values_json FROM administrative_policies WHERE id=?', [policyId])
  )[0];
  if (!row) return null;
  try {
    return parseGosiRule(JSON.parse(row.values_json));
  } catch {
    throw fail(
      400,
      'gosi_rule_invalid',
      'قسم التأمينات في إصدار القواعد غير مكتمل أو غير صالح؛ لا يُحتسب المسير به.',
    );
  }
}
/**
 * Staff or contractor for payroll. The payroll field wins; otherwise the existing profile field
 * «نوع العلاقة» (موظف / متعاون) already says it, so HR does not enter it twice.
 */
export function payrollEmploymentTypeOf(
  profile: Record<string, unknown>,
): '' | 'staff' | 'contractor' {
  const explicit = String(profile.payrollEmploymentType ?? '').trim();
  if (explicit === 'staff' || explicit === 'contractor') return explicit;
  const relation = String(profile.relationshipType ?? '').trim();
  if (relation === 'employee') return 'staff';
  if (relation === 'collaborator') return 'contractor';
  return '';
}
const EXCLUSION_LABEL: Record<string, string> = {
  copy_left: 'في المسير السابق وليسوا على رأس العمل الآن (لم يُنسخوا)',
  copy_added: 'على رأس العمل ولم يكونوا في المسير السابق (أضيفوا من ملفاتهم)',
  salary_incomplete: 'الراتب الأساسي غير مدخل أو مكونات الراتب غير صالحة',
  employment_type_missing: 'نوع الارتباط (رسمي أو متعاون) غير محدد في الملف',
  contractor_amount_missing: 'المبلغ الشهري المقطوع للمتعاون غير مدخل',
  ...GOSI_PROBLEM_LABEL,
};
const paymentMethodOf = (value: unknown): PayrollPaymentMethod =>
  value === 'direct' || value === 'wps' ? value : 'unspecified';

/**
 * Payroll commands shared by the session routes (/api/admin/payroll) and the «محاسب سبق»
 * service routes (/api/service/hr/payroll). The service actor (role 'service') may create a
 * draft and submit its own draft; every other transition stays with people (see runAction).
 */
export function createPayrollCommands(db: AsyncDb) {
  async function getRun(id: string, actor: Actor, query: AsyncDb = db): Promise<PayrollRun> {
    const r = (await query.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [id]))[0];
    if (!r) throw fail(404, 'not_found', 'المسير غير موجود.');
    // Approvers see runs that reached their step, including runs they (or a peer approver)
    // rejected at that step; a run rejected by finance never had reviewed_by set.
    if (
      actor.role === 'approver' &&
      !['pending_approver', 'closed'].includes(r.state) &&
      !(r.state === 'rejected' && r.reviewed_by)
    )
      throw fail(404, 'not_found', 'المسير غير موجود.');
    const lines = await query.read<Row>(
      `SELECT l.*,e.name employee_name FROM payroll_lines l JOIN employee_access e ON e.id=l.employee_id WHERE l.run_id=? ORDER BY e.name,l.id`,
      [id],
    );
    if (
      ['employee', 'manager'].includes(actor.role) &&
      (r.state !== 'closed' || !lines.some((l) => l.employee_id === actor.id))
    )
      throw fail(404, 'not_found', 'المسير غير موجود.');
    if (
      !['employee', 'manager', 'hr', 'finance', 'approver', 'auditor', 'service'].includes(
        actor.role,
      )
    )
      throw fail(403, 'forbidden', 'لا تملك صلاحية الاطلاع.');
    const visible = ['employee', 'manager'].includes(actor.role)
      ? lines.filter((l) => l.employee_id === actor.id)
      : lines;
    const payments = ['employee', 'manager'].includes(actor.role)
      ? await query.read<Row>(
          'SELECT employee_id,state,paid_minor,encrypted_reference,recorded_at FROM payroll_payments WHERE run_id=? AND employee_id=?',
          [id, actor.id],
        )
      : await query.read<Row>(
          'SELECT employee_id,state,paid_minor,encrypted_reference,recorded_at FROM payroll_payments WHERE run_id=?',
          [id],
        );
    const earningsMinor = visible
      .filter((l) => l.kind === 'earning')
      .reduce((n, l) => n + Number(l.amount_minor), 0);
    const deductionsMinor = visible
      .filter((l) => l.kind === 'deduction')
      .reduce((n, l) => n + Number(l.amount_minor), 0);
    if (!Number.isSafeInteger(earningsMinor) || !Number.isSafeInteger(deductionsMinor))
      throw fail(500, 'payroll_total_invalid', 'مجموع المسير يتجاوز دقة العملة الآمنة.');
    // Auditors see one stable pseudonym per employee so the register still groups rows.
    const pseudonyms = new Map<string, string>();
    for (const l of visible)
      if (!pseudonyms.has(l.employee_id))
        pseudonyms.set(l.employee_id, `موظف ${pseudonyms.size + 1}`);
    const visibleIds = new Set(visible.map((l) => l.employee_id));
    const people = (
      await query.read<Row>(
        'SELECT p.*,e.name employee_name FROM payroll_run_people p JOIN employees e ON e.id=p.employee_id WHERE p.run_id=? ORDER BY p.employee_id',
        [id],
      )
    ).filter((p) => visibleIds.has(p.employee_id));
    const policy = (
      await query.read<Row>('SELECT name,version FROM administrative_policies WHERE id=?', [
        r.policy_id,
      ])
    )[0];
    const events = await query.read<Row>(
      // employees, not employee_access: the service account row is hidden from the view but
      // its events must still read «محاسب سبق».
      'SELECT pe.*,COALESCE(e.name,pe.actor_id) actor_name FROM payroll_events pe LEFT JOIN employees e ON e.id=pe.actor_id WHERE pe.run_id=? ORDER BY pe.created_at,pe.id',
      [id],
    );
    return {
      id: r.id,
      period: r.period,
      version: Number(r.version),
      state: r.state,
      preparedBy: actor.role === 'auditor' ? 'redacted' : r.prepared_by,
      reviewedBy: actor.role === 'auditor' ? (r.reviewed_by ? 'redacted' : null) : r.reviewed_by,
      approvedBy: actor.role === 'auditor' ? (r.approved_by ? 'redacted' : null) : r.approved_by,
      policyId: r.policy_id,
      correctionOf: r.correction_of,
      reason: actor.role === 'auditor' ? '[معلومة محمية]' : r.reason,
      policyName: policy ? `${policy.name} · الإصدار ${Number(policy.version)}` : r.policy_id,
      lines: visible.map((l): PayrollLine => ({
        id: l.id,
        employeeId: actor.role === 'auditor' ? '' : l.employee_id,
        employeeName: actor.role === 'auditor' ? pseudonyms.get(l.employee_id)! : l.employee_name,
        component: l.component,
        kind: l.kind,
        amountMinor: Number(l.amount_minor),
        source: actor.role === 'auditor' ? 'مصدر مالي معتمد' : l.source,
        sourceRequestId: actor.role === 'auditor' ? null : l.source_request_id,
      })),
      people: people.map((p) => ({
        employeeId: actor.role === 'auditor' ? '' : p.employee_id,
        employeeName:
          actor.role === 'auditor' ? (pseudonyms.get(p.employee_id) ?? 'موظف') : p.employee_name,
        title: actor.role === 'auditor' ? '' : p.title,
        paymentMethod: paymentMethodOf(p.payment_method),
        employerContributionMinor: Number(p.employer_contribution_minor),
        insuranceCategory: p.insurance_category ?? null,
        insuranceCategoryInferred: Number(p.insurance_category_inferred) === 1,
        insuredWageMinor: Number(p.insured_wage_minor),
        employmentType: p.employment_type === 'contractor' ? 'contractor' : 'staff',
      })),
      payments: payments.map((p) => ({
        employeeId: actor.role === 'auditor' ? '' : p.employee_id,
        ...(actor.role === 'auditor' && pseudonyms.has(p.employee_id)
          ? { employeeKey: pseudonyms.get(p.employee_id)! }
          : {}),
        state: p.state,
        paidMinor: Number(p.paid_minor),
        reference:
          actor.role === 'finance'
            ? decryptSensitive(p.encrypted_reference, `payroll-payment:${id}:${p.employee_id}`)
            : '',
        recordedAt: p.recorded_at,
      })),
      totals: { earningsMinor, deductionsMinor, netMinor: earningsMinor - deductionsMinor },
      createdAt: r.created_at,
      closedAt: r.closed_at,
      canEdit: actor.role === 'hr' && r.state === 'draft' && r.prepared_by === actor.id,
      canReview:
        actor.role === 'finance' && r.state === 'pending_finance' && r.prepared_by !== actor.id,
      canApprove:
        approvesPayroll(actor) &&
        r.state === 'pending_approver' &&
        r.prepared_by !== actor.id &&
        r.reviewed_by !== actor.id,
      timeline: events.map((e) => ({
        id: e.id,
        actorId: actor.role === 'auditor' ? '' : e.actor_id,
        actorName: actor.role === 'auditor' ? e.actor_role : e.actor_name,
        role: e.actor_role,
        action: e.action,
        reason: actor.role === 'auditor' ? (e.reason ? '[معلومة محمية]' : null) : e.reason,
        createdAt: e.created_at,
        version: Number(e.version),
      })),
    };
  }
  /**
   * Recomputes every staff member's insurance line and employer share from the run's own
   * contributory lines and the rule version's GOSI section. Contractors and people without a
   * category get none. Used after creating, copying or editing a draft, so an edited basic
   * salary never leaves a stale insurance amount.
   */
  /**
   * Every employee with lines in a primary draft gets a register snapshot before insurance is
   * applied: someone added by hand after creation, or a draft from before migration 017.
   * Under a rule with an insurance section, a staff member whose category cannot be resolved
   * stops the save or submission with the reason instead of passing without insurance.
   */
  async function reconcilePeople(tx: AsyncDb, runId: string, gosi: GosiRule | null) {
    const missing = await tx.read<Row>(
      `SELECT DISTINCT l.employee_id,e.title FROM payroll_lines l JOIN employees e ON e.id=l.employee_id
       WHERE l.run_id=? AND NOT EXISTS (SELECT 1 FROM payroll_run_people p WHERE p.run_id=l.run_id AND p.employee_id=l.employee_id)
       ORDER BY l.employee_id`,
      [runId],
    );
    for (const person of missing) {
      const profile = await getProfileValues(tx, person.employee_id);
      const typeValue = payrollEmploymentTypeOf(profile);
      if (!typeValue && gosi)
        throw fail(
          400,
          'employment_type_missing',
          `${EXCLUSION_LABEL.employment_type_missing} لموظف أضيف إلى المسير.`,
        );
      const employmentType = typeValue === 'contractor' ? 'contractor' : 'staff';
      let category: { category: GosiCategory; inferred: boolean } | null = null;
      if (gosi && employmentType === 'staff') {
        const resolved = resolveGosiCategory(profile);
        if (!resolved.category)
          throw fail(
            400,
            resolved.problem,
            `${GOSI_PROBLEM_LABEL[resolved.problem]} لموظف أضيف إلى المسير.`,
          );
        category = resolved;
      }
      await tx.execute(
        'INSERT INTO payroll_run_people(run_id,employee_id,title,payment_method,employment_type,employer_contribution_minor,insurance_category,insurance_category_inferred,insured_wage_minor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          runId,
          person.employee_id,
          String(person.title ?? ''),
          paymentMethodOf(profile.payrollPaymentMethod),
          employmentType,
          0,
          category?.category ?? null,
          category?.inferred ? 1 : 0,
          0,
          now(),
        ],
      );
    }
  }
  async function applyInsurance(tx: AsyncDb, runId: string, gosi: GosiRule, policyId: string) {
    const people = await tx.read<Row>(
      'SELECT employee_id,employment_type,insurance_category FROM payroll_run_people WHERE run_id=?',
      [runId],
    );
    const lines = await tx.read<Row>(
      "SELECT employee_id,component,amount_minor FROM payroll_lines WHERE run_id=? AND kind='earning'",
      [runId],
    );
    const at = now();
    for (const person of people) {
      await tx.execute(
        'DELETE FROM payroll_lines WHERE run_id=? AND employee_id=? AND component=? AND kind=?',
        [runId, person.employee_id, PAYROLL_COMPONENTS.insurance, 'deduction'],
      );
      let result = { wageMinor: 0, employeeMinor: 0, employerMinor: 0 };
      if (person.employment_type === 'staff' && person.insurance_category) {
        const components: Record<string, number> = {};
        for (const [field, component] of Object.entries(COMPONENT_BY_FIELD))
          components[field] = lines
            .filter((l) => l.employee_id === person.employee_id && l.component === component)
            .reduce((n, l) => n + Number(l.amount_minor), 0);
        result = gosiContribution(gosi, person.insurance_category as GosiCategory, components);
      }
      if (result.employeeMinor)
        await tx.execute(
          'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          [
            randomUUID(),
            runId,
            person.employee_id,
            PAYROLL_COMPONENTS.insurance,
            'deduction',
            result.employeeMinor,
            `حصة الموظف وفق إصدار القواعد ${policyId}`,
            null,
            at,
          ],
        );
      await tx.execute(
        'UPDATE payroll_run_people SET employer_contribution_minor=?,insured_wage_minor=? WHERE run_id=? AND employee_id=?',
        [result.employerMinor, result.wageMinor, runId, person.employee_id],
      );
    }
  }
  /**
   * Adds one on-duty employee to a draft from the profile: contractors get their lump sum,
   * staff their salary components and (when the rule has an insurance section) a GOSI
   * category. Returns an exclusion code instead when the profile is incomplete. Insurance
   * amounts are written afterwards by applyInsurance.
   */
  async function addPersonFromProfile(
    tx: AsyncDb,
    args: {
      runId: string;
      person: Row;
      gosi: GosiRule | null;
      synthetic: boolean;
      created: string;
    },
  ): Promise<string | null> {
    const { runId, person, gosi, synthetic, created } = args;
    const profile = await getProfileValues(tx, person.id);
    const blank = (value: unknown) =>
      value === undefined || value === null || String(value).trim() === '';
    const typeValue = payrollEmploymentTypeOf(profile);
    // A rule with an insurance section needs to know who is under GOSI.
    if (!typeValue && gosi) {
      return 'employment_type_missing';
    }
    const employmentType: 'staff' | 'contractor' =
      typeValue === 'contractor' ? 'contractor' : 'staff';
    const earnings: [string, number][] = [];
    let category: { category: GosiCategory; inferred: boolean } | null = null;
    if (employmentType === 'contractor') {
      const lump = decimalRiyalToMinor(profile.contractorMonthlyAmount);
      if (!lump) {
        return 'contractor_amount_missing';
      }
      earnings.push([PAYROLL_COMPONENTS.lumpSum, lump]);
    } else {
      // Salary components as entered: the basic salary is required and a blank
      // allowance counts as zero.
      const amounts: Record<string, number | null> = {};
      for (const key of ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'])
        amounts[key] =
          key !== 'basicSalary' && blank(profile[key]) ? 0 : decimalRiyalToMinor(profile[key]);
      if (Object.values(amounts).some((v) => v === null) || !amounts.basicSalary) {
        return 'salary_incomplete';
      }
      if (gosi) {
        const resolved = resolveGosiCategory(profile);
        if (!resolved.category) {
          return resolved.problem;
        }
        category = resolved;
      }
      for (const key of Object.keys(COMPONENT_BY_FIELD))
        earnings.push([COMPONENT_BY_FIELD[key]!, amounts[key]!]);
    }
    for (const [component, amountMinor] of earnings) {
      if (!amountMinor) continue;
      await tx.execute(
        'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          runId,
          person.id,
          component,
          'earning',
          amountMinor,
          synthetic
            ? 'الملف الوظيفي الاصطناعي؛ قيمة عرض فقط بلا احتساب نظامي.'
            : 'الملف الوظيفي؛ مبلغ مُدخل كما هو.',
          null,
          created,
        ],
      );
    }
    await tx.execute(
      'INSERT INTO payroll_run_people(run_id,employee_id,title,payment_method,employment_type,employer_contribution_minor,insurance_category,insurance_category_inferred,insured_wage_minor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        runId,
        person.id,
        String(person.title ?? ''),
        paymentMethodOf(profile.payrollPaymentMethod),
        employmentType,
        0,
        category?.category ?? null,
        category?.inferred ? 1 : 0,
        0,
        created,
      ],
    );
    return null;
  }
  async function validateRunNet(tx: AsyncDb, run: Row, requireCorrection: boolean) {
    const lines = await tx.read<Row>(
      'SELECT employee_id,kind,amount_minor FROM payroll_lines WHERE run_id=?',
      [run.id],
    );
    const deltas = new Map<string, number>();
    let nonZero = false;
    for (const line of lines) {
      const amount = Number(line.amount_minor) * (line.kind === 'earning' ? 1 : -1);
      if (amount) nonZero = true;
      deltas.set(line.employee_id, (deltas.get(line.employee_id) || 0) + amount);
      if (!Number.isSafeInteger(deltas.get(line.employee_id)))
        throw fail(400, 'payroll_total_invalid', 'مجموع أسطر الموظف يتجاوز دقة العملة الآمنة.');
    }
    if (requireCorrection && run.correction_of && !nonZero)
      throw fail(409, 'empty_correction', 'أدخل فرقًا ماليًا قبل اعتماد مسير التصحيح.');
    let base = new Map<string, number>();
    if (run.correction_of) {
      // A correction is measured against everything already closed for the same base run:
      // the base itself plus every earlier closed correction in its chain, whichever run each
      // one pointed at. Comparing with the run named in correction_of alone let a second
      // correction ignore the first (net could fall below zero) and made a correction of a
      // correction compare against a bare delta (valid nets were refused).
      let rootId = String(run.correction_of);
      for (let depth = 0; ; depth += 1) {
        if (depth > 1000) throw fail(409, 'invalid_correction', 'سلسلة التصحيح غير صالحة.');
        const parent = (
          await tx.read<Row>('SELECT correction_of FROM payroll_runs WHERE id=?', [rootId])
        )[0];
        if (!parent?.correction_of) break;
        rootId = String(parent.correction_of);
      }
      // Corrections must share the base run's period, and a period has one non-rejected base,
      // so the closed runs of this period that are the root or a correction form the chain.
      const original = await tx.read<Row>(
        `SELECT l.employee_id,l.kind,l.amount_minor FROM payroll_lines l
         JOIN payroll_runs r ON r.id=l.run_id
         WHERE r.period=? AND r.state='closed' AND r.id<>?
           AND (r.id=? OR r.correction_of IS NOT NULL)`,
        [run.period, run.id, rootId],
      );
      for (const line of original) {
        const amount = Number(line.amount_minor) * (line.kind === 'earning' ? 1 : -1);
        base.set(line.employee_id, (base.get(line.employee_id) || 0) + amount);
        if (!Number.isSafeInteger(base.get(line.employee_id)))
          throw fail(
            400,
            'payroll_total_invalid',
            'مجموع المسير الأصلي وتصحيحاته يتجاوز دقة العملة الآمنة.',
          );
      }
    }
    for (const [employeeId, delta] of deltas) {
      if (!Number.isSafeInteger((base.get(employeeId) || 0) + delta))
        throw fail(400, 'payroll_total_invalid', 'مجموع التصحيح يتجاوز دقة العملة الآمنة.');
      if ((base.get(employeeId) || 0) + delta < 0)
        throw fail(400, 'negative_net', 'لا يمكن أن يقل الصافي بعد التصحيح عن صفر.');
      if (run.correction_of && !base.has(employeeId))
        throw fail(
          400,
          'correction_employee_missing',
          'لا يمكن تصحيح موظف غير موجود في المسير الأصلي.',
        );
    }
  }
  async function replay<T>(
    req: Request,
    actor: Actor,
    action: string,
    payload: unknown,
    work: (tx: AsyncDb) => Promise<T>,
  ): Promise<T> {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 200)
      throw fail(400, 'idempotency_key_required', 'مفتاح Idempotency-Key مطلوب.');
    const digest = hash(payload);
    return db.transaction(async (tx) => {
      const prior = (
        await tx.read<Row>(
          'SELECT payload_hash,response_json FROM payroll_commands WHERE actor_id=? AND action=? AND command_key=?',
          [actor.id, action, key],
        )
      )[0];
      if (prior) {
        if (prior.payload_hash !== digest)
          throw fail(409, 'idempotency_conflict', 'استُخدم المفتاح نفسه بمحتوى مختلف.');
        const replayed = JSON.parse(prior.response_json) as {
          resource?: string;
          id?: string;
          excludedCount?: number;
          exclusions?: unknown;
        };
        if (replayed.resource !== 'payroll_run' || !replayed.id)
          throw fail(500, 'idempotency_record_invalid', 'تعذر التحقق من نتيجة العملية السابقة.');
        return {
          run: await getRun(replayed.id, actor, tx),
          ...(Number.isSafeInteger(replayed.excludedCount)
            ? { excludedCount: replayed.excludedCount }
            : {}),
          ...(Array.isArray(replayed.exclusions) ? { exclusions: replayed.exclusions } : {}),
        } as T;
      }
      const result = await work(tx);
      const runId = (result as { run?: { id?: string } } | null)?.run?.id;
      if (!runId) throw fail(500, 'idempotency_record_invalid', 'تعذر حفظ نتيجة العملية.');
      const excludedCount = (result as { excludedCount?: number }).excludedCount;
      const exclusions = (result as { exclusions?: unknown }).exclusions;
      await tx.execute(
        'INSERT INTO payroll_commands(actor_id,action,command_key,payload_hash,response_json,created_at) VALUES(?,?,?,?,?,?)',
        [
          actor.id,
          action,
          key,
          digest,
          JSON.stringify({
            resource: 'payroll_run',
            id: runId,
            ...(Number.isSafeInteger(excludedCount) ? { excludedCount } : {}),
            ...(Array.isArray(exclusions) ? { exclusions } : {}),
          }),
          now(),
        ],
      );
      return result;
    });
  }
  /** serviceAudit: extra details for the administration event a service-key write leaves. */
  async function createRun(req: Request, actor: Actor, serviceAudit?: Record<string, unknown>) {
    if (!mayPrepare(actor)) throw fail(403, 'forbidden', 'إنشاء المسير متاح للموارد البشرية فقط.');
    const { period, policyId: requestedPolicyId, reason, correctionOf } = req.body ?? {};
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) ||
      typeof reason !== 'string' ||
      reason.trim().length < 3 ||
      (requestedPolicyId !== undefined && typeof requestedPolicyId !== 'string')
    )
      throw fail(400, 'invalid_input', 'أدخل فترة صحيحة وسببًا واضحًا.');
    // Without an explicit version, the newest approved version covering the period applies.
    const policyId: string | undefined =
      requestedPolicyId ?? (await approvedPayrollPolicies(db, period))[0]?.id;
    if (!policyId)
      throw fail(
        400,
        'policy_unavailable',
        'لا يوجد إصدار قواعد رواتب معتمد يسري على هذه الفترة. تنشئه الموارد البشرية من صفحة القواعد ويعتمده المعتمد المستقل.',
      );
    const result = await replay(
      req,
      actor,
      'create',
      { period, policyId, reason, correctionOf },
      async (tx) => {
        const policy = (
          await tx.read<Row>(
            "SELECT * FROM administrative_policies WHERE id=? AND state='synthetic_approved'",
            [policyId],
          )
        )[0];
        if (!policy)
          throw fail(
            400,
            'policy_unavailable',
            'إصدار قواعد الرواتب المطلوب غير معتمد أو غير موجود.',
          );
        if (!supportedPolicy(policy))
          throw fail(
            400,
            'unsupported_calculator',
            'إصدار القواعد لا يطابق حاسبة مكونات الملف الوظيفي.',
          );
        const policyValues = JSON.parse(policy.values_json);
        const synthetic = policyValues.calculation === 'synthetic-profile-components';
        let gosi: GosiRule | null;
        try {
          gosi = parseGosiRule(policyValues);
        } catch {
          throw fail(
            400,
            'gosi_rule_invalid',
            'قسم التأمينات في إصدار القواعد غير مكتمل أو غير صالح؛ لا يُحتسب المسير به.',
          );
        }
        const exclusions = new Map<string, number>();
        if (!policyCovers(policy, period))
          throw fail(400, 'policy_out_of_period', 'إصدار القواعد لا يسري على فترة المسير.');
        let original: Row | undefined;
        if (correctionOf) {
          original = (
            await tx.read<Row>("SELECT * FROM payroll_runs WHERE id=? AND state='closed'", [
              correctionOf,
            ])
          )[0];
          if (!original) throw fail(400, 'invalid_correction', 'المسير الأصلي المغلق غير موجود.');
          if (original.period !== period)
            throw fail(
              400,
              'correction_period_mismatch',
              'يجب أن يطابق مسير التصحيح فترة المسير الأصلي.',
            );
        } else {
          const existing = (
            await tx.read<Row>(
              "SELECT id FROM payroll_runs WHERE period=? AND correction_of IS NULL AND state<>'rejected'",
              [period],
            )
          )[0];
          if (existing)
            throw fail(
              409,
              'period_already_exists',
              'يوجد مسير أساسي لهذه الفترة؛ استخدم مسير تصحيح مرتبط عند الحاجة.',
            );
        }
        const id = randomUUID(),
          created = now();
        // payroll_runs.prepared_by references employees(id): the key's row must exist first.
        if (actor.role === 'service') await ensureServiceAccountRow(tx);
        await tx.execute(
          "INSERT INTO payroll_runs(id,period,version,state,prepared_by,policy_id,correction_of,reason,created_at,updated_at) VALUES(?,?,1,'draft',?,?,?,?,?,?)",
          [id, period, actor.id, policyId, correctionOf ?? null, reason.trim(), created, created],
        );
        let excludedCount = 0;
        if (original) {
          const priorLines = await tx.read<Row>(
            'SELECT employee_id,component,kind FROM payroll_lines WHERE run_id=?',
            [original.id],
          );
          await tx.execute(
            'INSERT INTO payroll_run_people(run_id,employee_id,title,payment_method,employment_type,employer_contribution_minor,insurance_category,insurance_category_inferred,insured_wage_minor,created_at) SELECT ?,employee_id,title,payment_method,employment_type,0,insurance_category,insurance_category_inferred,0,? FROM payroll_run_people WHERE run_id=?',
            [id, created, original.id],
          );
          for (const line of priorLines)
            await tx.execute(
              'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
              [
                randomUUID(),
                id,
                line.employee_id,
                `فرق: ${line.component}`,
                line.kind,
                0,
                `Adjustment placeholder; linked to ${original.id}`,
                null,
                created,
              ],
            );
        } else {
          const people = await tx.read<Row>(
            "SELECT id,name,title FROM employee_access WHERE status='active' ORDER BY id",
            [],
          );
          for (const person of people) {
            const problem = await addPersonFromProfile(tx, {
              runId: id,
              person,
              gosi,
              synthetic,
              created,
            });
            if (problem) {
              excludedCount += 1;
              exclusions.set(problem, (exclusions.get(problem) ?? 0) + 1);
            }
          }
          if (gosi) await applyInsurance(tx, id, gosi, policyId);
          const count = (
            await tx.read<Row>('SELECT COUNT(*) count FROM payroll_lines WHERE run_id=?', [id])
          )[0];
          if (Number(count?.count ?? 0) === 0) {
            const reasons = [...exclusions]
              .map(([code, n]) => `${EXCLUSION_LABEL[code] ?? code}: ${n}`)
              .join('؛ ');
            throw fail(
              400,
              'no_salary_profiles',
              `لا يوجد موظف على رأس العمل ملفه الوظيفي مكتمل للرواتب، فلم يُنشأ المسير.${reasons ? ` الأسباب: ${reasons}.` : ''} أكمل الحقول في قسم «المالية» من الملف الوظيفي ثم أعد المحاولة.`,
            );
          }
        }
        await tx.execute(
          'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
          [randomUUID(), id, actor.id, actor.role, 'created', reason.trim(), created, 1],
        );
        if (actor.role === 'service')
          await appendEvent(
            tx,
            actor as unknown as AdministrationActor,
            'payroll_run',
            id,
            'service_payroll_draft_created',
            reason.trim(),
            { ...serviceAudit, period, correctionOf: correctionOf ?? null },
            1,
            created,
          );
        return {
          run: await getRun(id, actor, tx),
          ...(correctionOf
            ? {}
            : {
                excludedCount,
                exclusions: [...exclusions].map(([code, count]) => ({
                  code,
                  label: EXCLUSION_LABEL[code] ?? code,
                  count,
                })),
              }),
        };
      },
    );
    return result;
  }
  async function runAction(req: Request, actor: Actor, serviceAudit?: Record<string, unknown>) {
    const body = req.body ?? {};
    // The service key may only submit its own draft; review, reject and approve (which closes
    // the run) stay with people whatever scopes are configured.
    if (actor.role === 'service' && body.action !== 'submit')
      throw fail(403, 'service_action_forbidden', 'هذا الإجراء للبشر فقط ولا يُمنح لمفتاح خدمة.');
    const allowed =
      body.action === 'submit'
        ? mayPrepare(actor)
        : body.action === 'review'
          ? actor.role === 'finance'
          : body.action === 'approve'
            ? approvesPayroll(actor)
            : body.action === 'reject'
              ? actor.role === 'finance' || approvesPayroll(actor)
              : false;
    if (!allowed) throw fail(403, 'forbidden', 'لا تملك صلاحية تنفيذ هذا الإجراء.');
    if (
      body.action === 'reject' &&
      (typeof body.reason !== 'string' || body.reason.trim().length < 3)
    )
      throw fail(400, 'reason_required', 'سبب الرفض مطلوب.');
    return replay(req, actor, `action:${req.params.id}`, body, async (tx) => {
      const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]))[0];
      if (!run) throw fail(404, 'not_found', 'المسير غير موجود.');
      if (Number(body.version) !== Number(run.version))
        throw fail(409, 'version_conflict', 'تغير المسير؛ حدّث الصفحة ثم أعد المحاولة.');
      if (run.state === 'closed')
        throw fail(409, 'closed_immutable', 'المسير المغلق غير قابل للتعديل.');
      const action = body.action;
      let next: string,
        reviewed = run.reviewed_by,
        approved = run.approved_by;
      if (
        action === 'submit' &&
        mayPrepare(actor) &&
        run.state === 'draft' &&
        run.prepared_by === actor.id
      )
        next = 'pending_finance';
      else if (
        action === 'review' &&
        actor.role === 'finance' &&
        run.state === 'pending_finance' &&
        run.prepared_by !== actor.id
      ) {
        // The reviewer's own salary may be in the run (owner decision, decision 013).
        next = 'pending_approver';
        reviewed = actor.id;
      } else if (
        action === 'approve' &&
        approvesPayroll(actor) &&
        run.state === 'pending_approver' &&
        run.prepared_by !== actor.id &&
        run.reviewed_by !== actor.id
      ) {
        // The approver's own salary may be in the run (owner decision, decision 013).
        next = 'closed';
        approved = actor.id;
      } else if (
        action === 'reject' &&
        ((['finance', 'approver'].includes(actor.role) &&
          ['pending_finance', 'pending_approver'].includes(run.state)) ||
          (approvesPayroll(actor) &&
            run.state === 'pending_approver' &&
            run.prepared_by !== actor.id &&
            run.reviewed_by !== actor.id))
      ) {
        next = 'rejected';
      } else throw fail(403, 'transition_forbidden', 'لا تملك صلاحية تنفيذ هذه الخطوة.');
      // Submitting a primary draft re-applies the rule, so no recipient escapes it.
      if (action === 'submit' && !run.correction_of) {
        const gosi = await policyGosi(tx, run.policy_id);
        await reconcilePeople(tx, run.id, gosi);
        if (gosi) await applyInsurance(tx, run.id, gosi, run.policy_id);
        await validateRunNet(tx, run, false);
      }
      if (next === 'closed') {
        await validateRunNet(tx, run, true);
      }
      const closed = next === 'closed' ? now() : null;
      await tx.execute(
        'UPDATE payroll_runs SET state=?,reviewed_by=?,approved_by=?,version=version+1,updated_at=?,closed_at=? WHERE id=? AND version=?',
        [next, reviewed, approved, now(), closed, run.id, run.version],
      );
      await tx.execute(
        'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          run.id,
          actor.id,
          actor.role,
          action,
          body.reason ?? null,
          now(),
          Number(run.version) + 1,
        ],
      );
      if (actor.role === 'service')
        await appendEvent(
          tx,
          actor as unknown as AdministrationActor,
          'payroll_run',
          run.id,
          'service_payroll_submitted',
          typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null,
          { ...serviceAudit, period: run.period, from: run.state, to: next },
          Number(run.version) + 1,
        );
      return { run: await getRun(run.id, actor, tx) };
    });
  }
  return {
    getRun,
    validateRunNet,
    replay,
    createRun,
    runAction,
    applyInsurance,
    addPersonFromProfile,
    reconcilePeople,
  };
}

export function registerPayroll(app: Express, { db, requireActor }: Options) {
  const {
    getRun,
    validateRunNet,
    replay,
    createRun,
    runAction,
    applyInsurance,
    addPersonFromProfile,
    reconcilePeople,
  } = createPayrollCommands(db);
  const route = (
    method: 'get' | 'post' | 'patch',
    path: string,
    handler: (req: Request, actor: Actor) => Promise<unknown>,
  ) => {
    app[method](`/api/admin${path}`, async (req, res) => {
      try {
        const value = await handler(req, await requireActor(req));
        if (path.endsWith('/export'))
          res.type('text/csv; charset=utf-8').attachment('payroll.csv').send(value);
        else res.json(value);
      } catch (e) {
        const err = e as any;
        res.status(err.status ?? 500).json({
          error: {
            code: err.code ?? 'internal_error',
            message: err.status ? err.message : 'تعذرت معالجة الطلب.',
          },
        });
      }
    });
  };
  route('get', '/payroll', async (req, actor) => {
    const rows = await db.read<Row>(
      ['employee', 'manager'].includes(actor.role)
        ? "SELECT * FROM payroll_runs WHERE state='closed' ORDER BY period DESC"
        : actor.role === 'approver'
          ? "SELECT * FROM payroll_runs WHERE state IN ('pending_approver','closed') ORDER BY created_at DESC"
          : 'SELECT * FROM payroll_runs ORDER BY created_at DESC',
    );
    const runs = [];
    for (const row of rows) {
      try {
        runs.push(await getRun(row.id, actor));
      } catch (e) {
        if ((e as any).status !== 404) throw e;
      }
    }
    return { runs };
  });
  route('get', '/payroll/sources', async (_req, actor) => {
    if (actor.role !== 'hr')
      throw fail(403, 'forbidden', 'مصادر الإضافات المعتمدة متاحة للموارد البشرية فقط.');
    const approved = await db.read<Row>(
      "SELECT id FROM administrative_requests WHERE state='approved' AND kind IN ('reward','overtime') ORDER BY created_at,id",
    );
    const options = [];
    for (const row of approved) {
      if (
        (
          await db.read<Row>('SELECT 1 found FROM payroll_lines WHERE source_request_id=?', [
            row.id,
          ])
        ).length
      )
        continue;
      const source = await getApprovedPayrollSource(db, row.id);
      if (
        source.kind === 'overtime' &&
        (source.values.compensation !== 'payment' || source.values.consent !== true)
      )
        continue;
      const amountMinor = decimalRiyalToMinor(source.values.amount);
      if (amountMinor === null || amountMinor <= 0) continue;
      const employee = (
        await db.read<Row>('SELECT name FROM employee_access WHERE id=?', [source.employeeId])
      )[0];
      if (!employee) continue;
      options.push({
        id: source.id,
        kind: source.kind,
        employeeId: source.employeeId,
        employeeName: employee.name,
        amountMinor,
        label: source.kind === 'reward' ? 'مكافأة معتمدة' : 'عمل إضافي معتمد',
      });
    }
    return { sources: options };
  });
  route('get', '/payroll/policies', async (req, actor) => {
    if (!['hr', 'finance', 'approver', 'auditor'].includes(actor.role))
      throw fail(403, 'forbidden', 'قواعد الرواتب متاحة للأدوار المالية والإدارية فقط.');
    const period = typeof req.query.period === 'string' ? req.query.period : undefined;
    if (period !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
      throw fail(400, 'invalid_input', 'الفترة غير صالحة.');
    return { policies: await approvedPayrollPolicies(db, period) };
  });
  route('get', '/payroll/:id', async (req, actor) => ({
    run: await getRun(String(req.params.id), actor),
  }));
  route('post', '/payroll', (req, actor) => createRun(req, actor));
  route('post', '/payroll/:id/copy', async (req, actor) => {
    if (actor.role !== 'hr') throw fail(403, 'forbidden', 'نسخ المسير متاح للموارد البشرية فقط.');
    const body = req.body ?? {};
    const { period, reason, policyId: requestedPolicyId } = body;
    if (
      typeof period !== 'string' ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) ||
      typeof reason !== 'string' ||
      reason.trim().length < 3 ||
      (requestedPolicyId !== undefined && typeof requestedPolicyId !== 'string')
    )
      throw fail(400, 'invalid_input', 'أدخل فترة صحيحة وسببًا واضحًا.');
    return replay(req, actor, `copy:${req.params.id}`, body, async (tx) => {
      const source = (
        await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [String(req.params.id)])
      )[0];
      if (!source || source.correction_of || source.state === 'rejected')
        throw fail(404, 'not_found', 'المسير الأساسي المراد نسخه غير موجود.');
      if (period <= source.period)
        throw fail(400, 'copy_period_invalid', 'يُنسخ المسير إلى شهر لاحق لشهره فقط.');
      const existing = (
        await tx.read<Row>(
          "SELECT id FROM payroll_runs WHERE period=? AND correction_of IS NULL AND state<>'rejected'",
          [period],
        )
      )[0];
      if (existing) throw fail(409, 'period_already_exists', 'يوجد مسير أساسي لهذه الفترة.');
      const policyId = requestedPolicyId ?? (await approvedPayrollPolicies(tx, period))[0]?.id;
      const policy = policyId
        ? (
            await tx.read<Row>(
              "SELECT * FROM administrative_policies WHERE id=? AND state='synthetic_approved'",
              [policyId],
            )
          )[0]
        : undefined;
      if (!policy || !supportedPolicy(policy) || !policyCovers(policy, period))
        throw fail(
          400,
          'policy_unavailable',
          'لا يوجد إصدار قواعد رواتب معتمد يسري على هذه الفترة. تنشئه الموارد البشرية من صفحة القواعد ويعتمده المعتمد المستقل.',
        );
      const gosi = await policyGosi(tx, policy.id);
      const synthetic =
        JSON.parse(policy.values_json).calculation === 'synthetic-profile-components';
      const id = randomUUID(),
        created = now();
      await tx.execute(
        "INSERT INTO payroll_runs(id,period,version,state,prepared_by,policy_id,correction_of,reason,created_at,updated_at) VALUES(?,?,1,'draft',?,?,NULL,?,?,?)",
        [id, period, actor.id, policy.id, reason.trim(), created, created],
      );
      // Everyone on duty now, the signers included (owner decision 2026-11-14, decision 013).
      const onDuty = await tx.read<Row>(
        "SELECT id,name,title FROM employee_access WHERE status='active' ORDER BY id",
        [],
      );
      const sourcePeople = new Map(
        (await tx.read<Row>('SELECT * FROM payroll_run_people WHERE run_id=?', [source.id])).map(
          (p) => [p.employee_id, p],
        ),
      );
      const sourceLines = await tx.read<Row>(
        'SELECT * FROM payroll_lines WHERE run_id=? ORDER BY id',
        [source.id],
      );
      const exclusions = new Map<string, number>();
      const note = (code: string) => exclusions.set(code, (exclusions.get(code) ?? 0) + 1);
      const stillOnDuty = new Set(onDuty.map((p) => p.id));
      for (const employeeId of new Set(sourceLines.map((l) => l.employee_id)))
        if (!stillOnDuty.has(employeeId)) note('copy_left');
      for (const person of onDuty) {
        const prior = sourcePeople.get(person.id);
        const lines = sourceLines.filter(
          (l) =>
            l.employee_id === person.id &&
            !l.source_request_id &&
            l.component !== PAYROLL_COMPONENTS.insurance,
        );
        if (!prior || !lines.length) {
          // Not in last month's register: build their lines from the profile.
          const problem = await addPersonFromProfile(tx, {
            runId: id,
            person,
            gosi,
            synthetic,
            created,
          });
          if (problem) note(problem);
          else note('copy_added');
          continue;
        }
        let category = prior.insurance_category ?? null;
        let inferred = Number(prior.insurance_category_inferred) === 1;
        if (gosi && prior.employment_type === 'staff' && !category) {
          const resolved = resolveGosiCategory(await getProfileValues(tx, person.id));
          if (!resolved.category) {
            note(resolved.problem);
            continue;
          }
          category = resolved.category;
          inferred = resolved.inferred;
        }
        for (const line of lines)
          await tx.execute(
            'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
            [
              randomUUID(),
              id,
              person.id,
              line.component,
              line.kind,
              Number(line.amount_minor),
              `منسوخ من مسير ${source.period}`,
              null,
              created,
            ],
          );
        await tx.execute(
          'INSERT INTO payroll_run_people(run_id,employee_id,title,payment_method,employment_type,employer_contribution_minor,insurance_category,insurance_category_inferred,insured_wage_minor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [
            id,
            person.id,
            String(person.title ?? prior.title ?? ''),
            prior.payment_method,
            prior.employment_type,
            0,
            category,
            inferred ? 1 : 0,
            0,
            created,
          ],
        );
      }
      if (gosi) await applyInsurance(tx, id, gosi, policy.id);
      const count = (
        await tx.read<Row>('SELECT COUNT(*) count FROM payroll_lines WHERE run_id=?', [id])
      )[0];
      if (Number(count?.count ?? 0) === 0)
        throw fail(400, 'no_salary_profiles', 'لا يوجد من يُنسخ إلى المسير الجديد.');
      await validateRunNet(tx, { id, correction_of: null }, false);
      await tx.execute(
        'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          id,
          actor.id,
          actor.role,
          'created',
          `${reason.trim()} (نسخة من مسير ${source.period})`,
          created,
          1,
        ],
      );
      return {
        run: await getRun(id, actor, tx),
        excludedCount: [...exclusions]
          .filter(([code]) => !['copy_added'].includes(code))
          .reduce((n, [, c]) => n + c, 0),
        exclusions: [...exclusions].map(([code, count]) => ({
          code,
          label: EXCLUSION_LABEL[code] ?? code,
          count,
        })),
      };
    });
  });
  route('patch', '/payroll/:id', async (req, actor) => {
    if (actor.role !== 'hr') throw fail(403, 'forbidden', 'تعديل المسير متاح للموارد البشرية فقط.');
    const body = req.body ?? {};
    return replay(req, actor, `edit:${req.params.id}`, body, async (tx) => {
      const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]))[0];
      if (!run) throw fail(404, 'not_found', 'المسير غير موجود.');
      if (run.state !== 'draft' || run.prepared_by !== actor.id)
        throw fail(409, 'immutable_or_forbidden', 'لا يمكن تعديل هذا المسير.');
      if (Number(body.version) !== Number(run.version))
        throw fail(409, 'version_conflict', 'تغير المسير؛ حدّث الصفحة ثم أعد المحاولة.');
      if (
        !Array.isArray(body.lines) ||
        typeof body.reason !== 'string' ||
        body.reason.trim().length < 3
      )
        throw fail(400, 'invalid_input', 'الأسطر والسبب مطلوبان.');
      const ids = new Set<string>();
      const sources = new Set<string>();
      for (const line of body.lines) {
        const identity = `${line.employeeId}:${line.component}:${line.kind}`;
        if (
          !line.employeeId ||
          ids.has(identity) ||
          !['earning', 'deduction'].includes(line.kind) ||
          !Number.isSafeInteger(line.amountMinor) ||
          line.amountMinor < 0 ||
          !line.component
        )
          throw fail(400, 'invalid_line', 'سطر راتب غير صالح أو مكرر.');
        const subject = (
          await tx.read<Row>('SELECT status FROM employee_access WHERE id=?', [
            String(line.employeeId),
          ])
        )[0];
        if (!subject) throw fail(400, 'invalid_employee', 'الموظف في السطر غير موجود.');
        // Inactive employees are allowed only in a correction run, and only if they were paid
        // in the original closed run, so historical pay stays correctable after they leave.
        if (['terminated', 'suspended'].includes(String(subject.status))) {
          const inOriginal = run.correction_of
            ? (
                await tx.read<Row>(
                  'SELECT 1 found FROM payroll_lines WHERE run_id=? AND employee_id=? LIMIT 1',
                  [run.correction_of, String(line.employeeId)],
                )
              )[0]
            : undefined;
          if (!inOriginal)
            throw fail(400, 'invalid_employee', 'الموظف في السطر غير نشط في مسير جديد.');
        }
        ids.add(identity);
        if (line.sourceRequestId) {
          if (sources.has(line.sourceRequestId))
            throw fail(400, 'duplicate_source', 'مصدر الطلب مكرر داخل المسير.');
          sources.add(line.sourceRequestId);
          const source = await getApprovedPayrollSource(tx, line.sourceRequestId);
          if (source.employeeId !== line.employeeId)
            throw fail(400, 'invalid_source', 'المصدر المعتمد يعود لموظف آخر.');
          if (source.kind === 'advance')
            throw fail(
              400,
              'advance_allocation_required',
              'السلفة تحتاج خطة حسم شهرية معتمدة؛ لا يحددها هذا المسير التجريبي.',
            );
          if (!['reward', 'overtime'].includes(source.kind))
            throw fail(400, 'invalid_source', 'نوع الطلب لا يدعم الإدراج في هذا المسير.');
          if (
            source.kind === 'overtime' &&
            (source.values.compensation !== 'payment' || source.values.consent !== true)
          )
            throw fail(
              400,
              'non_cash_overtime',
              'لا يدرج العمل الإضافي إلا إذا كان المقترح ماليًا وموافقة الموظف موثقة.',
            );
          const sourceMinor = decimalRiyalToMinor(source.values.amount);
          if (
            sourceMinor === null ||
            sourceMinor <= 0 ||
            sourceMinor !== line.amountMinor ||
            line.kind !== 'earning'
          )
            throw fail(
              400,
              'source_amount_mismatch',
              'يجب مطابقة قيمة المصدر المعتمد بالهللات كسطر استحقاق.',
            );
          const consumed = (
            await tx.read<Row>(
              'SELECT 1 found FROM payroll_lines WHERE source_request_id=? AND run_id<>?',
              [line.sourceRequestId, run.id],
            )
          )[0];
          if (consumed) throw fail(409, 'source_consumed', 'سبق استخدام مصدر الطلب في مسير آخر.');
        }
      }
      if (!body.lines.length)
        throw fail(400, 'empty_run', 'يجب أن يحتوي المسير على سطر واحد على الأقل.');
      await tx.execute('DELETE FROM payroll_lines WHERE run_id=?', [run.id]);
      for (const l of body.lines)
        await tx.execute(
          'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          [
            randomUUID(),
            run.id,
            l.employeeId,
            l.component,
            l.kind,
            l.amountMinor,
            run.correction_of
              ? `فرق تصحيحي مرتبط بالمسير ${run.correction_of}`
              : l.sourceRequestId
                ? `طلب ${l.sourceRequestId} معتمد؛ قيمة مقترحة`
                : String(l.source || 'Synthetic manual adjustment'),
            l.sourceRequestId ?? null,
            now(),
          ],
        );
      // Insurance follows the rule, not hand edits: recompute it from the edited lines.
      if (!run.correction_of) {
        const gosi = await policyGosi(tx, run.policy_id);
        await reconcilePeople(tx, run.id, gosi);
        if (gosi) await applyInsurance(tx, run.id, gosi, run.policy_id);
      }
      await validateRunNet(tx, run, false);
      await tx.execute(
        'UPDATE payroll_runs SET version=version+1,updated_at=? WHERE id=? AND version=?',
        [now(), run.id, run.version],
      );
      await tx.execute(
        'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          run.id,
          actor.id,
          actor.role,
          'edited',
          body.reason.trim(),
          now(),
          Number(run.version) + 1,
        ],
      );
      return { run: await getRun(run.id, actor, tx) };
    });
  });
  route('post', '/payroll/:id/actions', (req, actor) => runAction(req, actor));
  route('post', '/payroll/:id/payments', async (req, actor) => {
    if (actor.role !== 'finance')
      throw fail(403, 'forbidden', 'تسجيل حالة الدفع اليدوي للمالية فقط.');
    const body = req.body ?? {};
    return replay(req, actor, `payment:${req.params.id}`, body, async (tx) => {
      const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]))[0];
      if (!run) throw fail(404, 'not_found', 'المسير غير موجود.');
      if (run.state !== 'closed')
        throw fail(409, 'run_not_closed', 'يسجل الدفع بعد إغلاق المسير فقط.');
      if (Number(run.version) !== Number(body.version))
        throw fail(409, 'version_conflict', 'تغير المسير؛ حدّث الصفحة.');
      if (
        !['paid', 'failed', 'partial'].includes(body.state) ||
        !Number.isSafeInteger(body.paidMinor) ||
        body.paidMinor < 0 ||
        typeof body.reference !== 'string' ||
        !body.reference.trim()
      )
        throw fail(400, 'invalid_payment', 'بيانات حالة الدفع غير صالحة.');
      const line = await tx.read<Row>(
        "SELECT SUM(CASE WHEN kind='earning' THEN amount_minor ELSE -amount_minor END) net FROM payroll_lines WHERE run_id=? AND employee_id=?",
        [run.id, body.employeeId],
      );
      if (!line.length || line[0].net === null)
        throw fail(404, 'employee_not_in_run', 'الموظف غير مدرج في المسير.');
      const net = Number(line[0].net);
      if (net <= 0) throw fail(400, 'no_positive_payment', 'لا يمكن تسجيل دفعة موجبة لهذه القيمة.');
      if (
        body.paidMinor > net ||
        (body.state === 'paid' && body.paidMinor !== net) ||
        (body.state === 'failed' && body.paidMinor !== 0) ||
        (body.state === 'partial' && (body.paidMinor === 0 || body.paidMinor === net))
      )
        throw fail(400, 'payment_amount_mismatch', 'المبلغ لا يطابق حالة الدفع.');
      await tx.execute(
        'INSERT INTO payroll_payments(id,run_id,employee_id,state,paid_minor,encrypted_reference,recorded_at,recorded_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,employee_id) DO UPDATE SET state=excluded.state,paid_minor=excluded.paid_minor,encrypted_reference=excluded.encrypted_reference,recorded_at=excluded.recorded_at,recorded_by=excluded.recorded_by',
        [
          randomUUID(),
          run.id,
          body.employeeId,
          body.state,
          body.paidMinor,
          encryptSensitive(body.reference, `payroll-payment:${run.id}:${body.employeeId}`),
          now(),
          actor.id,
        ],
      );
      await tx.execute(
        'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          run.id,
          actor.id,
          actor.role,
          'payment_recorded',
          `حالة دفع يدوية: ${body.state}`,
          now(),
          Number(run.version),
        ],
      );
      return { run: await getRun(run.id, actor, tx) };
    });
  });
  route('get', '/payroll/:id/export', async (req, actor) => {
    const run = await getRun(String(req.params.id), actor);
    if (!['hr', 'finance', 'approver', 'auditor'].includes(actor.role))
      throw fail(403, 'forbidden', 'تصدير المسير متاح للأدوار المالية والإدارية فقط.');
    return payrollRegisterCsv(run);
  });
  app.get('/api/admin/payroll/:id/register.xlsx', async (req, res) => {
    try {
      const actor = await requireActor(req);
      const run = await getRun(String(req.params.id), actor);
      if (!['hr', 'finance', 'approver', 'auditor'].includes(actor.role))
        throw fail(403, 'forbidden', 'تصدير المسير متاح للأدوار المالية والإدارية فقط.');
      const buffer = await payrollRegisterXlsx(run);
      res
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .setHeader('Cache-Control', 'no-store')
        .attachment(`payroll-${run.period}.xlsx`)
        .send(buffer);
    } catch (e) {
      const err = e as any;
      res.status(err.status ?? 500).json({
        error: {
          code: err.code ?? 'internal_error',
          message: err.status ? err.message : 'تعذرت معالجة الطلب.',
        },
      });
    }
  });
}

const csvRow = (row: (string | number)[]) =>
  row
    .map((v) => {
      const value = String(v);
      const safe = /^[\s]*[=+\-@]/.test(value) && typeof v === 'string' ? `'${value}` : value;
      return '"' + safe.replace(/"/g, '""') + '"';
    })
    .join(',');

/** The register in the owner's template column order (no BOM; the client adds one). */
export function payrollRegisterCsv(run: PayrollRun): string {
  const { header, rows } = registerTable(buildPayrollRegister(run));
  return [header, ...rows].map(csvRow).join('\r\n');
}

/** Excel register: title rows, template columns, one section per payment method, totals. */
export async function payrollRegisterXlsx(run: PayrollRun): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const register = buildPayrollRegister(run);
  const { header } = registerTable(register);
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('مسير الرواتب', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 5 }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1 },
  });
  const width = header.length;
  const title = (row: number, text: string, size: number) => {
    sheet.mergeCells(row, 1, row, width);
    const cell = sheet.getCell(row, 1);
    cell.value = text;
    cell.font = { bold: true, size };
    cell.alignment = { horizontal: 'center' };
  };
  const [year, month] = run.period.split('-').map(Number);
  const monthName = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year!, month! - 1, 1)));
  title(1, 'صحيفة سبق الإلكترونية', 16);
  title(2, run.correctionOf ? 'مسير فرق تصحيحي' : 'مسير الرواتب', 14);
  title(3, monthName, 12);
  const headerRow = sheet.getRow(5);
  headerRow.values = header;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  const amountColumns = header.length - 5; // between the title column and the two text columns
  let index = 0;
  for (const group of register.groups) {
    const groupRow = sheet.addRow([`${group.label} (${group.rows.length} موظف)`]);
    sheet.mergeCells(groupRow.number, 1, groupRow.number, width);
    groupRow.font = { bold: true };
    for (const row of group.rows) {
      const values = registerTable({ ...register, groups: [{ ...group, rows: [row] }] }).rows[0]!;
      values[0] = ++index;
      sheet.addRow(values);
    }
    const subtotal = registerTable({ ...register, groups: [], totals: group.totals }).rows[0]!;
    subtotal[1] = `مجموع ${group.label}`;
    sheet.addRow(subtotal).font = { bold: true };
  }
  const total = registerTable({ ...register, groups: [] }).rows[0]!;
  const totalRow = sheet.addRow(total);
  totalRow.font = { bold: true, color: { argb: 'FF059669' } };
  sheet.addRow([]);
  sheet.addRow([
    '',
    'حصة صاحب العمل في التأمينات (لا تدخل في الصافي)',
    '',
    Number((register.employerContributionMinor / 100).toFixed(2)),
  ]);
  sheet.columns.forEach((column, i) => {
    column.width = i === 1 ? 28 : i === 0 ? 6 : i === 2 ? 20 : 13;
    if (i >= 3 && i < 3 + amountColumns) column.numFmt = '#,##0.00';
  });
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** CSV of a run's lines (no BOM). Shared by the in-app export and the HR service key export. */
export function payrollCsv(run: Pick<PayrollRun, 'lines'>): string {
  return [
    ['الموظف', 'المكوّن', 'النوع', 'المبلغ بالريال', 'المصدر'],
    ...run.lines.map((l) => [
      l.employeeName,
      l.component,
      l.kind,
      (l.amountMinor / 100).toFixed(2),
      l.source,
    ]),
  ]
    .map((row) =>
      row
        .map((v) => {
          const value = String(v);
          const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
          return '"' + safe.replace(/"/g, '""') + '"';
        })
        .join(','),
    )
    .join('\r\n');
}
