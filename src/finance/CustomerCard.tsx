import { FileSpreadsheet, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FinanceCustomer, FinanceInvoice, FinanceQuote } from '../../shared/finance';
import { Modal } from '../lib';
import { Status } from './paper';

const money = (halalas: number) =>
  new Intl.NumberFormat('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    halalas / 100,
  );
const day = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date(iso));

function Field({ label, children, ltr }: { label: string; children?: ReactNode; ltr?: boolean }) {
  const empty = children === undefined || children === null || children === '';
  return (
    <div>
      <dt>{label}</dt>
      <dd className={empty ? 'empty' : ''}>
        {empty ? 'غير مسجَّل' : ltr ? <bdi dir="ltr">{children}</bdi> : children}
      </dd>
    </div>
  );
}

/** Read-only card with everything saved for one customer; editing stays on its own page. */
export function CustomerCard({
  customer,
  quotes,
  invoices,
  close,
  edit,
  statement,
}: {
  customer: FinanceCustomer;
  quotes: FinanceQuote[];
  invoices: FinanceInvoice[];
  close: () => void;
  edit: () => void;
  statement: () => void;
}) {
  const own = quotes.filter((q) => q.customerId === customer.id);
  const ids = new Set(own.map((q) => q.id));
  const issued = invoices.filter((i) => ids.has(i.quoteId));
  const a = customer.address;
  const business = customer.type !== 'individual';
  return (
    <Modal title="بيانات العميل" close={close} className="fin-customer-dialog">
      <div className="fin-customer-card">
        <header>
          <span className="fin-customer-mark" aria-hidden="true">
            {customer.name.trim().charAt(0)}
          </span>
          <div>
            <h3>{customer.name}</h3>
            {customer.nameEnglish && <p dir="ltr">{customer.nameEnglish}</p>}
            <div className="fin-customer-tags">
              <Status text={business ? 'منشأة' : 'فرد'} />
              <Status
                text={
                  customer.syncStatus === 'synced'
                    ? 'متزامن مع وافق'
                    : customer.syncStatus === 'error'
                      ? 'تعذرت المزامنة مع وافق'
                      : 'غير متزامن مع وافق'
                }
                kind={
                  customer.syncStatus === 'synced'
                    ? 'good'
                    : customer.syncStatus === 'error'
                      ? 'bad'
                      : 'neutral'
                }
              />
            </div>
          </div>
        </header>
        <ul className="fin-customer-stats">
          <li>
            <b>{own.length}</b>
            <span>عروض الأسعار</span>
          </li>
          <li>
            <b>{issued.length}</b>
            <span>الفواتير</span>
          </li>
          <li>
            <b>{money(issued.reduce((sum, i) => sum + i.totalHalalas, 0))}</b>
            <span>إجمالي الفواتير بالريال</span>
          </li>
        </ul>
        <section>
          <h4>البيانات النظامية</h4>
          <dl>
            <Field label="الرقم الضريبي" ltr>
              {customer.vatNumber}
            </Field>
            <Field label="السجل التجاري" ltr>
              {customer.commercialRegistration}
            </Field>
          </dl>
        </section>
        <section>
          <h4>التواصل</h4>
          <dl>
            <Field label="البريد الإلكتروني" ltr>
              {customer.email}
            </Field>
            <Field label="الجوال" ltr>
              {customer.mobile}
            </Field>
            <Field label="الهاتف" ltr>
              {customer.phone}
            </Field>
          </dl>
        </section>
        <section>
          <h4>العنوان الوطني</h4>
          <dl>
            <Field label="الشارع">{a.line}</Field>
            <Field label="رقم المبنى" ltr>
              {a.buildingNumber}
            </Field>
            <Field label="الحي">{a.district}</Field>
            <Field label="المدينة">{a.city}</Field>
            <Field label="الرمز البريدي" ltr>
              {a.postalCode}
            </Field>
            <Field label="الرقم الإضافي" ltr>
              {a.additionalNumber}
            </Field>
          </dl>
        </section>
        {customer.notes && (
          <section>
            <h4>ملاحظات</h4>
            <p className="fin-customer-notes">{customer.notes}</p>
          </section>
        )}
        {customer.syncStatus === 'error' && customer.syncMessage && (
          <p className="fin-alert" role="alert">
            {customer.syncMessage}
          </p>
        )}
        <footer>
          <small>
            أُضيف في <bdi>{day(customer.createdAt)}</bdi>
          </small>
          <div>
            <button className="button secondary" onClick={statement}>
              <FileSpreadsheet size={16} />
              كشف حساب
            </button>
            <button className="button primary" onClick={edit}>
              <Pencil size={16} />
              تعديل البيانات
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
