// Payroll register in the layout of the owner's payroll template: one row per employee with
// fixed columns, grouped by payment method (direct payment, wage protection), with group and
// grand totals. Pure: the screen, the printed register and the CSV/Excel exports all use it.
// It only re-arranges the run's stored lines; it computes no rate and no entitlement.
import type {
  PayrollLine,
  PayrollPaymentMethod,
  PayrollPerson,
  PayrollRun,
} from './administration';

export const REGISTER_COLUMNS = [
  ['basicMinor', 'الراتب الأساسي'],
  ['housingMinor', 'بدل السكن'],
  ['transportMinor', 'بدل النقل'],
  ['otherAllowancesMinor', 'بدلات أخرى'],
  ['bonusMinor', 'المكافأة'],
  ['grossMinor', 'إجمالي الراتب'],
  ['insuranceMinor', 'تأمين الموظف'],
  ['deductionsMinor', 'الخصومات'],
  ['totalDeductionsMinor', 'إجمالي الخصومات'],
  ['netMinor', 'صافي الراتب'],
] as const;
export type RegisterAmountKey = (typeof REGISTER_COLUMNS)[number][0];
export type RegisterAmounts = Record<RegisterAmountKey, number>;

/** Component names the run creates from the profile; anything else falls in bonus/deductions. */
export const PAYROLL_COMPONENTS = {
  basic: 'الراتب الأساسي',
  housing: 'بدل السكن',
  transport: 'بدل النقل',
  other: 'بدلات ثابتة أخرى',
  insurance: 'تأمين الموظف',
  lumpSum: 'مبلغ مقطوع',
} as const;

export const PAYMENT_METHOD_LABEL: Record<PayrollPaymentMethod, string> = {
  direct: 'الدفع المباشر',
  wps: 'حماية الأجور',
  unspecified: 'غير محدد',
};
export type RegisterPaymentState = 'unpaid' | 'paid' | 'partial' | 'failed';
export const PAYMENT_STATE_LABEL: Record<RegisterPaymentState, string> = {
  unpaid: 'غير مدفوع',
  paid: 'مدفوع',
  partial: 'مدفوع جزئيًا',
  failed: 'تعذر الدفع',
};

export interface RegisterRow extends RegisterAmounts {
  key: string;
  employeeId: string;
  employeeName: string;
  title: string;
  paymentMethod: PayrollPaymentMethod;
  paymentState: RegisterPaymentState;
  paidMinor: number;
  employerContributionMinor: number;
  insuranceCategory: PayrollPerson['insuranceCategory'];
  insuranceCategoryInferred: boolean;
  employmentType: PayrollPerson['employmentType'];
}
export interface RegisterGroup {
  method: PayrollPaymentMethod;
  label: string;
  rows: RegisterRow[];
  totals: RegisterAmounts;
}
export interface PayrollRegister {
  groups: RegisterGroup[];
  totals: RegisterAmounts;
  employeeCount: number;
  employerContributionMinor: number;
  paid: { count: number; amountMinor: number };
  unpaid: { count: number; amountMinor: number };
}

const zero = (): RegisterAmounts =>
  Object.fromEntries(REGISTER_COLUMNS.map(([key]) => [key, 0])) as RegisterAmounts;

function column(line: Pick<PayrollLine, 'component' | 'kind'>): RegisterAmountKey {
  const name = line.component.replace(/^فرق:\s*/, '').trim();
  if (line.kind === 'deduction')
    return name === PAYROLL_COMPONENTS.insurance || name === 'تأمينات الموظف'
      ? 'insuranceMinor'
      : 'deductionsMinor';
  if (name === PAYROLL_COMPONENTS.basic || name === PAYROLL_COMPONENTS.lumpSum) return 'basicMinor';
  if (name === PAYROLL_COMPONENTS.housing) return 'housingMinor';
  if (name === PAYROLL_COMPONENTS.transport) return 'transportMinor';
  if (name === PAYROLL_COMPONENTS.other || name === 'بدلات أخرى') return 'otherAllowancesMinor';
  return 'bonusMinor';
}

/** Lines of a redacted (auditor) run carry no id; the stable pseudonym is the key then. */
const keyOf = (item: { employeeId: string; employeeName: string }) =>
  item.employeeId || `name:${item.employeeName}`;

export function buildPayrollRegister(
  run: Pick<PayrollRun, 'lines' | 'payments'> & { people?: PayrollPerson[] },
): PayrollRegister {
  const people = new Map((run.people ?? []).map((p) => [keyOf(p), p]));
  const rows = new Map<string, RegisterRow>();
  for (const line of run.lines) {
    const key = keyOf(line);
    let row = rows.get(key);
    if (!row) {
      const person = people.get(key);
      row = {
        key,
        employeeId: line.employeeId,
        employeeName: line.employeeName,
        title: person?.title ?? '',
        paymentMethod: person?.paymentMethod ?? 'unspecified',
        paymentState: 'unpaid',
        paidMinor: 0,
        employerContributionMinor: person?.employerContributionMinor ?? 0,
        insuranceCategory: person?.insuranceCategory ?? null,
        insuranceCategoryInferred: person?.insuranceCategoryInferred ?? false,
        employmentType: person?.employmentType ?? 'staff',
        ...zero(),
      };
      rows.set(key, row);
    }
    row[column(line)] += line.amountMinor;
  }
  for (const payment of run.payments) {
    const key = payment.employeeId || (payment.employeeKey ? `name:${payment.employeeKey}` : '');
    const row = key ? rows.get(key) : undefined;
    if (!row || payment.state === 'pending') continue;
    row.paymentState = payment.state;
    row.paidMinor = payment.paidMinor;
  }
  const totals = zero();
  const order: PayrollPaymentMethod[] = ['direct', 'wps', 'unspecified'];
  const groups = new Map<PayrollPaymentMethod, RegisterGroup>();
  let employerContributionMinor = 0;
  const paid = { count: 0, amountMinor: 0 };
  const unpaid = { count: 0, amountMinor: 0 };
  const sorted = [...rows.values()].sort((a, b) =>
    a.employeeName.localeCompare(b.employeeName, 'ar'),
  );
  for (const row of sorted) {
    row.grossMinor =
      row.basicMinor +
      row.housingMinor +
      row.transportMinor +
      row.otherAllowancesMinor +
      row.bonusMinor;
    row.totalDeductionsMinor = row.insuranceMinor + row.deductionsMinor;
    row.netMinor = row.grossMinor - row.totalDeductionsMinor;
    let group = groups.get(row.paymentMethod);
    if (!group) {
      group = {
        method: row.paymentMethod,
        label: PAYMENT_METHOD_LABEL[row.paymentMethod],
        rows: [],
        totals: zero(),
      };
      groups.set(row.paymentMethod, group);
    }
    group.rows.push(row);
    for (const [key] of REGISTER_COLUMNS) {
      group.totals[key] += row[key];
      totals[key] += row[key];
    }
    employerContributionMinor += row.employerContributionMinor;
    if (row.paymentState === 'paid') {
      paid.count += 1;
      paid.amountMinor += row.paidMinor;
    } else {
      unpaid.count += 1;
      paid.amountMinor += row.paidMinor;
      unpaid.amountMinor += Math.max(row.netMinor - row.paidMinor, 0);
    }
  }
  return {
    groups: order.flatMap((method) => (groups.has(method) ? [groups.get(method)!] : [])),
    totals,
    employeeCount: rows.size,
    employerContributionMinor,
    paid,
    unpaid,
  };
}

/** Plain riyal amount with two decimals and Latin digits, for exports. */
export const riyal = (minor: number) => (minor / 100).toFixed(2);

/** Header and body rows of the register in the template's column order, for CSV and Excel. */
export function registerTable(register: PayrollRegister): {
  header: string[];
  rows: (string | number)[][];
} {
  const header = [
    'م',
    'اسم الموظف',
    'المسمى الوظيفي',
    ...REGISTER_COLUMNS.map(([, label]) => label),
    'طريقة الدفع',
    'حالة الدفع',
  ];
  const rows: (string | number)[][] = [];
  let index = 0;
  for (const group of register.groups)
    for (const row of group.rows)
      rows.push([
        ++index,
        row.employeeName,
        row.title,
        ...REGISTER_COLUMNS.map(([key]) => Number(riyal(row[key]))),
        PAYMENT_METHOD_LABEL[row.paymentMethod],
        PAYMENT_STATE_LABEL[row.paymentState],
      ]);
  rows.push([
    '',
    'الإجمالي',
    '',
    ...REGISTER_COLUMNS.map(([key]) => Number(riyal(register.totals[key]))),
    '',
    '',
  ]);
  return { header, rows };
}
