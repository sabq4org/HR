import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import type { FinanceCustomer } from '../../shared/finance';
import type { CustomerStatement, CustomerStatementRow } from '../../shared/ledger';
import { api, Modal } from '../lib';
import { SellerBlock } from './SellerBlock';

const amount = (halalas: number) =>
  new Intl.NumberFormat('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    halalas / 100,
  );
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
const kindText: Record<CustomerStatementRow['kind'], string> = {
  invoice: 'فاتورة',
  receipt: 'سداد',
  credit_note: 'إشعار دائن',
  reversal: 'عكس',
};

/** Customer statement preview; prints on landscape A4 in the same paper style as the invoice. */
export function CustomerStatementModal({
  customer,
  close,
}: {
  customer: FinanceCustomer;
  close: () => void;
}) {
  const [range, setRange] = useState({ from: '', to: today() });
  const [statement, setStatement] = useState<CustomerStatement | null>(null);
  // The range the visible statement was loaded for; printing waits until it matches the inputs.
  const [loaded, setLoaded] = useState('');
  const wanted = `${range.from}|${range.to}`;
  const [error, setError] = useState('');
  useEffect(() => {
    if (!range.to || (range.from && range.from > range.to)) {
      setError('بداية الفترة يجب ألا تتجاوز نهايتها.');
      return;
    }
    let live = true;
    const query = new URLSearchParams({
      to: range.to,
      ...(range.from ? { from: range.from } : {}),
    });
    api<{ statement: CustomerStatement }>(
      `/finance/customers/${encodeURIComponent(customer.id)}/statement?${query}`,
    )
      .then((result) => {
        if (!live) return;
        setStatement(result.statement);
        setLoaded(wanted);
        setError('');
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : 'تعذّر تحميل كشف الحساب.');
      });
    return () => {
      live = false;
    };
  }, [customer.id, range.from, range.to, wanted]);
  // Browsers without named-page support still need the sheet turned to landscape.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = '@page { size: A4 landscape; margin: 10mm 12mm; }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  return (
    <Modal
      title={`كشف حساب · ${customer.name}`}
      close={close}
      wide
      className="fin-statement-dialog"
    >
      <div className="fin-preview-actions fin-statement-actions">
        <label>
          <span>من</span>
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </label>
        <label>
          <span>إلى</span>
          <input
            type="date"
            required
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </label>
        <button
          className="button primary"
          disabled={!statement || Boolean(error) || loaded !== wanted}
          onClick={() => window.print()}
        >
          <Printer size={16} />
          طباعة أو حفظ PDF
        </button>
        {statement && statement.unpostedInvoices > 0 && (
          <small>
            {statement.unpostedInvoices === 1
              ? 'فاتورة واحدة معتمدة لم تُرحَّل'
              : `${statement.unpostedInvoices} فواتير معتمدة لم تُرحَّل`}{' '}
            إلى الدفاتر بعد، فلا يظهر عليها سداد حتى تُرحَّل من صفحة الإيرادات.
          </small>
        )}
      </div>
      {error && (
        <p className="fin-alert" role="alert">
          {error}
        </p>
      )}
      {statement && (
        <div
          aria-busy={loaded !== wanted}
          className={loaded !== wanted ? 'fin-statement-stale' : ''}
        >
          <StatementPaper statement={statement} />
        </div>
      )}
    </Modal>
  );
}

function StatementPaper({ statement }: { statement: CustomerStatement }) {
  const { customer, seller } = statement;
  const address = [
    customer.address.line,
    customer.address.district,
    customer.address.city,
    customer.address.postalCode,
  ]
    .filter(Boolean)
    .join('، ');
  return (
    <article className="fin-document-paper fin-statement-paper" dir="rtl" lang="ar">
      <header className="fin-doc-head">
        <SellerBlock seller={seller} />
        <aside className="fin-doc-heading">
          <h1>كشف حساب العميل</h1>
          <span>Customer Statement</span>
        </aside>
      </header>
      <div className="fin-document-rule" />
      <section className="fin-detail-card fin-statement-customer">
        <header>
          <b>بيانات العميل</b>
          <span lang="en">Customer Details</span>
        </header>
        <dl>
          <div>
            <dt>اسم العميل / Name</dt>
            <dd>{customer.name || '—'}</dd>
          </div>
          <div>
            <dt>الرقم الضريبي / VAT No</dt>
            <dd dir="ltr">{customer.vatNumber || '—'}</dd>
          </div>
          {customer.commercialRegistration && (
            <div>
              <dt>السجل التجاري / CR</dt>
              <dd dir="ltr">{customer.commercialRegistration}</dd>
            </div>
          )}
          <div>
            <dt>العنوان / Address</dt>
            <dd>{address || '—'}</dd>
          </div>
        </dl>
      </section>
      <dl className="fin-statement-stats">
        <div>
          <dt>الفترة من / From</dt>
          <dd dir={statement.from ? 'ltr' : undefined}>{statement.from ?? 'بداية التعامل'}</dd>
        </div>
        <div>
          <dt>الفترة إلى / To</dt>
          <dd dir="ltr">{statement.to}</dd>
        </div>
        {statement.from && (
          <div>
            <dt>الرصيد الافتتاحي / Opening</dt>
            <dd dir="ltr">{amount(statement.openingHalalas)}</dd>
          </div>
        )}
        <div>
          <dt>إجمالي الفواتير / Invoiced</dt>
          <dd dir="ltr" className="fin-statement-debit">
            {amount(statement.invoicedHalalas)}
          </dd>
        </div>
        <div>
          <dt>إجمالي المسدد / Paid</dt>
          <dd dir="ltr" className="fin-statement-credit">
            {amount(statement.paidHalalas)}
          </dd>
        </div>
        {statement.creditedHalalas > 0 && (
          <div>
            <dt>إشعارات دائنة / Credit Notes</dt>
            <dd dir="ltr" className="fin-statement-credit">
              {amount(statement.creditedHalalas)}
            </dd>
          </div>
        )}
        <div className="fin-statement-closing">
          <dt>الرصيد القائم / Balance Due</dt>
          <dd dir="ltr">{amount(statement.closingHalalas)}</dd>
        </div>
      </dl>
      <h2 className="fin-document-title">الحركات المالية / Financial Transactions</h2>
      <div className="fin-paper-table-wrap">
        <table className="fin-paper-table fin-statement-table">
          <thead>
            <tr>
              <th scope="col">التاريخ / Date</th>
              <th scope="col">النوع / Type</th>
              <th scope="col">المرجع / Reference</th>
              <th scope="col" className="fin-paper-description">
                البيان / Description
              </th>
              <th scope="col">مدين / Debit</th>
              <th scope="col">دائن / Credit</th>
              <th scope="col">الرصيد / Balance</th>
            </tr>
          </thead>
          <tbody>
            {statement.from && (
              <tr>
                <td dir="ltr">{statement.from}</td>
                <td>—</td>
                <td>—</td>
                <td className="fin-paper-description">رصيد افتتاحي مرحّل</td>
                <td>—</td>
                <td>—</td>
                <td dir="ltr">
                  <b>{amount(statement.openingHalalas)}</b>
                </td>
              </tr>
            )}
            {statement.rows.map((row, index) => (
              <tr key={`${index}-${row.number}`}>
                <td dir="ltr">{row.date}</td>
                <td>
                  <span className={`fin-statement-kind ${row.kind}`}>{kindText[row.kind]}</span>
                </td>
                <td dir="ltr">{row.number}</td>
                <td className="fin-paper-description">{row.description}</td>
                <td dir="ltr" className="fin-statement-debit">
                  {row.debitHalalas ? amount(row.debitHalalas) : '—'}
                </td>
                <td dir="ltr" className="fin-statement-credit">
                  {row.creditHalalas ? amount(row.creditHalalas) : '—'}
                </td>
                <td dir="ltr">
                  <b>{amount(row.balanceHalalas)}</b>
                </td>
              </tr>
            ))}
            {!statement.rows.length && (
              <tr>
                <td colSpan={7} className="fin-statement-empty">
                  لا توجد حركات في هذه الفترة.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {statement.openInvoices.length > 0 && (
        <>
          <h2 className="fin-document-title">الفواتير غير المسددة / Outstanding Invoices</h2>
          <div className="fin-paper-table-wrap">
            <table className="fin-paper-table fin-statement-table">
              <thead>
                <tr>
                  <th scope="col">رقم الفاتورة / Invoice No</th>
                  <th scope="col">تاريخ الإصدار / Issue Date</th>
                  <th scope="col">تاريخ الاستحقاق / Due Date</th>
                  <th scope="col">أيام التأخير / Days Overdue</th>
                  <th scope="col">قيمة الفاتورة / Total</th>
                  <th scope="col">المسدد / Paid</th>
                  <th scope="col">المتبقي / Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {statement.openInvoices.map((item) => (
                  <tr key={item.number}>
                    <td dir="ltr">{item.number}</td>
                    <td dir="ltr">{item.date}</td>
                    <td dir="ltr">{item.dueDate}</td>
                    <td dir="ltr">{item.daysOverdue || '—'}</td>
                    <td dir="ltr">{amount(item.totalHalalas)}</td>
                    <td dir="ltr" className="fin-statement-credit">
                      {item.settledHalalas ? amount(item.settledHalalas) : '—'}
                    </td>
                    <td dir="ltr" className="fin-statement-debit">
                      <b>{amount(item.outstandingHalalas)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <footer className="fin-paper-footer">
        <span>
          المبالغ بالريال السعودي · تاريخ الطباعة: <bdi>{today()}</bdi>
          {statement.overdueHalalas > 0 && (
            <>
              {' '}
              · المتأخر عن موعد استحقاقه: <bdi>{amount(statement.overdueHalalas)}</bdi>
            </>
          )}
        </span>
        <span>
          أُنشئ هذا المستند إلكترونيًا |{' '}
          <span lang="en">This document was generated electronically</span>
        </span>
      </footer>
    </article>
  );
}
