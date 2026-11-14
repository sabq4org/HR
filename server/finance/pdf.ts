/**
 * Server-side A4 PDF for quotes and internal invoice copies (Arabic, right-to-left).
 *
 * pdfkit shapes Arabic through fontkit but has no bidi algorithm, so each line is split into
 * visual runs with bidi-js and drawn run by run: Arabic runs with the Sabq display font, digits
 * and Latin with IBM Plex Sans Arabic (Latin subset).
 *
 * An invoice rendered here is an internal copy, never the tax invoice: it carries no QR and says
 * so on every page. The official artifact stays GET /api/finance/invoices/:id/pdf (provider).
 */
import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';
import { fileURLToPath } from 'node:url';
import type {
  FinanceDocumentType,
  FinanceInvoice,
  FinanceLine,
  FinanceQuote,
  FinanceSeller,
  FinanceCustomerInput,
} from '../../shared/finance.js';

const bidi = bidiFactory();
const ARABIC = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const CONTROL = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/** Isolates a left-to-right value (date, number, code) inside Arabic text. */
const ltr = (value: string) => `\u2066${value}\u2069`;
const LETTER =
  /[\u0621-\u065F\u066E-\u06D3\u06D5-\u06FF\u0670\uFB50-\uFDFF\uFE70-\uFEFF\u200C\u200D]/;
const asset = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const FONTS = {
  ar: asset('../../public/fonts/TheYearofHandicrafts-Regular.woff2'),
  arBold: asset('../../public/fonts/TheYearofHandicrafts-Bold.woff2'),
  lat: asset(
    '../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-400-normal.woff',
  ),
  latBold: asset(
    '../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-700-normal.woff',
  ),
};
const COLORS = {
  ink: '#1A1A1A',
  muted: '#5F6670',
  brand: '#0B5394',
  line: '#D5DAE1',
  band: '#F2F5F9',
};
type Doc = InstanceType<typeof PDFDocument>;
type Run = { text: string; rtl: boolean; space?: boolean };
type TextOptions = {
  size?: number;
  bold?: boolean;
  color?: string;
  align?: 'left' | 'right' | 'center';
};

/**
 * Splits one logical line into visual-order tokens (left to right on the page). Whitespace is
 * its own token because the display font gives the space no advance inside shaped runs.
 */
export function visualRuns(text: string): Run[] {
  if (!text) return [];
  const levels = bidi.getEmbeddingLevels(text, 'rtl');
  const order = [...text].map((_, i) => i);
  for (const [start, end] of bidi.getReorderSegments(text, levels)) {
    const slice = order.slice(start, end + 1).reverse();
    order.splice(start, slice.length, ...slice);
  }
  // Tokens break on whitespace, direction and Arabic letters vs. everything else: fontkit only
  // reliably shapes pure Arabic-letter runs, and it neither mirrors nor places punctuation.
  const kind = (i: number) =>
    /\s/.test(text[i]) ? 's' : `${levels.levels[i] & 1}${LETTER.test(text[i]) ? 'a' : 'o'}`;
  const groups: number[][] = [];
  for (const index of order) {
    const last = groups[groups.length - 1];
    if (last && kind(last[0]) === kind(index)) last.push(index);
    else groups.push([index]);
  }
  return groups.flatMap((indices) => {
    indices = indices.filter((i) => !CONTROL.test(text[i]));
    if (!indices.length) return [];
    const k = kind(indices[0]);
    if (k === 's') return { text: ' ', rtl: false, space: true };
    const rtl = k[0] === '1';
    // Arabic letters: logical order back to fontkit, which reverses right-to-left script itself.
    if (k[1] === 'a')
      return {
        text: [...indices]
          .reverse()
          .map((i) => text[i])
          .join(''),
        rtl,
      };
    return {
      text: indices
        .map((i) => (rtl ? (bidi.getMirroredCharacter(text[i]) ?? text[i]) : text[i]))
        .join(''),
      rtl,
    };
  });
}

const fontFor = (run: Run, bold: boolean) =>
  ARABIC.test(run.text) ? (bold ? 'arBold' : 'ar') : bold ? 'latBold' : 'lat';

function measure(doc: Doc, text: string, size: number, bold: boolean) {
  return visualRuns(text).map((run) => {
    doc.font(fontFor(run, bold)).fontSize(size);
    return { run, width: doc.widthOfString(run.text) };
  });
}
function widthOf(doc: Doc, text: string, size: number, bold = false) {
  return measure(doc, text, size, bold).reduce((sum, part) => sum + part.width, 0);
}
/** Draws one line inside [x, x + width]; RTL documents default to right alignment. */
function line(doc: Doc, text: string, x: number, y: number, width: number, o: TextOptions = {}) {
  const size = o.size ?? 10;
  const parts = measure(doc, text, size, !!o.bold);
  const total = parts.reduce((sum, part) => sum + part.width, 0);
  const align = o.align ?? 'right';
  let cursor =
    align === 'left' ? x : align === 'center' ? x + (width - total) / 2 : x + width - total;
  doc.fillColor(o.color ?? COLORS.ink);
  for (const part of parts) {
    doc.font(fontFor(part.run, !!o.bold)).fontSize(size);
    doc.text(part.run.text, cursor, y, { lineBreak: false });
    cursor += part.width;
  }
}
/** Word-wraps logical text to the width; returns the wrapped lines in reading order. */
function wrap(doc: Doc, text: string, width: number, size: number, bold = false): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && widthOf(doc, candidate, size, bold) > width) {
        out.push(current);
        current = word;
      } else current = candidate;
    }
    out.push(current);
  }
  return out;
}

export function riyals(halalas: number): string {
  const sign = halalas < 0 ? '-' : '';
  const abs = Math.abs(halalas);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}
const typeLabel: Record<FinanceDocumentType, string> = {
  standard: `ضريبية (منشآت) ${ltr('15%')}`,
  simplified: `ضريبية مبسطة (أفراد) ${ltr('15%')}`,
  zero_rated: 'خاضعة لنسبة الصفر',
  out_of_scope: 'خارج نطاق الضريبة',
};
const address = (a: FinanceCustomerInput['address']) =>
  [a.buildingNumber, a.line, a.district, a.city, a.postalCode].filter(Boolean).join('، ');

type Printable = {
  kind: 'quote' | 'invoice';
  heading: string;
  number: string;
  facts: [string, string][];
  seller: FinanceSeller;
  customer: FinanceCustomerInput;
  lines: FinanceLine[];
  subtotalHalalas: number;
  taxHalalas: number;
  totalHalalas: number;
  notes: string;
  footer: string;
};

function render(p: Printable): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: {
      Title: `${p.heading} ${p.number}`,
      Author: p.seller.name || 'Sabq',
      Producer: 'Sabq HR',
    },
  });
  for (const [name, path] of Object.entries(FONTS)) doc.registerFont(name, path);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = 40,
    right = doc.page.width - 40,
    width = right - left,
    bottom = doc.page.height - 70;

  const footer = () => {
    doc
      .moveTo(left, doc.page.height - 60)
      .lineTo(right, doc.page.height - 60)
      .strokeColor(COLORS.line)
      .stroke();
    for (const [i, text] of wrap(doc, p.footer, width, 8).entries())
      line(doc, text, left, doc.page.height - 54 + i * 11, width, { size: 8, color: COLORS.muted });
  };
  // Header band
  doc.rect(0, 0, doc.page.width, 92).fill(COLORS.brand);
  line(doc, p.seller.name || 'صحيفة سبق', left, 22, width, {
    size: 18,
    bold: true,
    color: '#FFFFFF',
  });
  const sellerFacts = [
    p.seller.vatNumber ? `الرقم الضريبي: ${ltr(p.seller.vatNumber)}` : '',
    p.seller.commercialRegistration ? `السجل التجاري: ${ltr(p.seller.commercialRegistration)}` : '',
  ]
    .filter(Boolean)
    .join('   ');
  if (sellerFacts) line(doc, sellerFacts, left, 50, width, { size: 9, color: '#FFFFFF' });
  if (p.seller.address?.city)
    line(doc, address(p.seller.address), left, 66, width, { size: 9, color: '#FFFFFF' });
  line(doc, p.heading, left, 26, width, { size: 16, bold: true, color: '#FFFFFF', align: 'left' });
  line(doc, p.number, left, 52, width, { size: 11, color: '#FFFFFF', align: 'left' });

  // Facts and customer
  let y = 112;
  const half = width / 2 - 10;
  line(doc, 'العميل', left + half + 20, y, half, { size: 11, bold: true, color: COLORS.brand });
  line(doc, 'بيانات المستند', left, y, half, { size: 11, bold: true, color: COLORS.brand });
  y += 18;
  const customerRows = [
    p.customer.name,
    p.customer.vatNumber ? `الرقم الضريبي: ${ltr(p.customer.vatNumber)}` : '',
    p.customer.commercialRegistration
      ? `السجل التجاري: ${ltr(p.customer.commercialRegistration)}`
      : '',
    address(p.customer.address),
    p.customer.email,
  ].filter(Boolean);
  customerRows.forEach((text, i) =>
    line(doc, text, left + half + 20, y + i * 14, half, { size: 9.5 }),
  );
  p.facts.forEach(([label, value], i) =>
    line(doc, `${label}: ${value}`, left, y + i * 14, half, { size: 9.5 }),
  );
  y += Math.max(customerRows.length, p.facts.length) * 14 + 14;

  // Lines table (columns right to left)
  const cols = [
    { key: 'n', title: '#', w: 24 },
    { key: 'd', title: 'الوصف', w: width - 24 - 50 - 80 - 50 - 90 },
    { key: 'q', title: 'الكمية', w: 50 },
    { key: 'u', title: 'سعر الوحدة', w: 80 },
    { key: 't', title: 'الضريبة', w: 50 },
    { key: 's', title: 'الإجمالي', w: 90 },
  ];
  const header = () => {
    doc.rect(left, y, width, 22).fill(COLORS.band);
    let x = right;
    for (const col of cols) {
      x -= col.w;
      line(doc, col.title, x + 4, y + 6, col.w - 8, { size: 9, bold: true, align: 'center' });
    }
    y += 24;
  };
  header();
  p.lines.forEach((item, index) => {
    const description = wrap(doc, item.description, cols[1].w - 8, 9.5);
    const height = Math.max(1, description.length) * 13 + 8;
    if (y + height > bottom - 90) {
      footer();
      doc.addPage();
      y = 50;
      header();
    }
    const cells: Record<string, string[]> = {
      n: [String(index + 1)],
      d: description,
      q: [item.quantity],
      u: [item.unitPrice],
      t: [`${(item.taxRateBps / 100).toFixed(item.taxRateBps % 100 ? 2 : 0)}%`],
      s: [riyals(item.totalHalalas)],
    };
    let x = right;
    for (const col of cols) {
      x -= col.w;
      cells[col.key].forEach((text, i) =>
        line(doc, text, x + 4, y + 4 + i * 13, col.w - 8, {
          size: 9.5,
          align: col.key === 'd' ? 'right' : 'center',
        }),
      );
    }
    y += height;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(COLORS.line).stroke();
  });

  // Totals
  y += 12;
  if (y > bottom - 80) {
    footer();
    doc.addPage();
    y = 50;
  }
  const totals: [string, number, boolean][] = [
    ['المجموع قبل الضريبة', p.subtotalHalalas, false],
    ['ضريبة القيمة المضافة', p.taxHalalas, false],
    ['الإجمالي المستحق (ريال سعودي)', p.totalHalalas, true],
  ];
  for (const [label, value, strong] of totals) {
    if (strong) doc.rect(left, y - 4, 230, 22).fill(COLORS.band);
    line(doc, label, left + 100, y, 130, { size: 10, bold: strong });
    line(doc, `${riyals(value)} SAR`, left, y, 95, { size: 10, bold: strong, align: 'left' });
    y += 22;
  }
  // Notes and bank
  const extras: string[] = [];
  if (p.notes.trim()) extras.push(`ملاحظات: ${p.notes.trim()}`);
  const bank = p.seller.bankAccount;
  if (bank?.iban)
    extras.push(
      `التحويل البنكي: ${bank.bankName} — ${bank.beneficiaryName} — ${ltr(`IBAN ${bank.iban}`)}`,
    );
  y += 8;
  for (const text of extras)
    for (const row of wrap(doc, text, width, 9.5)) {
      if (y > bottom) {
        footer();
        doc.addPage();
        y = 50;
      }
      line(doc, row, left, y, width, { size: 9.5 });
      y += 14;
    }
  footer();
  doc.end();
  return done;
}

export function quotePdf(quote: FinanceQuote): Promise<Buffer> {
  return render({
    kind: 'quote',
    heading: 'عرض سعر',
    number: quote.number,
    facts: [
      ['العنوان', quote.title],
      ['تاريخ العرض', ltr(quote.issueDate)],
      ['صالح حتى', ltr(quote.validUntil)],
      ['نوع المستند عند الفوترة', typeLabel[quote.documentType ?? 'standard']],
    ],
    seller: quote.seller,
    customer: quote.customer,
    lines: quote.lines,
    subtotalHalalas: quote.subtotalHalalas,
    taxHalalas: quote.taxHalalas,
    totalHalalas: quote.totalHalalas,
    notes: quote.notes,
    footer: `عرض سعر صادر من النظام المالي لمساحة الفريق، صالح حتى ${ltr(quote.validUntil)}. لا يُعد فاتورة ولا مطالبة بالدفع.`,
  });
}

export function invoicePdf(invoice: FinanceInvoice): Promise<Buffer> {
  return render({
    kind: 'invoice',
    heading: 'فاتورة — نسخة داخلية',
    number: invoice.number,
    facts: [
      ['العنوان', invoice.title],
      ['تاريخ الإصدار', ltr(invoice.issueDate)],
      ['تاريخ الاستحقاق', ltr(invoice.dueDate)],
      ['مرجع عرض السعر', ltr(invoice.quoteNumber)],
      ['النوع', typeLabel[invoice.documentType ?? 'standard']],
      ...(invoice.purchaseOrder
        ? ([['أمر الشراء', invoice.purchaseOrder]] as [string, string][])
        : []),
    ],
    seller: invoice.seller,
    customer: invoice.customer,
    lines: invoice.lines,
    subtotalHalalas: invoice.subtotalHalalas,
    taxHalalas: invoice.taxHalalas,
    totalHalalas: invoice.totalHalalas,
    notes: invoice.notes,
    footer:
      'نسخة داخلية للمراجعة من مساحة الفريق، وليست فاتورة ضريبية معتمدة: لا تحمل رمز QR ولا ختم الهيئة. الفاتورة الضريبية الرسمية تصدر عبر المزود المعتمد.',
  });
}
