// Social insurance (GOSI) contribution as a versioned payroll rule. No rate, cap or category
// lives in this file: every number comes from the approved payroll rule version (its values
// JSON), which records its source, effective dates and approver. This file only validates the
// rule's shape and applies it the same way to every employee of the same category.

export const GOSI_CATEGORIES = ['saudi_existing', 'saudi_new', 'non_saudi'] as const;
export type GosiCategory = (typeof GOSI_CATEGORIES)[number];
export const GOSI_CATEGORY_LABEL: Record<GosiCategory, string> = {
  saudi_existing: 'سعودي · النظام السابق',
  saudi_new: 'سعودي · النظام الجديد',
  non_saudi: 'غير سعودي',
};

export interface GosiCategoryRule {
  /** Shares in basis points of the contributory wage (975 = 9.75%). */
  employeeBps: number;
  employerBps: number;
}
export interface GosiRule {
  /** Profile money fields summed into the contributory wage, e.g. basic and housing. */
  wageComponents: string[];
  /** Ceiling and optional floor of the contributory wage, in halalas. */
  maxWageMinor: number;
  minWageMinor: number;
  categories: Record<GosiCategory, GosiCategoryRule>;
}

export const GOSI_WAGE_COMPONENTS = ['basicSalary', 'housingAllowance'] as const;

const bps = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5000;
const minor = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000_00;

/**
 * Reads the `gosi` section of a payroll rule version. Returns null when the version has no
 * insurance section; throws when the section exists but is malformed, so a bad version never
 * computes silently.
 */
export function parseGosiRule(values: unknown): GosiRule | null {
  const gosi = (values as { gosi?: unknown } | null)?.gosi;
  if (gosi === undefined || gosi === null) return null;
  const rule = gosi as Partial<GosiRule>;
  const categories = rule.categories as Partial<Record<GosiCategory, Partial<GosiCategoryRule>>>;
  const valid =
    Array.isArray(rule.wageComponents) &&
    rule.wageComponents.length > 0 &&
    rule.wageComponents.every((key) =>
      (GOSI_WAGE_COMPONENTS as readonly string[])
        .concat(['transportAllowance', 'otherAllowance'])
        .includes(key),
    ) &&
    minor(rule.maxWageMinor) &&
    (rule.maxWageMinor as number) > 0 &&
    minor(rule.minWageMinor ?? 0) &&
    (rule.minWageMinor ?? 0) <= (rule.maxWageMinor as number) &&
    !!categories &&
    GOSI_CATEGORIES.every(
      (key) =>
        categories[key] && bps(categories[key]!.employeeBps) && bps(categories[key]!.employerBps),
    );
  if (!valid) throw new Error('gosi_rule_invalid');
  return {
    wageComponents: [...rule.wageComponents!],
    maxWageMinor: rule.maxWageMinor!,
    minWageMinor: rule.minWageMinor ?? 0,
    categories: Object.fromEntries(
      GOSI_CATEGORIES.map((key) => [
        key,
        { employeeBps: categories[key]!.employeeBps!, employerBps: categories[key]!.employerBps! },
      ]),
    ) as GosiRule['categories'],
  };
}

export type GosiCategoryResult =
  | { category: GosiCategory; inferred: boolean }
  | { category: null; problem: 'nationality_missing' | 'gcc_manual' | 'category_unreviewed' };

export const GOSI_PROBLEM_LABEL = {
  nationality_missing: 'الجنسية أو فئة الجنسية في التأمينات غير مدخلة',
  gcc_manual: 'مواطن خليجي يخضع لنظام مد الحماية ويُعالج يدويًا',
  category_unreviewed: 'لم تُحدد فئة التأمينات (النظام السابق أو الجديد) لموظف سعودي',
} as const;

const GCC = /كويت|إمارات|امارات|قطر|بحرين|عمان|عُمان|kuwait|emirat|qatar|bahrain|oman/i;
const SAUDI = /سعود|saudi/i;

/**
 * Category from the profile. The explicit «فئة الجنسية في التأمينات» field wins; otherwise
 * the nationality text is read and the result is marked as inferred for review. A Saudi's
 * old/new system is never guessed: prior contribution periods elsewhere decide it.
 */
export function resolveGosiCategory(profile: Record<string, unknown>): GosiCategoryResult {
  const explicit = String(profile.insuranceNationalityGroup ?? '').trim();
  const nationality = String(profile.nationality ?? '').trim();
  let group = explicit;
  let inferred = false;
  if (!group && nationality) {
    inferred = true;
    group = SAUDI.test(nationality) ? 'saudi' : GCC.test(nationality) ? 'gcc' : 'non_saudi';
  }
  if (!group) return { category: null, problem: 'nationality_missing' };
  if (group === 'gcc') return { category: null, problem: 'gcc_manual' };
  if (group === 'non_saudi') return { category: 'non_saudi', inferred };
  if (group !== 'saudi') return { category: null, problem: 'nationality_missing' };
  const system = String(profile.insuranceCategory ?? '').trim();
  if (system === 'existing') return { category: 'saudi_existing', inferred };
  if (system === 'new') return { category: 'saudi_new', inferred };
  return { category: null, problem: 'category_unreviewed' };
}

/** Share of a wage in basis points, rounded half-up to the halala. */
export const shareOf = (wageMinor: number, rateBps: number) =>
  Math.floor((wageMinor * rateBps + 5000) / 10000);

export function gosiContribution(
  rule: GosiRule,
  category: GosiCategory,
  componentsMinor: Record<string, number>,
): { wageMinor: number; employeeMinor: number; employerMinor: number } {
  const raw = rule.wageComponents.reduce((n, key) => n + (componentsMinor[key] ?? 0), 0);
  const wageMinor = Math.min(Math.max(raw, rule.minWageMinor), rule.maxWageMinor);
  const shares = rule.categories[category];
  return {
    wageMinor,
    employeeMinor: shareOf(wageMinor, shares.employeeBps),
    employerMinor: shareOf(wageMinor, shares.employerBps),
  };
}
