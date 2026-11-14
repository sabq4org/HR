/** Private finance contract. Provider acceptance is never inferred from local state. */
export interface FinanceAddress {
  line: string;
  city: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. The seller is always SA; customers may be abroad. */
  country: string;
  district?: string;
  buildingNumber?: string;
  additionalNumber?: string;
}
export interface FinanceCustomerInput {
  name: string;
  email: string;
  vatNumber: string;
  address: FinanceAddress;
  nameEnglish?: string;
  type?: 'business' | 'individual';
  commercialRegistration?: string;
  phone?: string;
  mobile?: string;
  notes?: string;
  /** Language of the quotes and invoices issued to this customer. Older records read as Arabic. */
  language?: FinanceDocumentLanguage;
}
export type FinanceDocumentLanguage = 'ar' | 'en';
export interface FinanceCustomer extends FinanceCustomerInput {
  id: string;
  version: number;
  createdAt: string;
  wafeqId: string | null;
  syncStatus: 'not_synced' | 'synced' | 'error';
  syncMessage?: string;
}
/** One Wafeq contact offered for import; `exists` means a local customer already covers it. */
export interface WafeqImportCandidate {
  id: string;
  name: string;
  vatNumber: string;
  email: string;
  city: string;
  /** `unsupported`: a country that cannot be read as an ISO code. */
  status: 'new' | 'exists' | 'unsupported';
}
export interface FinanceSeller {
  name: string;
  vatNumber: string;
  commercialRegistration: string;
  address: FinanceAddress;
  /** Printed on English documents in place of the Arabic name and address when set. */
  nameEnglish?: string;
  addressEnglish?: string;
  /** Display-only bank details, encrypted with and frozen into the seller snapshot. */
  bankAccount?: {
    beneficiaryName: string;
    bankName: string;
    accountNumber: string;
    iban: string;
  };
}
/**
 * Legal identity of the issuing company as on its commercial registration, VAT certificate and
 * national address proof. Public details printed on every document; used in the private workspace
 * wherever the saved settings leave a field empty.
 */
export const companySeller: FinanceSeller = {
  name: 'شركة صحيفة سبق الإلكترونية',
  vatNumber: '315027341800003',
  commercialRegistration: '7004271396',
  address: {
    line: 'طريق صلاح الدين الأيوبي',
    buildingNumber: '6567',
    additionalNumber: '2305',
    district: 'حي الزهراء',
    city: 'الرياض',
    postalCode: '12812',
    country: 'SA',
  },
};
/** Fills only the fields a seller record leaves empty; saved values always win. */
export function completeSeller(
  seller: FinanceSeller,
  fallback: FinanceSeller = companySeller,
): FinanceSeller {
  const bank = seller.bankAccount;
  const hasBank = bank && Object.values(bank).some((value) => value.trim());
  return {
    ...seller,
    name: seller.name.trim() || fallback.name,
    vatNumber: seller.vatNumber.trim() || fallback.vatNumber,
    commercialRegistration:
      seller.commercialRegistration?.trim() || fallback.commercialRegistration,
    // An address is taken whole, so a saved street is never mixed with another district.
    address:
      seller.address.line.trim() || seller.address.city.trim() ? seller.address : fallback.address,
    ...(hasBank || !fallback.bankAccount ? {} : { bankAccount: fallback.bankAccount }),
  };
}
/** Display-only: groups an IBAN in blocks of 4. The stored value stays without spaces. */
export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}
export const sellerAddressText = (address: FinanceAddress) =>
  [
    [address.buildingNumber, address.line].filter(Boolean).join(' '),
    address.district,
    [address.city, address.postalCode].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join('، ');
export interface FinanceSettings {
  seller: FinanceSeller;
  version: number;
  mode: 'preview' | 'private';
  apiKeyConfigured: boolean;
  canStoreApiKey: boolean;
  canSync: boolean;
  connectionMessage: string;
  organization: { id: string; name: string } | null;
  revenueAccountId: string;
  standardTaxRateId: string;
  zeroTaxRateId: string;
}
/**
 * Chosen when the quote is created and carried to the invoice:
 * standard = B2B tax invoice at 15%, simplified = B2C simplified tax invoice at 15%,
 * zero_rated = tax invoice with every line zero-rated (e.g. export of services),
 * out_of_scope = non-tax invoice for amounts outside VAT scope (no VAT, no QR, not reported).
 */
export type FinanceDocumentType = 'standard' | 'simplified' | 'zero_rated' | 'out_of_scope';
export const financeDocumentTypes: readonly FinanceDocumentType[] = [
  'standard',
  'simplified',
  'zero_rated',
  'out_of_scope',
];
/** Types whose lines must all be at 0%. */
export const zeroLineDocumentTypes: readonly FinanceDocumentType[] = ['zero_rated', 'out_of_scope'];
export interface FinanceLineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRateBps: number;
  taxReason: string;
}
export interface FinanceLine extends FinanceLineInput {
  subtotalHalalas: number;
  taxHalalas: number;
  totalHalalas: number;
}
export interface FinanceQuoteInput {
  customerId: string;
  /** Older quotes without a type are read as 'standard'. */
  documentType?: FinanceDocumentType;
  title: string;
  issueDate: string;
  validUntil: string;
  notes: string;
  lines: FinanceLineInput[];
  /** Fixed per document; defaults to the customer's language. */
  language?: FinanceDocumentLanguage;
}
export interface FinanceQuote extends FinanceQuoteInput {
  documentType: FinanceDocumentType;
  id: string;
  number: string;
  version: number;
  /** `cancelled` is a draft the owner voided: it stays on record and can no longer change. */
  status: 'draft' | 'converted' | 'cancelled';
  cancelledAt?: string;
  currency: 'SAR';
  customer: FinanceCustomerInput;
  seller: FinanceSeller;
  lines: FinanceLine[];
  subtotalHalalas: number;
  taxHalalas: number;
  totalHalalas: number;
  invoiceId: string | null;
  createdAt: string;
}
export interface FinanceInvoice {
  id: string;
  number: string;
  quoteId: string;
  quoteNumber: string;
  title: string;
  version: number;
  issueDate: string;
  dueDate: string;
  status:
    | 'draft'
    | 'syncing'
    | 'pending'
    | 'cleared'
    | 'reported'
    | 'rejected'
    | 'reconciliation_required'
    /** A draft voided before anything was sent to the provider; it stays on record. */
    | 'cancelled';
  cancelledAt?: string;
  invoiceType?: 'standard' | 'simplified';
  documentType?: FinanceDocumentType;
  language?: FinanceDocumentLanguage;
  purchaseOrder?: string;
  currency: 'SAR';
  customer: FinanceCustomerInput;
  seller: FinanceSeller;
  lines: FinanceLine[];
  notes: string;
  subtotalHalalas: number;
  taxHalalas: number;
  totalHalalas: number;
  wafeqId: string | null;
  zatcaStatus: 'not_submitted' | 'pending' | 'cleared' | 'reported' | 'rejected' | 'unknown';
  qrCode: string | null;
  syncMessage?: string;
  canDownload: boolean;
  /** Official artifact availability; never generated from local draft fields. */
  canDownloadXml?: boolean;
  createdAt: string;
}
/** Tax-accepted statuses coming back from Wafeq / ZATCA. Drafts and pending invoices are not posted. */
export const taxAcceptedInvoiceStatuses: ReadonlyArray<FinanceInvoice['status']> = [
  'cleared',
  'reported',
];
export function isTaxAcceptedInvoice(status: string): status is 'cleared' | 'reported' {
  return status === 'cleared' || status === 'reported';
}
/** A saved line that can be inserted into quotes instead of retyping it. */
export interface FinanceCatalogItemInput {
  description: string;
  unitPrice: string;
  taxRateBps: number;
  taxReason: string;
}
export interface FinanceCatalogItem extends FinanceCatalogItemInput {
  id: string;
  version: number;
  active: boolean;
  createdAt: string;
}
export interface FinanceOverview {
  customers: FinanceCustomer[];
  catalog: FinanceCatalogItem[];
  quotes: FinanceQuote[];
  invoices: FinanceInvoice[];
  settings: FinanceSettings;
}

// All mutations require Idempotency-Key; authenticated, explicitly granted finance access.
// GET /api/finance -> FinanceOverview
// GET /api/finance/settings -> {settings: FinanceSettings}
// PATCH /api/finance/settings {version,seller,revenueAccountId,standardTaxRateId,zeroTaxRateId} -> {settings: FinanceSettings}
// POST /api/finance/customers FinanceCustomerInput -> {customer: FinanceCustomer}
// PATCH /api/finance/customers/:id {version,...FinanceCustomerInput} -> {customer: FinanceCustomer}
// POST /api/finance/quotes FinanceQuoteInput -> {quote: FinanceQuote}
// PATCH /api/finance/quotes/:id {version,...FinanceQuoteInput} -> {quote: FinanceQuote}
// POST /api/finance/catalog FinanceCatalogItemInput -> {item: FinanceCatalogItem}
// PATCH /api/finance/catalog/:id {version,active,...FinanceCatalogItemInput} -> {item: FinanceCatalogItem}
// POST /api/finance/quotes/:id/convert {version,issueDate,dueDate,invoiceType?,purchaseOrder?}
//   invoiceType follows the quote's documentType; a conflicting value is rejected. -> {invoice: FinanceInvoice}
// POST /api/finance/customers/:id/sync {version} -> {customer: FinanceCustomer}
// GET /api/finance/wafeq/customers -> {contacts: WafeqImportCandidate[]}, read-only at the provider.
// POST /api/finance/wafeq/customers/import {ids} -> {imported: number, skipped: number}
// POST /api/finance/invoices/:id/sync {version} -> {invoice: FinanceInvoice}
// POST /api/finance/invoices/:id/refresh {} -> {invoice: FinanceInvoice}
// GET /api/finance/invoices/:id/pdf -> private provider PDF, only cleared.
// POST /api/finance/settings/api-key {apiKey} -> {settings: FinanceSettings}, private only.
// POST /api/finance/settings/test {} -> {settings: FinanceSettings}, read-only connection test.

/** Countries offered for a customer address; SA keeps the Saudi national address fields. */
export const financeCountries: ReadonlyArray<{ code: string; ar: string; en: string }> = [
  { code: 'SA', ar: 'المملكة العربية السعودية', en: 'Saudi Arabia' },
  { code: 'AE', ar: 'الإمارات العربية المتحدة', en: 'United Arab Emirates' },
  { code: 'KW', ar: 'الكويت', en: 'Kuwait' },
  { code: 'QA', ar: 'قطر', en: 'Qatar' },
  { code: 'BH', ar: 'البحرين', en: 'Bahrain' },
  { code: 'OM', ar: 'عُمان', en: 'Oman' },
  { code: 'EG', ar: 'مصر', en: 'Egypt' },
  { code: 'JO', ar: 'الأردن', en: 'Jordan' },
  { code: 'LB', ar: 'لبنان', en: 'Lebanon' },
  { code: 'MA', ar: 'المغرب', en: 'Morocco' },
  { code: 'TR', ar: 'تركيا', en: 'Türkiye' },
  { code: 'GB', ar: 'المملكة المتحدة', en: 'United Kingdom' },
  { code: 'US', ar: 'الولايات المتحدة', en: 'United States' },
  { code: 'CA', ar: 'كندا', en: 'Canada' },
  { code: 'FR', ar: 'فرنسا', en: 'France' },
  { code: 'DE', ar: 'ألمانيا', en: 'Germany' },
  { code: 'NL', ar: 'هولندا', en: 'Netherlands' },
  { code: 'CH', ar: 'سويسرا', en: 'Switzerland' },
  { code: 'IN', ar: 'الهند', en: 'India' },
  { code: 'PK', ar: 'باكستان', en: 'Pakistan' },
  { code: 'CN', ar: 'الصين', en: 'China' },
  { code: 'SG', ar: 'سنغافورة', en: 'Singapore' },
];
export const countryName = (code: string, language: FinanceDocumentLanguage = 'ar') =>
  financeCountries.find((c) => c.code === code)?.[language] ?? code;
/** A document's language: its own choice, else its customer's, else Arabic. */
export const documentLanguage = (doc: {
  language?: FinanceDocumentLanguage;
  customer: { language?: FinanceDocumentLanguage };
}): FinanceDocumentLanguage => doc.language ?? doc.customer.language ?? 'ar';
