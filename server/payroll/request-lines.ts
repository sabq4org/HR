// Payroll lines derived from approved administrative requests (decision 021).
//
// - Advance repayment: an approved «طلب سلفة» carries its own plan (amount, number of
//   installments, first deduction month) that HR, finance and the approver saw and approved.
//   From that month on, every primary run deducts «حسم سلفة <number>»: the planned installment
//   (amount ÷ installments, the remainder in the last one), never more than what is still owed
//   after the deductions in other runs that were not rejected or cancelled. A month the person
//   was not paid is not lost: the plan simply runs one month longer.
//   The deduction never takes the person's net below zero; what does not fit stays owed.
// - Unpaid leave: an approved «إجازة خاصة» of type «بدون أجر» deducts «خصم إجازة بدون أجر»
//   for its calendar days inside the run's month, at the daily wage of the approved leave
//   entitlement rule (its wage components ÷ its divisor, the owner's decision for leave pay).
//   No rule, no deduction: the preparer is told instead.
// - The lines are derived like insurance and leave advances: every create, copy, edit, people
//   change and submit of a primary draft removes them and writes them again, so hand edits
//   cannot change them. Correction runs are left alone.
import { randomUUID } from 'node:crypto';
import { daysBetweenInclusive } from '../../shared/leave-entitlement.js';
import type { AsyncDb } from '../database.js';
import { getProfileValues, readProtectedFormValues } from '../administration/service.js';
import {
  approvedEntitlementRules,
  ruleCovering,
  rulesForEmploymentType,
  ruleWage,
} from '../leave/entitlement.js';

type Row = Record<string, any>;

export const ADVANCE_COMPONENT_PREFIX = 'حسم سلفة';
export const UNPAID_LEAVE_COMPONENT = 'خصم إجازة بدون أجر';

/** True for a line this module writes; hand edits of such lines are dropped and rewritten. */
export const isRequestDerivedComponent = (component: unknown) => {
  const name = String(component ?? '');
  return name === UNPAID_LEAVE_COMPONENT || name.startsWith(`${ADVANCE_COMPONENT_PREFIX} `);
};

export const REQUEST_LINE_PROBLEM_LABEL: Record<string, string> = {
  advance_plan_invalid:
    'سلفة معتمدة خطة حسمها غير صالحة (المبلغ أو عدد الأقساط أو شهر أول حسم)؛ لم يُحسم منها شيء',
  advance_capped: 'قسط سلفة لم يتسع له صافي الراتب كله؛ حُسم الممكن ويبقى الباقي للشهر التالي',
  advance_over_tenth:
    'قسط سلفة يتجاوز 10% من إجمالي الراتب؛ راجع موافقة الموظف الكتابية (م92) قبل الإرسال',
  unpaid_leave_no_rule:
    'إجازة بدون أجر معتمدة ولا توجد قاعدة استحقاق معتمدة تحدد أجر اليوم؛ لم تُخصم',
  unpaid_leave_wage_incomplete: 'إجازة بدون أجر معتمدة ومكونات الأجر في الملف غير مكتملة؛ لم تُخصم',
};

const ltr = (value: string) => `⁦${value}⁩`;
const money = (minor: number) => (minor / 100).toFixed(2);

function monthBounds(period: string) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start: `${period}-01`, end };
}

/** Riyal amount as entered in a request form → halalas, or null. */
function riyalToMinor(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const minor = Math.round(Number(text) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

const VALID_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const insertLine = (
  tx: AsyncDb,
  runId: string,
  employeeId: string,
  component: string,
  amountMinor: number,
  source: string,
  requestId: string,
) =>
  tx.execute(
    'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [
      randomUUID(),
      runId,
      employeeId,
      component,
      'deduction',
      amountMinor,
      source,
      requestId,
      new Date().toISOString(),
    ],
  );

/** Net of one person's lines in the run (earnings − deductions), in halalas. */
async function personNet(tx: AsyncDb, runId: string, employeeId: string) {
  const rows = await tx.read<Row>(
    'SELECT kind,amount_minor FROM payroll_lines WHERE run_id=? AND employee_id=?',
    [runId, employeeId],
  );
  let earnings = 0;
  let deductions = 0;
  for (const row of rows) {
    if (row.kind === 'earning') earnings += Number(row.amount_minor);
    else deductions += Number(row.amount_minor);
  }
  return { earnings, net: earnings - deductions };
}

/**
 * Rewrites the advance and unpaid-leave deductions of a primary draft. Run it after insurance
 * and leave advances, so the advance cap sees the person's real net. Returns notices for the
 * preparer by code.
 */
export async function applyRequestDeductions(tx: AsyncDb, runId: string) {
  const problems = new Map<string, number>();
  const note = (code: string) => problems.set(code, (problems.get(code) ?? 0) + 1);
  const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [runId]))[0];
  if (!run || run.correction_of) return problems;
  await tx.execute(
    'DELETE FROM payroll_lines WHERE run_id=? AND source_request_id IS NOT NULL AND (component=? OR component LIKE ?)',
    [runId, UNPAID_LEAVE_COMPONENT, `${ADVANCE_COMPONENT_PREFIX} %`],
  );
  const people = new Map(
    (
      await tx.read<Row>(
        'SELECT employee_id,employment_type FROM payroll_run_people WHERE run_id=?',
        [runId],
      )
    ).map((p) => [String(p.employee_id), String(p.employment_type)]),
  );
  if (!people.size) return problems;
  const period = String(run.period);
  const bounds = monthBounds(period);

  // Unpaid leave first: it is part of what the month pays, the advance comes out of the rest.
  const leaves = await tx.read<Row>(
    "SELECT id,request_number,employee_id,values_json FROM administrative_requests WHERE kind='special_leave' AND state='approved' ORDER BY created_at,id",
  );
  let rules: Awaited<ReturnType<typeof approvedEntitlementRules>> | null = null;
  for (const leave of leaves) {
    const employmentType = people.get(String(leave.employee_id));
    if (!employmentType) continue;
    const values = readProtectedFormValues(
      String(leave.values_json || '{}'),
      `admin-request:${leave.id}:values`,
    ) as Record<string, unknown>;
    if (values.leaveType !== 'unpaid') continue;
    const start = String(values.startDate ?? '');
    const end = String(values.endDate ?? '');
    if (!VALID_ISO_DATE.test(start) || !VALID_ISO_DATE.test(end) || end < start) continue;
    const from = start > bounds.start ? start : bounds.start;
    const to = end < bounds.end ? end : bounds.end;
    if (from > to) continue;
    rules ??= await approvedEntitlementRules(tx);
    const rule = ruleCovering(rulesForEmploymentType(rules, employmentType), from);
    if (!rule) {
      note('unpaid_leave_no_rule');
      continue;
    }
    const wage = ruleWage(await getProfileValues(tx, String(leave.employee_id)), rule);
    if (!wage) {
      note('unpaid_leave_wage_incomplete');
      continue;
    }
    const days = daysBetweenInclusive(from, to);
    const dailyMinor = Math.round(wage.monthlyWageMinor / rule.values.dailyRateDivisor);
    if (!dailyMinor || days <= 0) continue;
    await insertLine(
      tx,
      runId,
      String(leave.employee_id),
      UNPAID_LEAVE_COMPONENT,
      days * dailyMinor,
      `طلب ${leave.request_number}: ${days} يومًا من ${ltr(from)} إلى ${ltr(to)} × ${money(dailyMinor)} ر.س (الأجر ÷ ${rule.values.dailyRateDivisor}، قاعدة الاستحقاق الإصدار ${rule.version})`,
      String(leave.id),
    );
  }

  // Advance repayments.
  const advances = await tx.read<Row>(
    "SELECT id,request_number,employee_id,values_json FROM administrative_requests WHERE kind='advance' AND state='approved' ORDER BY created_at,id",
  );
  for (const advance of advances) {
    const employeeId = String(advance.employee_id);
    if (!people.has(employeeId)) continue;
    const values = readProtectedFormValues(
      String(advance.values_json || '{}'),
      `admin-request:${advance.id}:values`,
    ) as Record<string, unknown>;
    const totalMinor = riyalToMinor(values.amount);
    const installments = Number(values.installments);
    const first = String(values.firstDeductionMonth ?? '').trim();
    if (
      totalMinor === null ||
      totalMinor <= 0 ||
      !Number.isInteger(installments) ||
      installments < 1 ||
      installments > 60 ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(first)
    ) {
      // Only worth telling once the plan would have started.
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(first) || first <= period) note('advance_plan_invalid');
      continue;
    }
    if (period < first) continue;
    const prior = await tx.read<Row>(
      `SELECT COUNT(*) AS count,COALESCE(SUM(l.amount_minor),0) AS total FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id
       WHERE l.source_request_id=? AND l.component LIKE ? AND r.state<>'rejected' AND r.correction_of IS NULL AND r.id<>?`,
      [advance.id, `${ADVANCE_COMPONENT_PREFIX} %`, runId],
    );
    const deductedMinor = Number(prior[0]?.total ?? 0);
    const paidCount = Number(prior[0]?.count ?? 0);
    const remainingMinor = totalMinor - deductedMinor;
    if (remainingMinor <= 0) continue;
    const baseMinor = Math.floor(totalMinor / installments);
    // The last planned installment carries the remainder; past the plan, whatever is left.
    const plannedMinor = paidCount + 1 >= installments ? remainingMinor : baseMinor;
    const { earnings, net } = await personNet(tx, runId, employeeId);
    let dueMinor = Math.min(plannedMinor, remainingMinor);
    if (dueMinor > net) {
      dueMinor = Math.max(0, net);
      note('advance_capped');
    }
    if (dueMinor <= 0) continue;
    if (earnings > 0 && dueMinor * 10 > earnings) note('advance_over_tenth');
    const after = remainingMinor - dueMinor;
    await insertLine(
      tx,
      runId,
      employeeId,
      `${ADVANCE_COMPONENT_PREFIX} ${advance.request_number}`,
      dueMinor,
      `سلفة ${money(totalMinor)} ر.س على ${installments} أقساط من ${ltr(first)}: القسط ${paidCount + 1}، حُسم قبله ${money(deductedMinor)} ر.س، ويبقى بعده ${money(after)} ر.س`,
      String(advance.id),
    );
  }
  return problems;
}
