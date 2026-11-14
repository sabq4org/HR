import type { Express, Request, Response } from 'express';
import type {
  FinanceAddress,
  FinanceCatalogItem,
  FinanceCatalogItemInput,
  FinanceCustomer,
  FinanceCustomerInput,
  FinanceInvoice,
  FinanceLine,
  FinanceLineInput,
  FinanceOverview,
  FinanceQuote,
  FinanceDocumentType,
  FinanceQuoteInput,
  FinanceSeller,
  FinanceSettings,
} from '../../shared/finance.js';
import { financeDocumentTypes, zeroLineDocumentTypes } from '../../shared/finance.js';
import type { AsyncDb } from '../database.js';
import { decryptSensitive, encryptSensitive } from '../administration/security.js';
import type { Actor } from '../administration/service.js';
import {
  actorOrThrow,
  idempotent as coreIdempotent,
  newId,
  registerRoute,
  requireRecord,
  versionValue,
} from '../administration/common.js';
import type { RequireActor } from '../administration/common.js';
import { fault } from '../administration/validation.js';
import {
  WafeqApiError,
  WafeqClient,
  type WafeqClientLike as WafeqProvider,
} from '../integrations/wafeq.js';
export type { WafeqClientLike } from '../integrations/wafeq.js';
import { autoPostInvoice } from './ledger.js';
import { registerLedger } from './ledger-routes.js';

export type FinanceAccessOptions = { privateMode: boolean; allowedActorId?: string };
export function canAccessFinance(actor: Actor, access: FinanceAccessOptions): boolean {
  return (
    access.privateMode === true &&
    typeof access.allowedActorId === 'string' &&
    access.allowedActorId.length > 0 &&
    actor.id === access.allowedActorId
  );
}
type Options = {
  db: AsyncDb;
  requireActor: RequireActor;
  privateMode?: boolean;
  allowedActorId?: string;
  createClient?: (apiKey: string) => WafeqProvider;
};
type CustomerRow = {
  id: string;
  owner_id: string;
  version: number;
  customer_ciphertext: string;
  created_at: string;
  wafeq_id: string | null;
  sync_status: 'not_synced' | 'synced' | 'error';
  sync_message: string | null;
};
type CatalogRow = {
  id: string;
  version: number;
  description: string;
  unit_price: string;
  tax_rate_bps: number;
  tax_reason: string;
  active: number | boolean;
  created_at: string;
};
const catalogItem = (row: CatalogRow): FinanceCatalogItem => ({
  id: row.id,
  version: row.version,
  description: row.description,
  unitPrice: row.unit_price,
  taxRateBps: Number(row.tax_rate_bps),
  taxReason: row.tax_reason,
  active: row.active === true || Number(row.active) === 1,
  createdAt: row.created_at,
});
type QuoteRow = {
  id: string;
  owner_id: string;
  customer_id: string;
  number: string;
  version: number;
  status: 'draft' | 'converted';
  quote_ciphertext: string;
  created_at: string;
  invoice_id: string | null;
};
export type InvoiceRow = {
  id: string;
  owner_id: string;
  quote_id: string;
  number: string;
  version: number;
  invoice_ciphertext: string;
  created_at: string;
};
type OperationRow = {
  id: string;
  idempotency_key: string;
  report_idempotency_key: string;
  state: string;
  provider_id: string | null;
  lease_until?: string | null;
};
const emptyAddress = (): FinanceAddress => ({ line: '', city: '', postalCode: '', country: 'SA' });
const emptySeller = (): FinanceSeller => ({
  name: '',
  vatNumber: '',
  commercialRegistration: '',
  address: emptyAddress(),
});
export const now = () => new Date().toISOString();
const denied = () =>
  fault(403, 'FINANCE_ACCESS_DENIED', 'لا تملك صلاحية الوصول إلى المعاينة المالية.');
function owner(actor: Actor, access: FinanceAccessOptions) {
  if (!canAccessFinance(actor, access)) throw denied();
  return actor.id;
}
export function safeJson<T>(ciphertext: string, context: string): T {
  try {
    return JSON.parse(decryptSensitive(ciphertext, context)) as T;
  } catch (error) {
    if ((error as { status?: number }).status) throw error;
    throw fault(500, 'FINANCE_DATA_INVALID', 'تعذر قراءة بيانات المعاينة.');
  }
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function dateValue(value: unknown): string {
  if (!validDate(value)) throw fault(400, 'INVALID_DATE', 'أدخل تاريخًا صحيحًا.');
  return value;
}
export function routeId(value: string | string[]): string {
  if (typeof value !== 'string') throw fault(400, 'INVALID_ID', 'معرّف المورد غير صالح.');
  return value;
}
export function text(value: unknown, max: number, code = 'INVALID_INPUT'): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw fault(400, code, 'تحقق من الحقول المطلوبة.');
  return value.trim();
}
export function optionalText(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max)
    throw fault(400, 'INVALID_INPUT', 'تحقق من الحقول النصية.');
  return value.trim();
}
function addressValue(value: unknown): FinanceAddress {
  const a = requireRecord(value);
  if (a.country !== 'SA')
    throw fault(400, 'INVALID_ADDRESS', 'الدولة المدعومة في المعاينة هي السعودية.');
  return {
    line: text(a.line, 200),
    city: text(a.city, 100),
    postalCode: text(a.postalCode, 20),
    country: 'SA',
    ...(a.district === undefined ? {} : { district: optionalText(a.district, 100) }),
    ...(a.buildingNumber === undefined
      ? {}
      : { buildingNumber: optionalText(a.buildingNumber, 20) }),
    ...(a.additionalNumber === undefined
      ? {}
      : { additionalNumber: optionalText(a.additionalNumber, 20) }),
  };
}
export function validateVat(value: unknown, optional = true): string {
  const vat = optionalText(value, 15);
  if ((!optional && !vat) || (vat && !/^3\d{13}3$/.test(vat)))
    throw fault(
      400,
      'INVALID_VAT',
      'رقم ضريبة القيمة المضافة يجب أن يتكون من 15 رقمًا ويبدأ وينتهي بـ3.',
    );
  return vat;
}
function customerInput(value: unknown): FinanceCustomerInput {
  const x = requireRecord(value);
  const email = text(x.email, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw fault(400, 'INVALID_EMAIL', 'أدخل بريدًا إلكترونيًا صحيحًا.');
  return {
    name: text(x.name, 200),
    email,
    vatNumber: validateVat(x.vatNumber),
    address: addressValue(x.address),
    ...(x.nameEnglish === undefined ? {} : { nameEnglish: optionalText(x.nameEnglish, 200) }),
    ...(x.type === undefined
      ? {}
      : {
          type:
            x.type === 'business' || x.type === 'individual'
              ? x.type
              : (() => {
                  throw fault(400, 'INVALID_CUSTOMER_TYPE', 'نوع العميل غير صالح.');
                })(),
        }),
    ...(x.commercialRegistration === undefined
      ? {}
      : { commercialRegistration: optionalText(x.commercialRegistration, 30) }),
    ...(x.phone === undefined ? {} : { phone: optionalText(x.phone, 30) }),
    ...(x.mobile === undefined ? {} : { mobile: optionalText(x.mobile, 30) }),
    ...(x.notes === undefined ? {} : { notes: optionalText(x.notes, 1000) }),
  };
}
function sellerInput(value: unknown): FinanceSeller {
  const x = requireRecord(value);
  let bankAccount: FinanceSeller['bankAccount'];
  if (x.bankAccount !== undefined) {
    const b = requireRecord(x.bankAccount);
    const iban = optionalText(b.iban, 50).replace(/\s/g, '').toUpperCase();
    if (iban && !validSaudiIban(iban))
      throw fault(400, 'INVALID_BANK_IBAN', 'أدخل رقم IBAN سعوديًا صحيح الصيغة.');
    bankAccount = {
      beneficiaryName: optionalText(b.beneficiaryName, 200),
      bankName: optionalText(b.bankName, 120),
      accountNumber: optionalText(b.accountNumber, 34),
      iban,
    };
  }
  return {
    name: text(x.name, 200),
    vatNumber: validateVat(x.vatNumber),
    commercialRegistration: optionalText(x.commercialRegistration, 30),
    address: addressValue(x.address),
    ...(bankAccount === undefined ? {} : { bankAccount }),
  };
}
function validSaudiIban(iban: string): boolean {
  if (!/^SA\d{22}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 2).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))}${iban.slice(2, 4)}`;
  let remainder = 0;
  for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}
function decimal(value: unknown, maxScale: number, code: string): bigint {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^(?:0|[1-9]\\d{0,8})(?:\\.\\d{1,${maxScale}})?$`).test(value)
  )
    throw fault(400, code, 'صيغة المبلغ أو الكمية غير صالحة.');
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * 10n ** BigInt(maxScale) +
    BigInt((fraction + '0'.repeat(maxScale)).slice(0, maxScale))
  );
}
function lineItems(value: unknown): FinanceLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw fault(400, 'INVALID_LINES', 'أضف بندًا واحدًا على الأقل.');
  return value.map((raw) => {
    const x = requireRecord(raw),
      description = text(x.description, 300);
    const quantityScaled = decimal(x.quantity, 3, 'INVALID_QUANTITY');
    const priceHalalas = decimal(x.unitPrice, 2, 'INVALID_PRICE');
    if (quantityScaled <= 0n || priceHalalas <= 0n)
      throw fault(400, 'INVALID_AMOUNT', 'يجب أن تكون الكمية والسعر أكبر من صفر.');
    if (x.taxRateBps !== 0 && x.taxRateBps !== 1500)
      throw fault(400, 'INVALID_TAX_RATE', 'اختر 15% أو صفرًا للمعاينة.');
    const taxReason = optionalText(x.taxReason, 300);
    if (x.taxRateBps === 0 && !taxReason)
      throw fault(400, 'TAX_REASON_REQUIRED', 'اذكر سبب اختيار نسبة صفر في المعاينة.');
    // quantity is thousandths and unit price is halalas. Round line subtotal to halalas, then tax half-up.
    const subtotal = (quantityScaled * priceHalalas + 500n) / 1000n;
    const tax = (subtotal * BigInt(x.taxRateBps) + 5000n) / 10000n;
    const total = subtotal + tax;
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
      throw fault(400, 'AMOUNT_TOO_LARGE', 'قيمة البند تتجاوز الحد المدعوم.');
    return {
      description,
      quantity: x.quantity as string,
      unitPrice: x.unitPrice as string,
      taxRateBps: x.taxRateBps,
      taxReason,
      subtotalHalalas: Number(subtotal),
      taxHalalas: Number(tax),
      totalHalalas: Number(total),
    };
  });
}
function amounts(lines: FinanceLine[]) {
  const sum = (selector: (line: FinanceLine) => number) =>
    lines.reduce((total, line) => total + BigInt(selector(line)), 0n);
  const subtotal = sum((line) => line.subtotalHalalas),
    tax = sum((line) => line.taxHalalas),
    total = sum((line) => line.totalHalalas),
    max = BigInt(Number.MAX_SAFE_INTEGER);
  if (subtotal > max || tax > max || total > max)
    throw fault(400, 'AMOUNT_TOO_LARGE', 'إجمالي العرض يتجاوز الحد المدعوم.');
  return {
    subtotalHalalas: Number(subtotal),
    taxHalalas: Number(tax),
    totalHalalas: Number(total),
  };
}
function quoteLines(input: FinanceQuoteInput): FinanceLine[] {
  const lines = lineItems(input.lines);
  if (
    zeroLineDocumentTypes.includes(input.documentType ?? 'standard') &&
    lines.some((line) => line.taxRateBps !== 0)
  )
    throw fault(
      400,
      'ZERO_RATED_LINES_REQUIRED',
      'هذا النوع بلا ضريبة؛ اجعل كل البنود بنسبة صفر مع ذكر السبب.',
    );
  return lines;
}
function catalogInput(value: unknown): FinanceCatalogItemInput {
  const [line] = lineItems([{ ...requireRecord(value), quantity: '1' }]);
  return {
    description: line.description,
    unitPrice: line.unitPrice,
    taxRateBps: line.taxRateBps,
    taxReason: line.taxRateBps === 0 ? line.taxReason : '',
  };
}
function quoteInput(value: unknown): FinanceQuoteInput {
  const x = requireRecord(value),
    issueDate = dateValue(x.issueDate),
    validUntil = dateValue(x.validUntil);
  if (validUntil < issueDate)
    throw fault(400, 'INVALID_DATE_RANGE', 'تاريخ الانتهاء يسبق تاريخ الإصدار.');
  if (!Array.isArray(x.lines)) throw fault(400, 'INVALID_LINES', 'صيغة البنود غير صالحة.');
  const documentType = x.documentType === undefined ? 'standard' : x.documentType;
  if (!financeDocumentTypes.includes(documentType as FinanceDocumentType))
    throw fault(400, 'INVALID_DOCUMENT_TYPE', 'نوع المستند غير صالح.');
  return {
    customerId: text(x.customerId, 80),
    documentType: documentType as FinanceDocumentType,
    title: text(x.title, 200),
    issueDate,
    validUntil,
    notes: optionalText(x.notes, 2000),
    lines: x.lines as FinanceLineInput[],
  };
}
async function nextNumber(
  db: AsyncDb,
  ownerId: string,
  entity: 'quotes' | 'invoices',
  prefix: 'HR-Q' | 'HR-INV',
): Promise<string> {
  const row = (
    await db.read<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM finance_${entity} WHERE owner_id=?`,
      [ownerId],
    )
  )[0];
  const count = Number(row?.n ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count >= 999999)
    throw fault(409, 'NUMBER_SEQUENCE_EXHAUSTED', 'وصل ترقيم المعاينة إلى الحد المتاح.');
  return `${prefix}-${String(count + 1).padStart(6, '0')}`;
}
async function readCustomer(db: AsyncDb, ownerId: string, id: string): Promise<FinanceCustomer> {
  const row = (
    await db.read<CustomerRow>('SELECT * FROM finance_customers WHERE owner_id=? AND id=?', [
      ownerId,
      id,
    ])
  )[0];
  if (!row) throw fault(404, 'CUSTOMER_NOT_FOUND', 'العميل غير موجود.');
  return {
    ...safeJson<FinanceCustomerInput>(row.customer_ciphertext, `finance:customer:${row.id}`),
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    wafeqId: row.wafeq_id,
    syncStatus: row.sync_status,
    ...(row.sync_message ? { syncMessage: row.sync_message } : {}),
  };
}
function customerSnapshot(customer: FinanceCustomer): FinanceCustomerInput {
  const {
    id: _id,
    version: _version,
    createdAt: _createdAt,
    wafeqId: _wafeqId,
    syncStatus: _syncStatus,
    syncMessage: _syncMessage,
    ...input
  } = customer;
  return input;
}
async function readQuote(db: AsyncDb, ownerId: string, id: string): Promise<FinanceQuote> {
  const row = (
    await db.read<QuoteRow>('SELECT * FROM finance_quotes WHERE owner_id=? AND id=?', [ownerId, id])
  )[0];
  if (!row) throw fault(404, 'QUOTE_NOT_FOUND', 'عرض السعر غير موجود.');
  const quote = safeJson<FinanceQuote>(row.quote_ciphertext, `finance:quote:${row.id}`);
  return { ...quote, documentType: quote.documentType ?? 'standard' };
}
async function readCatalogItem(
  db: AsyncDb,
  ownerId: string,
  id: string,
): Promise<FinanceCatalogItem> {
  const row = (
    await db.read<CatalogRow>('SELECT * FROM finance_catalog_items WHERE owner_id=? AND id=?', [
      ownerId,
      id,
    ])
  )[0];
  if (!row) throw fault(404, 'CATALOG_ITEM_NOT_FOUND', 'البند المحفوظ غير موجود.');
  return catalogItem(row);
}
export async function readInvoice(
  db: AsyncDb,
  ownerId: string,
  id: string,
): Promise<FinanceInvoice> {
  const row = (
    await db.read<InvoiceRow>('SELECT * FROM finance_invoices WHERE owner_id=? AND id=?', [
      ownerId,
      id,
    ])
  )[0];
  if (!row) throw fault(404, 'INVOICE_NOT_FOUND', 'الفاتورة غير موجودة.');
  return safeJson<FinanceInvoice>(row.invoice_ciphertext, `finance:invoice:${row.id}`);
}
async function getSettings(
  db: AsyncDb,
  ownerId: string,
  privateMode: boolean,
): Promise<FinanceSettings> {
  const row = (
    await db.read<{
      version: number;
      seller_ciphertext: string;
      organization_ciphertext: string | null;
      revenue_account_id: string;
      standard_tax_rate_id: string;
      zero_tax_rate_id: string;
    }>(
      'SELECT version,seller_ciphertext,organization_ciphertext,revenue_account_id,standard_tax_rate_id,zero_tax_rate_id FROM finance_settings WHERE owner_id=?',
      [ownerId],
    )
  )[0];
  const key = (
    await db.read<{ owner_id: string }>(
      'SELECT owner_id FROM finance_provider_credentials WHERE owner_id=?',
      [ownerId],
    )
  )[0];
  return {
    seller: row
      ? safeJson<FinanceSeller>(row.seller_ciphertext, `finance:seller:${ownerId}`)
      : emptySeller(),
    version: row?.version ?? 1,
    mode: privateMode ? 'private' : 'preview',
    apiKeyConfigured: !!key,
    canStoreApiKey: privateMode,
    canSync: privateMode && !!key,
    connectionMessage: key
      ? 'اتصال وافق محفوظ؛ استخدم اختبار الاتصال للتحقق من الحالة.'
      : 'أدخل مفتاح وافق للتحقق من المؤسسة وربطه.',
    organization: row?.organization_ciphertext
      ? safeJson<{ id: string; name: string }>(
          row.organization_ciphertext,
          `finance:organization:${ownerId}`,
        )
      : null,
    revenueAccountId: row?.revenue_account_id ?? '',
    standardTaxRateId: row?.standard_tax_rate_id ?? '',
    zeroTaxRateId: row?.zero_tax_rate_id ?? '',
  };
}
async function storedClient(
  db: AsyncDb,
  ownerId: string,
  createClient?: (key: string) => WafeqProvider,
): Promise<WafeqProvider> {
  const row = (
    await db.read<{ api_key_ciphertext: string }>(
      'SELECT api_key_ciphertext FROM finance_provider_credentials WHERE owner_id=?',
      [ownerId],
    )
  )[0];
  if (!row) throw fault(503, 'WAFEQ_NOT_CONNECTED', 'لم يتم إعداد اتصال وافق.');
  let key: string;
  try {
    key = decryptSensitive(row.api_key_ciphertext, `finance:api-key:${ownerId}`);
  } catch {
    throw fault(503, 'WAFEQ_CREDENTIAL_UNAVAILABLE', 'تعذر قراءة بيانات اتصال وافق.');
  }
  return (createClient ?? ((value: string) => new WafeqClient(value)))(key);
}
async function reserveOperation(
  db: AsyncDb,
  ownerId: string,
  type: 'customer' | 'invoice',
  resourceId: string,
  /** Runs in the reservation transaction, before the operation is written. */
  guard?: (tx: AsyncDb) => Promise<void>,
): Promise<OperationRow> {
  return db.transaction(async (tx) => {
    const found = (
      await tx.read<OperationRow>(
        'SELECT id,idempotency_key,report_idempotency_key,state,provider_id,lease_until FROM finance_provider_operations WHERE owner_id=? AND resource_type=? AND resource_id=?',
        [ownerId, type, resourceId],
      )
    )[0];
    if (found?.state === 'complete') return found;
    const at = now(),
      leaseUntil = new Date(Date.now() + 60_000).toISOString();
    if (found?.state === 'in_flight' && found.lease_until && found.lease_until > at)
      throw fault(409, 'WAFEQ_SYNC_IN_PROGRESS', 'توجد مزامنة جارية لهذا السجل؛ انتظر اكتمالها.');
    if (guard) await guard(tx);
    if (found) {
      await tx.execute(
        "UPDATE finance_provider_operations SET state='in_flight',lease_until=?,updated_at=? WHERE owner_id=? AND id=?",
        [leaseUntil, at, ownerId, found.id],
      );
      return { ...found, state: 'in_flight', lease_until: leaseUntil };
    }
    const id = newId(),
      key = newId(),
      reportKey = newId(),
      createdAt = now();
    await tx.execute(
      "INSERT INTO finance_provider_operations(id,owner_id,resource_type,resource_id,idempotency_key,report_idempotency_key,state,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,'in_flight',?,?,?)",
      [id, ownerId, type, resourceId, key, reportKey, leaseUntil, createdAt, createdAt],
    );
    return {
      id,
      idempotency_key: key,
      report_idempotency_key: reportKey,
      state: 'in_flight',
      provider_id: null,
      lease_until: leaseUntil,
    };
  });
}
function providerFailure(error: unknown) {
  const safeCode = error instanceof WafeqApiError ? error.code : 'provider_unavailable';
  return { syncMessage: `تعذر إكمال المزامنة (${safeCode}).` };
}
async function setCustomerSync(
  db: AsyncDb,
  actor: Actor,
  row: CustomerRow,
  wafeqId: string | null,
  status: 'not_synced' | 'synced' | 'error',
  syncMessage?: string,
) {
  const current = safeJson<FinanceCustomerInput>(
    row.customer_ciphertext,
    `finance:customer:${row.id}`,
  );
  const updated: FinanceCustomer = {
    ...current,
    id: row.id,
    version: row.version + 1,
    createdAt: row.created_at,
    wafeqId,
    syncStatus: status,
    ...(syncMessage ? { syncMessage } : {}),
  };
  await db.transaction(async (tx) => {
    const result = await tx.execute(
      'UPDATE finance_customers SET version=?,customer_ciphertext=?,updated_at=?,wafeq_id=?,sync_status=?,sync_message=? WHERE owner_id=? AND id=? AND version=?',
      [
        updated.version,
        encryptSensitive(JSON.stringify(current), `finance:customer:${row.id}`),
        now(),
        wafeqId,
        status,
        syncMessage ?? null,
        actor.id,
        row.id,
        row.version,
      ],
    );
    if (result.rowCount !== 1)
      throw fault(
        409,
        'VERSION_CONFLICT',
        'تغير سجل العميل أثناء المزامنة؛ حدّث البيانات ثم أعد المحاولة.',
      );
    await audited(
      tx,
      actor,
      'finance_customer',
      row.id,
      status === 'synced' ? 'sync_completed' : 'sync_failed',
      updated.version,
    );
  });
  return updated;
}
function mappedInvoiceStatus(status: 'pending' | 'cleared' | 'rejected' | 'unknown'): {
  status: FinanceInvoice['status'];
  zatcaStatus: FinanceInvoice['zatcaStatus'];
  canDownload: boolean;
} {
  if (status === 'cleared') return { status: 'cleared', zatcaStatus: 'cleared', canDownload: true };
  if (status === 'pending')
    return { status: 'pending', zatcaStatus: 'pending', canDownload: false };
  if (status === 'rejected')
    return { status: 'rejected', zatcaStatus: 'rejected', canDownload: false };
  return { status: 'reconciliation_required', zatcaStatus: 'unknown', canDownload: false };
}
async function updateInvoiceSnapshot(
  db: AsyncDb,
  actor: Actor,
  current: FinanceInvoice,
  changes: Partial<FinanceInvoice>,
  providerId?: string,
) {
  const next = {
    ...current,
    ...changes,
    version: current.version + 1,
    wafeqId: providerId ?? current.wafeqId,
  };
  await db.transaction(async (tx) => {
    const result = await tx.execute(
      'UPDATE finance_invoices SET number=?,version=version+1,invoice_ciphertext=? WHERE owner_id=? AND id=? AND version=?',
      [
        next.number,
        encryptSensitive(JSON.stringify(next), `finance:invoice:${next.id}`),
        actor.id,
        next.id,
        current.version,
      ],
    );
    if (result.rowCount !== 1)
      throw fault(409, 'VERSION_CONFLICT', 'تغيرت الفاتورة أثناء المزامنة؛ أعد قراءة الحالة.');
    await audited(
      tx,
      actor,
      'finance_invoice',
      '' + next.id,
      'provider_status_updated',
      next.version,
    );
  });
  return next;
}
function sendErr(res: Response, error: unknown) {
  const e = error as { status?: number; code?: string; message?: string };
  res.status(e.status ?? 500).json({
    error: {
      code: e.code ?? 'INTERNAL_ERROR',
      message: e.status ? e.message : 'تعذر إكمال العملية.',
    },
  });
}
function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void handler(req, res).catch((e) => sendErr(res, e));
  };
}
export function audited(
  db: AsyncDb,
  actor: Actor,
  kind: string,
  id: string,
  action: string,
  version: number,
) {
  return db.execute(
    'INSERT INTO administration_events(id,resource_type,resource_id,actor_id,actor_role,action,reason,details_json,resource_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [
      newId(),
      kind,
      id,
      actor.id,
      actor.role,
      action,
      'Finance preview action',
      '{}',
      version,
      now(),
    ],
  );
}
export function requireFinance(actor: Actor, access: FinanceAccessOptions) {
  actorOrThrow(actor);
  owner(actor, access);
}
export function idempotent<T>(
  db: AsyncDb,
  actor: Actor,
  action: string,
  key: string | undefined,
  payload: unknown,
  operation: (tx: AsyncDb) => Promise<{ marker: { type: string; id: string }; result: T }>,
  replay: (tx: AsyncDb, marker: { type: string; id: string }) => Promise<T>,
) {
  return coreIdempotent(db, actor, action, key, payload, replay, operation);
}

export function registerFinance(
  app: Express,
  { db, requireActor, privateMode = false, allowedActorId, createClient }: Options,
) {
  const access = { privateMode, allowedActorId };
  const clientFactory = createClient ?? ((apiKey: string) => new WafeqClient(apiKey));
  const auth = (req: Request) => requireActor(req);
  registerRoute(app, 'get', '/api/finance', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const ownerId = actor.id;
    const cRows = await db.read<CustomerRow>(
      'SELECT * FROM finance_customers WHERE owner_id=? ORDER BY created_at DESC',
      [ownerId],
    );
    const qRows = await db.read<QuoteRow>(
      'SELECT * FROM finance_quotes WHERE owner_id=? ORDER BY created_at DESC',
      [ownerId],
    );
    const iRows = await db.read<InvoiceRow>(
      'SELECT * FROM finance_invoices WHERE owner_id=? ORDER BY created_at DESC',
      [ownerId],
    );
    const customers = await Promise.all(cRows.map((r) => readCustomer(db, ownerId, r.id)));
    const quotes = await Promise.all(qRows.map((r) => readQuote(db, ownerId, r.id)));
    const invoices = await Promise.all(iRows.map((r) => readInvoice(db, ownerId, r.id)));
    const settings = await getSettings(db, ownerId, privateMode);
    const catalog = (
      await db.read<CatalogRow>(
        'SELECT * FROM finance_catalog_items WHERE owner_id=? ORDER BY created_at DESC',
        [ownerId],
      )
    ).map(catalogItem);
    const result: FinanceOverview = { customers, catalog, quotes, invoices, settings };
    res.json(result);
  });
  registerRoute(app, 'get', '/api/finance/settings', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    res.json({ settings: await getSettings(db, actor.id, privateMode) });
  });
  registerRoute(app, 'patch', '/api/finance/settings', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const b = requireRecord(req.body),
      version = versionValue(b.version),
      seller = sellerInput(b.seller);
    const revenueAccountId = optionalText(b.revenueAccountId, 120),
      standardTaxRateId = optionalText(b.standardTaxRateId, 120),
      zeroTaxRateId = optionalText(b.zeroTaxRateId, 120);
    const result = await idempotent<{ settings: FinanceSettings }>(
      db,
      actor,
      'finance.settings',
      req.get('idempotency-key'),
      { version, seller, revenueAccountId, standardTaxRateId, zeroTaxRateId },
      async (tx) => {
        const row = (
          await tx.read<{ version: number }>(
            'SELECT version FROM finance_settings WHERE owner_id=?',
            [actor.id],
          )
        )[0];
        if ((row?.version ?? 1) !== version)
          throw fault(409, 'VERSION_CONFLICT', 'تغيرت الإعدادات؛ حدّث الصفحة ثم أعد المحاولة.');
        const next = version + 1;
        const cipher = encryptSensitive(JSON.stringify(seller), `finance:seller:${actor.id}`);
        if (row) {
          const changed = await tx.execute(
            'UPDATE finance_settings SET version=?,seller_ciphertext=?,revenue_account_id=?,standard_tax_rate_id=?,zero_tax_rate_id=?,updated_at=? WHERE owner_id=? AND version=?',
            [
              next,
              cipher,
              revenueAccountId,
              standardTaxRateId,
              zeroTaxRateId,
              now(),
              actor.id,
              version,
            ],
          );
          if (changed.rowCount !== 1)
            throw fault(
              409,
              'VERSION_CONFLICT',
              'تغيرت الإعدادات أثناء الحفظ؛ حدّث الصفحة ثم أعد المحاولة.',
            );
        } else
          await tx.execute(
            'INSERT INTO finance_settings(owner_id,version,seller_ciphertext,revenue_account_id,standard_tax_rate_id,zero_tax_rate_id,updated_at) VALUES(?,?,?,?,?,?,?)',
            [actor.id, next, cipher, revenueAccountId, standardTaxRateId, zeroTaxRateId, now()],
          );
        await audited(tx, actor, 'finance_settings', actor.id, 'seller_updated', next);
        return {
          marker: { type: 'settings', id: actor.id },
          result: { settings: await getSettings(tx, actor.id, privateMode) },
        };
      },
      async (tx) => ({ settings: await getSettings(tx, actor.id, privateMode) }),
    );
    res.json(result);
  });
  registerRoute(app, 'post', '/api/finance/settings/api-key', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    if (!privateMode)
      throw fault(409, 'PRIVATE_FINANCE_REQUIRED', 'إعداد الربط متاح في النسخة الخاصة فقط.');
    const b = requireRecord(req.body),
      apiKey = text(b.apiKey, 2000);
    // Require the request key, but never persist a hash or payload for this secret-bearing route.
    if (!req.get('idempotency-key')?.trim())
      throw fault(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع تكرار صالحًا.');
    const organization = await clientFactory(apiKey).getOrganization();
    const keyCipher = encryptSensitive(apiKey, `finance:api-key:${actor.id}`),
      orgCipher = encryptSensitive(
        JSON.stringify(organization),
        `finance:credential-organization:${actor.id}`,
      );
    await db.transaction(async (tx) => {
      const previous = (
        await tx.read<{ organization_ciphertext: string }>(
          'SELECT organization_ciphertext FROM finance_provider_credentials WHERE owner_id=?',
          [actor.id],
        )
      )[0];
      if (previous) {
        const current = safeJson<{ id: string; name: string }>(
          previous.organization_ciphertext,
          `finance:credential-organization:${actor.id}`,
        );
        if (current.id !== organization.id)
          throw fault(409, 'WAFEQ_ORGANIZATION_MISMATCH', 'المفتاح الجديد ينتمي إلى مؤسسة مختلفة.');
      }
      await tx.execute(
        'INSERT INTO finance_provider_credentials(owner_id,api_key_ciphertext,organization_ciphertext,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET api_key_ciphertext=excluded.api_key_ciphertext,organization_ciphertext=excluded.organization_ciphertext,updated_at=excluded.updated_at',
        [actor.id, keyCipher, orgCipher, now()],
      );
      const s = (
        await tx.read<{
          version: number;
          seller_ciphertext: string;
          revenue_account_id: string;
          standard_tax_rate_id: string;
          zero_tax_rate_id: string;
        }>(
          'SELECT version,seller_ciphertext,revenue_account_id,standard_tax_rate_id,zero_tax_rate_id FROM finance_settings WHERE owner_id=?',
          [actor.id],
        )
      )[0];
      if (s)
        await tx.execute(
          'UPDATE finance_settings SET organization_ciphertext=?,updated_at=? WHERE owner_id=?',
          [
            encryptSensitive(JSON.stringify(organization), `finance:organization:${actor.id}`),
            now(),
            actor.id,
          ],
        );
      else
        await tx.execute(
          'INSERT INTO finance_settings(owner_id,version,seller_ciphertext,organization_ciphertext,updated_at) VALUES(?,1,?,?,?)',
          [
            actor.id,
            encryptSensitive(JSON.stringify(emptySeller()), `finance:seller:${actor.id}`),
            encryptSensitive(JSON.stringify(organization), `finance:organization:${actor.id}`),
            now(),
          ],
        );
      await audited(tx, actor, 'finance_settings', actor.id, 'provider_key_saved', s?.version ?? 1);
    });
    res.json({ settings: await getSettings(db, actor.id, privateMode) });
  });
  registerRoute(app, 'post', '/api/finance/settings/test', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const client = await storedClient(db, actor.id, clientFactory),
      organization = await client.getOrganization();
    const saved = (
      await db.read<{ organization_ciphertext: string }>(
        'SELECT organization_ciphertext FROM finance_provider_credentials WHERE owner_id=?',
        [actor.id],
      )
    )[0];
    if (!saved) throw fault(503, 'WAFEQ_NOT_CONNECTED', 'لم يتم إعداد اتصال وافق.');
    const bound = safeJson<{ id: string; name: string }>(
      saved.organization_ciphertext,
      `finance:credential-organization:${actor.id}`,
    );
    if (bound.id !== organization.id)
      throw fault(409, 'WAFEQ_ORGANIZATION_MISMATCH', 'المفتاح المحفوظ يشير إلى مؤسسة مختلفة.');
    res.json({ settings: await getSettings(db, actor.id, privateMode) });
  });
  registerRoute(app, 'post', '/api/finance/customers', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const input = customerInput(req.body);
    const customer = await idempotent<{ id: string }>(
      db,
      actor,
      'finance.customer.create',
      req.get('idempotency-key'),
      input,
      async (tx) => {
        const id = newId(),
          createdAt = now(),
          cipher = encryptSensitive(JSON.stringify(input), `finance:customer:${id}`);
        await tx.execute(
          'INSERT INTO finance_customers(id,owner_id,version,customer_ciphertext,created_at,updated_at) VALUES(?,?,1,?,?,?)',
          [id, actor.id, cipher, createdAt, createdAt],
        );
        await audited(tx, actor, 'finance_customer', id, 'created', 1);
        return { marker: { type: 'customer', id }, result: { id } };
      },
      async (_tx, m) => ({ id: m.id }),
    );
    res.status(201).json({ customer: await readCustomer(db, actor.id, customer.id) });
  });
  registerRoute(app, 'patch', '/api/finance/customers/:id', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const b = requireRecord(req.body),
      version = versionValue(b.version),
      input = customerInput(b);
    const saved = await idempotent<{ id: string }>(
      db,
      actor,
      `finance.customer.update:${routeId(req.params.id)}`,
      req.get('idempotency-key'),
      { version, input },
      async (tx) => {
        const row = (
          await tx.read<CustomerRow>('SELECT * FROM finance_customers WHERE owner_id=? AND id=?', [
            actor.id,
            routeId(req.params.id),
          ])
        )[0];
        if (!row) throw fault(404, 'CUSTOMER_NOT_FOUND', 'العميل غير موجود.');
        if (row.sync_status === 'synced')
          throw fault(
            409,
            'SYNCED_CUSTOMER_IMMUTABLE',
            'لا يمكن تعديل العميل بعد مزامنته مع وافق.',
          );
        const operation = (
          await tx.read<{ state: string }>(
            "SELECT state FROM finance_provider_operations WHERE owner_id=? AND resource_type='customer' AND resource_id=?",
            [actor.id, row.id],
          )
        )[0];
        if (operation)
          throw fault(
            409,
            'CUSTOMER_SYNC_UNCERTAIN',
            'تعذر حسم حالة العميل في وافق؛ أكمل المصالحة قبل تعديل بياناته.',
          );
        if (row.version !== version)
          throw fault(409, 'VERSION_CONFLICT', 'تغير العميل؛ حدّث الصفحة ثم أعد المحاولة.');
        const next = version + 1;
        const cipher = encryptSensitive(JSON.stringify(input), `finance:customer:${row.id}`);
        const changed = await tx.execute(
          'UPDATE finance_customers SET version=?,customer_ciphertext=?,updated_at=? WHERE owner_id=? AND id=? AND version=?',
          [next, cipher, now(), actor.id, row.id, version],
        );
        if (changed.rowCount !== 1)
          throw fault(409, 'VERSION_CONFLICT', 'تغير العميل؛ حدّث الصفحة ثم أعد المحاولة.');
        await audited(tx, actor, 'finance_customer', row.id, 'updated', next);
        return { marker: { type: 'customer', id: row.id }, result: { id: row.id } };
      },
      async (_tx, m) => ({ id: m.id }),
    );
    res.json({ customer: await readCustomer(db, actor.id, saved.id) });
  });
  registerRoute(app, 'post', '/api/finance/customers/:id/sync', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const id = routeId(req.params.id),
      body = requireRecord(req.body),
      version = versionValue(body.version);
    if (!req.get('idempotency-key')?.trim())
      throw fault(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع تكرار صالحًا.');
    const initial = (
      await db.read<CustomerRow>('SELECT * FROM finance_customers WHERE owner_id=? AND id=?', [
        actor.id,
        id,
      ])
    )[0];
    if (!initial) throw fault(404, 'CUSTOMER_NOT_FOUND', 'العميل غير موجود.');
    if (initial.sync_status === 'synced' && initial.wafeq_id) {
      res.json({ customer: await readCustomer(db, actor.id, id) });
      return;
    }
    const priorOperation = (
      await db.read<OperationRow>(
        "SELECT id,idempotency_key,report_idempotency_key,state,provider_id FROM finance_provider_operations WHERE owner_id=? AND resource_type='customer' AND resource_id=?",
        [actor.id, id],
      )
    )[0];
    if (priorOperation?.state === 'complete' && priorOperation.provider_id) {
      const customer = await setCustomerSync(
        db,
        actor,
        initial,
        priorOperation.provider_id,
        'synced',
      );
      res.json({ customer });
      return;
    }
    if (!priorOperation && initial.version !== version)
      throw fault(409, 'VERSION_CONFLICT', 'تغير العميل؛ حدّث الصفحة ثم أعد المحاولة.');
    const client = await storedClient(db, actor.id, createClient);
    // Claim the customer's version in the same transaction that records the operation, so an
    // edit committed after `initial` was read cannot be sent or marked synced from a stale copy.
    const operation = await reserveOperation(db, actor.id, 'customer', id, async (tx) => {
      const claimed = await tx.execute(
        'UPDATE finance_customers SET version=version+1,updated_at=? WHERE owner_id=? AND id=? AND version=?',
        [now(), actor.id, id, initial.version],
      );
      if (claimed.rowCount !== 1)
        throw fault(409, 'VERSION_CONFLICT', 'تغير العميل؛ حدّث الصفحة ثم أعد المحاولة.');
    });
    const reserved = (
      await db.read<CustomerRow>('SELECT * FROM finance_customers WHERE owner_id=? AND id=?', [
        actor.id,
        id,
      ])
    )[0];
    const input = safeJson<FinanceCustomerInput>(
      reserved.customer_ciphertext,
      `finance:customer:${id}`,
    );
    let created: { id: string };
    try {
      const found = await client.findCustomerByExternalId(id);
      created = found ?? (await client.createCustomer(input, id, operation.idempotency_key));
    } catch (error) {
      const safe = providerFailure(error);
      await db.execute(
        "UPDATE finance_provider_operations SET state='reconciliation_required',lease_until=NULL,updated_at=? WHERE owner_id=? AND id=?",
        [now(), actor.id, operation.id],
      );
      const customer = await setCustomerSync(
        db,
        actor,
        reserved,
        reserved.wafeq_id,
        'error',
        safe.syncMessage,
      );
      res.status(503).json({
        error: {
          code: 'WAFEQ_SYNC_UNCERTAIN',
          message: 'تعذر تأكيد مزامنة العميل؛ أعد المحاولة للتحقق من وافق.',
        },
        customer,
      });
      return;
    }
    await db.execute(
      "UPDATE finance_provider_operations SET state='complete',provider_id=?,lease_until=NULL,updated_at=? WHERE owner_id=? AND id=?",
      [created.id, now(), actor.id, operation.id],
    );
    const customer = await setCustomerSync(db, actor, reserved, created.id, 'synced');
    res.json({ customer });
  });
  registerRoute(app, 'post', '/api/finance/catalog', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const input = catalogInput(req.body);
    const item = await idempotent<{ id: string }>(
      db,
      actor,
      'finance.catalog.create',
      req.get('idempotency-key'),
      input,
      async (tx) => {
        const id = newId(),
          createdAt = now();
        await tx.execute(
          'INSERT INTO finance_catalog_items(id,owner_id,version,description,unit_price,tax_rate_bps,tax_reason,active,created_at,updated_at) VALUES(?,?,1,?,?,?,?,1,?,?)',
          [
            id,
            actor.id,
            input.description,
            input.unitPrice,
            input.taxRateBps,
            input.taxReason,
            createdAt,
            createdAt,
          ],
        );
        await audited(tx, actor, 'finance_catalog_item', id, 'created', 1);
        return { marker: { type: 'catalog_item', id }, result: { id } };
      },
      async (_tx, m) => ({ id: m.id }),
    );
    res.status(201).json({ item: await readCatalogItem(db, actor.id, item.id) });
  });
  registerRoute(app, 'patch', '/api/finance/catalog/:id', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const b = requireRecord(req.body),
      version = versionValue(b.version),
      input = catalogInput(b);
    if (typeof b.active !== 'boolean')
      throw fault(400, 'INVALID_ACTIVE', 'حدد إن كان البند متاحًا للإدراج.');
    const active = b.active;
    const saved = await idempotent<{ id: string }>(
      db,
      actor,
      `finance.catalog.update:${routeId(req.params.id)}`,
      req.get('idempotency-key'),
      { version, input, active },
      async (tx) => {
        const current = await readCatalogItem(tx, actor.id, routeId(req.params.id));
        if (current.version !== version)
          throw fault(409, 'VERSION_CONFLICT', 'تغير البند؛ حدّث الصفحة ثم أعد المحاولة.');
        const next = version + 1;
        await tx.execute(
          'UPDATE finance_catalog_items SET version=?,description=?,unit_price=?,tax_rate_bps=?,tax_reason=?,active=?,updated_at=? WHERE owner_id=? AND id=? AND version=?',
          [
            next,
            input.description,
            input.unitPrice,
            input.taxRateBps,
            input.taxReason,
            active ? 1 : 0,
            now(),
            actor.id,
            current.id,
            version,
          ],
        );
        await audited(
          tx,
          actor,
          'finance_catalog_item',
          current.id,
          current.active && !active ? 'archived' : 'updated',
          next,
        );
        return { marker: { type: 'catalog_item', id: current.id }, result: { id: current.id } };
      },
      async (_tx, m) => ({ id: m.id }),
    );
    res.json({ item: await readCatalogItem(db, actor.id, saved.id) });
  });
  registerRoute(app, 'post', '/api/finance/quotes', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const input = quoteInput(req.body);
    const quote = await idempotent<{ id: string }>(
      db,
      actor,
      'finance.quote.create',
      req.get('idempotency-key'),
      input,
      async (tx) => {
        const customer = await readCustomer(tx, actor.id, input.customerId);
        const seller = await getSettings(tx, actor.id, privateMode).then((x) => x.seller);
        const lines = quoteLines(input),
          totals = amounts(lines),
          id = newId(),
          createdAt = now(),
          number = await nextNumber(tx, actor.id, 'quotes', 'HR-Q');
        const snapshot: FinanceQuote = {
          ...input,
          documentType: input.documentType ?? 'standard',
          id,
          number,
          version: 1,
          status: 'draft',
          currency: 'SAR',
          customer: customerSnapshot(customer),
          seller,
          lines,
          ...totals,
          invoiceId: null,
          createdAt,
        };
        await tx.execute(
          'INSERT INTO finance_quotes(id,owner_id,customer_id,number,version,status,quote_ciphertext,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)',
          [
            id,
            actor.id,
            customer.id,
            number,
            'draft',
            encryptSensitive(JSON.stringify(snapshot), `finance:quote:${id}`),
            createdAt,
            createdAt,
          ],
        );
        await audited(tx, actor, 'finance_quote', id, 'created', 1);
        return { marker: { type: 'quote', id }, result: { id } };
      },
      async (_tx, m) => ({ id: m.id }),
    );
    res.status(201).json({ quote: await readQuote(db, actor.id, quote.id) });
  });
  registerRoute(app, 'patch', '/api/finance/quotes/:id', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const b = requireRecord(req.body),
      version = versionValue(b.version),
      input = quoteInput(b);
    const saved = await idempotent<{ id: string }>(
      db,
      actor,
      `finance.quote.update:${routeId(req.params.id)}`,
      req.get('idempotency-key'),
      { version, input },
      async (tx) => {
        const row = (
          await tx.read<QuoteRow>('SELECT * FROM finance_quotes WHERE owner_id=? AND id=?', [
            actor.id,
            routeId(req.params.id),
          ])
        )[0];
        if (!row) throw fault(404, 'QUOTE_NOT_FOUND', 'عرض السعر غير موجود.');
        if (row.status !== 'draft')
          throw fault(409, 'QUOTE_IMMUTABLE', 'لا يمكن تعديل عرض السعر بعد تحويله.');
        if (row.version !== version)
          throw fault(409, 'VERSION_CONFLICT', 'تغير عرض السعر؛ حدّث الصفحة ثم أعد المحاولة.');
        const customer = await readCustomer(tx, actor.id, input.customerId);
        const seller = (await getSettings(tx, actor.id, privateMode)).seller;
        const lines = quoteLines(input),
          totals = amounts(lines),
          next = version + 1;
        const snapshot: FinanceQuote = {
          ...input,
          documentType: input.documentType ?? 'standard',
          id: row.id,
          number: row.number,
          version: next,
          status: 'draft',
          currency: 'SAR',
          customer: customerSnapshot(customer),
          seller,
          lines,
          ...totals,
          invoiceId: null,
          createdAt: row.created_at,
        };
        await tx.execute(
          "UPDATE finance_quotes SET customer_id=?,version=?,quote_ciphertext=?,updated_at=? WHERE owner_id=? AND id=? AND version=? AND status='draft'",
          [
            customer.id,
            next,
            encryptSensitive(JSON.stringify(snapshot), `finance:quote:${row.id}`),
            now(),
            actor.id,
            row.id,
            version,
          ],
        );
        await audited(tx, actor, 'finance_quote', row.id, 'updated', next);
        return { marker: { type: 'quote', id: row.id }, result: { id: row.id } };
      },
      async (_tx, m) => ({ id: m.id }),
    );
    res.json({ quote: await readQuote(db, actor.id, saved.id) });
  });
  registerRoute(app, 'post', '/api/finance/quotes/:id/convert', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const b = requireRecord(req.body),
      version = versionValue(b.version),
      issueDate = dateValue(b.issueDate),
      dueDate = dateValue(b.dueDate),
      requestedType = b.invoiceType,
      purchaseOrder = optionalText(b.purchaseOrder, 120);
    if (
      requestedType !== undefined &&
      requestedType !== 'standard' &&
      requestedType !== 'simplified'
    )
      throw fault(400, 'INVALID_INVOICE_TYPE', 'نوع الفاتورة غير صالح.');
    if (dueDate < issueDate)
      throw fault(400, 'INVALID_DATE_RANGE', 'تاريخ الاستحقاق يسبق تاريخ الإصدار.');
    const invoice = await idempotent<{ id: string }>(
      db,
      actor,
      `finance.quote.convert:${routeId(req.params.id)}`,
      req.get('idempotency-key'),
      { version, issueDate, dueDate, invoiceType: requestedType, purchaseOrder },
      async (tx) => {
        const row = (
          await tx.read<QuoteRow>('SELECT * FROM finance_quotes WHERE owner_id=? AND id=?', [
            actor.id,
            routeId(req.params.id),
          ])
        )[0];
        if (!row) throw fault(404, 'QUOTE_NOT_FOUND', 'عرض السعر غير موجود.');
        const prior = (
          await tx.read<InvoiceRow>(
            'SELECT * FROM finance_invoices WHERE owner_id=? AND quote_id=?',
            [actor.id, row.id],
          )
        )[0];
        if (prior) return { marker: { type: 'invoice', id: prior.id }, result: { id: prior.id } };
        if (row.status !== 'draft')
          throw fault(409, 'QUOTE_IMMUTABLE', 'عرض السعر غير قابل للتحويل مرة أخرى.');
        if (row.version !== version)
          throw fault(409, 'VERSION_CONFLICT', 'تغير عرض السعر؛ حدّث الصفحة ثم أعد المحاولة.');
        const q = await readQuote(tx, actor.id, row.id);
        // The invoice type is fixed when the quote is prepared, so its line taxes already match.
        const invoiceType = q.documentType === 'simplified' ? 'simplified' : 'standard';
        if (requestedType !== undefined && requestedType !== invoiceType)
          throw fault(
            409,
            'INVOICE_TYPE_MISMATCH',
            'نوع الفاتورة يُحدد في عرض السعر؛ عدّل العرض لتغييره.',
          );
        const currentCustomer = await readCustomer(tx, actor.id, q.customerId);
        if (JSON.stringify(customerSnapshot(currentCustomer)) !== JSON.stringify(q.customer))
          throw fault(
            409,
            'QUOTE_SNAPSHOT_STALE',
            'تغيرت بيانات العميل؛ حدّث عرض السعر قبل تحويله.',
          );
        const currentSeller = (await getSettings(tx, actor.id, privateMode)).seller;
        if (JSON.stringify(currentSeller) !== JSON.stringify(q.seller))
          throw fault(
            409,
            'SELLER_SNAPSHOT_STALE',
            'تغيرت بيانات البائع؛ حدّث عرض السعر قبل تحويله.',
          );
        const id = newId(),
          createdAt = now(),
          next = version + 1,
          invoiceSequence = await nextNumber(tx, actor.id, 'invoices', 'HR-INV');
        const snapshot: FinanceInvoice = {
          id,
          number: invoiceSequence,
          quoteId: row.id,
          quoteNumber: row.number,
          title: q.title,
          version: 1,
          issueDate,
          dueDate,
          status: 'draft',
          invoiceType,
          documentType: q.documentType,
          ...(purchaseOrder ? { purchaseOrder } : {}),
          currency: 'SAR',
          customer: q.customer,
          seller: q.seller,
          lines: q.lines,
          notes: q.notes,
          subtotalHalalas: q.subtotalHalalas,
          taxHalalas: q.taxHalalas,
          totalHalalas: q.totalHalalas,
          wafeqId: null,
          zatcaStatus: 'not_submitted',
          qrCode: null,
          canDownload: false,
          canDownloadXml: false,
          createdAt,
        };
        await tx.execute(
          'INSERT INTO finance_invoices(id,owner_id,quote_id,number,version,invoice_ciphertext,created_at) VALUES(?,?,?,?,1,?,?)',
          [
            id,
            actor.id,
            row.id,
            snapshot.number,
            encryptSensitive(JSON.stringify(snapshot), `finance:invoice:${id}`),
            createdAt,
          ],
        );
        const converted = { ...q, status: 'converted' as const, version: next, invoiceId: id };
        await tx.execute(
          "UPDATE finance_quotes SET status='converted',invoice_id=?,version=?,quote_ciphertext=?,updated_at=? WHERE owner_id=? AND id=? AND version=? AND status='draft'",
          [
            id,
            next,
            encryptSensitive(JSON.stringify(converted), `finance:quote:${row.id}`),
            createdAt,
            actor.id,
            row.id,
            version,
          ],
        );
        await audited(tx, actor, 'finance_invoice', id, 'draft_created', 1);
        return { marker: { type: 'invoice', id }, result: { id } };
      },
      async (_tx, m) => ({ id: m.id }),
    );
    res.status(201).json({ invoice: await readInvoice(db, actor.id, invoice.id) });
  });
  registerRoute(app, 'post', '/api/finance/invoices/:id/sync', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const id = routeId(req.params.id),
      body = requireRecord(req.body);
    const expectedVersion = versionValue(body.version);
    if (!req.get('idempotency-key')?.trim())
      throw fault(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع تكرار صالحًا.');
    const invoice = await readInvoice(db, actor.id, id);
    const priorOperation = (
      await db.read<OperationRow>(
        "SELECT id,idempotency_key,report_idempotency_key,state,provider_id FROM finance_provider_operations WHERE owner_id=? AND resource_type='invoice' AND resource_id=?",
        [actor.id, id],
      )
    )[0];
    if (invoice.wafeqId && (!priorOperation || priorOperation.state === 'complete')) {
      res.json({ invoice });
      return;
    }
    if (!priorOperation && invoice.version !== expectedVersion)
      throw fault(409, 'VERSION_CONFLICT', 'تغيرت الفاتورة؛ حدّث الصفحة ثم أعد المحاولة.');
    if (invoice.invoiceType === 'simplified' || invoice.customer.type === 'individual')
      throw fault(
        409,
        'WAFEQ_INVOICE_TYPE_UNSUPPORTED',
        'نوع الفاتورة المبسطة أو العميل الفردي غير مدعوم في موصل وافق الحالي.',
      );
    if (!invoice.seller.name || !/^3\d{13}3$/.test(invoice.seller.vatNumber))
      throw fault(
        409,
        'SELLER_PROFILE_REQUIRED',
        'أكمل اسم البائع ورقم ضريبته الصحيح قبل إرسال الفاتورة إلى وافق.',
      );
    const quote = (
      await db.read<QuoteRow>('SELECT * FROM finance_quotes WHERE owner_id=? AND id=?', [
        actor.id,
        invoice.quoteId,
      ])
    )[0];
    if (!quote) throw fault(409, 'QUOTE_NOT_FOUND', 'عرض السعر المرتبط بالفاتورة غير موجود.');
    const quoteSnapshot = safeJson<FinanceQuote>(
      quote.quote_ciphertext,
      `finance:quote:${quote.id}`,
    );
    const customerRow = (
      await db.read<CustomerRow>('SELECT * FROM finance_customers WHERE owner_id=? AND id=?', [
        actor.id,
        quoteSnapshot.customerId,
      ])
    )[0];
    if (!customerRow || customerRow.sync_status !== 'synced' || !customerRow.wafeq_id)
      throw fault(409, 'CUSTOMER_SYNC_REQUIRED', 'زامن العميل مع وافق قبل إنشاء الفاتورة.');
    const currentCustomer = await readCustomer(db, actor.id, customerRow.id);
    if (JSON.stringify(customerSnapshot(currentCustomer)) !== JSON.stringify(invoice.customer))
      throw fault(
        409,
        'CUSTOMER_SNAPSHOT_STALE',
        'تغيرت بيانات العميل بعد إصدار المسودة؛ راجع نسخة الفاتورة قبل المزامنتها.',
      );
    const currentSeller = (await getSettings(db, actor.id, privateMode)).seller;
    if (JSON.stringify(currentSeller) !== JSON.stringify(invoice.seller))
      throw fault(
        409,
        'SELLER_SNAPSHOT_STALE',
        'تغيرت بيانات البائع بعد إصدار المسودة؛ راجع نسخة الفاتورة قبل المزامنتها.',
      );
    const settings = (
      await db.read<{
        revenue_account_id: string;
        standard_tax_rate_id: string;
        zero_tax_rate_id: string;
      }>(
        'SELECT revenue_account_id,standard_tax_rate_id,zero_tax_rate_id FROM finance_settings WHERE owner_id=?',
        [actor.id],
      )
    )[0];
    if (!settings?.revenue_account_id || !settings.standard_tax_rate_id)
      throw fault(
        409,
        'WAFAQ_MAPPINGS_REQUIRED',
        'أكمل ربط حساب الإيراد ونسبة الضريبة القياسية في الإعدادات.',
      );
    if (invoice.lines.some((line) => line.taxRateBps === 0))
      throw fault(
        409,
        'ZERO_TAX_INVOICE_UNSUPPORTED',
        'إصدار الفواتير ذات الضريبة الصفرية غير مدعوم حاليًا؛ لم يُرسل أي طلب إلى وافق.',
      );
    const client = await storedClient(db, actor.id, clientFactory);
    const operation = await reserveOperation(db, actor.id, 'invoice', id);
    let current = await updateInvoiceSnapshot(db, actor, invoice, {
      status: 'syncing',
      zatcaStatus: 'pending',
      canDownload: false,
      canDownloadXml: false,
      qrCode: null,
      syncMessage: undefined,
    });
    const failSync = async (error: unknown, snapshot: FinanceInvoice) => {
      const safe = providerFailure(error);
      const updated = await updateInvoiceSnapshot(db, actor, snapshot, {
        status: 'reconciliation_required',
        zatcaStatus: 'unknown',
        canDownload: false,
        qrCode: null,
        canDownloadXml: false,
        syncMessage: safe.syncMessage,
      });
      await db.execute(
        "UPDATE finance_provider_operations SET state='reconciliation_required',lease_until=NULL,updated_at=? WHERE owner_id=? AND id=?",
        [now(), actor.id, operation.id],
      );
      res.status(503).json({
        error: {
          code: 'WAFEQ_SYNC_UNCERTAIN',
          message: 'تعذر تأكيد حالة الفاتورة؛ استخدم تحديث الحالة قبل إعادة المحاولة.',
        },
        invoice: updated,
      });
    };
    let created;
    try {
      const found = await client.findInvoiceByExternalId(id);
      created =
        found ??
        (await client.createInvoice(
          current,
          {
            revenueAccountId: settings.revenue_account_id,
            standardTaxRateId: settings.standard_tax_rate_id,
            zeroTaxRateId: settings.zero_tax_rate_id,
          },
          customerRow.wafeq_id,
          operation.idempotency_key,
        ));
    } catch (error) {
      await failSync(error, current);
      return;
    }
    current = await updateInvoiceSnapshot(
      db,
      actor,
      current,
      { number: created.number ?? current.number },
      created.id,
    );
    let reported;
    try {
      reported = await client.reportInvoice(created.id, operation.report_idempotency_key);
    } catch (error) {
      await failSync(error, current);
      return;
    }
    const mapped = mappedInvoiceStatus(reported.status);
    const updated = await updateInvoiceSnapshot(
      db,
      actor,
      current,
      {
        ...mapped,
        number: reported.number ?? current.number,
        qrCode: mapped.status === 'cleared' ? reported.qrCode : null,
        ...(mapped.status === 'cleared' ? {} : { canDownloadXml: false }),
      },
      reported.id,
    );
    await db.execute(
      'UPDATE finance_provider_operations SET state=?,provider_id=?,lease_until=NULL,updated_at=? WHERE owner_id=? AND id=?',
      [
        reported.status === 'unknown' ? 'reconciliation_required' : 'complete',
        reported.id,
        now(),
        actor.id,
        operation.id,
      ],
    );
    await autoPostInvoice(db, actor, updated);
    res.json({ invoice: updated });
  });
  registerRoute(app, 'post', '/api/finance/invoices/:id/refresh', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const id = routeId(req.params.id),
      invoice = await readInvoice(db, actor.id, id);
    if (!invoice.wafeqId)
      throw fault(409, 'WAFEQ_INVOICE_REQUIRED', 'لا توجد فاتورة وافق لمراجعة حالتها.');
    try {
      const result = await (
        await storedClient(db, actor.id, clientFactory)
      ).getInvoice(invoice.wafeqId);
      const mapped = mappedInvoiceStatus(result.status);
      const updated = await updateInvoiceSnapshot(db, actor, invoice, {
        ...mapped,
        number: result.number ?? invoice.number,
        qrCode: mapped.status === 'cleared' ? result.qrCode : null,
        ...(mapped.status === 'cleared' ? {} : { canDownloadXml: false }),
        syncMessage: undefined,
      });
      await autoPostInvoice(db, actor, updated);
      res.json({ invoice: updated });
    } catch {
      throw fault(503, 'WAFEQ_REFRESH_FAILED', 'تعذر تحديث حالة الفاتورة من وافق.');
    }
  });
  registerRoute(app, 'get', '/api/finance/invoices/:id/pdf', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const id = routeId(req.params.id),
      invoice = await readInvoice(db, actor.id, id);
    if (invoice.status !== 'cleared' || !invoice.wafeqId || !invoice.canDownload)
      throw fault(409, 'ARTIFACT_UNAVAILABLE', 'ملف PDF متاح بعد تأكيد قبول الفاتورة.');
    const artifact = (
      await db.read<{ content_ciphertext: string }>(
        "SELECT content_ciphertext FROM finance_private_artifacts WHERE owner_id=? AND invoice_id=? AND artifact_type='pdf'",
        [actor.id, id],
      )
    )[0];
    let bytes: Buffer;
    if (artifact) {
      bytes = Buffer.from(
        decryptSensitive(artifact.content_ciphertext, `finance:artifact:${id}:pdf`),
        'base64',
      );
    } else {
      try {
        bytes = await (
          await storedClient(db, actor.id, clientFactory)
        ).getInvoicePdf(invoice.wafeqId);
      } catch {
        throw fault(503, 'WAFEQ_PDF_UNAVAILABLE', 'تعذر جلب ملف PDF من وافق.');
      }
      const ciphertext = encryptSensitive(bytes.toString('base64'), `finance:artifact:${id}:pdf`);
      await db.execute(
        "INSERT INTO finance_private_artifacts(owner_id,invoice_id,artifact_type,content_ciphertext,created_at) VALUES(?,?,'pdf',?,?) ON CONFLICT(owner_id,invoice_id,artifact_type) DO NOTHING",
        [actor.id, id, ciphertext, now()],
      );
    }
    res
      .status(200)
      .type('application/pdf')
      .set('content-disposition', `attachment; filename="${id}.pdf"`)
      .send(bytes);
  });
  registerRoute(app, 'get', '/api/finance/invoices/:id/qr', async (req, res) => {
    const actor = await auth(req);
    requireFinance(actor, access);
    const invoice = await readInvoice(db, actor.id, routeId(req.params.id));
    if (invoice.status !== 'cleared' || invoice.zatcaStatus !== 'cleared')
      throw fault(409, 'ARTIFACT_UNAVAILABLE', 'رمز QR الرسمي لا يتاح قبل تأكيد الاعتماد.');
    // The provider has no documented QR image contract yet; do not return JSON to an <img> caller.
    throw fault(409, 'ARTIFACT_UNAVAILABLE', 'صيغة صورة QR الرسمية لم تثبت بعد.');
  });
  registerLedger(app, { db, requireActor, access });
}
