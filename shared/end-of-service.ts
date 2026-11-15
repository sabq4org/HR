// End-of-service award arithmetic (decision 016). Pure functions shared by the server, the UI
// and the tests. No legal figure lives here: tiers, shares and the reason treatment come from an
// approved rule version (administrative_policies, policy_key 'end-of-service-award').

export const EOS_POLICY_KEY = 'end-of-service-award';
export const EOS_CALCULATION = 'eos-art84-v1';

/** Wage components a rule may count in the award wage (art. 84 "last wage"). */
export const EOS_WAGE_COMPONENTS = {
  basicSalary: 'الراتب الأساسي',
  housingAllowance: 'بدل السكن',
  transportAllowance: 'بدل النقل',
  otherAllowance: 'بدلات أخرى ثابتة',
} as const;
export type EosWageComponent = keyof typeof EOS_WAGE_COMPONENTS;

/** Why the service ended. The rule decides how each one is treated. */
export const EOS_REASONS = {
  resignation: 'استقالة',
  resignation_art87: 'ترك العمل لقوة قاهرة، أو للعاملة خلال 6 أشهر من الزواج أو 3 من الوضع',
  contract_end: 'انتهاء مدة العقد',
  employer: 'إنهاء من صاحب العمل لغير الأسباب الواردة في المادة 80',
  mutual: 'اتفاق الطرفين',
  worker_art81: 'ترك العامل العمل وفق المادة 81',
  dismissal_art80: 'فسخ العقد وفق المادة 80',
  death_disability: 'وفاة أو عجز كلي',
} as const;
export type EosReason = keyof typeof EOS_REASONS;
export type EosTreatment = 'full' | 'resignation' | 'none';
export const EOS_TREATMENTS: Record<EosTreatment, string> = {
  full: 'المكافأة كاملة',
  resignation: 'نسبة الاستقالة',
  none: 'لا مكافأة',
};

export interface EosResignationTier {
  /** Applies from this many years of service. */
  fromYears: number;
  numerator: number;
  denominator: number;
}

export interface EosRuleValues {
  calculation: typeof EOS_CALCULATION;
  /** Years paid at the first rate (art. 84: 5). */
  firstTierYears: number;
  /** Months of wage per year, in thousandths: first tier (500 = half a month), then later years (1000). */
  firstTierMonthsMilli: number;
  laterMonthsMilli: number;
  /** Days that make one service year (365). Fractions of a year are paid in proportion. */
  yearDays: number;
  /** Art. 85 shares, ascending by fromYears. Service below the first tier earns nothing. */
  resignationTiers: EosResignationTier[];
  reasonTreatment: Record<EosReason, EosTreatment>;
  wageComponents: EosWageComponent[];
  /** Contractors paid a lump sum are outside the award. */
  excludeContractors: boolean;
  sourceKind: 'official' | 'secondary';
}

export interface EosRule {
  id: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  values: EosRuleValues;
}

const int = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function parseEosValues(
  input: unknown,
): { ok: true; values: EosRuleValues } | { ok: false; message: string } {
  const v = (input ?? {}) as Record<string, unknown>;
  if (v.calculation !== EOS_CALCULATION)
    return { ok: false, message: 'نوع حساب قاعدة نهاية الخدمة غير معروف.' };
  if (!int(v.firstTierYears, 0, 40))
    return { ok: false, message: 'سنوات الشريحة الأولى غير صالحة.' };
  if (!int(v.firstTierMonthsMilli, 0, 5000) || !int(v.laterMonthsMilli, 0, 5000))
    return { ok: false, message: 'أشهر الأجر عن كل سنة غير صالحة.' };
  if (!int(v.yearDays, 360, 366)) return { ok: false, message: 'أيام السنة غير صالحة.' };
  const tiers = v.resignationTiers;
  if (!Array.isArray(tiers) || tiers.length > 10)
    return { ok: false, message: 'شرائح الاستقالة غير صالحة.' };
  let previous = -1;
  for (const t of tiers as Record<string, unknown>[]) {
    if (
      !int(t?.fromYears, 0, 40) ||
      !int(t?.numerator, 0, 100) ||
      !int(t?.denominator, 1, 100) ||
      (t.numerator as number) > (t.denominator as number) ||
      (t.fromYears as number) <= previous
    )
      return { ok: false, message: 'شرائح الاستقالة يجب أن تكون تصاعدية وبنسبة لا تتجاوز 1.' };
    previous = t.fromYears as number;
  }
  const treatment = v.reasonTreatment as Record<string, unknown> | undefined;
  if (
    !treatment ||
    typeof treatment !== 'object' ||
    Object.keys(treatment).length !== Object.keys(EOS_REASONS).length ||
    !Object.keys(EOS_REASONS).every(
      (k) => typeof treatment[k] === 'string' && (treatment[k] as string) in EOS_TREATMENTS,
    )
  )
    return { ok: false, message: 'حدد المعاملة لكل سبب من أسباب انتهاء الخدمة.' };
  const components = v.wageComponents;
  if (
    !Array.isArray(components) ||
    !components.length ||
    !components.includes('basicSalary') ||
    new Set(components).size !== components.length ||
    !components.every((c) => typeof c === 'string' && c in EOS_WAGE_COMPONENTS)
  )
    return { ok: false, message: 'حدد مكونات الأجر، والأساسي منها دائمًا.' };
  if (typeof v.excludeContractors !== 'boolean')
    return { ok: false, message: 'حدد هل يُستثنى المتعاون بمبلغ مقطوع.' };
  if (v.sourceKind !== 'official' && v.sourceKind !== 'secondary')
    return { ok: false, message: 'حدد نوع المصدر: رسمي أو ثانوي.' };
  return { ok: true, values: v as unknown as EosRuleValues };
}

const DAY = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const daysInclusive = (from: string, to: string) =>
  to < from ? 0 : Math.round((toTime(to) - toTime(from)) / DAY) + 1;

export interface ServicePeriod {
  startDate: string;
  endDate: string | null;
}
/** Calendar days of service up to lastDay, each period clipped, overlaps counted once. */
export function serviceDays(periods: ServicePeriod[], lastDay: string): number {
  const ranges = periods
    .map((p) => ({
      from: p.startDate,
      to: p.endDate && p.endDate < lastDay ? p.endDate : lastDay,
    }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from.localeCompare(b.from));
  let total = 0;
  let coveredTo: string | null = null;
  for (const r of ranges) {
    const from: string =
      coveredTo && r.from <= coveredTo
        ? new Date(toTime(coveredTo) + DAY).toISOString().slice(0, 10)
        : r.from;
    if (from <= r.to) total += daysInclusive(from, r.to);
    if (!coveredTo || r.to > coveredTo) coveredTo = r.to;
  }
  return total;
}

/** Integer division rounding half up, for non-negative BigInts. */
const divRound = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);

export interface EosAward {
  serviceDays: number;
  serviceYears: number;
  treatment: EosTreatment;
  /** Full art. 84 award before any resignation share. */
  fullAwardMinor: number;
  share: { numerator: number; denominator: number };
  amountMinor: number;
  firstTierDays: number;
  laterDays: number;
}

/**
 * Art. 84: firstTierMonths of wage for each of the first firstTierYears, laterMonths for each
 * year after, fractions of a year in proportion. Art. 85 (resignation): the share of the highest
 * tier reached; below the first tier nothing. Amounts in halalas, rounded half up once.
 */
export function eosAward(
  monthlyWageMinor: number,
  days: number,
  treatment: EosTreatment,
  rule: EosRuleValues,
): EosAward {
  const firstCap = rule.firstTierYears * rule.yearDays;
  const firstTierDays = Math.min(days, firstCap);
  const laterDays = Math.max(0, days - firstCap);
  const wage = BigInt(monthlyWageMinor);
  const weighted =
    BigInt(firstTierDays) * BigInt(rule.firstTierMonthsMilli) +
    BigInt(laterDays) * BigInt(rule.laterMonthsMilli);
  const den = BigInt(rule.yearDays) * 1000n;
  const fullAwardMinor = Number(divRound(wage * weighted, den));
  let share = { numerator: 1, denominator: 1 };
  if (treatment === 'none') share = { numerator: 0, denominator: 1 };
  if (treatment === 'resignation') {
    const tier = [...rule.resignationTiers]
      .reverse()
      .find((t) => days >= t.fromYears * rule.yearDays);
    share = tier
      ? { numerator: tier.numerator, denominator: tier.denominator }
      : { numerator: 0, denominator: 1 };
  }
  const amountMinor = Number(
    divRound(wage * weighted * BigInt(share.numerator), den * BigInt(share.denominator)),
  );
  return {
    serviceDays: days,
    serviceYears: Math.floor((days / rule.yearDays) * 100) / 100,
    treatment,
    fullAwardMinor,
    share,
    amountMinor,
    firstTierDays,
    laterDays,
  };
}
