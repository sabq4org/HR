// Annual leave entitlement arithmetic (decision 015). Pure functions shared by the server and
// the tests. Nothing here is a legal figure: every number comes from an approved rule version
// (administrative_policies, policy_key 'annual-leave-entitlement') passed in by the caller.

export const LEAVE_ENTITLEMENT_POLICY_KEY = 'annual-leave-entitlement';
export const LEAVE_ENTITLEMENT_CALCULATION = 'annual-leave-accrual-v1';

/** Wage components an entitlement rule may count in the daily leave wage. */
export const LEAVE_WAGE_COMPONENTS = {
  basicSalary: 'الراتب الأساسي',
  housingAllowance: 'بدل السكن',
  transportAllowance: 'بدل النقل',
  otherAllowance: 'بدلات أخرى ثابتة',
} as const;
export type LeaveWageComponent = keyof typeof LEAVE_WAGE_COMPONENTS;

export interface LeaveEntitlementRuleValues {
  calculation: typeof LEAVE_ENTITLEMENT_CALCULATION;
  /** Days per year before the senior threshold (art. 109: 21). */
  baseDays: number;
  /** Days per year once the employee completes seniorAfterYears of continuous service (30). */
  seniorDays: number;
  seniorAfterYears: number;
  /** Calendar days the yearly entitlement is spread over when accruing (365). */
  yearDays: number;
  /** The monthly wage is divided by this to get one day's leave wage (30). */
  dailyRateDivisor: number;
  wageComponents: LeaveWageComponent[];
  /** Contractors paid a lump sum accrue nothing under this rule. */
  excludeContractors: boolean;
  /** 'official' only when the figures were checked against the published law text. */
  sourceKind: 'official' | 'secondary';
}

export interface LeaveEntitlementRule {
  id: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  values: LeaveEntitlementRuleValues;
}

const int = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Validates rule values; returns the parsed rule or a reason in Arabic. */
export function parseLeaveEntitlementValues(
  input: unknown,
): { ok: true; values: LeaveEntitlementRuleValues } | { ok: false; message: string } {
  const v = (input ?? {}) as Record<string, unknown>;
  if (v.calculation !== LEAVE_ENTITLEMENT_CALCULATION)
    return { ok: false, message: 'نوع حساب قاعدة الاستحقاق غير معروف.' };
  if (!int(v.baseDays, 1, 60)) return { ok: false, message: 'أيام الاستحقاق الأساسية غير صالحة.' };
  if (!int(v.seniorDays, 1, 60) || (v.seniorDays as number) < (v.baseDays as number))
    return { ok: false, message: 'أيام الاستحقاق بعد مدة الخدمة يجب ألا تقل عن الأساسية.' };
  if (!int(v.seniorAfterYears, 1, 40))
    return { ok: false, message: 'عدد سنوات الخدمة للانتقال غير صالح.' };
  if (!int(v.yearDays, 360, 366)) return { ok: false, message: 'أيام السنة للتوزيع غير صالحة.' };
  if (!int(v.dailyRateDivisor, 1, 31))
    return { ok: false, message: 'مقسوم الأجر اليومي غير صالح.' };
  const components = v.wageComponents;
  if (
    !Array.isArray(components) ||
    !components.length ||
    new Set(components).size !== components.length ||
    !components.every((c) => typeof c === 'string' && c in LEAVE_WAGE_COMPONENTS)
  )
    return { ok: false, message: 'حدد مكونات الأجر المحتسبة في بدل الإجازة.' };
  if (typeof v.excludeContractors !== 'boolean')
    return { ok: false, message: 'حدد هل يُستثنى المتعاون بمبلغ مقطوع.' };
  if (v.sourceKind !== 'official' && v.sourceKind !== 'secondary')
    return { ok: false, message: 'حدد نوع المصدر: رسمي أو ثانوي.' };
  return { ok: true, values: v as unknown as LeaveEntitlementRuleValues };
}

const DAY = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (time: number) => new Date(time).toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => toIso(toTime(iso) + days * DAY);
export const daysBetweenInclusive = (from: string, to: string) =>
  to < from ? 0 : Math.round((toTime(to) - toTime(from)) / DAY) + 1;

/** The date `years` after `iso`; 29 February falls on 1 March in a common year. */
export function anniversary(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y + years, m - 1, d));
  return toIso(date.getTime());
}

/** Completed years of service on `asOf` (anniversary-based, no rounding up). */
export function completedServiceYears(joinDate: string, asOf: string): number {
  if (asOf < joinDate) return 0;
  let years = Math.max(0, Number(asOf.slice(0, 4)) - Number(joinDate.slice(0, 4)) - 1);
  while (anniversary(joinDate, years + 1) <= asOf) years++;
  return years;
}

export interface AccrualSegment {
  from: string;
  to: string;
  ruleId: string | null;
  ruleVersion: number | null;
  daysPerYear: number;
  calendarDays: number;
  /** Thousandths of a leave day earned in this segment (not rounded). */
  milli: number;
}

/**
 * Leave earned from `from` to `to` inclusive, day by day: each calendar day earns
 * daysPerYear / yearDays of the rule covering it. The senior rate applies from the day the
 * employee completes seniorAfterYears counted from `joinDate`. Days no approved rule covers
 * earn nothing and appear as a segment with ruleId null.
 */
export function accrueLeave(
  joinDate: string,
  from: string,
  to: string,
  rules: LeaveEntitlementRule[],
): { milli: number; segments: AccrualSegment[] } {
  const segments: AccrualSegment[] = [];
  if (to < from) return { milli: 0, segments };
  const ruleFor = (day: string) =>
    rules
      .filter((r) => r.effectiveFrom <= day && (!r.effectiveTo || r.effectiveTo >= day))
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
  let day = from;
  let total = 0;
  while (day <= to) {
    const rule = ruleFor(day);
    const senior =
      rule && day >= anniversary(joinDate, rule.values.seniorAfterYears) ? true : false;
    const daysPerYear = rule ? (senior ? rule.values.seniorDays : rule.values.baseDays) : 0;
    const last = segments[segments.length - 1];
    const perDay = rule ? (daysPerYear * 1000) / rule.values.yearDays : 0;
    if (last && last.ruleId === (rule?.id ?? null) && last.daysPerYear === daysPerYear) {
      last.to = day;
      last.calendarDays += 1;
      last.milli += perDay;
    } else
      segments.push({
        from: day,
        to: day,
        ruleId: rule?.id ?? null,
        ruleVersion: rule?.version ?? null,
        daysPerYear,
        calendarDays: 1,
        milli: perDay,
      });
    total += perDay;
    day = addDays(day, 1);
  }
  // Floor to whole thousandths so repeated postings never exceed the exact figure.
  return { milli: Math.floor(total + 1e-6), segments };
}

/** Daily leave wage and encashment amount in halalas from monthly components in halalas. */
export function encashmentAmount(
  monthlyWageMinor: number,
  divisor: number,
  balanceMilli: number,
): { dailyMinor: number; amountMinor: number } {
  return {
    dailyMinor: Math.round(monthlyWageMinor / divisor),
    amountMinor: Math.round((monthlyWageMinor * balanceMilli) / (divisor * 1000)),
  };
}

export const milliToDays = (milli: number) => Math.round(milli) / 1000;
