/** Private finance contract. Provider acceptance is never inferred from local state. */
export interface FinanceAddress {
  line: string;
  city: string;
  postalCode: string;
  country: 'SA';
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
}
export interface FinanceCustomer extends FinanceCustomerInput {
  id: string;
  version: number;
  createdAt: string;
  wafeqId: string | null;
  syncStatus: 'not_synced' | 'synced' | 'error';
  syncMessage?: string;
}
export interface FinanceSeller {
  name: string;
  vatNumber: string;
  commercialRegistration: string;
  address: FinanceAddress;
  /** Display-only bank details, encrypted with and frozen into the seller snapshot. */
  bankAccount?: {
    beneficiaryName: string;
    bankName: string;
    accountNumber: string;
    iban: string;
  };
}
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
}
export interface FinanceQuote extends FinanceQuoteInput {
  documentType: FinanceDocumentType;
  id: string;
  number: string;
  version: number;
  status: 'draft' | 'converted';
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
    | 'reconciliation_required';
  invoiceType?: 'standard' | 'simplified';
  documentType?: FinanceDocumentType;
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
// POST /api/finance/invoices/:id/sync {version} -> {invoice: FinanceInvoice}
// POST /api/finance/invoices/:id/refresh {} -> {invoice: FinanceInvoice}
// GET /api/finance/invoices/:id/pdf -> private provider PDF, only cleared.
// POST /api/finance/settings/api-key {apiKey} -> {settings: FinanceSettings}, private only.
// POST /api/finance/settings/test {} -> {settings: FinanceSettings}, read-only connection test.
