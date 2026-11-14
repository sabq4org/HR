// Leave wage paid in advance (labour law art. 109, decision 015).
//
// - Advance: an approved annual leave that starts in the month after a primary run's period is
//   paid in that run as «أجر إجازة مقدم»: calendar days of the leave × the daily wage of the
//   approved entitlement rule covering its first day (the rule's wage components from the
//   profile ÷ the rule's divisor). One advance per leave, its later changes included.
// - Recovery: the regular salary of the months the leave falls in pays the same days again, so
//   each later run deducts «استرداد أجر إجازة مقدم» for the leave days that fall in its period,
//   at the advance's own daily rate. Once the leave has ended, or was cancelled or shortened,
//   whatever is left is recovered in full. Only advances in closed runs are recovered.
// - The lines are derived, like insurance: every create, copy, edit and submit of a primary
//   draft removes them and writes them again, so hand edits cannot change them.
import { randomUUID } from 'node:crypto';
import { addDays, daysBetweenInclusive } from '../../shared/leave-entitlement.js';
import { PAYROLL_COMPONENTS } from '../../shared/payroll-register.js';
import type { AsyncDb } from '../database.js';
import { getProfileValues } from '../administration/service.js';
import {
  approvedEntitlementRules,
  ruleCovering,
  rulesForEmploymentType,
  ruleWage,
} from './entitlement.js';

type Row = Record<string, any>;

export const LEAVE_ADVANCE_COMPONENTS: string[] = [
  PAYROLL_COMPONENTS.leaveAdvance,
  PAYROLL_COMPONENTS.leaveAdvanceRecovery,
];

export const LEAVE_ADVANCE_PROBLEM_LABEL: Record<string, string> = {
  leave_advance_no_rule:
    'إجازة تبدأ الشهر القادم ولا توجد قاعدة استحقاق معتمدة تغطيها (لم يُصرف أجرها مقدمًا)',
  leave_advance_wage_incomplete:
    'إجازة تبدأ الشهر القادم ومكونات الأجر في الملف غير مكتملة (لم يُصرف أجرها مقدمًا)',
};

function monthBounds(period: string) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start: `${period}-01`, end };
}
/** Wraps a Latin date in a left-to-right isolate so it reads correctly inside Arabic text. */
const ltr = (value: string) => `\u2066${value}\u2069`;
const nextPeriod = (period: string) => addDays(monthBounds(period).end, 1).slice(0, 7);

/** The leave and every version it replaced (the change chain walks parent_leave_id). */
async function ancestry(tx: AsyncDb, leave: Row): Promise<string[]> {
  const ids = [String(leave.id)];
  let parent = leave.parent_leave_id;
  while (parent && !ids.includes(String(parent))) {
    ids.push(String(parent));
    parent = (
      await tx.read<Row>('SELECT parent_leave_id FROM leave_requests WHERE id=?', [parent])
    )[0]?.parent_leave_id;
  }
  return ids;
}

/** The version of a leave in force now: follow approved changes to the current row. */
async function currentVersion(tx: AsyncDb, leaveId: string): Promise<Row | undefined> {
  let row = (await tx.read<Row>('SELECT * FROM leave_requests WHERE id=?', [leaveId]))[0];
  const seen = new Set<string>();
  while (row && Number(row.current_flag) === 0 && !seen.has(row.id)) {
    seen.add(row.id);
    const child = (
      await tx.read<Row>(
        'SELECT * FROM leave_requests WHERE parent_leave_id=? ORDER BY created_at DESC LIMIT 1',
        [row.id],
      )
    )[0];
    if (!child) break;
    row = child;
  }
  return row;
}

const insertLine = (
  tx: AsyncDb,
  runId: string,
  employeeId: string,
  component: string,
  kind: 'earning' | 'deduction',
  amountMinor: number,
  source: string,
  leaveId: string,
) =>
  tx.execute(
    'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,source_leave_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [
      randomUUID(),
      runId,
      employeeId,
      component,
      kind,
      amountMinor,
      source,
      null,
      leaveId,
      new Date().toISOString(),
    ],
  );

/**
 * Rewrites the advance and recovery lines of a primary draft. Returns the leaves that start
 * next month but could not be advanced, by problem code, so the preparer sees them.
 */
export async function applyLeaveAdvances(tx: AsyncDb, runId: string) {
  const problems = new Map<string, number>();
  const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [runId]))[0];
  if (!run || run.correction_of) return problems;
  await tx.execute('DELETE FROM payroll_lines WHERE run_id=? AND source_leave_id IS NOT NULL', [
    runId,
  ]);
  const people = new Map(
    (
      await tx.read<Row>(
        'SELECT employee_id,employment_type FROM payroll_run_people WHERE run_id=?',
        [runId],
      )
    ).map((p) => [String(p.employee_id), String(p.employment_type)]),
  );
  if (!people.size) return problems;
  const period = monthBounds(String(run.period));
  const next = monthBounds(nextPeriod(String(run.period)));
  const rules = await approvedEntitlementRules(tx);

  // Advances for leaves starting next month.
  const leaves = await tx.read<Row>(
    "SELECT * FROM leave_requests WHERE status='approved' AND current_flag=1 AND start_date>=? AND start_date<=? ORDER BY start_date,id",
    [next.start, next.end],
  );
  for (const leave of leaves) {
    const employmentType = people.get(String(leave.employee_id));
    if (!employmentType) continue;
    const chain = await ancestry(tx, leave);
    const marks = chain.map(() => '?').join(',');
    const already = await tx.read(
      `SELECT 1 FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id
       WHERE l.source_leave_id IN (${marks}) AND l.component=? AND r.state<>'rejected' AND r.id<>? LIMIT 1`,
      [...chain, PAYROLL_COMPONENTS.leaveAdvance, runId],
    );
    if (already.length) continue;
    const rule = ruleCovering(rulesForEmploymentType(rules, employmentType), leave.start_date);
    if (!rule) {
      problems.set('leave_advance_no_rule', (problems.get('leave_advance_no_rule') ?? 0) + 1);
      continue;
    }
    const wage = ruleWage(await getProfileValues(tx, leave.employee_id), rule);
    if (!wage) {
      problems.set(
        'leave_advance_wage_incomplete',
        (problems.get('leave_advance_wage_incomplete') ?? 0) + 1,
      );
      continue;
    }
    const days = daysBetweenInclusive(leave.start_date, leave.end_date);
    const dailyMinor = Math.round(wage.monthlyWageMinor / rule.values.dailyRateDivisor);
    if (!dailyMinor || days <= 0) continue;
    await insertLine(
      tx,
      runId,
      String(leave.employee_id),
      PAYROLL_COMPONENTS.leaveAdvance,
      'earning',
      days * dailyMinor,
      `إجازة ${ltr(leave.start_date)} إلى ${ltr(leave.end_date)}: ${days} يومًا × ${(dailyMinor / 100).toFixed(2)} ر.س (الأجر ÷ ${rule.values.dailyRateDivisor}، قاعدة الاستحقاق الإصدار ${rule.version})؛ م109`,
      String(leave.id),
    );
  }

  // Recoveries of advances paid in closed earlier runs.
  const ids = [...people.keys()];
  const advances = await tx.read<Row>(
    `SELECT l.employee_id,l.amount_minor,l.source_leave_id,r.period FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id
     WHERE l.component=? AND l.kind='earning' AND l.source_leave_id IS NOT NULL AND r.state='closed' AND r.period<?
     AND l.employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.period,l.id`,
    [PAYROLL_COMPONENTS.leaveAdvance, String(run.period), ...ids],
  );
  for (const advance of advances) {
    const amountMinor = Number(advance.amount_minor);
    const advanced = (
      await tx.read<Row>('SELECT start_date,end_date FROM leave_requests WHERE id=?', [
        advance.source_leave_id,
      ])
    )[0];
    if (!advanced) continue;
    const advancedDays = daysBetweenInclusive(advanced.start_date, advanced.end_date);
    const dailyMinor = Math.round(amountMinor / advancedDays);
    const current = await currentVersion(tx, String(advance.source_leave_id));
    let dueMinor: number;
    let why: string;
    if (!current || current.status !== 'approved') {
      dueMinor = amountMinor;
      why = 'أُلغيت الإجازة بعد صرف أجرها مقدمًا';
    } else if (current.end_date <= period.end) {
      dueMinor = amountMinor;
      why = `انتهت الإجازة في ${ltr(current.end_date)}`;
    } else {
      const from = current.start_date;
      const covered = from > period.end ? 0 : daysBetweenInclusive(from, period.end);
      dueMinor = Math.min(amountMinor, covered * dailyMinor);
      why = `${covered} يومًا من الإجازة حتى ${ltr(period.end)}`;
    }
    const recovered = (
      await tx.read<Row>(
        `SELECT COALESCE(SUM(l.amount_minor),0) AS total FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id
         WHERE l.source_leave_id=? AND l.component=? AND r.state<>'rejected' AND r.correction_of IS NULL AND r.id<>?`,
        [advance.source_leave_id, PAYROLL_COMPONENTS.leaveAdvanceRecovery, runId],
      )
    )[0];
    const remaining = dueMinor - Number(recovered?.total ?? 0);
    if (remaining <= 0) continue;
    await insertLine(
      tx,
      runId,
      String(advance.employee_id),
      PAYROLL_COMPONENTS.leaveAdvanceRecovery,
      'deduction',
      remaining,
      `استرداد ما صُرف مقدمًا في مسير ${ltr(advance.period)} لأن راتب الشهر يغطي أيام الإجازة: ${why}`,
      String(advance.source_leave_id),
    );
  }
  return problems;
}
