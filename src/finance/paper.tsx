// The printed paper for quotes and invoices. Shared by the in-app preview (window.print) and the
// server PDF renderer, so both produce the same document from the same markup and stylesheet.
// Keep this module free of hooks, API calls and CSS imports: the server renders it to static HTML.
import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import type {
  FinanceCustomerInput,
  FinanceDocumentLanguage,
  FinanceDocumentType,
  FinanceInvoice,
  FinanceLine,
  FinanceQuote,
  FinanceSeller,
} from '../../shared/finance';
import {
  countryName,
  documentLanguage,
  formatIban,
  isTaxAcceptedInvoice,
} from '../../shared/finance';
import { RiyalSign } from './RiyalSign';
import { SellerBlock } from './SellerBlock';

type Lang = FinanceDocumentLanguage;
/** Arabic papers keep their bilingual labels; English papers carry English only. */
const label = (lang: Lang, ar: string, en: string) => (lang === 'en' ? en : `${ar} / ${en}`);
const documentTypeEnglish: Record<FinanceDocumentType, string> = {
  standard: 'Tax invoice (B2B)',
  simplified: 'Simplified (B2C)',
  zero_rated: 'Zero-rated',
  out_of_scope: 'Non-tax',
};
export const documentTypeShort: Record<FinanceDocumentType, string> = {
  standard: 'ضريبية B2B',
  simplified: 'مبسطة B2C',
  zero_rated: 'نسبة صفرية',
  out_of_scope: 'غير ضريبية',
};
export const invoiceTitle = (type: FinanceDocumentType | undefined, invoiceType?: string) =>
  type === 'out_of_scope'
    ? { ar: 'فاتورة', en: 'Invoice' }
    : invoiceType === 'simplified'
      ? { ar: 'فاتورة ضريبية مبسطة', en: 'Simplified Tax Invoice' }
      : type === 'zero_rated'
        ? { ar: 'فاتورة ضريبية', en: 'Tax Invoice · Zero-rated' }
        : { ar: 'فاتورة ضريبية', en: 'Tax Invoice' };
export const statusText: Record<FinanceInvoice['status'], string> = {
  draft: 'مسودة فاتورة',
  syncing: 'جارٍ الإرسال',
  pending: 'بانتظار نتيجة التحقق',
  cleared: 'فاتورة ضريبية صادرة',
  reported: 'فاتورة ضريبية صادرة',
  rejected: 'مرفوضة',
  reconciliation_required: 'تحتاج إلى مطابقة الحالة',
  cancelled: 'فاتورة ملغاة',
};
const statusTextEnglish: Record<FinanceInvoice['status'], string> = {
  draft: 'Draft invoice',
  syncing: 'Sending',
  pending: 'Awaiting validation',
  cleared: 'Tax invoice issued',
  reported: 'Tax invoice issued',
  rejected: 'Rejected',
  reconciliation_required: 'Status needs reconciliation',
  cancelled: 'Cancelled invoice',
};
const quoteStatusEnglish: Record<FinanceQuote['status'], string> = {
  draft: 'Draft quotation',
  converted: 'Converted to a draft invoice',
  cancelled: 'Cancelled quotation',
};
const quoteFooterEnglish: Record<FinanceQuote['status'], string> = {
  draft: 'Quotation saved as a draft. It is not a tax invoice.',
  converted: 'A draft invoice was created from this quotation. A quotation is not a tax invoice.',
  cancelled: 'Cancelled quotation. It is void and is not a tax invoice.',
};
export const quoteStatusText: Record<FinanceQuote['status'], string> = {
  draft: 'مسودة عرض سعر',
  converted: 'تم التحويل إلى مسودة فاتورة',
  cancelled: 'عرض سعر ملغي',
};
export const quoteFooterText: Record<FinanceQuote['status'], string> = {
  draft: 'عرض سعر محفوظ كمسودة. لم يُرسل إلى العميل، ولا يمثل فاتورة ضريبية.',
  converted: 'تم إنشاء مسودة فاتورة من عرض السعر. عرض السعر لا يمثل فاتورة ضريبية.',
  cancelled: 'عرض سعر ملغي. لا يُعتد به ولا يمثل فاتورة ضريبية.',
};
export function invoiceStatusText(invoice: FinanceInvoice, lang: Lang = 'ar'): string {
  const title = invoiceTitle(invoice.documentType, invoice.invoiceType);
  if (lang === 'en')
    return isTaxAcceptedInvoice(invoice.status)
      ? `${title.en} issued`
      : statusTextEnglish[invoice.status];
  return isTaxAcceptedInvoice(invoice.status) ? `${title.ar} صادرة` : statusText[invoice.status];
}
type StatusKind = 'neutral' | 'good' | 'bad' | 'waiting' | 'cancelled';
export function invoiceStatusKind(status: FinanceInvoice['status']): StatusKind {
  if (status === 'cancelled') return 'cancelled';
  return isTaxAcceptedInvoice(status)
    ? 'good'
    : status === 'rejected' || status === 'reconciliation_required'
      ? 'bad'
      : status === 'draft' || status === 'pending'
        ? 'waiting'
        : 'neutral';
}
/** A converted quote is only green once its linked invoice has confirmed acceptance. */
export function quoteStatus(quote: FinanceQuote, invoice?: FinanceInvoice) {
  if (quote.status === 'cancelled') return { text: 'ملغي', kind: 'cancelled' as const };
  if (invoice?.status === 'cancelled') return { text: 'أُلغيت فاتورته', kind: 'cancelled' as const };
  if (quote.status === 'draft' || !invoice || invoice.status === 'draft') {
    return { text: quoteStatusText[quote.status], kind: 'waiting' as const };
  }
  return {
    text: isTaxAcceptedInvoice(invoice.status) ? 'تم إصدار الفاتورة' : statusText[invoice.status],
    kind: invoiceStatusKind(invoice.status),
  };
}
/** Always shown on API document.pdf copies; the official tax invoice is /api/finance/invoices/:id/pdf. */
export const INTERNAL_COPY_LABEL =
  'نسخة داخلية – ليست الفاتورة الضريبية الرسمية / Internal copy – not the official tax invoice';

/** Crosses a cancelled document so a printed or exported copy cannot pass for a live one. */
export function CancelledStamp({ lang = 'ar' }: { lang?: Lang }) {
  return (
    <div className="fin-cancelled-stamp" aria-hidden="true">
      <X size={30} strokeWidth={3} />
      {lang === 'en' ? <span>CANCELLED</span> : <span>ملغي</span>}
      {lang !== 'en' && <small>CANCELLED</small>}
    </div>
  );
}
export function Status({ text, kind = 'neutral' }: { text: string; kind?: StatusKind }) {
  return (
    <span className={`fin-status ${kind}`}>
      {kind === 'cancelled' ? (
        <X size={12} strokeWidth={3} aria-hidden="true" />
      ) : (
        <i aria-hidden="true" />
      )}
      {text}
    </span>
  );
}

/** Quote paper exactly as shown in the preview dialog. */
export function QuotePaper({ quote, seller }: { quote: FinanceQuote; seller: FinanceSeller }) {
  const lang = documentLanguage(quote);
  const status = (lang === 'en' ? quoteStatusEnglish : quoteStatusText)[quote.status];
  const statusKind: StatusKind = quote.status === 'cancelled' ? 'cancelled' : 'waiting';
  return (
    <article
      className={`fin-document-paper fin-quote-paper${quote.status === 'cancelled' ? ' is-cancelled' : ''}`}
      dir={lang === 'en' ? 'ltr' : 'rtl'}
      lang={lang}
    >
      {quote.status === 'cancelled' && <CancelledStamp lang={lang} />}
      <DocumentHeader
        lang={lang}
        seller={seller}
        title={lang === 'en' ? 'Price Quotation' : 'عرض سعر'}
        subtitle={lang === 'en' ? undefined : 'Price Quotation'}
        number={quote.number}
        status={status}
        statusKind={statusKind}
      />
      <div className="fin-document-rule" />
      <div className="fin-document-cards">
        <CustomerDetails lang={lang} customer={quote.customer} />
        <DocumentDetails
          lang={lang}
          kind="quote"
          number={quote.number}
          issueDate={quote.issueDate}
          validUntil={quote.validUntil}
          status={status}
          statusKind={statusKind}
          documentType={quote.documentType ?? 'standard'}
        />
      </div>
      <LineItemsTable
        lang={lang}
        lines={quote.lines}
        noVat={quote.documentType === 'out_of_scope'}
      />
      <div className="fin-document-ending">
        <PaperTotals
          lang={lang}
          subtotal={quote.subtotalHalalas}
          tax={quote.taxHalalas}
          total={quote.totalHalalas}
          totalLabel={label(lang, 'الإجمالي', 'Total')}
          noVat={quote.documentType === 'out_of_scope'}
        />
        <BankAccountDetails lang={lang} seller={seller} />
        {quote.notes && <NotesBox lang={lang} notes={quote.notes} />}
        <PaperFooter lang={lang}>
          {(lang === 'en' ? quoteFooterEnglish : quoteFooterText)[quote.status]}
        </PaperFooter>
      </div>
    </article>
  );
}

/** Invoice paper exactly as shown in the preview dialog. `qrSrc` is only used once accepted. */
export function InvoicePaper({
  invoice,
  seller,
  qrSrc,
  internalCopy = false,
}: {
  invoice: FinanceInvoice;
  seller: FinanceSeller;
  qrSrc?: string;
  /** API document.pdf copies; never the official tax invoice from the provider. */
  internalCopy?: boolean;
}) {
  const accepted = ['cleared', 'reported'].includes(invoice.status);
  const qrShown = Boolean(accepted && invoice.qrCode && qrSrc);
  const cancelled = invoice.status === 'cancelled';
  const lang = documentLanguage(invoice);
  const en = lang === 'en';
  const title = invoiceTitle(invoice.documentType, invoice.invoiceType);
  const status = invoiceStatusText(invoice, lang);
  const statusKind = invoiceStatusKind(invoice.status);
  return (
    <article
      className={`fin-document-paper fin-invoice-paper${cancelled ? ' is-cancelled' : ''}`}
      dir={en ? 'ltr' : 'rtl'}
      lang={lang}
    >
      {cancelled && <CancelledStamp lang={lang} />}
      <DocumentHeader
        lang={lang}
        seller={seller}
        title={en ? title.en : title.ar}
        subtitle={en ? undefined : title.en}
        number={invoice.number}
        status={status}
        statusKind={statusKind}
      />
      <div className="fin-document-rule" />
      {internalCopy && (
        <div className="fin-internal-copy-banner">
          {!en && 'نسخة داخلية – ليست الفاتورة الضريبية الرسمية'}
          <span lang="en">Internal copy – not the official tax invoice</span>
        </div>
      )}
      {accepted ? (
        <div className="fin-final-banner">
          <Check size={17} />
          {status} · {en ? 'Status confirmed by Wafeq and ZATCA' : 'حالة مصدرها وافق والهيئة'}
        </div>
      ) : (
        <div className="fin-draft-watermark">
          {cancelled
            ? en
              ? 'Cancelled invoice · void'
              : 'فاتورة ملغاة · لا يُعتد بها'
            : en
              ? 'Draft invoice · internal preview only'
              : 'مسودة فاتورة · للمعاينة الداخلية فقط'}
        </div>
      )}
      <div className="fin-document-cards">
        <CustomerDetails lang={lang} customer={invoice.customer} />
        <DocumentDetails
          lang={lang}
          kind="invoice"
          number={invoice.number}
          issueDate={invoice.issueDate}
          validUntil={invoice.dueDate}
          validUntilLabel={label(lang, 'تاريخ الاستحقاق', 'Due Date')}
          status={status}
          statusKind={statusKind}
          purchaseOrder={invoice.purchaseOrder}
          documentType={invoice.documentType}
        />
      </div>
      <h2 className="fin-document-title">{invoice.title}</h2>
      <LineItemsTable
        lang={lang}
        lines={invoice.lines}
        noVat={invoice.documentType === 'out_of_scope'}
      />
      <div className="fin-document-ending">
        <PaperTotals
          lang={lang}
          subtotal={invoice.subtotalHalalas}
          tax={invoice.taxHalalas}
          total={invoice.totalHalalas}
          totalLabel={label(lang, 'الإجمالي المستحق', 'Total Due')}
          noVat={invoice.documentType === 'out_of_scope'}
          aside={
            qrShown ? (
              <div className="fin-qr-wrap" dir={en ? 'ltr' : 'rtl'}>
                <img
                  className="fin-qr"
                  src={qrSrc}
                  alt={en ? 'Invoice verification QR' : 'رمز التحقق من الفاتورة'}
                />
                <b>
                  {internalCopy
                    ? label(lang, 'رمز التحقق', 'QR')
                    : label(lang, 'فاتورة ضريبية', 'Tax Invoice')}
                </b>
                <small>
                  {internalCopy
                    ? en
                      ? 'Code derived from the stored value. This is an internal copy, not the official invoice.'
                      : 'رمز مستمد من القيمة المخزّنة. هذه نسخة داخلية وليست الفاتورة الرسمية.'
                    : en
                      ? 'Verification code issued by Wafeq after the invoice was accepted.'
                      : 'رمز التحقق صادر من وافق بعد قبول الفاتورة.'}
                </small>
              </div>
            ) : null
          }
        />
        <BankAccountDetails lang={lang} seller={seller} />
        {invoice.notes && <NotesBox lang={lang} notes={invoice.notes} />}
        <PaperFooter lang={lang}>
          {invoiceFooterText(invoice, { qrShown, internalCopy, lang })}
        </PaperFooter>
      </div>
    </article>
  );
}

function invoiceFooterText(
  invoice: FinanceInvoice,
  { qrShown, internalCopy, lang }: { qrShown: boolean; internalCopy: boolean; lang: Lang },
): string {
  if (lang === 'en') {
    const parts: string[] = [];
    if (invoice.documentType === 'out_of_scope')
      parts.push('Non-tax document: the amount is outside the scope of VAT.');
    if (invoice.status === 'cancelled')
      parts.push('Draft invoice cancelled before issue. It is void and is not a tax document.');
    else if (!['cleared', 'reported'].includes(invoice.status))
      parts.push('Internal preview of a draft; not an issued invoice or a tax document.');
    if (internalCopy) parts.push('Internal copy – not the official tax invoice.');
    return parts.join(' ');
  }
  const parts: string[] = [];
  if (invoice.documentType === 'out_of_scope') {
    parts.push('مستند غير ضريبي: المبلغ خارج نطاق ضريبة القيمة المضافة.');
  }
  if (invoice.status === 'cancelled') {
    parts.push('مسودة فاتورة ملغاة قبل الإصدار. لا يُعتد بها وليست مستندًا ضريبيًا.');
  } else if (!['cleared', 'reported'].includes(invoice.status)) {
    parts.push('هذه معاينة داخلية للمسودة وليست فاتورة صادرة أو مستندًا ضريبيًا.');
  } else if (qrShown && !internalCopy) {
    // In-app preview may state compliance only when the QR image is actually on the paper.
    parts.push('فاتورة سبق متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك.');
  }
  if (internalCopy) parts.push(INTERNAL_COPY_LABEL);
  return parts.join(' ');
}

function DocumentHeader({
  lang,
  seller,
  title,
  number,
  status,
  statusKind,
  subtitle,
}: {
  lang: Lang;
  seller: FinanceSeller;
  title: string;
  number: string;
  status: string;
  statusKind: StatusKind;
  subtitle?: string;
}) {
  return (
    <header className="fin-doc-head">
      <SellerBlock seller={seller} lang={lang} />
      <aside className="fin-doc-heading">
        <h1>{title}</h1>
        {subtitle && <span>{subtitle}</span>}
        <Status text={status} kind={statusKind} />
        <b className="fin-doc-number" dir="ltr">
          {number}
        </b>
      </aside>
    </header>
  );
}

function CardHeader({ lang, ar, en }: { lang: Lang; ar: string; en: string }) {
  return lang === 'en' ? (
    <header>
      <b>{en}</b>
    </header>
  ) : (
    <header>
      <b>{ar}</b>
      <span lang="en">{en}</span>
    </header>
  );
}

function CustomerDetails({ lang, customer }: { lang: Lang; customer: FinanceCustomerInput }) {
  const en = lang === 'en';
  const country = customer.address.country;
  return (
    <section className="fin-detail-card">
      <CardHeader lang={lang} ar="بيانات العميل" en="Customer Details" />
      <dl>
        <div>
          <dt>{label(lang, 'الاسم', 'Name')}</dt>
          <dd>{(en && customer.nameEnglish) || customer.name || '—'}</dd>
        </div>
        {!en && customer.nameEnglish && (
          <div>
            <dt>الاسم بالإنجليزية / English Name</dt>
            <dd dir="ltr">{customer.nameEnglish}</dd>
          </div>
        )}
        <div>
          <dt>{label(lang, 'العنوان', 'Address')}</dt>
          <dd>
            {[
              customer.address.line,
              customer.address.district,
              customer.address.city,
              customer.address.postalCode,
              // A Saudi address on an Arabic paper reads without its country, as before.
              en || (country && country !== 'SA') ? countryName(country, lang) : '',
            ]
              .filter(Boolean)
              .join(en ? ', ' : '، ') || '—'}
          </dd>
        </div>
        {customer.vatNumber && (
          <div>
            <dt>{label(lang, 'الرقم الضريبي', en && country !== 'SA' ? 'Tax ID' : 'VAT No')}</dt>
            <dd dir="ltr">{customer.vatNumber}</dd>
          </div>
        )}
        {customer.commercialRegistration && (
          <div>
            <dt>
              {label(lang, 'السجل التجاري', en && country !== 'SA' ? 'Registration No' : 'CR')}
            </dt>
            <dd dir="ltr">{customer.commercialRegistration}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function DocumentDetails({
  lang,
  statusKind,
  kind,
  number,
  issueDate,
  validUntil,
  validUntilLabel,
  status,
  purchaseOrder,
  documentType,
}: {
  lang: Lang;
  statusKind: StatusKind;
  kind: 'quote' | 'invoice';
  number: string;
  issueDate: string;
  validUntil?: string;
  validUntilLabel?: string;
  status: string;
  purchaseOrder?: string;
  documentType?: FinanceDocumentType;
}) {
  return (
    <section className="fin-detail-card fin-detail-rows">
      <CardHeader
        lang={lang}
        ar={kind === 'quote' ? 'بيانات عرض السعر' : 'بيانات الفاتورة'}
        en={kind === 'quote' ? 'Quotation Details' : 'Invoice Details'}
      />
      <dl>
        <div>
          <dt>
            {kind === 'quote'
              ? label(lang, 'رقم العرض', 'Quotation No')
              : label(lang, 'رقم الفاتورة', 'Invoice No')}
          </dt>
          <dd dir="ltr">{number}</dd>
        </div>
        <div>
          <dt>{label(lang, 'تاريخ الإصدار', 'Issue Date')}</dt>
          <dd dir="ltr">{issueDate}</dd>
        </div>
        {validUntil && (
          <div>
            <dt>{validUntilLabel ?? label(lang, 'صالح حتى', 'Valid Until')}</dt>
            <dd dir="ltr">{validUntil}</dd>
          </div>
        )}
        {documentType && (
          <div>
            <dt>{label(lang, 'نوع الفاتورة', 'Invoice Type')}</dt>
            <dd>
              {lang === 'en' ? documentTypeEnglish[documentType] : documentTypeShort[documentType]}
            </dd>
          </div>
        )}
        {purchaseOrder && (
          <div>
            <dt>{label(lang, 'أمر الشراء', 'Purchase Order')}</dt>
            <dd dir="ltr">{purchaseOrder}</dd>
          </div>
        )}
        <div>
          <dt>{label(lang, 'الحالة', 'Status')}</dt>
          <dd>
            <Status text={status} kind={statusKind} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

function LineItemsTable({
  lang,
  lines,
  noVat = false,
}: {
  lang: Lang;
  lines: FinanceLine[];
  noVat?: boolean;
}) {
  const percent = (bps: number) =>
    new Intl.NumberFormat('en-SA', { maximumFractionDigits: 2 }).format(bps / 100);
  // Table cells show plain amounts like the legacy layout; currency appears in the totals.
  const amount = (halalas: number) =>
    new Intl.NumberFormat('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      halalas / 100,
    );
  return (
    <div className="fin-paper-table-wrap">
      <table className="fin-paper-table">
        <thead>
          <tr>
            <th scope="col" className="fin-paper-number">
              #
            </th>
            <th scope="col" className="fin-paper-description">
              {label(lang, 'الوصف', 'Description')}
            </th>
            <th scope="col">{label(lang, 'الكمية', 'Qty')}</th>
            <th scope="col">{label(lang, 'السعر', 'Unit Price')}</th>
            {!noVat && <th scope="col">{label(lang, 'الضريبة', 'VAT')}</th>}
            {!noVat && <th scope="col">{label(lang, 'مبلغ الضريبة', 'VAT Amt')}</th>}
            <th scope="col">{label(lang, 'الإجمالي', 'Total')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.description}-${index}`}>
              <td className="fin-paper-number" dir="ltr">
                {index + 1}
              </td>
              <td className="fin-paper-description">
                {line.description}
                {!noVat && line.taxRateBps === 0 && line.taxReason && (
                  <small className="fin-paper-reason">
                    {label(lang, 'سبب عدم احتساب الضريبة', 'VAT exemption reason')}:{' '}
                    {line.taxReason}
                  </small>
                )}
              </td>
              <td dir="ltr">{line.quantity}</td>
              <td dir="ltr">{amount(Math.round(Number(line.unitPrice) * 100))}</td>
              {!noVat && <td dir="ltr">{percent(line.taxRateBps)}%</td>}
              {!noVat && <td dir="ltr">{amount(line.taxHalalas)}</td>}
              <td dir="ltr">{amount(line.totalHalalas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaperAmount({ halalas }: { halalas: number }) {
  const value = new Intl.NumberFormat('en-SA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(halalas / 100);
  return (
    <b dir="ltr" className="fin-paper-amount">
      <RiyalSign />
      {value}
    </b>
  );
}

function PaperTotals({
  lang,
  subtotal,
  tax,
  total,
  totalLabel,
  aside,
  noVat = false,
}: {
  lang: Lang;
  subtotal: number;
  tax: number;
  total: number;
  totalLabel: string;
  aside?: ReactNode;
  noVat?: boolean;
}) {
  return (
    <div className="fin-paper-summary" dir="ltr">
      <div className="fin-paper-summary-rows" dir={lang === 'en' ? 'ltr' : 'rtl'}>
        {!noVat && (
          <div>
            <span>{label(lang, 'المجموع الفرعي', 'Subtotal')}</span>
            <PaperAmount halalas={subtotal} />
          </div>
        )}
        {!noVat && (
          <div>
            <span>{label(lang, 'ضريبة القيمة المضافة', 'VAT')}</span>
            <PaperAmount halalas={tax} />
          </div>
        )}
        <div className="fin-paper-grand-total">
          <span>{totalLabel}</span>
          <PaperAmount halalas={total} />
        </div>
      </div>
      {aside}
    </div>
  );
}

function BankAccountDetails({ lang, seller }: { lang: Lang; seller: FinanceSeller }) {
  const bank = seller.bankAccount;
  if (!bank || !Object.values(bank).some((value) => value.trim())) return null;
  return (
    <section className="fin-bank-card">
      <CardHeader lang={lang} ar="بيانات الحساب البنكي" en="Bank Account Details" />
      <dl>
        {bank.beneficiaryName && (
          <div>
            <dt>{label(lang, 'اسم المستفيد', 'Beneficiary Name')}</dt>
            <dd>{bank.beneficiaryName}</dd>
          </div>
        )}
        {bank.bankName && (
          <div>
            <dt>{label(lang, 'البنك', 'Bank')}</dt>
            <dd>{bank.bankName}</dd>
          </div>
        )}
        {bank.accountNumber && (
          <div>
            <dt>{label(lang, 'رقم الحساب', 'Account No')}</dt>
            <dd className="fin-bank-value" dir="ltr">
              {bank.accountNumber}
            </dd>
          </div>
        )}
        {bank.iban && (
          <div>
            <dt>{label(lang, 'الآيبان', 'IBAN')}</dt>
            <dd className="fin-bank-value" dir="ltr">
              {formatIban(bank.iban)}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function NotesBox({ lang, notes }: { lang: Lang; notes: string }) {
  return (
    <section className="fin-notes-box">
      <b>{label(lang, 'ملاحظات', 'Notes')}</b>
      <p>{notes}</p>
    </section>
  );
}

function PaperFooter({ lang, children }: { lang: Lang; children: ReactNode }) {
  return (
    <footer className="fin-paper-footer">
      <span>{children}</span>
      <span>
        {lang !== 'en' && 'أُنشئ هذا المستند إلكترونيًا | '}
        <span lang="en">This document was generated electronically</span>
      </span>
    </footer>
  );
}
