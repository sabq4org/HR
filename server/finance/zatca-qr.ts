// Reads the official ZATCA QR from the PDF that Wafeq issues for a reported invoice.
//
// Wafeq's accounting API has no QR field (checked live 2026-11-16). Its download is a PDF/A-3
// with the signed ZATCA UBL XML attached as an embedded file, and that XML carries the QR as
// cac:AdditionalDocumentReference ID=QR (base64 TLV): the same value printed as the QR image.
// Reading the attachment needs only zlib, so no rasteriser or image QR decoder is involved.
import { inflateSync } from 'node:zlib';
import type { FinanceInvoice } from '../../shared/finance.js';

const MAX_XML_BYTES = 2 * 1024 * 1024;

export class ZatcaQrError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Official QR unavailable (${code})`);
    this.name = 'ZatcaQrError';
    this.code = code;
  }
}

export interface ZatcaTlv {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  total: string;
  vat: string;
  /** Tags present after 1–5: 6 hash, 7 signature, 8 public key, 9 ZATCA stamp (simplified). */
  extraTags: number[];
}

/** Decodes a base64 ZATCA TLV payload. Throws ZatcaQrError when it is not a well-formed one. */
export function decodeZatcaTlv(base64: string): ZatcaTlv {
  const value = base64.trim();
  if (!/^[A-Za-z0-9+/]{20,4000}={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new ZatcaQrError('qr_not_base64');
  const raw = Buffer.from(value, 'base64');
  const tags = new Map<number, Buffer>();
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 2 > raw.length) throw new ZatcaQrError('qr_tlv_truncated');
    const tag = raw[offset],
      length = raw[offset + 1];
    const end = offset + 2 + length;
    if (tag < 1 || tag > 9 || end > raw.length || tags.has(tag))
      throw new ZatcaQrError('qr_tlv_invalid');
    tags.set(tag, raw.subarray(offset + 2, end));
    offset = end;
  }
  const text = (tag: number) => {
    const bytes = tags.get(tag);
    if (!bytes || bytes.length === 0) throw new ZatcaQrError('qr_tlv_missing_tag');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const tlv = {
    sellerName: text(1),
    vatNumber: text(2),
    timestamp: text(3),
    total: text(4),
    vat: text(5),
    extraTags: [...tags.keys()].filter((tag) => tag > 5).sort((a, b) => a - b),
  };
  if (!/^3\d{13}3$/.test(tlv.vatNumber)) throw new ZatcaQrError('qr_tlv_invalid_vat');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(tlv.total) || !/^\d{1,12}(\.\d{1,2})?$/.test(tlv.vat))
    throw new ZatcaQrError('qr_tlv_invalid_amount');
  // Phase 2 QR codes carry the invoice hash, signature and public key.
  if (![6, 7, 8].every((tag) => tlv.extraTags.includes(tag)))
    throw new ZatcaQrError('qr_tlv_not_phase2');
  return tlv;
}

const halalas = (amount: string) => {
  const [whole, fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

/** Refuses a QR whose seller VAT number, total or VAT differs from the HR invoice. */
export function assertQrMatchesInvoice(tlv: ZatcaTlv, invoice: FinanceInvoice): void {
  if (tlv.vatNumber !== invoice.seller.vatNumber) throw new ZatcaQrError('qr_seller_vat_mismatch');
  if (halalas(tlv.total) !== invoice.totalHalalas) throw new ZatcaQrError('qr_total_mismatch');
  if (halalas(tlv.vat) !== invoice.taxHalalas) throw new ZatcaQrError('qr_vat_mismatch');
}

/** The embedded files of a PDF, decoded. Only uncompressed or FlateDecode streams are read. */
export function embeddedFiles(pdf: Buffer): Buffer[] {
  const text = pdf.toString('latin1');
  const files: Buffer[] = [];
  let at = 0;
  while ((at = text.indexOf('stream', at)) !== -1) {
    const keyword = at;
    at += 6;
    if (text.slice(keyword - 3, keyword) === 'end') continue;
    const objStart = text.lastIndexOf(' obj', keyword);
    if (objStart === -1) continue;
    const dict = text.slice(objStart, keyword);
    if (!/\/Type\s*\/EmbeddedFile\b/.test(dict)) continue;
    let start = at;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const end = declared ? start + Number(declared[1]) : text.indexOf('endstream', start);
    if (end <= start || end > pdf.length) continue;
    const data = pdf.subarray(start, end);
    const filter = /\/Filter\s*\/?\[?\s*\/(\w+)/.exec(dict)?.[1];
    try {
      if (!filter) files.push(Buffer.from(data));
      else if (filter === 'FlateDecode')
        files.push(inflateSync(data, { maxOutputLength: MAX_XML_BYTES }));
    } catch {
      /* an unreadable attachment is skipped */
    }
  }
  return files;
}

const xmlText = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The QR value and invoice number in a ZATCA UBL invoice, or null when it is not one. */
export function qrFromUbl(xml: string): { qr: string; invoiceNumber: string | null } | null {
  if (!xml.includes('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2')) return null;
  for (const block of xml.match(
    /<cac:AdditionalDocumentReference>[\s\S]*?<\/cac:AdditionalDocumentReference>/g,
  ) ?? []) {
    if (!/<cbc:ID>\s*QR\s*<\/cbc:ID>/.test(block)) continue;
    const value = /<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(block)?.[1];
    if (!value) return null;
    // The invoice's own cbc:ID is the first one directly under <Invoice>, after the extensions.
    const body = xml.replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, '');
    const number = /<cbc:ID>([^<]+)<\/cbc:ID>/.exec(body)?.[1];
    return { qr: value.replace(/\s+/g, ''), invoiceNumber: number ? xmlText(number).trim() : null };
  }
  return null;
}

/**
 * Finds the official QR in Wafeq's PDF and checks it against the HR invoice: well-formed Phase 2
 * TLV, same invoice number, seller VAT number, total and VAT. Throws ZatcaQrError otherwise.
 */
export function officialQrFromPdf(
  pdf: Buffer,
  invoice: FinanceInvoice,
): { qr: string; tlv: ZatcaTlv } {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ZatcaQrError('not_a_pdf');
  const found = embeddedFiles(pdf)
    .map((file) => qrFromUbl(file.toString('utf8')))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (found.length === 0) throw new ZatcaQrError('no_embedded_zatca_xml');
  if (found.length > 1) throw new ZatcaQrError('multiple_embedded_zatca_xml');
  const [{ qr, invoiceNumber }] = found;
  if (invoiceNumber !== null && invoiceNumber !== invoice.number)
    throw new ZatcaQrError('qr_invoice_number_mismatch');
  const tlv = decodeZatcaTlv(qr);
  assertQrMatchesInvoice(tlv, invoice);
  return { qr, tlv };
}

/** True when a stored value is a well-formed Phase 2 ZATCA QR that matches the invoice. */
export function isOfficialQr(invoice: FinanceInvoice): boolean {
  if (!invoice.qrCode) return false;
  try {
    assertQrMatchesInvoice(decodeZatcaTlv(invoice.qrCode), invoice);
    return true;
  } catch {
    return false;
  }
}

/** Cleared (or reported) with a verified official QR: our own paper is then the tax invoice. */
export function isOfficialInvoice(invoice: FinanceInvoice): boolean {
  return (invoice.status === 'cleared' || invoice.status === 'reported') && isOfficialQr(invoice);
}
