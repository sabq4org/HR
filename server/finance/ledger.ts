/**
 * Double-entry ledger core. postEntry is the only writer of journal rows: it enforces
 * balance, open periods and postable accounts inside the caller's transaction.
 */
import type { FinanceInvoice } from '../../shared/finance.js';
import {
  defaultChart,
  purchaseTaxCodes,
  salesTaxCodes,
  VAT_RATE_BPS,
  type AccountStatement,
  type AgingRow,
  type BalanceSheet,
  type BudgetReport,
  type CustomerStatement,
  type CustomerStatementRow,
  type IncomeStatement,
  type InvoiceLedgerState,
  type JournalEntry,
  type JournalKind,
  type JournalTax,
  type LedgerAccount,
  type LedgerDashboard,
  type LedgerSettings,
  type LedgerVendor,
  type LedgerVendorInput,
  type LedgerVoucher,
  type PeriodLock,
  type StatementSection,
  type TaxCode,
  type TrialBalanceRow,
  type VatBox,
  type VatComputation,
  type VatPeriodSummary,
  type VatReturn,
  type VoucherKind,
} from '../../shared/ledger.js';
import { todayInRiyadh, type AsyncDb } from '../database.js';
import { decryptSensitive, encryptSensitive } from '../administration/security.js';
import type { Actor } from '../administration/service.js';
import { newId } from '../administration/common.js';
import { fault } from '../administration/validation.js';
import { audited, dateValue, now, safeJson, type InvoiceRow } from './routes.js';

export const n = (value: unknown): number => Number(value ?? 0);
const MAX = Number.MAX_SAFE_INTEGER;

/** Parses a non-negative SAR decimal string into halalas. */
export function halalas(value: unknown, code = 'INVALID_AMOUNT'): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(value.trim()))
    throw fault(400, code, 'أدخل مبلغًا صحيحًا بخانتين عشريتين على الأكثر.');
  const [whole, fraction = ''] = value.trim().split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}
export const vatOf = (net: number) => Math.floor((net * VAT_RATE_BPS + 5000) / 10000);

type AccountRow = {
  code: string;
  name: string;
  type: LedgerAccount['type'];
  normal_side: 'debit' | 'credit';
  parent_code: string | null;
  postable: number;
  is_cash: number;
  system_key: string | null;
  default_tax_code: TaxCode | null;
  active: number;
  version: number;
};
const flag = (value: unknown) => value === true || Number(value) === 1;
const account = (row: AccountRow, balance = 0): LedgerAccount => ({
  code: row.code,
  name: row.name,
  type: row.type,
  normalSide: row.normal_side,
  parentCode: row.parent_code,
  postable: flag(row.postable),
  isCash: flag(row.is_cash),
  systemKey: row.system_key,
  defaultTaxCode: row.default_tax_code,
  active: flag(row.active),
  version: n(row.version),
  balanceHalalas: balance,
});

export async function accountRows(db: AsyncDb, ownerId: string): Promise<Map<string, AccountRow>> {
  const rows = await db.read<AccountRow>(
    'SELECT * FROM finance_accounts WHERE owner_id=? ORDER BY code',
    [ownerId],
  );
  return new Map(rows.map((row) => [row.code, row]));
}
export async function systemAccount(db: AsyncDb, ownerId: string, key: string): Promise<string> {
  const row = (
    await db.read<{ code: string }>(
      'SELECT code FROM finance_accounts WHERE owner_id=? AND system_key=?',
      [ownerId, key],
    )
  )[0];
  if (!row) throw fault(409, 'LEDGER_NOT_INITIALIZED', 'هيّئ دليل الحسابات أولًا من صفحة الحسابات.');
  return row.code;
}
type Totals = Map<string, { debit: number; credit: number }>;
/** Debit and credit totals per account for entries dated within [from, to]. */
export async function totals(
  db: AsyncDb,
  ownerId: string,
  range: { from?: string; to?: string } = {},
): Promise<Totals> {
  const where = ['l.owner_id=?'];
  const params: unknown[] = [ownerId];
  if (range.from) {
    where.push('e.entry_date>=?');
    params.push(range.from);
  }
  if (range.to) {
    where.push('e.entry_date<=?');
    params.push(range.to);
  }
  const rows = await db.read<{ code: string; d: unknown; c: unknown }>(
    `SELECT l.account_code AS code, SUM(l.debit) AS d, SUM(l.credit) AS c
     FROM finance_journal_lines l JOIN finance_journal_entries e ON e.owner_id=l.owner_id AND e.id=l.entry_id
     WHERE ${where.join(' AND ')} GROUP BY l.account_code`,
    params,
  );
  return new Map(rows.map((row) => [row.code, { debit: n(row.d), credit: n(row.c) }]));
}
const signed = (row: AccountRow, t?: { debit: number; credit: number }) =>
  !t ? 0 : row.normal_side === 'debit' ? t.debit - t.credit : t.credit - t.debit;

export async function listAccounts(db: AsyncDb, ownerId: string): Promise<LedgerAccount[]> {
  const rows = await accountRows(db, ownerId),
    sums = await totals(db, ownerId);
  return [...rows.values()].map((row) => account(row, signed(row, sums.get(row.code))));
}

export async function ledgerSettings(db: AsyncDb, ownerId: string): Promise<LedgerSettings> {
  const row = (
    await db.read<{
      version: number;
      filing_frequency: 'quarterly' | 'monthly';
      default_revenue_account: string;
      default_cash_account: string;
      vat_correction_limit: unknown;
    }>('SELECT * FROM finance_ledger_settings WHERE owner_id=?', [ownerId])
  )[0];
  return {
    version: n(row?.version ?? 1),
    filingFrequency: row?.filing_frequency ?? 'quarterly',
    defaultRevenueAccount: row?.default_revenue_account ?? '',
    defaultCashAccount: row?.default_cash_account ?? '',
    vatCorrectionLimitHalalas: n(row?.vat_correction_limit ?? 0),
  };
}
export async function isInitialized(db: AsyncDb, ownerId: string): Promise<boolean> {
  return (
    (
      await db.read<{ owner_id: string }>(
        'SELECT owner_id FROM finance_ledger_settings WHERE owner_id=?',
        [ownerId],
      )
    ).length > 0
  );
}
/** Creates the suggested chart and default settings. Explicit, once, never automatic. */
export async function setupLedger(tx: AsyncDb, actor: Actor): Promise<void> {
  if (await isInitialized(tx, actor.id))
    throw fault(409, 'LEDGER_ALREADY_INITIALIZED', 'دليل الحسابات مهيأ من قبل.');
  const at = now();
  for (const item of defaultChart) {
    const parent = item.code.length > 1 ? item.code.slice(0, item.code.length === 2 ? 1 : 2) : null;
    await tx.execute(
      'INSERT INTO finance_accounts(owner_id,code,name,type,normal_side,parent_code,postable,is_cash,system_key,default_tax_code,active,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,1,?,?)',
      [
        actor.id,
        item.code,
        item.name,
        item.type,
        item.normalSide,
        parent,
        item.postable === false ? 0 : 1,
        item.isCash ? 1 : 0,
        item.systemKey ?? null,
        item.defaultTaxCode ?? null,
        at,
        at,
      ],
    );
  }
  await tx.execute(
    "INSERT INTO finance_ledger_settings(owner_id,version,filing_frequency,default_revenue_account,default_cash_account,vat_correction_limit,created_at,updated_at) VALUES(?,1,'quarterly','4101','1102',1500000,?,?)",
    [actor.id, at, at],
  );
  await audited(tx, actor, 'finance_ledger', actor.id, 'chart_initialized', 1);
}

// ---------------------------------------------------------------- periods
const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
export function vatPeriod(date: string, frequency: 'quarterly' | 'monthly') {
  const year = Number(date.slice(0, 4)),
    month = Number(date.slice(5, 7));
  const first = frequency === 'monthly' ? month : month - ((month - 1) % 3);
  const last = frequency === 'monthly' ? month : first + 2;
  const dueYear = last === 12 ? year + 1 : year,
    dueMonth = last === 12 ? 1 : last + 1;
  return {
    periodStart: `${year}-${pad(first)}-01`,
    periodEnd: `${year}-${pad(last)}-${pad(lastDay(year, last))}`,
    // Art. 74 of the VAT Implementing Regulations: the due date does not move for weekends.
    dueDate: `${dueYear}-${pad(dueMonth)}-${pad(lastDay(dueYear, dueMonth))}`,
    label:
      frequency === 'monthly'
        ? `${year}-${pad(month)}`
        : `الربع ${['الأول', 'الثاني', 'الثالث', 'الرابع'][(first - 1) / 3]} ${year}`,
  };
}
export async function locks(db: AsyncDb, ownerId: string): Promise<PeriodLock[]> {
  const rows = await db.read<{ year: number; month: number; locked: number; reason: string }>(
    'SELECT year,month,locked,reason FROM finance_period_locks WHERE owner_id=? ORDER BY year,month',
    [ownerId],
  );
  return rows
    .filter((row) => flag(row.locked))
    .map((row) => ({
      year: n(row.year),
      month: n(row.month),
      locked: true,
      reason: row.reason === 'vat' ? 'vat' : 'manual',
    }));
}
export async function setLock(
  tx: AsyncDb,
  actor: Actor,
  year: number,
  month: number,
  locked: boolean,
  reason: 'manual' | 'vat',
) {
  await tx.execute(
    'INSERT INTO finance_period_locks(owner_id,year,month,locked,reason,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,year,month) DO UPDATE SET locked=excluded.locked,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    [actor.id, year, month, locked ? 1 : 0, reason, actor.id, now()],
  );
}
async function assertOpen(tx: AsyncDb, ownerId: string, date: string) {
  const row = (
    await tx.read<{ locked: number }>(
      'SELECT locked FROM finance_period_locks WHERE owner_id=? AND year=? AND month=?',
      [ownerId, Number(date.slice(0, 4)), Number(date.slice(5, 7))],
    )
  )[0];
  if (row && flag(row.locked))
    throw fault(
      409,
      'PERIOD_LOCKED',
      `الفترة ${date.slice(0, 7)} مقفلة؛ سجّل الحركة بتاريخ في فترة مفتوحة.`,
    );
}

// ---------------------------------------------------------------- journal
export type PostLine = {
  accountCode: string;
  debit: number;
  credit: number;
  memo?: string;
  tax?: JournalTax | null;
};
export type PostInput = {
  date: string;
  kind: JournalKind;
  sourceId?: string;
  description: string;
  lines: PostLine[];
  reversalOf?: string;
  originalDate?: string;
  /** Closing a VAT period posts on its last day just before locking it. */
  allowInactive?: boolean;
};
async function sequence(tx: AsyncDb, sql: string, params: unknown[]): Promise<string> {
  const count = n((await tx.read<{ c: unknown }>(sql, params))[0]?.c);
  if (count >= 999999) throw fault(409, 'NUMBER_SEQUENCE_EXHAUSTED', 'وصل الترقيم إلى حده.');
  return String(count + 1).padStart(6, '0');
}
const vatKeys = new Set(['vat_input', 'vat_output', 'vat_settlement']);
export async function postEntry(
  tx: AsyncDb,
  actor: Actor,
  input: PostInput,
): Promise<{ id: string; number: string }> {
  const date = dateValue(input.date);
  await assertOpen(tx, actor.id, date);
  const lines = input.lines.filter((line) => line.debit !== 0 || line.credit !== 0);
  if (lines.length < 2) throw fault(400, 'ENTRY_LINES_REQUIRED', 'القيد يحتاج طرفين على الأقل.');
  const accounts = await accountRows(tx, actor.id);
  // A closed return froze its carry-forward: no VAT movement may be backdated to before its end,
  // even into a month that no return covers and nobody locked.
  if (
    input.kind !== 'vat_close' &&
    input.kind !== 'vat_payment' &&
    lines.some(
      (line) =>
        // Out-of-scope and non-deductible bases never reach a box of the return.
        (line.tax && line.tax.code !== 'O' && line.tax.code !== 'ND') ||
        vatKeys.has(accounts.get(line.accountCode)?.system_key ?? ''),
    )
  ) {
    const last = (
      await tx.read<{ d: string | null }>(
        'SELECT MAX(period_end) AS d FROM finance_vat_returns WHERE owner_id=?',
        [actor.id],
      )
    )[0]?.d;
    if (last && date <= last)
      throw fault(
        409,
        'VAT_PERIOD_CLOSED',
        `أُقفل إقرار ضريبي حتى ${last}؛ لا تُسجَّل حركة ضريبية بتاريخ يسبقه. سجّلها في الفترة المفتوحة أو صحّحها في الخانة 14.`,
      );
  }
  let debit = 0,
    credit = 0;
  for (const line of lines) {
    const row = accounts.get(line.accountCode);
    if (!row) throw fault(400, 'ACCOUNT_NOT_FOUND', `الحساب ${line.accountCode} غير موجود.`);
    if (!flag(row.postable))
      throw fault(400, 'ACCOUNT_NOT_POSTABLE', `الحساب ${row.code} حساب تجميعي لا يقبل الترحيل.`);
    if (!flag(row.active) && !input.allowInactive)
      throw fault(400, 'ACCOUNT_INACTIVE', `الحساب ${row.code} موقوف.`);
    if (
      !Number.isSafeInteger(line.debit) ||
      !Number.isSafeInteger(line.credit) ||
      line.debit < 0 ||
      line.credit < 0 ||
      (line.debit > 0 && line.credit > 0)
    )
      throw fault(400, 'INVALID_ENTRY_LINE', 'كل سطر يكون مدينًا أو دائنًا بمبلغ موجب.');
    debit += line.debit;
    credit += line.credit;
  }
  if (debit !== credit)
    throw fault(400, 'ENTRY_UNBALANCED', 'القيد غير متوازن: مجموع المدين لا يساوي مجموع الدائن.');
  if (debit <= 0 || debit > MAX) throw fault(400, 'INVALID_AMOUNT', 'مبلغ القيد غير صالح.');
  const id = newId(),
    year = date.slice(0, 4);
  const number = `JE-${year}-${await sequence(
    tx,
    'SELECT COUNT(*) AS c FROM finance_journal_entries WHERE owner_id=? AND entry_no LIKE ?',
    [actor.id, `JE-${year}-%`],
  )}`;
  await tx.execute(
    'INSERT INTO finance_journal_entries(id,owner_id,entry_no,entry_date,kind,source_id,reversal_of,original_date,description_ciphertext,total,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      actor.id,
      number,
      date,
      input.kind,
      input.sourceId ?? id,
      input.reversalOf ?? null,
      input.originalDate ?? null,
      encryptSensitive(input.description, `finance:journal:${id}`),
      debit,
      actor.id,
      now(),
    ],
  );
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    const lineId = newId();
    await tx.execute(
      'INSERT INTO finance_journal_lines(id,owner_id,entry_id,line_no,account_code,debit,credit,tax_side,tax_code,tax_role,memo_ciphertext) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [
        lineId,
        actor.id,
        id,
        lineNo,
        line.accountCode,
        line.debit,
        line.credit,
        line.tax?.side ?? null,
        line.tax?.code ?? null,
        line.tax?.role ?? null,
        line.memo ? encryptSensitive(line.memo, `finance:journal-line:${lineId}`) : null,
      ],
    );
  }
  await audited(tx, actor, 'finance_journal_entry', id, `posted_${input.kind}`, 1);
  return { id, number };
}
type EntryRow = {
  id: string;
  entry_no: string;
  entry_date: string;
  kind: JournalKind;
  source_id: string;
  reversal_of: string | null;
  description_ciphertext: string;
  total: unknown;
  created_at: string;
};
type LineRow = {
  id: string;
  entry_id: string;
  line_no: number;
  account_code: string;
  debit: unknown;
  credit: unknown;
  tax_side: JournalTax['side'] | null;
  tax_code: TaxCode | null;
  tax_role: JournalTax['role'] | null;
  memo_ciphertext: string | null;
};
const plain = (ciphertext: string | null, context: string) => {
  if (!ciphertext) return '';
  try {
    return decryptSensitive(ciphertext, context);
  } catch {
    throw fault(500, 'FINANCE_DATA_INVALID', 'تعذر قراءة بيانات القيد.');
  }
};
async function hydrate(db: AsyncDb, ownerId: string, rows: EntryRow[]): Promise<JournalEntry[]> {
  if (!rows.length) return [];
  const marks = rows.map(() => '?').join(','),
    ids = rows.map((row) => row.id);
  const lines = await db.read<LineRow>(
    `SELECT * FROM finance_journal_lines WHERE owner_id=? AND entry_id IN (${marks}) ORDER BY line_no`,
    [ownerId, ...ids],
  );
  const reversals = await db.read<{ id: string; reversal_of: string }>(
    `SELECT id,reversal_of FROM finance_journal_entries WHERE owner_id=? AND reversal_of IN (${marks})`,
    [ownerId, ...ids],
  );
  const reversedBy = new Map(reversals.map((row) => [row.reversal_of, row.id]));
  const accounts = await accountRows(db, ownerId);
  return rows.map((row) => ({
    id: row.id,
    number: row.entry_no,
    date: row.entry_date,
    kind: row.kind,
    description: plain(row.description_ciphertext, `finance:journal:${row.id}`),
    totalHalalas: n(row.total),
    sourceId: row.source_id,
    reversalOf: row.reversal_of,
    reversedBy: reversedBy.get(row.id) ?? null,
    createdAt: row.created_at,
    lines: lines
      .filter((line) => line.entry_id === row.id)
      .map((line) => ({
        lineNo: n(line.line_no),
        accountCode: line.account_code,
        accountName: accounts.get(line.account_code)?.name ?? '',
        debitHalalas: n(line.debit),
        creditHalalas: n(line.credit),
        memo: plain(line.memo_ciphertext, `finance:journal-line:${line.id}`),
        tax:
          line.tax_side && line.tax_code && line.tax_role
            ? { side: line.tax_side, code: line.tax_code, role: line.tax_role }
            : null,
      })),
  }));
}
export async function listEntries(
  db: AsyncDb,
  ownerId: string,
  filter: { from?: string; to?: string; account?: string } = {},
): Promise<JournalEntry[]> {
  const where = ['e.owner_id=?'];
  const params: unknown[] = [ownerId];
  if (filter.from) {
    where.push('e.entry_date>=?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('e.entry_date<=?');
    params.push(filter.to);
  }
  if (filter.account) {
    where.push(
      'EXISTS (SELECT 1 FROM finance_journal_lines l WHERE l.owner_id=e.owner_id AND l.entry_id=e.id AND l.account_code=?)',
    );
    params.push(filter.account);
  }
  const rows = await db.read<EntryRow>(
    `SELECT e.* FROM finance_journal_entries e WHERE ${where.join(' AND ')} ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT 500`,
    params,
  );
  return hydrate(db, ownerId, rows);
}
export async function readEntry(db: AsyncDb, ownerId: string, id: string): Promise<JournalEntry> {
  const rows = await db.read<EntryRow>(
    'SELECT * FROM finance_journal_entries WHERE owner_id=? AND id=?',
    [ownerId, id],
  );
  const entry = (await hydrate(db, ownerId, rows))[0];
  if (!entry) throw fault(404, 'ENTRY_NOT_FOUND', 'القيد غير موجود.');
  return entry;
}
/** Posts the mirror image of an entry. The unique (kind, source) index blocks a second reversal. */
export async function reverseEntry(
  tx: AsyncDb,
  actor: Actor,
  entryId: string,
  date: string,
  reason: string,
): Promise<{ id: string; number: string }> {
  const original = await readEntry(tx, actor.id, entryId);
  if (original.reversedBy) throw fault(409, 'ENTRY_ALREADY_REVERSED', 'سبق عكس هذا القيد.');
  if (original.kind === 'reversal')
    throw fault(409, 'ENTRY_NOT_REVERSIBLE', 'القيد العكسي لا يُعكس؛ سجّل قيدًا جديدًا.');
  if (date < original.date)
    throw fault(400, 'INVALID_DATE_RANGE', 'تاريخ القيد العكسي لا يسبق تاريخ القيد الأصلي.');
  return postEntry(tx, actor, {
    date,
    kind: 'reversal',
    sourceId: original.id,
    reversalOf: original.id,
    originalDate: original.date,
    description: `عكس القيد ${original.number}: ${reason}`,
    allowInactive: true,
    lines: original.lines.map((line) => ({
      accountCode: line.accountCode,
      debit: line.creditHalalas,
      credit: line.debitHalalas,
      memo: line.memo,
      tax: line.tax,
    })),
  });
}

// ---------------------------------------------------------------- vendors
type VendorRow = {
  id: string;
  version: number;
  vendor_ciphertext: string;
  resident: number;
  active: number;
  created_at: string;
};
const vendor = (row: VendorRow): LedgerVendor => ({
  ...safeJson<LedgerVendorInput>(row.vendor_ciphertext, `finance:vendor:${row.id}`),
  id: row.id,
  version: n(row.version),
  resident: flag(row.resident),
  active: flag(row.active),
  createdAt: row.created_at,
});
export async function listVendors(db: AsyncDb, ownerId: string): Promise<LedgerVendor[]> {
  return (
    await db.read<VendorRow>(
      'SELECT * FROM finance_vendors WHERE owner_id=? ORDER BY created_at DESC',
      [ownerId],
    )
  ).map(vendor);
}
export async function readVendor(db: AsyncDb, ownerId: string, id: string): Promise<LedgerVendor> {
  const row = (
    await db.read<VendorRow>('SELECT * FROM finance_vendors WHERE owner_id=? AND id=?', [
      ownerId,
      id,
    ])
  )[0];
  if (!row) throw fault(404, 'VENDOR_NOT_FOUND', 'المورد غير موجود.');
  return vendor(row);
}

// ---------------------------------------------------------------- vouchers
type VoucherRow = {
  id: string;
  kind: VoucherKind;
  number: string;
  doc_date: string;
  account_code: string | null;
  cash_account_code: string | null;
  party_id: string | null;
  related_id: string | null;
  tax_code: TaxCode | null;
  net: unknown;
  vat: unknown;
  total: unknown;
  entry_id: string;
  status: 'posted' | 'reversed';
  details_ciphertext: string;
  version: number;
  created_at: string;
  entry_no?: string;
};
export type VoucherDetails = {
  description: string;
  reference?: string;
  partyName?: string;
  dueDate?: string;
  taxableNet?: number;
  zeroNet?: number;
  zeroCode?: TaxCode;
  portion?: 'taxable' | 'zero';
};
const voucherPrefix: Record<VoucherKind, string> = {
  invoice: 'SI',
  credit_note: 'CN',
  receipt: 'RC',
  revenue: 'RV',
  expense: 'EX',
  payment: 'PV',
};
export const voucherDetails = (row: { id: string; details_ciphertext: string }) =>
  safeJson<VoucherDetails>(row.details_ciphertext, `finance:voucher:${row.id}`);
async function settledMap(db: AsyncDb, ownerId: string): Promise<Map<string, number>> {
  const rows = await db.read<{ related_id: string; s: unknown }>(
    "SELECT related_id, SUM(total) AS s FROM finance_vouchers WHERE owner_id=? AND status='posted' AND kind IN ('receipt','credit_note','payment') AND related_id IS NOT NULL GROUP BY related_id",
    [ownerId],
  );
  return new Map(rows.map((row) => [row.related_id, n(row.s)]));
}
function voucher(row: VoucherRow, settled: Map<string, number>): LedgerVoucher {
  const details = voucherDetails(row),
    total = n(row.total);
  // Only documents that carry a balance settle: posted invoices and expenses bought on credit.
  const open =
    row.status === 'posted' &&
    (row.kind === 'invoice' || (row.kind === 'expense' && !row.cash_account_code));
  const paid = open ? (settled.get(row.id) ?? 0) : 0;
  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    date: row.doc_date,
    accountCode: row.account_code,
    cashAccountCode: row.cash_account_code,
    partyId: row.party_id,
    partyName: details.partyName ?? '',
    relatedId: row.related_id,
    taxCode: row.tax_code,
    netHalalas: n(row.net),
    vatHalalas: n(row.vat),
    totalHalalas: total,
    settledHalalas: paid,
    outstandingHalalas: open ? total - paid : 0,
    entryId: row.entry_id,
    entryNumber: row.entry_no ?? '',
    status: row.status,
    description: details.description,
    reference: details.reference ?? '',
    dueDate: details.dueDate ?? '',
    version: n(row.version),
    createdAt: row.created_at,
  };
}
const voucherSelect =
  'SELECT v.*, e.entry_no FROM finance_vouchers v JOIN finance_journal_entries e ON e.owner_id=v.owner_id AND e.id=v.entry_id';
export async function listVouchers(
  db: AsyncDb,
  ownerId: string,
  kinds?: VoucherKind[],
): Promise<LedgerVoucher[]> {
  const rows = await db.read<VoucherRow>(
    `${voucherSelect} WHERE v.owner_id=?${kinds?.length ? ` AND v.kind IN (${kinds.map(() => '?').join(',')})` : ''} ORDER BY v.doc_date DESC, v.number DESC LIMIT 1000`,
    [ownerId, ...(kinds ?? [])],
  );
  const settled = await settledMap(db, ownerId);
  return rows.map((row) => voucher(row, settled));
}
export async function voucherRow(db: AsyncDb, ownerId: string, id: string): Promise<VoucherRow> {
  const row = (
    await db.read<VoucherRow>(`${voucherSelect} WHERE v.owner_id=? AND v.id=?`, [ownerId, id])
  )[0];
  if (!row) throw fault(404, 'VOUCHER_NOT_FOUND', 'المستند غير موجود.');
  return row;
}
export async function readVoucher(db: AsyncDb, ownerId: string, id: string) {
  return voucher(await voucherRow(db, ownerId, id), await settledMap(db, ownerId));
}
export type VoucherInput = {
  kind: VoucherKind;
  date: string;
  accountCode?: string | null;
  cashAccountCode?: string | null;
  partyId?: string | null;
  relatedId?: string | null;
  taxCode?: TaxCode | null;
  net: number;
  vat: number;
  total: number;
  details: VoucherDetails;
  lines: PostLine[];
};
/** Writes the source document and its journal entry together. */
export async function createVoucher(
  tx: AsyncDb,
  actor: Actor,
  input: VoucherInput,
): Promise<string> {
  if (input.total <= 0 || input.total > MAX)
    throw fault(400, 'INVALID_AMOUNT', 'المبلغ يجب أن يكون أكبر من صفر.');
  const id = newId(),
    year = input.date.slice(0, 4),
    prefix = `${voucherPrefix[input.kind]}-${year}-`;
  const number = `${prefix}${await sequence(
    tx,
    'SELECT COUNT(*) AS c FROM finance_vouchers WHERE owner_id=? AND number LIKE ?',
    [actor.id, `${prefix}%`],
  )}`;
  const entry = await postEntry(tx, actor, {
    date: input.date,
    kind: input.kind,
    sourceId: id,
    description: `${number} · ${input.details.description}`,
    lines: input.lines,
  });
  await tx.execute(
    "INSERT INTO finance_vouchers(id,owner_id,kind,number,doc_date,account_code,cash_account_code,party_id,related_id,tax_code,net,vat,total,entry_id,status,details_ciphertext,version,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,1,?,?)",
    [
      id,
      actor.id,
      input.kind,
      number,
      input.date,
      input.accountCode ?? null,
      input.cashAccountCode ?? null,
      input.partyId ?? null,
      input.relatedId ?? null,
      input.taxCode ?? null,
      input.net,
      input.vat,
      input.total,
      entry.id,
      encryptSensitive(JSON.stringify(input.details), `finance:voucher:${id}`),
      actor.id,
      now(),
    ],
  );
  await audited(tx, actor, 'finance_voucher', id, `created_${input.kind}`, 1);
  return id;
}
export async function reverseVoucher(
  tx: AsyncDb,
  actor: Actor,
  id: string,
  version: number,
  date: string,
  reason: string,
) {
  const row = await voucherRow(tx, actor.id, id);
  if (row.status !== 'posted') throw fault(409, 'VOUCHER_REVERSED', 'سبق عكس هذا المستند.');
  if (n(row.version) !== version)
    throw fault(409, 'VERSION_CONFLICT', 'تغير المستند؛ حدّث الصفحة ثم أعد المحاولة.');
  const dependents = await tx.read<{ id: string }>(
    "SELECT id FROM finance_vouchers WHERE owner_id=? AND related_id=? AND status='posted' AND kind IN ('receipt','credit_note','payment') LIMIT 1",
    [actor.id, id],
  );
  if (dependents.length)
    throw fault(
      409,
      'VOUCHER_HAS_SETTLEMENTS',
      'اعكس أولًا سندات التحصيل أو السداد أو الإشعارات المرتبطة بهذا المستند.',
    );
  await reverseEntry(tx, actor, row.entry_id, date, reason);
  const changed = await tx.execute(
    "UPDATE finance_vouchers SET status='reversed',version=version+1 WHERE owner_id=? AND id=? AND version=? AND status='posted'",
    [actor.id, id, version],
  );
  if (changed.rowCount !== 1)
    throw fault(409, 'VERSION_CONFLICT', 'تغير المستند؛ حدّث الصفحة ثم أعد المحاولة.');
  await audited(tx, actor, 'finance_voucher', id, 'reversed', version + 1);
}

// ---------------------------------------------------------------- invoices
const invoicePortions = (invoice: FinanceInvoice) => {
  let taxableNet = 0,
    zeroNet = 0;
  for (const line of invoice.lines)
    if (line.taxRateBps > 0) taxableNet += line.subtotalHalalas;
    else zeroNet += line.subtotalHalalas;
  return { taxableNet, zeroNet };
};
export async function invoiceStates(
  db: AsyncDb,
  ownerId: string,
  readInvoice: (row: InvoiceRow) => FinanceInvoice,
): Promise<InvoiceLedgerState[]> {
  const rows = await db.read<InvoiceRow>(
    'SELECT * FROM finance_invoices WHERE owner_id=? ORDER BY created_at DESC',
    [ownerId],
  );
  const posted = new Map(
    (await listVouchers(db, ownerId, ['invoice']))
      .filter((item) => item.status === 'posted')
      .map((item) => [item.relatedId, item]),
  );
  return rows.map((row) => {
    const invoice = readInvoice(row),
      portions = invoicePortions(invoice);
    return {
      invoiceId: invoice.id,
      number: invoice.number,
      title: invoice.title,
      customerName: invoice.customer.name,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      documentType: invoice.documentType ?? 'standard',
      status: invoice.status,
      subtotalHalalas: invoice.subtotalHalalas,
      taxHalalas: invoice.taxHalalas,
      totalHalalas: invoice.totalHalalas,
      hasZeroLines: portions.zeroNet > 0,
      hasTaxableLines: portions.taxableNet > 0,
      voucher: posted.get(invoice.id) ?? null,
    };
  });
}
/** Books an issued invoice: receivable against revenue and output VAT, dated on its issue date. */
export async function postInvoice(
  tx: AsyncDb,
  actor: Actor,
  invoice: FinanceInvoice,
  revenueAccountCode: string,
  zeroLinesTaxCode?: TaxCode,
): Promise<string> {
  if (invoice.status === 'rejected')
    throw fault(409, 'INVOICE_REJECTED', 'الفاتورة مرفوضة من الهيئة ولا تُرحّل.');
  const prior = await tx.read<{ id: string }>(
    "SELECT id FROM finance_vouchers WHERE owner_id=? AND kind='invoice' AND related_id=? AND status='posted'",
    [actor.id, invoice.id],
  );
  if (prior[0]) return prior[0].id;
  const accounts = await accountRows(tx, actor.id),
    revenue = accounts.get(revenueAccountCode);
  if (!revenue || revenue.type !== 'revenue' || revenue.system_key)
    throw fault(400, 'INVALID_REVENUE_ACCOUNT', 'اختر حساب إيراد صالحًا.');
  const { taxableNet, zeroNet } = invoicePortions(invoice);
  const documentType = invoice.documentType ?? 'standard';
  let zeroCode: TaxCode | undefined;
  if (zeroNet > 0) {
    zeroCode =
      documentType === 'zero_rated'
        ? 'ZE'
        : documentType === 'out_of_scope'
          ? 'O'
          : zeroLinesTaxCode;
    if (!zeroCode || !['ZD', 'ZE', 'E', 'O'].includes(zeroCode))
      throw fault(
        400,
        'ZERO_LINES_TAX_CODE_REQUIRED',
        'في الفاتورة بنود بلا ضريبة؛ حدد معالجتها: صفرية محلية أو صادرات أو معفاة أو خارج النطاق.',
      );
  }
  const receivable = await systemAccount(tx, actor.id, 'receivable'),
    output = await systemAccount(tx, actor.id, 'vat_output');
  return createVoucher(tx, actor, {
    kind: 'invoice',
    date: invoice.issueDate,
    accountCode: revenueAccountCode,
    relatedId: invoice.id,
    taxCode: taxableNet > 0 ? 'S' : (zeroCode ?? null),
    net: invoice.subtotalHalalas,
    vat: invoice.taxHalalas,
    total: invoice.totalHalalas,
    details: {
      description: `فاتورة ${invoice.number} · ${invoice.title}`,
      reference: invoice.number,
      partyName: invoice.customer.name,
      dueDate: invoice.dueDate,
      taxableNet,
      zeroNet,
      zeroCode,
    },
    lines: [
      { accountCode: receivable, debit: invoice.totalHalalas, credit: 0 },
      {
        accountCode: revenueAccountCode,
        debit: 0,
        credit: taxableNet,
        tax: { side: 'sales', code: 'S', role: 'base' },
      },
      {
        accountCode: revenueAccountCode,
        debit: 0,
        credit: zeroNet,
        tax: zeroCode ? { side: 'sales', code: zeroCode, role: 'base' } : null,
      },
      {
        accountCode: output,
        debit: 0,
        credit: invoice.taxHalalas,
        tax: { side: 'sales', code: 'S', role: 'output' },
      },
    ],
  });
}
/** Best-effort posting when the provider confirms an invoice; never blocks the sync itself. */
export async function autoPostInvoice(db: AsyncDb, actor: Actor, invoice: FinanceInvoice) {
  try {
    if (invoice.status !== 'cleared' && invoice.status !== 'reported') return;
    if (!(await isInitialized(db, actor.id))) return;
    const settings = await ledgerSettings(db, actor.id);
    if (!settings.defaultRevenueAccount) return;
    const documentType = invoice.documentType ?? 'standard';
    // Mixed 0% lines need a human decision on their VAT treatment.
    if (
      invoicePortions(invoice).zeroNet > 0 &&
      documentType !== 'zero_rated' &&
      documentType !== 'out_of_scope'
    )
      return;
    await db.transaction((tx) => postInvoice(tx, actor, invoice, settings.defaultRevenueAccount));
  } catch {
    // The invoice stays in the "awaiting posting" list for a manual decision.
  }
}

// ---------------------------------------------------------------- VAT return
const boxLabels: Record<number, string> = {
  1: 'المبيعات الخاضعة للنسبة الأساسية',
  2: 'المبيعات للمواطنين (خدمات صحية وتعليم أهلي ومسكن أول)',
  3: 'المبيعات المحلية الخاضعة للنسبة الصفرية',
  4: 'الصادرات',
  5: 'المبيعات المعفاة',
  6: 'إجمالي المبيعات',
  7: 'المشتريات الخاضعة للنسبة الأساسية',
  8: 'الاستيرادات الخاضعة للضريبة والمسددة في الجمارك',
  9: 'الاستيرادات الخاضعة للضريبة بآلية الاحتساب العكسي',
  10: 'المشتريات الخاضعة للنسبة الصفرية',
  11: 'المشتريات المعفاة',
  12: 'إجمالي المشتريات',
  13: 'إجمالي ضريبة القيمة المضافة المستحقة عن الفترة الحالية',
  14: 'تصحيحات من الفترات السابقة',
  15: 'ضريبة القيمة المضافة المرحّلة من الفترات السابقة',
  16: 'صافي الضريبة المستحقة (أو المستردة)',
};
export async function computeVat(
  db: AsyncDb,
  ownerId: string,
  period: { periodStart: string; periodEnd: string; dueDate: string },
  correction = 0,
): Promise<VatComputation> {
  const rows = await db.read<{
    tax_side: string;
    tax_code: TaxCode;
    tax_role: string;
    adj: unknown;
    d: unknown;
    c: unknown;
  }>(
    `SELECT tax_side, tax_code, tax_role, adj, SUM(debit) AS d, SUM(credit) AS c FROM (
       SELECT l.tax_side, l.tax_code, l.tax_role, l.debit, l.credit,
         CASE WHEN e.kind='credit_note' OR (e.kind='reversal' AND e.original_date < ?) THEN 1 ELSE 0 END AS adj
       FROM finance_journal_lines l JOIN finance_journal_entries e ON e.owner_id=l.owner_id AND e.id=l.entry_id
       WHERE l.owner_id=? AND e.entry_date>=? AND e.entry_date<=? AND l.tax_side IS NOT NULL
     ) t GROUP BY tax_side, tax_code, tax_role, adj`,
    [period.periodStart, ownerId, period.periodStart, period.periodEnd],
  );
  const pick = (side: string, code: TaxCode, role: string, adj?: boolean) =>
    rows
      .filter(
        (row) =>
          row.tax_side === side &&
          row.tax_code === code &&
          row.tax_role === role &&
          (adj === undefined || flag(row.adj) === adj),
      )
      .reduce(
        (sum, row) => sum + (side === 'sales' ? n(row.c) - n(row.d) : n(row.d) - n(row.c)),
        0,
      );
  const box = (id: number, amount = 0, adjustment = 0, vat = 0): VatBox => ({
    box: id,
    label: boxLabels[id],
    amountHalalas: amount,
    adjustmentHalalas: adjustment,
    vatHalalas: vat,
  });
  const sales = (id: number, code: TaxCode, vat = 0) =>
    box(id, pick('sales', code, 'base', false), pick('sales', code, 'base', true), vat);
  const buys = (id: number, code: TaxCode, vat = 0) =>
    box(id, pick('purchases', code, 'base', false), pick('purchases', code, 'base', true), vat);
  const outputS = pick('sales', 'S', 'output');
  // Reverse charge: self-assessed output (a credit on the output account) and its matching input.
  const outputRc = -pick('purchases', 'RC', 'output');
  const inputS = pick('purchases', 'S', 'input'),
    inputImp = pick('purchases', 'IMP', 'input'),
    inputRc = pick('purchases', 'RC', 'input');
  const boxes = [sales(1, 'S', outputS), box(2), sales(3, 'ZD'), sales(4, 'ZE'), sales(5, 'E')];
  boxes.push(
    box(
      6,
      boxes.reduce((sum, item) => sum + item.amountHalalas, 0),
      boxes.reduce((sum, item) => sum + item.adjustmentHalalas, 0),
      outputS,
    ),
  );
  const purchases = [
    buys(7, 'S', inputS),
    buys(8, 'IMP', inputImp),
    // Box 9 carries the reverse-charge VAT once; it is due and deductible at the same time.
    buys(9, 'RC', inputRc),
    buys(10, 'ZD'),
    buys(11, 'E'),
  ];
  purchases.push(
    box(
      12,
      purchases.reduce((sum, item) => sum + item.amountHalalas, 0),
      purchases.reduce((sum, item) => sum + item.adjustmentHalalas, 0),
      inputS + inputImp + inputRc,
    ),
  );
  const outputVat = outputS + outputRc,
    inputVat = inputS + inputImp + inputRc,
    current = outputVat - inputVat;
  // Anything on the VAT control accounts that the boxes do not explain is a posting error.
  const control = await db.read<{ k: string; d: unknown; c: unknown }>(
    `SELECT a.system_key AS k, SUM(l.debit) AS d, SUM(l.credit) AS c
     FROM finance_journal_lines l
     JOIN finance_journal_entries e ON e.owner_id=l.owner_id AND e.id=l.entry_id
     JOIN finance_accounts a ON a.owner_id=l.owner_id AND a.code=l.account_code
     WHERE l.owner_id=? AND e.entry_date>=? AND e.entry_date<=? AND a.system_key IN ('vat_input','vat_output')
       AND e.kind<>'vat_close'
       AND NOT (e.kind='reversal' AND e.reversal_of IN (SELECT id FROM finance_journal_entries WHERE owner_id=? AND kind='vat_close'))
     GROUP BY a.system_key`,
    [ownerId, period.periodStart, period.periodEnd, ownerId],
  );
  const movement = (key: string) => control.find((row) => row.k === key);
  const outRow = movement('vat_output'),
    inRow = movement('vat_input');
  const unexplainedOutput = (outRow ? n(outRow.c) - n(outRow.d) : 0) - outputVat,
    unexplainedInput = (inRow ? n(inRow.d) - n(inRow.c) : 0) - inputVat;
  const settlement = await systemAccount(db, ownerId, 'vat_settlement').catch(() => '');
  const before = settlement
    ? (
        await db.read<{ d: unknown; c: unknown }>(
          `SELECT SUM(l.debit) AS d, SUM(l.credit) AS c FROM finance_journal_lines l
           JOIN finance_journal_entries e ON e.owner_id=l.owner_id AND e.id=l.entry_id
           WHERE l.owner_id=? AND l.account_code=? AND e.entry_date<=?
             AND NOT (e.kind='vat_close' AND e.entry_date=?)`,
          [ownerId, settlement, period.periodEnd, period.periodEnd],
        )
      )[0]
    : undefined;
  const credit = Math.max(0, n(before?.d) - n(before?.c));
  const netDue = current + correction - credit;
  const warnings: string[] = [];
  if (unexplainedOutput !== 0 || unexplainedInput !== 0)
    warnings.push(
      'توجد حركة على حسابات ضريبة القيمة المضافة بلا رمز ضريبي؛ راجع القيود اليدوية قبل الإقفال.',
    );
  if (outputRc !== inputRc)
    warnings.push('ضريبة الاحتساب العكسي المستحقة لا تساوي المخصومة؛ راجع قيود الخانة 9.');
  boxes.push(
    ...purchases,
    box(13, 0, 0, current),
    box(14, 0, 0, correction),
    box(15, 0, 0, credit),
    box(16, 0, 0, netDue),
  );
  return {
    ...period,
    boxes,
    outputVatHalalas: outputVat,
    inputVatHalalas: inputVat,
    currentPeriodHalalas: current,
    correctionHalalas: correction,
    creditBroughtForwardHalalas: credit,
    netDueHalalas: netDue,
    unexplainedOutputHalalas: unexplainedOutput,
    unexplainedInputHalalas: unexplainedInput,
    warnings,
  };
}
type VatRow = {
  id: string;
  period_start: string;
  period_end: string;
  due_date: string;
  status: VatReturn['status'];
  boxes_json: string;
  correction: unknown;
  correction_note_ciphertext: string | null;
  credit_brought_forward: unknown;
  net_due: unknown;
  closing_entry_id: string | null;
  payment_entry_id: string | null;
  filed_at: string | null;
  filing_reference_ciphertext: string | null;
  version: number;
  closed_at: string;
};
function vatReturn(row: VatRow): VatReturn {
  const snapshot = JSON.parse(row.boxes_json) as VatComputation;
  return {
    ...snapshot,
    id: row.id,
    status: row.status,
    correctionNote: plain(row.correction_note_ciphertext, `finance:vat-note:${row.id}`),
    closingEntryId: row.closing_entry_id,
    paymentEntryId: row.payment_entry_id,
    filedAt: row.filed_at,
    filingReference: plain(row.filing_reference_ciphertext, `finance:vat-reference:${row.id}`),
    version: n(row.version),
    closedAt: row.closed_at,
  };
}
export async function listVatReturns(db: AsyncDb, ownerId: string): Promise<VatReturn[]> {
  return (
    await db.read<VatRow>(
      'SELECT * FROM finance_vat_returns WHERE owner_id=? ORDER BY period_start DESC',
      [ownerId],
    )
  ).map(vatReturn);
}
export async function readVatReturn(db: AsyncDb, ownerId: string, id: string): Promise<VatReturn> {
  const row = (
    await db.read<VatRow>('SELECT * FROM finance_vat_returns WHERE owner_id=? AND id=?', [
      ownerId,
      id,
    ])
  )[0];
  if (!row) throw fault(404, 'VAT_RETURN_NOT_FOUND', 'الإقرار غير موجود.');
  return vatReturn(row);
}
export async function vatPeriods(
  db: AsyncDb,
  ownerId: string,
  frequency: 'quarterly' | 'monthly',
): Promise<VatPeriodSummary[]> {
  const today = todayInRiyadh();
  const first = (
    await db.read<{ d: string | null }>(
      'SELECT MIN(entry_date) AS d FROM finance_journal_entries WHERE owner_id=?',
      [ownerId],
    )
  )[0]?.d;
  const returns = await listVatReturns(db, ownerId);
  const earliest = [first, ...returns.map((item) => item.periodStart), today]
    .filter((value): value is string => !!value)
    .sort()[0];
  const closed = new Map(returns.map((item) => [item.periodStart, item]));
  const result: VatPeriodSummary[] = [];
  let cursor = vatPeriod(earliest, frequency);
  for (let i = 0; i < 60 && cursor.periodStart <= today; i += 1) {
    const done = closed.get(cursor.periodStart);
    result.push({
      ...cursor,
      status: done?.status ?? 'open',
      netDueHalalas: done?.netDueHalalas ?? null,
      returnId: done?.id ?? null,
    });
    const end = new Date(`${cursor.periodEnd}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    cursor = vatPeriod(end.toISOString().slice(0, 10), frequency);
  }
  // Returns closed under another filing frequency still appear.
  for (const item of returns)
    if (!result.some((period) => period.periodStart === item.periodStart))
      result.push({
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        dueDate: item.dueDate,
        label: `${item.periodStart} – ${item.periodEnd}`,
        status: item.status,
        netDueHalalas: item.netDueHalalas,
        returnId: item.id,
      });
  return result.sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}
/** Freezes the period's figures, moves the VAT accounts to the settlement account and locks its months. */
export async function closeVat(
  tx: AsyncDb,
  actor: Actor,
  periodStart: string,
  correction: number,
  note: string,
): Promise<string> {
  const settings = await ledgerSettings(tx, actor.id),
    period = vatPeriod(periodStart, settings.filingFrequency);
  if (period.periodStart !== periodStart)
    throw fault(400, 'INVALID_VAT_PERIOD', 'بداية الفترة لا تطابق دورية الإقرار.');
  if (period.periodEnd >= todayInRiyadh())
    throw fault(409, 'VAT_PERIOD_NOT_ENDED', 'لا تُقفل الفترة الضريبية قبل انتهائها.');
  const existing = await tx.read<{ id: string }>(
    'SELECT id FROM finance_vat_returns WHERE owner_id=? AND period_start<=? AND period_end>=?',
    [actor.id, period.periodEnd, period.periodStart],
  );
  if (existing.length) throw fault(409, 'VAT_PERIOD_CLOSED', 'سبق إقفال إقرار يغطي هذه الفترة.');
  // Returns close in order: an earlier open period may hold a credit this one must bring forward.
  const earlier = await tx.read<{ d: string }>(
    `SELECT MIN(e.entry_date) AS d FROM finance_journal_lines l
     JOIN finance_journal_entries e ON e.owner_id=l.owner_id AND e.id=l.entry_id
     JOIN finance_accounts a ON a.owner_id=l.owner_id AND a.code=l.account_code
     WHERE l.owner_id=? AND e.entry_date<? AND ((l.tax_side IS NOT NULL AND l.tax_code NOT IN ('O','ND')) OR a.system_key IN ('vat_input','vat_output'))
       AND NOT EXISTS (SELECT 1 FROM finance_vat_returns r WHERE r.owner_id=l.owner_id AND r.period_start<=e.entry_date AND r.period_end>=e.entry_date)`,
    [actor.id, period.periodStart],
  );
  if (earlier[0]?.d)
    throw fault(
      409,
      'VAT_EARLIER_PERIOD_OPEN',
      `توجد حركة ضريبية بتاريخ ${earlier[0].d} في فترة أسبق لم تُقفل. أقفل الفترات بترتيبها الزمني.`,
    );
  // Art. 63: the cap applies to tax understated earlier; an overstatement may be corrected later.
  if (correction > settings.vatCorrectionLimitHalalas)
    throw fault(
      400,
      'VAT_CORRECTION_LIMIT',
      'الضريبة الناقصة تتجاوز الحد المسموح تصحيحه في الخانة 14؛ الأخطاء الأكبر تُصحح بتعديل الإقرار الأصلي لدى الهيئة.',
    );
  if (correction !== 0 && !note)
    throw fault(400, 'VAT_CORRECTION_NOTE_REQUIRED', 'اذكر سبب تصحيح الفترات السابقة.');
  const computed = await computeVat(tx, actor.id, period, correction);
  if (computed.unexplainedOutputHalalas !== 0 || computed.unexplainedInputHalalas !== 0)
    throw fault(
      409,
      'VAT_UNRECONCILED',
      'أرصدة حسابات الضريبة لا تطابق خانات الإقرار؛ صحح القيود اليدوية أولًا.',
    );
  const id = newId();
  const output = await systemAccount(tx, actor.id, 'vat_output'),
    input = await systemAccount(tx, actor.id, 'vat_input'),
    settlement = await systemAccount(tx, actor.id, 'vat_settlement'),
    adjustments = await systemAccount(tx, actor.id, 'vat_adjustments');
  const side = (accountCode: string, amount: number, memo: string): PostLine => ({
    accountCode,
    debit: amount > 0 ? amount : 0,
    credit: amount < 0 ? -amount : 0,
    memo,
  });
  const payable = computed.currentPeriodHalalas + correction;
  const lines = [
    side(output, computed.outputVatHalalas, 'إقفال ضريبة المخرجات'),
    side(input, -computed.inputVatHalalas, 'إقفال ضريبة المدخلات'),
    side(adjustments, correction, 'تصحيحات فترات سابقة'),
    side(settlement, -payable, 'صافي الفترة'),
  ];
  let entryId: string | null = null;
  if (lines.some((line) => line.debit || line.credit))
    entryId = (
      await postEntry(tx, actor, {
        date: period.periodEnd,
        kind: 'vat_close',
        sourceId: id,
        description: `إقفال ضريبة القيمة المضافة · ${period.label}`,
        lines,
      })
    ).id;
  await tx.execute(
    "INSERT INTO finance_vat_returns(id,owner_id,period_start,period_end,due_date,status,boxes_json,correction,correction_note_ciphertext,credit_brought_forward,net_due,closing_entry_id,version,closed_by,closed_at) VALUES(?,?,?,?,?,'closed',?,?,?,?,?,?,1,?,?)",
    [
      id,
      actor.id,
      period.periodStart,
      period.periodEnd,
      period.dueDate,
      JSON.stringify(computed),
      correction,
      note ? encryptSensitive(note, `finance:vat-note:${id}`) : null,
      computed.creditBroughtForwardHalalas,
      computed.netDueHalalas,
      entryId,
      actor.id,
      now(),
    ],
  );
  const year = Number(period.periodStart.slice(0, 4));
  for (
    let month = Number(period.periodStart.slice(5, 7));
    month <= Number(period.periodEnd.slice(5, 7));
    month += 1
  )
    await setLock(tx, actor, year, month, true, 'vat');
  await audited(tx, actor, 'finance_vat_return', id, 'closed', 1);
  return id;
}

// ---------------------------------------------------------------- reports
export async function trialBalance(
  db: AsyncDb,
  ownerId: string,
  from: string,
  to: string,
): Promise<TrialBalanceRow[]> {
  const accounts = await accountRows(db, ownerId);
  const day = new Date(`${from}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  const opening = await totals(db, ownerId, { to: day.toISOString().slice(0, 10) }),
    period = await totals(db, ownerId, { from, to });
  const result: TrialBalanceRow[] = [];
  for (const row of accounts.values()) {
    if (!flag(row.postable)) continue;
    const o = opening.get(row.code) ?? { debit: 0, credit: 0 },
      p = period.get(row.code) ?? { debit: 0, credit: 0 };
    const openNet = o.debit - o.credit,
      closeNet = openNet + p.debit - p.credit;
    if (!openNet && !p.debit && !p.credit) continue;
    result.push({
      code: row.code,
      name: row.name,
      type: row.type,
      openingDebit: openNet > 0 ? openNet : 0,
      openingCredit: openNet < 0 ? -openNet : 0,
      periodDebit: p.debit,
      periodCredit: p.credit,
      closingDebit: closeNet > 0 ? closeNet : 0,
      closingCredit: closeNet < 0 ? -closeNet : 0,
    });
  }
  return result;
}
function sections(
  accounts: Map<string, AccountRow>,
  sums: Totals,
  type: LedgerAccount['type'],
  /** Statement sign: credit-positive for revenue, liabilities and equity. */
  creditPositive: boolean,
): StatementSection[] {
  const groups = new Map<string, StatementSection>();
  for (const row of accounts.values()) {
    if (row.type !== type || !flag(row.postable)) continue;
    const t = sums.get(row.code);
    if (!t) continue;
    const amount = creditPositive ? t.credit - t.debit : t.debit - t.credit;
    if (!amount) continue;
    const key = row.parent_code ?? row.code;
    const section =
      groups.get(key) ??
      groups
        .set(key, {
          key,
          title: accounts.get(key)?.name ?? key,
          lines: [],
          totalHalalas: 0,
        })
        .get(key)!;
    section.lines.push({ code: row.code, name: row.name, amountHalalas: amount });
    section.totalHalalas += amount;
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
const sum = (items: StatementSection[]) => items.reduce((total, s) => total + s.totalHalalas, 0);
export async function incomeStatement(
  db: AsyncDb,
  ownerId: string,
  from: string,
  to: string,
): Promise<IncomeStatement> {
  const accounts = await accountRows(db, ownerId),
    sums = await totals(db, ownerId, { from, to });
  const revenue = sections(accounts, sums, 'revenue', true),
    expense = sections(accounts, sums, 'expense', false);
  return {
    from,
    to,
    sections: [...revenue, ...expense],
    revenueHalalas: sum(revenue),
    expenseHalalas: sum(expense),
    netProfitHalalas: sum(revenue) - sum(expense),
  };
}
async function earnings(db: AsyncDb, ownerId: string, range: { from?: string; to?: string }) {
  const accounts = await accountRows(db, ownerId),
    sums = await totals(db, ownerId, range);
  return (
    sum(sections(accounts, sums, 'revenue', true)) - sum(sections(accounts, sums, 'expense', false))
  );
}
export async function balanceSheet(
  db: AsyncDb,
  ownerId: string,
  asOf: string,
): Promise<BalanceSheet> {
  const accounts = await accountRows(db, ownerId),
    sums = await totals(db, ownerId, { to: asOf });
  const assets = sections(accounts, sums, 'asset', false),
    liabilities = sections(accounts, sums, 'liability', true),
    equity = sections(accounts, sums, 'equity', true);
  // No year-end closing entries are posted: results are derived from the income accounts.
  const yearStart = `${asOf.slice(0, 4)}-01-01`,
    previous = new Date(`${yearStart}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const prior = await earnings(db, ownerId, { to: previous.toISOString().slice(0, 10) }),
    current = await earnings(db, ownerId, { from: yearStart, to: asOf });
  const derived: StatementSection = {
    key: 'results',
    title: 'نتائج الأعمال (محسوبة من حسابات الإيرادات والمصروفات)',
    lines: [
      { code: '', name: 'أرباح أو خسائر السنوات السابقة غير المقفلة', amountHalalas: prior },
      { code: '', name: 'صافي ربح أو خسارة السنة الحالية', amountHalalas: current },
    ].filter((line) => line.amountHalalas !== 0),
    totalHalalas: prior + current,
  };
  const equityAll = derived.lines.length ? [...equity, derived] : equity;
  const a = sum(assets),
    l = sum(liabilities),
    e = sum(equityAll);
  return {
    asOf,
    sections: [...assets, ...liabilities, ...equityAll],
    assetsHalalas: a,
    liabilitiesHalalas: l,
    equityHalalas: e,
    balanced: a === l + e,
  };
}
const STATEMENT_ROWS = 2000;
export async function accountStatement(
  db: AsyncDb,
  ownerId: string,
  code: string,
  from: string,
  to: string,
): Promise<AccountStatement> {
  const row = (await accountRows(db, ownerId)).get(code);
  if (!row) throw fault(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود.');
  const day = new Date(`${from}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  const opening = signed(
    row,
    (await totals(db, ownerId, { to: day.toISOString().slice(0, 10) })).get(code),
  );
  const lines = await db.read<LineRow & EntryRow & { line_id: string }>(
    `SELECT l.id AS line_id, l.debit, l.credit, l.memo_ciphertext, e.id, e.entry_no, e.entry_date, e.description_ciphertext
     FROM finance_journal_lines l JOIN finance_journal_entries e ON e.owner_id=l.owner_id AND e.id=l.entry_id
     WHERE l.owner_id=? AND l.account_code=? AND e.entry_date>=? AND e.entry_date<=?
     ORDER BY e.entry_date, e.entry_no, l.line_no LIMIT ${STATEMENT_ROWS + 1}`,
    [ownerId, code, from, to],
  );
  // The detail is capped, the balance is not: closing comes from every movement up to the end date.
  const truncated = lines.length > STATEMENT_ROWS;
  if (truncated) lines.length = STATEMENT_ROWS;
  const closing = signed(row, (await totals(db, ownerId, { to })).get(code));
  let balance = opening;
  return {
    account: account(row, signed(row, (await totals(db, ownerId)).get(code))),
    from,
    to,
    openingHalalas: opening,
    rows: lines.map((line) => {
      const debit = n(line.debit),
        credit = n(line.credit);
      balance += row.normal_side === 'debit' ? debit - credit : credit - debit;
      return {
        entryId: line.id,
        entryNumber: line.entry_no,
        date: line.entry_date,
        description: plain(line.description_ciphertext, `finance:journal:${line.id}`),
        memo: plain(line.memo_ciphertext, `finance:journal-line:${line.line_id}`),
        debitHalalas: debit,
        creditHalalas: credit,
        balanceHalalas: balance,
      };
    }),
    closingHalalas: closing,
    truncated,
  };
}
export async function aging(
  db: AsyncDb,
  ownerId: string,
  side: 'receivable' | 'payable',
  asOf: string,
): Promise<AgingRow[]> {
  // Rebuild each balance as it stood on the reporting date: only documents and settlements dated
  // on or before it count, and a later reversal has not happened yet.
  const reversedOn = new Map(
    (
      await db.read<{ reversal_of: string; entry_date: string }>(
        "SELECT reversal_of, entry_date FROM finance_journal_entries WHERE owner_id=? AND kind='reversal' AND reversal_of IS NOT NULL",
        [ownerId],
      )
    ).map((row) => [row.reversal_of, row.entry_date]),
  );
  const live = (row: VoucherRow) =>
    row.doc_date <= asOf &&
    (row.status === 'posted' || (reversedOn.get(row.entry_id) ?? '9999-12-31') > asOf);
  const rows = await db.read<VoucherRow>(
    `${voucherSelect} WHERE v.owner_id=? AND v.doc_date<=? AND v.kind IN (?,?,?,?)`,
    [
      ownerId,
      asOf,
      ...(side === 'receivable'
        ? ['invoice', 'receipt', 'credit_note', 'invoice']
        : ['expense', 'payment', 'payment', 'expense']),
    ],
  );
  const settled = new Map<string, number>();
  for (const row of rows)
    if (row.related_id && row.kind !== 'invoice' && row.kind !== 'expense' && live(row))
      settled.set(row.related_id, (settled.get(row.related_id) ?? 0) + n(row.total));
  const items = rows
    .filter((row) => (row.kind === 'invoice' || row.kind === 'expense') && live(row))
    // `voucher` settles posted documents only; one reversed after the date was still open on it.
    .map((row) => voucher({ ...row, status: 'posted' }, settled));
  return items
    .filter((item) => item.outstandingHalalas !== 0)
    .map((item) => {
      const due = item.dueDate || item.date;
      const days = Math.round(
        (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000,
      );
      return {
        voucherId: item.id,
        number: item.reference || item.number,
        partyName: item.partyName,
        date: item.date,
        dueDate: due,
        outstandingHalalas: item.outstandingHalalas,
        daysOverdue: Math.max(0, days),
        bucket:
          days <= 0
            ? ('current' as const)
            : days <= 30
              ? ('1-30' as const)
              : days <= 60
                ? ('31-60' as const)
                : days <= 90
                  ? ('61-90' as const)
                  : ('90+' as const),
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}
const dayGap = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/**
 * Movements of one customer: invoices issued to them, then the receipts and credit notes recorded
 * on those invoices. An approved invoice counts even before it is posted to the books.
 */
export async function customerStatement(
  db: AsyncDb,
  ownerId: string,
  customerId: string,
  from: string | null,
  to: string,
): Promise<Omit<CustomerStatement, 'customer' | 'seller'>> {
  const invoices = (
    await db.read<InvoiceRow>(
      'SELECT i.* FROM finance_invoices i JOIN finance_quotes q ON q.owner_id=i.owner_id AND q.id=i.quote_id WHERE i.owner_id=? AND q.customer_id=?',
      [ownerId, customerId],
    )
  ).map((row) => safeJson<FinanceInvoice>(row.invoice_ciphertext, `finance:invoice:${row.id}`));
  const vouchers = invoices.length
    ? await db.read<VoucherRow>(
        `${voucherSelect} WHERE v.owner_id=? AND v.kind IN ('invoice','receipt','credit_note')`,
        [ownerId],
      )
    : [];
  const postedByInvoice = new Map(
    vouchers
      .filter((row) => row.kind === 'invoice' && row.status === 'posted')
      .map((row) => [row.related_id, row]),
  );
  // A reversed receipt or credit note stays on the statement with its reversal as a later
  // movement, so a balance already reported for an earlier date never changes.
  const reversedOn = new Map(
    vouchers.some((row) => row.status === 'reversed')
      ? (
          await db.read<{ reversal_of: string; entry_date: string }>(
            "SELECT reversal_of, entry_date FROM finance_journal_entries WHERE owner_id=? AND kind='reversal' AND reversal_of IS NOT NULL",
            [ownerId],
          )
        ).map((row) => [row.reversal_of, row.entry_date])
      : [],
  );
  type Movement = Omit<CustomerStatementRow, 'balanceHalalas'> & {
    order: number;
    key: string;
    of?: 'receipt' | 'credit_note';
  };
  const movements: Movement[] = [];
  const byVoucher = new Map<string, string>();
  let unpostedInvoices = 0;
  for (const invoice of invoices) {
    const posted = postedByInvoice.get(invoice.id);
    const approved = invoice.status === 'cleared' || invoice.status === 'reported';
    if (!posted && !approved) continue;
    if (!posted) unpostedInvoices += 1;
    // Settlements may hang on an earlier posting of the same invoice that was later reversed.
    for (const row of vouchers)
      if (row.kind === 'invoice' && row.related_id === invoice.id)
        byVoucher.set(row.id, invoice.number);
    movements.push({
      date: invoice.issueDate,
      kind: 'invoice',
      number: invoice.number,
      invoiceNumber: invoice.number,
      description: invoice.title,
      dueDate: invoice.dueDate,
      debitHalalas: invoice.totalHalalas,
      creditHalalas: 0,
      order: 0,
      key: invoice.number,
    });
  }
  for (const row of vouchers) {
    const invoiceNumber = row.related_id ? byVoucher.get(row.related_id) : undefined;
    if (row.kind === 'invoice' || !invoiceNumber) continue;
    const reference = voucherDetails(row).reference;
    const kind = row.kind as 'receipt' | 'credit_note';
    const reversal = row.status === 'reversed' ? reversedOn.get(row.entry_id) : undefined;
    if (row.status === 'reversed' && !reversal) continue;
    if (reversal)
      movements.push({
        date: reversal,
        kind: 'reversal',
        number: row.number,
        invoiceNumber,
        description: `${kind === 'receipt' ? 'عكس سداد فاتورة' : 'عكس إشعار دائن على فاتورة'} ${invoiceNumber}`,
        dueDate: '',
        debitHalalas: n(row.total),
        creditHalalas: 0,
        order: 2,
        key: row.number,
        of: kind,
      });
    movements.push({
      date: row.doc_date,
      kind,
      number: row.number,
      invoiceNumber,
      description:
        `${row.kind === 'receipt' ? 'سداد فاتورة' : 'إشعار دائن على فاتورة'} ${invoiceNumber}` +
        (reference && reference !== invoiceNumber ? ` · ${reference}` : ''),
      dueDate: '',
      debitHalalas: 0,
      creditHalalas: n(row.total),
      order: 1,
      key: row.number,
    });
  }
  movements.sort(
    (a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.key.localeCompare(b.key),
  );
  let balance = 0,
    openingHalalas = 0,
    invoicedHalalas = 0,
    paidHalalas = 0,
    creditedHalalas = 0;
  const rows: CustomerStatementRow[] = [];
  // Per-invoice balance on the closing date, whatever the start of the period is.
  const open = new Map<string, { total: number; settled: number; date: string; due: string }>();
  for (const { order: _order, key: _key, of, ...item } of movements) {
    if (item.date > to) continue;
    balance += item.debitHalalas - item.creditHalalas;
    const state = open.get(item.invoiceNumber);
    if (item.kind === 'invoice')
      open.set(item.invoiceNumber, {
        total: item.debitHalalas,
        settled: state?.settled ?? 0,
        date: item.date,
        due: item.dueDate || item.date,
      });
    else if (state) state.settled += item.creditHalalas - item.debitHalalas;
    if (from && item.date < from) {
      openingHalalas = balance;
      continue;
    }
    if (item.kind === 'invoice') invoicedHalalas += item.debitHalalas;
    if (item.kind === 'receipt' || of === 'receipt')
      paidHalalas += item.creditHalalas - item.debitHalalas;
    if (item.kind === 'credit_note' || of === 'credit_note')
      creditedHalalas += item.creditHalalas - item.debitHalalas;
    rows.push({ ...item, balanceHalalas: balance });
  }
  const openInvoices = [...open.entries()]
    .map(([number, state]) => ({
      number,
      date: state.date,
      dueDate: state.due,
      totalHalalas: state.total,
      settledHalalas: state.settled,
      outstandingHalalas: state.total - state.settled,
      daysOverdue: Math.max(0, dayGap(state.due, to)),
    }))
    .filter((item) => item.outstandingHalalas !== 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number));
  return {
    from,
    to,
    openingHalalas,
    invoicedHalalas,
    paidHalalas,
    creditedHalalas,
    closingHalalas: balance,
    overdueHalalas: openInvoices
      .filter((item) => item.daysOverdue > 0)
      .reduce((sum, item) => sum + item.outstandingHalalas, 0),
    rows,
    openInvoices,
    unpostedInvoices,
  };
}
async function monthlyActuals(db: AsyncDb, ownerId: string, from: string, to: string) {
  return db.read<{ code: string; month: string; d: unknown; c: unknown }>(
    `SELECT l.account_code AS code, substr(e.entry_date,1,7) AS month, SUM(l.debit) AS d, SUM(l.credit) AS c
     FROM finance_journal_lines l JOIN finance_journal_entries e ON e.owner_id=l.owner_id AND e.id=l.entry_id
     WHERE l.owner_id=? AND e.entry_date>=? AND e.entry_date<=?
     GROUP BY l.account_code, substr(e.entry_date,1,7)`,
    [ownerId, from, to],
  );
}
export async function budgetReport(
  db: AsyncDb,
  ownerId: string,
  year: number,
): Promise<BudgetReport> {
  const accounts = await accountRows(db, ownerId);
  const version = n(
    (
      await db.read<{ version: number }>(
        'SELECT version FROM finance_budget_years WHERE owner_id=? AND year=?',
        [ownerId, year],
      )
    )[0]?.version ?? 1,
  );
  const planned = await db.read<{ account_code: string; month: number; amount: unknown }>(
    'SELECT account_code,month,amount FROM finance_budgets WHERE owner_id=? AND year=?',
    [ownerId, year],
  );
  const actual = await monthlyActuals(db, ownerId, `${year}-01-01`, `${year}-12-31`);
  const lines: BudgetReport['lines'] = [];
  for (const row of accounts.values()) {
    if (!flag(row.postable) || (row.type !== 'revenue' && row.type !== 'expense')) continue;
    const budget = Array.from({ length: 12 }, () => 0),
      spent = Array.from({ length: 12 }, () => 0);
    for (const item of planned)
      if (item.account_code === row.code) budget[n(item.month) - 1] = n(item.amount);
    for (const item of actual)
      if (item.code === row.code)
        spent[Number(item.month.slice(5, 7)) - 1] =
          row.type === 'revenue' ? n(item.c) - n(item.d) : n(item.d) - n(item.c);
    if (!flag(row.active) && !budget.some(Boolean) && !spent.some(Boolean)) continue;
    lines.push({
      accountCode: row.code,
      accountName: row.name,
      type: row.type,
      budget,
      actual: spent,
    });
  }
  return { year, version, lines };
}
export async function dashboard(
  db: AsyncDb,
  ownerId: string,
  unpostedInvoices: number,
): Promise<LedgerDashboard> {
  const today = todayInRiyadh(),
    year = today.slice(0, 4),
    month = today.slice(0, 7);
  const accounts = await accountRows(db, ownerId),
    all = await totals(db, ownerId);
  const yearStatement = await incomeStatement(db, ownerId, `${year}-01-01`, today),
    monthStatement = await incomeStatement(db, ownerId, `${month}-01`, today);
  const start = new Date(Date.UTC(Number(year), Number(today.slice(5, 7)) - 12, 1))
    .toISOString()
    .slice(0, 10);
  const actual = await monthlyActuals(db, ownerId, start, today);
  const monthly: LedgerDashboard['monthly'] = [];
  for (let i = 0; i < 12; i += 1) {
    const key = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1 + i, 1))
      .toISOString()
      .slice(0, 7);
    let revenue = 0,
      expense = 0;
    for (const item of actual) {
      if (item.month !== key) continue;
      const type = accounts.get(item.code)?.type;
      if (type === 'revenue') revenue += n(item.c) - n(item.d);
      if (type === 'expense') expense += n(item.d) - n(item.c);
    }
    monthly.push({ month: key, revenueHalalas: revenue, expenseHalalas: expense });
  }
  const bySystem = (key: string) => {
    const row = [...accounts.values()].find((item) => item.system_key === key);
    return row ? signed(row, all.get(row.code)) : 0;
  };
  const cash = [...accounts.values()]
    .filter((row) => flag(row.is_cash))
    .reduce((total, row) => total + signed(row, all.get(row.code)), 0);
  const settings = await ledgerSettings(db, ownerId),
    periods = await vatPeriods(db, ownerId, settings.filingFrequency);
  const current = vatPeriod(today, settings.filingFrequency);
  const receivables = await aging(db, ownerId, 'receivable', today);
  const unbalanced = await db.read<{ entry_id: string }>(
    'SELECT entry_id FROM finance_journal_lines WHERE owner_id=? GROUP BY entry_id HAVING SUM(debit)<>SUM(credit) LIMIT 1',
    [ownerId],
  );
  return {
    today,
    monthRevenueHalalas: monthStatement.revenueHalalas,
    monthExpenseHalalas: monthStatement.expenseHalalas,
    yearRevenueHalalas: yearStatement.revenueHalalas,
    yearExpenseHalalas: yearStatement.expenseHalalas,
    cashHalalas: cash,
    receivablesHalalas: bySystem('receivable'),
    payablesHalalas: bySystem('payable'),
    vatPositionHalalas: bySystem('vat_output') - bySystem('vat_input') + bySystem('vat_settlement'),
    monthly,
    topExpenses: yearStatement.sections
      .filter((section) => accounts.get(section.key)?.type === 'expense')
      .flatMap((section) => section.lines)
      .sort((a, b) => b.amountHalalas - a.amountHalalas)
      .slice(0, 6),
    currentVatPeriod: periods.find((item) => item.periodStart === current.periodStart) ?? {
      ...current,
      status: 'open',
      netDueHalalas: null,
      returnId: null,
    },
    overdueVatPeriods: periods.filter(
      (item) => item.periodEnd < today && (item.status === 'open' || item.status === 'closed'),
    ),
    unpostedInvoices,
    overdueReceivablesHalalas: receivables
      .filter((row) => row.daysOverdue > 0)
      .reduce((total, row) => total + row.outstandingHalalas, 0),
    booksBalanced: unbalanced.length === 0,
  };
}
export const isSalesCode = (code: unknown): code is TaxCode =>
  salesTaxCodes.includes(code as TaxCode);
export const isPurchaseCode = (code: unknown): code is TaxCode =>
  purchaseTaxCodes.includes(code as TaxCode);
