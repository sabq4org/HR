// The printed paper for quotes and invoices. Shared by the in-app preview (window.print) and the
// server PDF renderer, so both produce the same document from the same markup and stylesheet.
// Keep this module free of hooks, API calls and CSS imports: the server renders it to static HTML.
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type {
  FinanceCustomerInput,
  FinanceDocumentType,
  FinanceInvoice,
  FinanceLine,
  FinanceQuote,
  FinanceSeller,
} from '../../shared/finance';
import { RiyalSign } from './RiyalSign';
import { SellerBlock } from './SellerBlock';

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
  cleared: 'معتمدة',
  reported: 'تم الإبلاغ عنها',
  rejected: 'مرفوضة',
  reconciliation_required: 'تحتاج إلى مطابقة الحالة',
};

export function Status({
  text,
  kind = 'neutral',
}: {
  text: string;
  kind?: 'neutral' | 'good' | 'bad' | 'waiting';
}) {
  return (
    <span className={`fin-status ${kind}`}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

/** Quote paper exactly as shown in the preview dialog. */
export function QuotePaper({ quote, seller }: { quote: FinanceQuote; seller: FinanceSeller }) {
  return (
    <article className="fin-document-paper fin-quote-paper" dir="rtl" lang="ar">
      <DocumentHeader
        seller={seller}
        kind="quote"
        title="عرض سعر"
        number={quote.number}
        status="مسودة عرض سعر"
      />
      <div className="fin-document-rule" />
      <div className="fin-document-cards">
        <CustomerDetails customer={quote.customer} />
        <DocumentDetails
          kind="quote"
          number={quote.number}
          issueDate={quote.issueDate}
          validUntil={quote.validUntil}
          status="مسودة عرض سعر"
          documentType={quote.documentType ?? 'standard'}
        />
      </div>
      <LineItemsTable lines={quote.lines} noVat={quote.documentType === 'out_of_scope'} />
      <div className="fin-document-ending">
        <PaperTotals
          subtotal={quote.subtotalHalalas}
          tax={quote.taxHalalas}
          total={quote.totalHalalas}
          totalLabel="الإجمالي / Total"
          noVat={quote.documentType === 'out_of_scope'}
        />
        <BankAccountDetails seller={seller} />
        {quote.notes && <NotesBox notes={quote.notes} />}
        <PaperFooter>عرض سعر محفوظ كمسودة. لم يُرسل إلى العميل، ولا يمثل فاتورة ضريبية.</PaperFooter>
      </div>
    </article>
  );
}

/** Invoice paper exactly as shown in the preview dialog. `qrSrc` is only used once accepted. */
export function InvoicePaper({
  invoice,
  seller,
  qrSrc,
}: {
  invoice: FinanceInvoice;
  seller: FinanceSeller;
  qrSrc?: string;
}) {
  return (
    <article className="fin-document-paper fin-invoice-paper" dir="rtl" lang="ar">
      <DocumentHeader
        seller={seller}
        kind="invoice"
        title={invoiceTitle(invoice.documentType, invoice.invoiceType).ar}
        subtitle={invoiceTitle(invoice.documentType, invoice.invoiceType).en}
        number={invoice.number}
        status={statusText[invoice.status]}
      />
      <div className="fin-document-rule" />
      {['cleared', 'reported'].includes(invoice.status) ? (
        <div className="fin-final-banner">
          <Check size={17} />
          {statusText[invoice.status]} · حالة مصدرها وافق والهيئة
        </div>
      ) : (
        <div className="fin-draft-watermark">مسودة فاتورة · للمعاينة الداخلية فقط</div>
      )}
      <div className="fin-document-cards">
        <CustomerDetails customer={invoice.customer} />
        <DocumentDetails
          kind="invoice"
          number={invoice.number}
          issueDate={invoice.issueDate}
          validUntil={invoice.dueDate}
          validUntilLabel="تاريخ الاستحقاق / Due Date"
          status={statusText[invoice.status]}
          purchaseOrder={invoice.purchaseOrder}
          documentType={invoice.documentType}
        />
      </div>
      <h2 className="fin-document-title">{invoice.title}</h2>
      <LineItemsTable lines={invoice.lines} noVat={invoice.documentType === 'out_of_scope'} />
      <div className="fin-document-ending">
        <PaperTotals
          subtotal={invoice.subtotalHalalas}
          tax={invoice.taxHalalas}
          total={invoice.totalHalalas}
          totalLabel="الإجمالي المستحق / Total Due"
          noVat={invoice.documentType === 'out_of_scope'}
          aside={
            ['cleared', 'reported'].includes(invoice.status) && invoice.qrCode && qrSrc ? (
              <div className="fin-qr-wrap" dir="rtl">
                <img className="fin-qr" src={qrSrc} alt="رمز التحقق من الفاتورة" />
                <b>فاتورة ضريبية / Tax Invoice</b>
                <small>رمز التحقق صادر من وافق بعد قبول الفاتورة.</small>
              </div>
            ) : null
          }
        />
        <BankAccountDetails seller={seller} />
        {invoice.notes && <NotesBox notes={invoice.notes} />}
        <PaperFooter>
          {invoice.documentType === 'out_of_scope'
            ? 'مستند غير ضريبي: المبلغ خارج نطاق ضريبة القيمة المضافة.'
            : ['cleared', 'reported'].includes(invoice.status) && invoice.qrCode
              ? 'فاتورة سبق متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك.'
              : 'هذه معاينة داخلية للمسودة وليست فاتورة صادرة أو مستندًا ضريبيًا.'}
        </PaperFooter>
      </div>
    </article>
  );
}

function DocumentHeader({
  seller,
  kind,
  title,
  number,
  status,
  subtitle,
}: {
  seller: FinanceSeller;
  kind: 'quote' | 'invoice';
  title: string;
  number: string;
  status: string;
  subtitle?: string;
}) {
  return (
    <header className="fin-doc-head">
      <SellerBlock seller={seller} />
      <aside className="fin-doc-heading">
        <h1>{title}</h1>
        <span>{subtitle ?? (kind === 'quote' ? 'Price Quotation' : 'Tax Invoice')}</span>
        <Status
          text={status}
          kind={kind === 'quote' || status.includes('مسودة') ? 'waiting' : 'good'}
        />
        <b className="fin-doc-number" dir="ltr">
          {number}
        </b>
      </aside>
    </header>
  );
}

function CustomerDetails({ customer }: { customer: FinanceCustomerInput }) {
  return (
    <section className="fin-detail-card">
      <header>
        <b>بيانات العميل</b>
        <span lang="en">Customer Details</span>
      </header>
      <dl>
        <div>
          <dt>الاسم / Name</dt>
          <dd>{customer.name || '—'}</dd>
        </div>
        {customer.nameEnglish && (
          <div>
            <dt>الاسم بالإنجليزية / English Name</dt>
            <dd dir="ltr">{customer.nameEnglish}</dd>
          </div>
        )}
        <div>
          <dt>العنوان / Address</dt>
          <dd>
            {[
              customer.address.line,
              customer.address.district,
              customer.address.city,
              customer.address.postalCode,
            ]
              .filter(Boolean)
              .join('، ') || '—'}
          </dd>
        </div>
        {customer.vatNumber && (
          <div>
            <dt>الرقم الضريبي / VAT No</dt>
            <dd dir="ltr">{customer.vatNumber}</dd>
          </div>
        )}
        {customer.commercialRegistration && (
          <div>
            <dt>السجل التجاري / CR</dt>
            <dd dir="ltr">{customer.commercialRegistration}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function DocumentDetails({
  kind,
  number,
  issueDate,
  validUntil,
  validUntilLabel,
  status,
  purchaseOrder,
  documentType,
}: {
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
      <header>
        <b>{kind === 'quote' ? 'بيانات عرض السعر' : 'بيانات الفاتورة'}</b>
        <span lang="en">{kind === 'quote' ? 'Quotation Details' : 'Invoice Details'}</span>
      </header>
      <dl>
        <div>
          <dt>{kind === 'quote' ? 'رقم العرض / Quotation No' : 'رقم الفاتورة / Invoice No'}</dt>
          <dd dir="ltr">{number}</dd>
        </div>
        <div>
          <dt>تاريخ الإصدار / Issue Date</dt>
          <dd dir="ltr">{issueDate}</dd>
        </div>
        {validUntil && (
          <div>
            <dt>{validUntilLabel ?? 'صالح حتى / Valid Until'}</dt>
            <dd dir="ltr">{validUntil}</dd>
          </div>
        )}
        {documentType && (
          <div>
            <dt>نوع الفاتورة / Invoice Type</dt>
            <dd>{documentTypeShort[documentType]}</dd>
          </div>
        )}
        {purchaseOrder && (
          <div>
            <dt>أمر الشراء / Purchase Order</dt>
            <dd dir="ltr">{purchaseOrder}</dd>
          </div>
        )}
        <div>
          <dt>الحالة / Status</dt>
          <dd>
            <Status text={status} kind={status.includes('مسودة') ? 'waiting' : 'good'} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

function LineItemsTable({ lines, noVat = false }: { lines: FinanceLine[]; noVat?: boolean }) {
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
              الوصف / Description
            </th>
            <th scope="col">الكمية / Qty</th>
            <th scope="col">السعر / Unit Price</th>
            {!noVat && <th scope="col">الضريبة / VAT</th>}
            {!noVat && <th scope="col">مبلغ الضريبة / VAT Amt</th>}
            <th scope="col">الإجمالي / Total</th>
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
                    سبب عدم احتساب الضريبة / VAT exemption reason: {line.taxReason}
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
  subtotal,
  tax,
  total,
  totalLabel,
  aside,
  noVat = false,
}: {
  subtotal: number;
  tax: number;
  total: number;
  totalLabel: string;
  aside?: ReactNode;
  noVat?: boolean;
}) {
  return (
    <div className="fin-paper-summary" dir="ltr">
      <div className="fin-paper-summary-rows" dir="rtl">
        {!noVat && (
          <div>
            <span>المجموع الفرعي / Subtotal</span>
            <PaperAmount halalas={subtotal} />
          </div>
        )}
        {!noVat && (
          <div>
            <span>ضريبة القيمة المضافة / VAT</span>
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

function BankAccountDetails({ seller }: { seller: FinanceSeller }) {
  const bank = seller.bankAccount;
  if (!bank || !Object.values(bank).some((value) => value.trim())) return null;
  return (
    <section className="fin-bank-card">
      <header>
        <b>بيانات الحساب البنكي</b>
        <span lang="en">Bank Account Details</span>
      </header>
      <dl>
        {bank.beneficiaryName && (
          <div>
            <dt>اسم المستفيد / Beneficiary Name</dt>
            <dd>{bank.beneficiaryName}</dd>
          </div>
        )}
        {bank.bankName && (
          <div>
            <dt>البنك / Bank</dt>
            <dd>{bank.bankName}</dd>
          </div>
        )}
        {bank.accountNumber && (
          <div>
            <dt>رقم الحساب / Account No</dt>
            <dd dir="ltr">{bank.accountNumber}</dd>
          </div>
        )}
        {bank.iban && (
          <div>
            <dt>الآيبان / IBAN</dt>
            <dd dir="ltr">{bank.iban}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function NotesBox({ notes }: { notes: string }) {
  return (
    <section className="fin-notes-box">
      <b>ملاحظات / Notes</b>
      <p>{notes}</p>
    </section>
  );
}

function PaperFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="fin-paper-footer">
      <span>{children}</span>
      <span>
        أُنشئ هذا المستند إلكترونيًا |{' '}
        <span lang="en">This document was generated electronically</span>
      </span>
    </footer>
  );
}
