import type { FinanceCustomerInput, FinanceInvoice } from '../../shared/finance.js';

const BASE_URL = 'https://api.wafeq.com/v1/';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 12 * 1024 * 1024;

export interface WafeqOrganization {
  id: string;
  name: string;
}

export interface WafeqInvoiceResult {
  id: string;
  number?: string;
  status: 'pending' | 'cleared' | 'rejected' | 'unknown';
  /** Raw status string; the public schema does not enumerate final verdict values. */
  taxAuthorityStatus?: string;
  qrCode: string | null;
}

export interface WafeqInvoiceMappings {
  revenueAccountId: string;
  standardTaxRateId: string;
  zeroTaxRateId: string;
}

export interface WafeqClientLike {
  getOrganization(): Promise<WafeqOrganization>;
  createCustomer(
    input: FinanceCustomerInput,
    externalId: string,
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  getCustomer(id: string): Promise<{ id: string }>;
  findCustomerByExternalId(externalId: string): Promise<{ id: string } | null>;
  createInvoice(
    invoice: FinanceInvoice,
    mappings: WafeqInvoiceMappings,
    customerWafeqId: string,
    idempotencyKey: string,
  ): Promise<WafeqInvoiceResult>;
  findInvoiceByExternalId(externalId: string): Promise<WafeqInvoiceResult | null>;
  getInvoice(id: string): Promise<WafeqInvoiceResult>;
  reportInvoice(id: string, idempotencyKey: string): Promise<WafeqInvoiceResult>;
  getInvoicePdf(id: string): Promise<Buffer>;
}

export class WafeqApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(code: string, status: number | null = null) {
    super(`Wafeq request failed (${code}${status === null ? '' : `, HTTP ${status}`})`);
    this.name = 'WafeqApiError';
    this.status = status;
    this.code = code;
  }
}

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pathPart(value: string, label: string): string {
  if (!value || value.length > 255 || /[\u0000-\u0020/\\?#]/.test(value)) {
    throw new WafeqApiError(`invalid_${label}`);
  }
  return encodeURIComponent(value);
}

function assertIdempotencyKey(key: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new WafeqApiError('invalid_idempotency_key');
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseInvoice(value: unknown, isReportResponse = false): WafeqInvoiceResult {
  if (!isObject(value)) throw new WafeqApiError('invalid_response');
  const id = string(value.id);
  if (!id) throw new WafeqApiError('invalid_response');
  // Invoice lifecycle and report-action responses have separate schemas.
  const rawStatus = isReportResponse ? string(value.status)?.toUpperCase() : undefined;
  // Only PENDING has a documented meaning in the report operation text.
  const status = rawStatus === 'PENDING' ? 'pending' : 'unknown';
  return {
    id,
    ...(string(value.invoice_number) ? { number: string(value.invoice_number) } : {}),
    status,
    ...(rawStatus ? { taxAuthorityStatus: rawStatus } : {}),
    // QR is absent from the documented Public API invoice and report schemas.
    qrCode: null,
  };
}

function quantityNumber(value: string): number {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/.test(value))
    throw new WafeqApiError('invalid_invoice_quantity');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new WafeqApiError('invalid_invoice_quantity');
  return parsed;
}

function unitAmount(value: string): number {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value))
    throw new WafeqApiError('invalid_invoice_amount');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new WafeqApiError('invalid_invoice_amount');
  return parsed;
}

function listPage(value: unknown): { count: number; hasNext: boolean; results: JsonObject[] } {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0 ||
    !(value.next === null || typeof value.next === 'string') ||
    !Array.isArray(value.results)
  ) {
    throw new WafeqApiError('invalid_response');
  }
  const results: JsonObject[] = [];
  for (const row of value.results) {
    if (!isObject(row) || !string(row.id) || typeof row.external_id !== 'string')
      throw new WafeqApiError('invalid_response');
    results.push(row);
  }
  return { count: value.count as number, hasNext: value.next !== null, results };
}

function findExactExternalId(pages: JsonObject[][], externalId: string): JsonObject | null {
  const matches = pages.flat().filter((row) => row.external_id === externalId);
  if (matches.length > 1) throw new WafeqApiError('duplicate_external_id');
  return matches[0] ?? null;
}

export class WafeqClient implements WafeqClientLike {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly apiKey: string,
    fetchImpl: FetchLike = fetch,
  ) {
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new WafeqApiError('invalid_api_key');
    this.fetchImpl = fetchImpl;
  }

  async getOrganization(): Promise<WafeqOrganization> {
    const value = await this.jsonRequest('GET', 'organization/');
    if (!isObject(value)) throw new WafeqApiError('invalid_response');
    const id = string(value.id);
    const nameValue = isObject(value.name) ? value.name : undefined;
    const name = nameValue ? (string(nameValue.ar) ?? string(nameValue.en)) : undefined;
    if (!id || !name) throw new WafeqApiError('invalid_response');
    return { id, name };
  }

  async createCustomer(
    input: FinanceCustomerInput,
    externalId: string,
    idempotencyKey: string,
  ): Promise<{ id: string }> {
    assertIdempotencyKey(idempotencyKey);
    const body = {
      name: input.name,
      email: input.email,
      tax_registration_number: input.vatNumber,
      address: input.address.line,
      city: input.address.city,
      postal_code: input.address.postalCode,
      country: input.address.country,
      is_customer: true,
      external_id: externalId,
      ...(input.address.district ? { district: input.address.district } : {}),
      ...(input.address.buildingNumber ? { building_number: input.address.buildingNumber } : {}),
      ...(input.address.additionalNumber
        ? { additional_number: input.address.additionalNumber }
        : {}),
      ...(input.phone ? { phone: input.phone } : {}),
    };
    return this.idResult(await this.jsonRequest('POST', 'contacts/', body, idempotencyKey));
  }

  async getCustomer(id: string): Promise<{ id: string }> {
    return this.idResult(await this.jsonRequest('GET', `contacts/${pathPart(id, 'customer_id')}/`));
  }

  async findCustomerByExternalId(externalId: string): Promise<{ id: string } | null> {
    const rows = await this.listByExternalId('contacts/', externalId);
    const match = findExactExternalId(rows, externalId);
    return match ? this.idResult(match) : null;
  }

  async createInvoice(
    invoice: FinanceInvoice,
    mappings: WafeqInvoiceMappings,
    customerWafeqId: string,
    idempotencyKey: string,
  ): Promise<WafeqInvoiceResult> {
    assertIdempotencyKey(idempotencyKey);
    if (invoice.invoiceType === 'simplified')
      throw new WafeqApiError('simplified_invoice_not_supported');
    if (invoice.lines.some((line) => line.taxRateBps === 0)) {
      throw new WafeqApiError('zero_tax_reason_mapping_required');
    }
    const body = {
      contact: customerWafeqId,
      currency: 'SAR',
      invoice_date: invoice.issueDate,
      invoice_due_date: invoice.dueDate,
      invoice_number: invoice.number,
      reference: invoice.quoteNumber,
      ...(invoice.purchaseOrder ? { purchase_order: invoice.purchaseOrder } : {}),
      external_id: invoice.id,
      notes: invoice.notes,
      tax_amount_type: 'TAX_EXCLUSIVE',
      line_items: invoice.lines.map((line) => ({
        description: line.description,
        account: mappings.revenueAccountId,
        quantity: quantityNumber(line.quantity),
        unit_amount: unitAmount(line.unitPrice),
        tax_rate: mappings.standardTaxRateId,
      })),
    };
    const created = responseInvoice(
      await this.jsonRequest('POST', 'invoices/', body, idempotencyKey),
    );
    return created;
  }

  async findInvoiceByExternalId(externalId: string): Promise<WafeqInvoiceResult | null> {
    const rows = await this.listByExternalId('invoices/', externalId);
    const match = findExactExternalId(rows, externalId);
    return match ? responseInvoice(match) : null;
  }

  async getInvoice(id: string): Promise<WafeqInvoiceResult> {
    return responseInvoice(
      await this.jsonRequest('GET', `invoices/${pathPart(id, 'invoice_id')}/`),
    );
  }

  async reportInvoice(id: string, idempotencyKey: string): Promise<WafeqInvoiceResult> {
    assertIdempotencyKey(idempotencyKey);
    try {
      const value = await this.jsonRequest(
        'POST',
        `invoices/${pathPart(id, 'invoice_id')}/tax-authority/report/`,
        undefined,
        idempotencyKey,
      );
      const object = isObject(value) ? value : {};
      return responseInvoice({ id, ...object }, true);
    } catch (error) {
      if (
        error instanceof WafeqApiError &&
        error.status === 409 &&
        error.code === 'report_in_progress'
      ) {
        return this.getInvoice(id);
      }
      throw error;
    }
  }

  async getInvoicePdf(id: string): Promise<Buffer> {
    const response = await this.request(
      'GET',
      `invoices/${pathPart(id, 'invoice_id')}/download/`,
      undefined,
      undefined,
      'application/pdf',
      MAX_PDF_BYTES,
    );
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!type || type !== 'application/pdf')
      throw new WafeqApiError('invalid_pdf_response', response.status);
    return Buffer.from(await response.arrayBuffer());
  }

  private idResult(value: unknown): { id: string } {
    if (!isObject(value) || !string(value.id)) throw new WafeqApiError('invalid_response');
    const id = string(value.id);
    if (!id) throw new WafeqApiError('invalid_response');
    return { id };
  }

  private async listByExternalId(
    path: 'contacts/' | 'invoices/',
    externalId: string,
  ): Promise<JsonObject[][]> {
    const pages: JsonObject[][] = [];
    let page = 1;
    while (page <= 100) {
      const query = new URLSearchParams({ external_id: externalId, page_size: '100' });
      if (page > 1) query.set('page', String(page));
      const result = listPage(await this.jsonRequest('GET', `${path}?${query.toString()}`));
      pages.push(result.results);
      if (!result.hasNext) {
        if (pages.flat().length < result.count) throw new WafeqApiError('incomplete_list_response');
        return pages;
      }
      page++;
    }
    throw new WafeqApiError('too_many_pages');
  }

  private async jsonRequest(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const response = await this.request(
      method,
      path,
      body,
      idempotencyKey,
      'application/json',
      MAX_JSON_BYTES,
    );
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new WafeqApiError('invalid_json_response', response.status);
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    accept = 'application/json',
    maxBytes = MAX_JSON_BYTES,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Api-Key ${this.apiKey}`,
          Accept: accept,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'X-Wafeq-Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const bytes = await this.readBounded(response, Math.min(maxBytes, 16_384));
        const code = this.errorCode(bytes, response.status);
        throw new WafeqApiError(code, response.status);
      }
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes)
        throw new WafeqApiError('response_too_large', response.status);
      const bytes = await this.readBounded(response, maxBytes);
      return new Response(Buffer.from(bytes), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (error instanceof WafeqApiError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw new WafeqApiError('timeout');
      throw new WafeqApiError('network_error');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new WafeqApiError('response_too_large', response.status);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private errorCode(bytes: Uint8Array, status: number): string {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const nestedCode =
        isObject(value) && isObject(value.error) ? string(value.error.code) : undefined;
      const code = nestedCode ?? (isObject(value) ? string(value.code) : undefined);
      if (code && /^[a-z][a-z0-9_]{0,63}$/i.test(code) && !code.includes(this.apiKey)) return code;
    } catch {
      /* response bodies are intentionally never surfaced */
    }
    return status === 429 ? 'rate_limited' : 'http_error';
  }
}
