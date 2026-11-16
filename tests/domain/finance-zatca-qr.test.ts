import test from 'node:test';
import assert from 'node:assert/strict';
import type { FinanceInvoice } from '../../shared/finance.js';
import {
  decodeZatcaTlv,
  isOfficialInvoice,
  officialQrFromPdf,
  ZatcaQrError,
} from '../../server/finance/zatca-qr.js';
import { invoiceHtml } from '../../server/finance/document-html.js';
import { syntheticTlv, syntheticUbl, syntheticWafeqPdf } from '../support/zatca-pdf.js';

const invoice = {
  id: 'inv-local-1',
  number: 'HR-INV-000001',
  quoteId: 'q-1',
  quoteNumber: 'HR-Q-000001',
  title: 'Synthetic service',
  version: 3,
  issueDate: '2026-11-16',
  dueDate: '2026-11-26',
  status: 'cleared',
  documentType: 'standard',
  language: 'ar',
  currency: 'SAR',
  customer: {
    name: 'عميل تجريبي',
    email: 'billing@example.test',
    vatNumber: '300000000000003',
    address: { line: 'Synthetic Road', city: 'Riyadh', postalCode: '12345', country: 'SA' },
  },
  seller: {
    name: 'بائع تجريبي',
    vatNumber: '310000000000003',
    commercialRegistration: '1010101010',
    address: { line: 'Synthetic Road', city: 'Riyadh', postalCode: '12345', country: 'SA' },
    bankAccount: {
      beneficiaryName: 'Synthetic Beneficiary',
      bankName: 'Synthetic Bank',
      accountNumber: '000000000000',
      iban: 'SA0000000000000000000000',
    },
  },
  lines: [
    {
      description: 'Synthetic service',
      quantity: '1',
      unitPrice: '3000.00',
      taxRateBps: 1500,
      taxReason: '',
      subtotalHalalas: 300000,
      taxHalalas: 45000,
      totalHalalas: 345000,
    },
  ],
  notes: '',
  subtotalHalalas: 300000,
  taxHalalas: 45000,
  totalHalalas: 345000,
  wafeqId: 'inv_synthetic',
  zatcaStatus: 'cleared',
  qrCode: null,
  canDownload: true,
  createdAt: '2026-11-16T08:06:27.637Z',
} as FinanceInvoice;

const goodQr = syntheticTlv({ vat: '310000000000003', total: '3450.00', tax: '450.00' });
const pdfWith = (qr: string, number = invoice.number) =>
  syntheticWafeqPdf(syntheticUbl(number, qr));
const refusal = (code: string) => (error: unknown) =>
  error instanceof ZatcaQrError && error.code === code;

test('reads the QR from the ZATCA XML embedded in the PDF and decodes its TLV', () => {
  const { qr, tlv } = officialQrFromPdf(pdfWith(goodQr), invoice);
  assert.equal(qr, goodQr);
  assert.equal(tlv.vatNumber, '310000000000003');
  assert.equal(tlv.total, '3450.00');
  assert.equal(tlv.vat, '450.00');
  assert.deepEqual(tlv.extraTags, [6, 7, 8]);
});

test('refuses a QR whose seller VAT number, total, VAT or invoice number differs', () => {
  const other = (values: Partial<{ vat: string; total: string; tax: string }>) =>
    syntheticTlv({ vat: '310000000000003', total: '3450.00', tax: '450.00', ...values });
  assert.throws(
    () => officialQrFromPdf(pdfWith(other({ vat: '399999999999993' })), invoice),
    refusal('qr_seller_vat_mismatch'),
  );
  assert.throws(
    () => officialQrFromPdf(pdfWith(other({ total: '3450.01' })), invoice),
    refusal('qr_total_mismatch'),
  );
  assert.throws(
    () => officialQrFromPdf(pdfWith(other({ tax: '450.10' })), invoice),
    refusal('qr_vat_mismatch'),
  );
  assert.throws(
    () => officialQrFromPdf(pdfWith(goodQr, 'HR-INV-000099'), invoice),
    refusal('qr_invoice_number_mismatch'),
  );
});

test('refuses PDFs without the embedded XML and malformed or Phase 1 TLV values', () => {
  assert.throws(
    () => officialQrFromPdf(syntheticWafeqPdf(null), invoice),
    refusal('no_embedded_zatca_xml'),
  );
  assert.throws(() => officialQrFromPdf(Buffer.from('not a pdf'), invoice), refusal('not_a_pdf'));
  assert.throws(() => decodeZatcaTlv('!!!'), refusal('qr_not_base64'));
  const phase1 = Buffer.concat(
    [
      [1, 'Seller'],
      [2, '310000000000003'],
      [3, '2026-11-16T11:06:38'],
      [4, '3450.00'],
      [5, '450.00'],
    ].map(([tag, value]) =>
      Buffer.concat([
        Buffer.from([tag as number, Buffer.byteLength(value as string)]),
        Buffer.from(value as string),
      ]),
    ),
  ).toString('base64');
  assert.throws(() => decodeZatcaTlv(phase1), refusal('qr_tlv_not_phase2'));
  const truncated = Buffer.from(goodQr, 'base64').subarray(0, 30).toString('base64');
  assert.throws(() => decodeZatcaTlv(truncated));
});

test('our paper is the tax invoice only when cleared with a matching QR; otherwise an internal copy', () => {
  const official = { ...invoice, qrCode: goodQr };
  assert.equal(isOfficialInvoice(official), true);
  const html = invoiceHtml(official, official.seller);
  assert.equal(html.includes('Internal copy'), false);
  assert.equal(html.includes('نسخة داخلية'), false);
  assert.match(html, /<img class="fin-qr" src="data:image\/svg\+xml/);
  assert.ok(html.includes('Synthetic Beneficiary'), 'bank details stay on the invoice');

  const noQr = invoiceHtml(invoice, invoice.seller);
  assert.ok(noQr.includes('Internal copy – not the official tax invoice'));
  assert.equal(noQr.includes('class="fin-qr"'), false);

  const wrongQr = {
    ...invoice,
    qrCode: syntheticTlv({ vat: '310000000000003', total: '1.00', tax: '0.15' }),
  };
  assert.equal(isOfficialInvoice(wrongQr), false);
  assert.ok(invoiceHtml(wrongQr, wrongQr.seller).includes('Internal copy'));

  const pending = { ...invoice, status: 'pending' as const, qrCode: goodQr };
  assert.equal(isOfficialInvoice(pending), false);
});
