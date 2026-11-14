/**
 * Accounting ledger contract for the private finance workspace.
 * All money is integer halalas. Journal entries are append-only; corrections are reversals.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalSide = 'debit' | 'credit';
/**
 * VAT treatment of a line. Sales use S, ZD, ZE, E, O. Purchases use S, ZD, E, O, IMP, RC, ND.
 * S = standard 15%; ZD = zero-rated domestic; ZE = zero-rated export; E = exempt;
 * O = outside the scope of VAT; IMP = import with VAT paid at customs;
 * RC = imported service under the reverse charge mechanism;
 * ND = standard-rated purchase whose input VAT is not deductible (cost includes the VAT).
 */
export type TaxCode = 'S' | 'ZD' | 'ZE' | 'E' | 'O' | 'IMP' | 'RC' | 'ND';
export type TaxSide = 'sales' | 'purchases';
export type TaxRole = 'base' | 'output' | 'input';
export const salesTaxCodes: readonly TaxCode[] = ['S', 'ZD', 'ZE', 'E', 'O'];
export const purchaseTaxCodes: readonly TaxCode[] = ['S', 'ND', 'RC', 'IMP', 'ZD', 'E', 'O'];
export const VAT_RATE_BPS = 1500;
export const taxCodeLabel: Record<TaxCode, string> = {
  S: 'خاضع 15٪',
  ZD: 'نسبة صفرية محلية',
  ZE: 'صادرات (نسبة صفرية)',
  E: 'معفى',
  O: 'خارج نطاق الضريبة',
  IMP: 'استيراد مسدد في الجمارك',
  RC: 'احتساب عكسي (خدمة من مورد أجنبي)',
  ND: '15٪ غير قابلة للخصم',
};
export const purchaseTaxHint: Record<TaxCode, string> = {
  S: 'فاتورة ضريبية محلية؛ تُخصم ضريبتها في الإقرار.',
  ND: 'ضريبة مدفوعة لا يجوز خصمها (مثل الضيافة والترفيه)؛ تُحمَّل على المصروف.',
  RC: 'خدمة من مورد غير مقيم بلا ضريبة في فاتورته؛ تُحتسب 15٪ مخرجات ومدخلات معًا.',
  IMP: 'بضاعة مستوردة سُددت ضريبتها للجمارك؛ أدخل مبلغ الضريبة من البيان الجمركي.',
  ZD: 'توريد محلي بنسبة صفر.',
  E: 'توريد معفى مثل إيجار سكني أو تمويل بهامش ربح.',
  O: 'لا يخضع للضريبة أصلًا: رواتب، رسوم حكومية، زكاة، غرامات.',
  ZE: '',
};

export interface LedgerAccount {
  code: string;
  name: string;
  type: AccountType;
  normalSide: NormalSide;
  parentCode: string | null;
  postable: boolean;
  isCash: boolean;
  systemKey: string | null;
  defaultTaxCode: TaxCode | null;
  active: boolean;
  version: number;
  /** Signed in the account's normal direction, over all posted entries. */
  balanceHalalas: number;
}
export interface LedgerAccountInput {
  code: string;
  name: string;
  parentCode: string;
  isCash?: boolean;
  defaultTaxCode?: TaxCode | null;
}
export interface LedgerSettings {
  version: number;
  filingFrequency: 'quarterly' | 'monthly';
  defaultRevenueAccount: string;
  defaultCashAccount: string;
  /** Largest prior-period correction accepted in box 14, halalas. */
  vatCorrectionLimitHalalas: number;
}
export interface JournalTax {
  side: TaxSide;
  code: TaxCode;
  role: TaxRole;
}
export interface JournalLineInput {
  accountCode: string;
  /** Decimal SAR strings, e.g. "1500.00". Exactly one of the two is non-zero. */
  debit: string;
  credit: string;
  memo?: string;
  tax?: JournalTax | null;
}
export interface JournalEntryInput {
  date: string;
  description: string;
  kind?: 'manual' | 'opening';
  lines: JournalLineInput[];
}
export type JournalKind =
  | 'manual'
  | 'opening'
  | 'invoice'
  | 'credit_note'
  | 'receipt'
  | 'revenue'
  | 'expense'
  | 'payment'
  | 'vat_close'
  | 'vat_payment'
  | 'reversal';
export interface JournalLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  debitHalalas: number;
  creditHalalas: number;
  memo: string;
  tax: JournalTax | null;
}
export interface JournalEntry {
  id: string;
  number: string;
  date: string;
  kind: JournalKind;
  description: string;
  totalHalalas: number;
  sourceId: string;
  reversalOf: string | null;
  reversedBy: string | null;
  createdAt: string;
  lines: JournalLine[];
}
export interface LedgerVendorInput {
  name: string;
  vatNumber: string;
  country: string;
  resident: boolean;
  notes?: string;
}
export interface LedgerVendor extends LedgerVendorInput {
  id: string;
  version: number;
  active: boolean;
  createdAt: string;
}
export type VoucherKind = 'invoice' | 'credit_note' | 'receipt' | 'revenue' | 'expense' | 'payment';
export interface LedgerVoucher {
  id: string;
  kind: VoucherKind;
  number: string;
  date: string;
  accountCode: string | null;
  cashAccountCode: string | null;
  partyId: string | null;
  partyName: string;
  relatedId: string | null;
  taxCode: TaxCode | null;
  netHalalas: number;
  vatHalalas: number;
  totalHalalas: number;
  /** Receipts, payments and credit notes already applied against this document. */
  settledHalalas: number;
  outstandingHalalas: number;
  entryId: string;
  entryNumber: string;
  status: 'posted' | 'reversed';
  description: string;
  reference: string;
  dueDate: string;
  version: number;
  createdAt: string;
}
export interface RevenueInput {
  date: string;
  description: string;
  accountCode: string;
  taxCode: TaxCode;
  /** Net of VAT, decimal SAR string. */
  net: string;
  cashAccountCode: string;
  customerName?: string;
  /** Number of the tax invoice issued for this supply; required for taxable revenue. */
  reference?: string;
}
export interface ExpenseInput {
  date: string;
  description: string;
  accountCode: string;
  taxCode: TaxCode;
  net: string;
  /** Optional VAT as printed on the supplier invoice; defaults to 15% of net. */
  vat?: string;
  /** A cash/bank account code, or empty to record the amount as payable to the vendor. */
  cashAccountCode: string;
  vendorId?: string;
  reference?: string;
  dueDate?: string;
}
export interface InvoicePostingInput {
  revenueAccountCode: string;
  /** VAT treatment for 0% lines on a standard or simplified invoice. */
  zeroLinesTaxCode?: TaxCode;
}
export interface SettlementInput {
  date: string;
  amount: string;
  cashAccountCode: string;
  reference?: string;
}
export interface CreditNoteInput {
  date: string;
  net: string;
  portion?: 'taxable' | 'zero';
  reason: string;
}
export interface InvoiceLedgerState {
  invoiceId: string;
  number: string;
  title: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  documentType: string;
  status: string;
  subtotalHalalas: number;
  taxHalalas: number;
  totalHalalas: number;
  hasZeroLines: boolean;
  hasTaxableLines: boolean;
  voucher: LedgerVoucher | null;
}
export interface VatBox {
  box: number;
  label: string;
  amountHalalas: number;
  adjustmentHalalas: number;
  vatHalalas: number;
}
export interface VatComputation {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  boxes: VatBox[];
  outputVatHalalas: number;
  inputVatHalalas: number;
  /** Box 13: output VAT minus deductible input VAT for the period. */
  currentPeriodHalalas: number;
  correctionHalalas: number;
  creditBroughtForwardHalalas: number;
  /** Box 16. Positive is payable to ZATCA; negative is a credit to carry forward or reclaim. */
  netDueHalalas: number;
  /** Ledger movement on the VAT control accounts that the boxes do not explain; must be zero. */
  unexplainedOutputHalalas: number;
  unexplainedInputHalalas: number;
  warnings: string[];
}
export interface VatReturn extends VatComputation {
  id: string;
  status: 'closed' | 'filed' | 'paid';
  correctionNote: string;
  closingEntryId: string | null;
  paymentEntryId: string | null;
  filedAt: string | null;
  filingReference: string;
  version: number;
  closedAt: string;
}
export interface VatPeriodSummary {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  label: string;
  status: 'open' | 'closed' | 'filed' | 'paid';
  netDueHalalas: number | null;
  returnId: string | null;
}
export interface TrialBalanceRow {
  code: string;
  name: string;
  type: AccountType;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
}
export interface StatementLine {
  code: string;
  name: string;
  amountHalalas: number;
}
export interface StatementSection {
  key: string;
  title: string;
  lines: StatementLine[];
  totalHalalas: number;
}
export interface IncomeStatement {
  from: string;
  to: string;
  sections: StatementSection[];
  revenueHalalas: number;
  expenseHalalas: number;
  netProfitHalalas: number;
}
export interface BalanceSheet {
  asOf: string;
  sections: StatementSection[];
  assetsHalalas: number;
  liabilitiesHalalas: number;
  equityHalalas: number;
  balanced: boolean;
}
export interface AccountStatement {
  account: LedgerAccount;
  from: string;
  to: string;
  openingHalalas: number;
  closingHalalas: number;
  rows: {
    entryId: string;
    entryNumber: string;
    date: string;
    description: string;
    memo: string;
    debitHalalas: number;
    creditHalalas: number;
    balanceHalalas: number;
  }[];
}
export interface AgingRow {
  voucherId: string;
  number: string;
  partyName: string;
  date: string;
  dueDate: string;
  outstandingHalalas: number;
  daysOverdue: number;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
}
export interface BudgetLine {
  accountCode: string;
  accountName: string;
  type: AccountType;
  /** Twelve monthly amounts, January first. */
  budget: number[];
  actual: number[];
}
export interface BudgetReport {
  year: number;
  version: number;
  lines: BudgetLine[];
}
export interface BudgetInput {
  version: number;
  lines: { accountCode: string; months: string[] }[];
}
export interface PeriodLock {
  year: number;
  month: number;
  locked: boolean;
  reason: 'manual' | 'vat';
}
export interface LedgerDashboard {
  today: string;
  monthRevenueHalalas: number;
  monthExpenseHalalas: number;
  yearRevenueHalalas: number;
  yearExpenseHalalas: number;
  cashHalalas: number;
  receivablesHalalas: number;
  payablesHalalas: number;
  /** Net balance of the VAT control accounts; positive is owed to ZATCA. */
  vatPositionHalalas: number;
  monthly: { month: string; revenueHalalas: number; expenseHalalas: number }[];
  topExpenses: StatementLine[];
  currentVatPeriod: VatPeriodSummary;
  overdueVatPeriods: VatPeriodSummary[];
  unpostedInvoices: number;
  overdueReceivablesHalalas: number;
  /** True when every entry balances and total debits equal total credits. */
  booksBalanced: boolean;
}
export interface LedgerOverview {
  initialized: boolean;
  settings: LedgerSettings;
  accounts: LedgerAccount[];
  vendors: LedgerVendor[];
  locks: PeriodLock[];
  dashboard: LedgerDashboard | null;
}

export interface ChartSeedAccount {
  code: string;
  name: string;
  type: AccountType;
  normalSide: NormalSide;
  postable?: boolean;
  isCash?: boolean;
  systemKey?: string;
  defaultTaxCode?: TaxCode;
}
const seed = (
  type: AccountType,
  normalSide: NormalSide,
  rows: [string, string, Partial<ChartSeedAccount>?][],
): ChartSeedAccount[] =>
  rows.map(([code, name, extra]) => ({ code, name, type, normalSide, ...extra }));
const group = { postable: false };
/**
 * Suggested chart for a digital newspaper. A proposal for the accountant to adjust,
 * not a mandated chart: SOCPA does not issue a compulsory chart of accounts.
 */
export const defaultChart: readonly ChartSeedAccount[] = [
  ...seed('asset', 'debit', [
    ['1', 'الأصول', group],
    ['11', 'الأصول المتداولة', group],
    ['1101', 'الصندوق (النقدية)', { isCash: true }],
    ['1102', 'البنك – الحساب الجاري', { isCash: true }],
    ['1103', 'بوابات الدفع – مبالغ قيد التحصيل', { isCash: true }],
    ['1110', 'العملاء (ذمم مدينة)', { systemKey: 'receivable' }],
    ['1120', 'ضريبة القيمة المضافة – مدخلات قابلة للخصم', { systemKey: 'vat_input' }],
    ['1130', 'مصروفات مدفوعة مقدمًا'],
    ['1140', 'سلف وعُهد الموظفين'],
    ['12', 'الأصول غير المتداولة', group],
    ['1201', 'معدات تصوير وبث واستوديو', { defaultTaxCode: 'S' }],
    ['1202', 'أجهزة حاسب وخوادم', { defaultTaxCode: 'S' }],
    ['1203', 'أثاث وتجهيزات مكتبية', { defaultTaxCode: 'S' }],
    ['1210', 'أصول غير ملموسة (الموقع والتطبيق والبرمجيات)', { defaultTaxCode: 'S' }],
  ]),
  { code: '1290', name: 'مجمع الإهلاك والإطفاء', type: 'asset', normalSide: 'credit' },
  ...seed('liability', 'credit', [
    ['2', 'الخصوم', group],
    ['21', 'الخصوم المتداولة', group],
    ['2101', 'الموردون (ذمم دائنة)', { systemKey: 'payable' }],
    ['2110', 'ضريبة القيمة المضافة – مخرجات', { systemKey: 'vat_output' }],
    ['2111', 'تسوية ضريبة القيمة المضافة مع الهيئة', { systemKey: 'vat_settlement' }],
    ['2120', 'رواتب مستحقة'],
    ['2121', 'التأمينات الاجتماعية المستحقة'],
    ['2130', 'مصروفات مستحقة'],
    ['2140', 'إيرادات مقدمة (غير مكتسبة)'],
    ['2150', 'الزكاة المستحقة'],
    ['22', 'الخصوم غير المتداولة', group],
    ['2201', 'مخصص مكافأة نهاية الخدمة'],
  ]),
  ...seed('equity', 'credit', [
    ['3', 'حقوق الملكية', group],
    ['3101', 'رأس المال'],
    ['3201', 'الاحتياطيات'],
    ['3301', 'الأرباح المبقاة', { systemKey: 'retained_earnings' }],
    ['3401', 'جاري الشركاء أو المالك'],
    ['3901', 'أرصدة افتتاحية', { systemKey: 'opening_balance' }],
  ]),
  ...seed('revenue', 'credit', [
    ['4', 'الإيرادات', group],
    ['41', 'إيرادات النشاط', group],
    ['4101', 'إيرادات الإعلانات الرقمية'],
    ['4102', 'إيرادات المحتوى المدعوم (الإعلاني)'],
    ['4103', 'إيرادات الرعايات والفعاليات'],
    ['4104', 'إيرادات خدمات الإنتاج (فيديو وتصميم وإنفوجرافيك)'],
    ['4105', 'إيرادات ترخيص المحتوى والاشتراكات'],
    ['4190', 'إيرادات أخرى'],
    ['49', 'مردودات وخصومات', group],
  ]),
  {
    code: '4910',
    name: 'مردودات وخصومات المبيعات',
    type: 'revenue',
    normalSide: 'debit',
    systemKey: 'sales_returns',
  },
  ...seed('expense', 'debit', [
    ['5', 'المصروفات', group],
    ['51', 'تكاليف المحتوى', group],
    ['5101', 'مكافآت الكتّاب والمراسلين المتعاونين', { defaultTaxCode: 'O' }],
    ['5102', 'الإنتاج والتصوير', { defaultTaxCode: 'S' }],
    ['5103', 'اشتراكات وكالات الأنباء والصور', { defaultTaxCode: 'S' }],
    ['5104', 'الاستضافة والخدمات السحابية', { defaultTaxCode: 'RC' }],
    ['5105', 'الترويج والإعلان المدفوع', { defaultTaxCode: 'RC' }],
    ['52', 'تكاليف الموظفين', group],
    ['5201', 'الرواتب الأساسية', { defaultTaxCode: 'O' }],
    ['5202', 'البدلات (سكن ونقل وغيرها)', { defaultTaxCode: 'O' }],
    ['5203', 'التأمينات الاجتماعية – حصة المنشأة', { defaultTaxCode: 'O' }],
    ['5204', 'مكافأة نهاية الخدمة', { defaultTaxCode: 'O' }],
    ['5205', 'التأمين الطبي', { defaultTaxCode: 'S' }],
    ['5206', 'الرسوم الحكومية (إقامات ورخص عمل)', { defaultTaxCode: 'O' }],
    ['53', 'المصروفات الإدارية والعمومية', group],
    ['5301', 'الإيجار', { defaultTaxCode: 'S' }],
    ['5302', 'الكهرباء والمياه والاتصالات', { defaultTaxCode: 'S' }],
    ['5303', 'البرمجيات والاشتراكات', { defaultTaxCode: 'RC' }],
    ['5304', 'الأتعاب المهنية (محاسبة ومراجعة ومحاماة)', { defaultTaxCode: 'S' }],
    ['5305', 'السفر والانتقالات', { defaultTaxCode: 'S' }],
    ['5306', 'الضيافة والترفيه', { defaultTaxCode: 'ND' }],
    ['5307', 'الرسوم والعمولات البنكية', { defaultTaxCode: 'S' }],
    ['5308', 'الإهلاك والإطفاء', { defaultTaxCode: 'O' }],
    ['5309', 'القرطاسية والمستلزمات المكتبية', { defaultTaxCode: 'S' }],
    ['5390', 'فروقات وتسويات ضريبية', { systemKey: 'vat_adjustments', defaultTaxCode: 'O' }],
    ['59', 'الزكاة', group],
    ['5901', 'الزكاة', { defaultTaxCode: 'O' }],
  ]),
];

// Every mutation requires Idempotency-Key and the explicitly granted finance account.
// GET   /api/finance/ledger -> LedgerOverview
// POST  /api/finance/ledger/setup {} -> LedgerOverview (creates the suggested chart once)
// PATCH /api/finance/ledger/settings {version,...} -> {settings}
// POST  /api/finance/ledger/accounts LedgerAccountInput ; PATCH /accounts/:code {version,name,active,...}
// POST  /api/finance/ledger/vendors ; PATCH /vendors/:id
// GET   /api/finance/ledger/entries?from&to&account -> {entries: JournalEntry[]}
// POST  /api/finance/ledger/entries JournalEntryInput -> {entry}
// POST  /api/finance/ledger/entries/:id/reverse {date,reason} -> {entry} (manual and opening entries)
// GET   /api/finance/ledger/vouchers?kind -> {vouchers: LedgerVoucher[]}
// GET   /api/finance/ledger/invoices -> {invoices: InvoiceLedgerState[]}
// POST  /api/finance/ledger/invoices/:id/post InvoicePostingInput -> {voucher}
// POST  /api/finance/ledger/invoices/:id/receipts SettlementInput -> {voucher}
// POST  /api/finance/ledger/invoices/:id/credit-notes CreditNoteInput -> {voucher}
// POST  /api/finance/ledger/revenues RevenueInput -> {voucher}
// POST  /api/finance/ledger/expenses ExpenseInput -> {voucher}
// POST  /api/finance/ledger/expenses/:id/payments SettlementInput -> {voucher}
// POST  /api/finance/ledger/vouchers/:id/reverse {version,date,reason} -> {voucher}
// GET   /api/finance/ledger/reports/trial-balance?from&to ; income-statement?from&to ;
//       balance-sheet?asOf ; account/:code?from&to ; aging?asOf&side ; budget?year
// PATCH /api/finance/ledger/budgets/:year BudgetInput -> BudgetReport
// POST  /api/finance/ledger/periods {year,month,locked} -> {locks}
// GET   /api/finance/ledger/vat?start -> {periods, computation, returns}
// POST  /api/finance/ledger/vat/close {periodStart,correction,correctionNote} -> {return}
// POST  /api/finance/ledger/vat/:id/file {version,filedAt,reference} -> {return}
// POST  /api/finance/ledger/vat/:id/pay {version,date,cashAccountCode} -> {return}
