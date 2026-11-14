import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  salesTaxCodes,
  taxCodeLabel,
  type InvoiceLedgerState,
  type LedgerVoucher,
  type TaxCode,
} from '../../../shared/ledger';
import { Alert, Empty, Field, Status } from '../index';
import {
  AccountSelect,
  amountText,
  fmt,
  LedgerForm,
  ltr,
  Money,
  read,
  ReverseForm,
  today,
  toHalalas,
  useLoad,
  useMutate,
  type ViewProps,
} from './shared';

type Form =
  | { kind: 'revenue' }
  | { kind: 'post'; invoice: InvoiceLedgerState }
  | { kind: 'receipt'; invoice: InvoiceLedgerState }
  | { kind: 'credit'; invoice: InvoiceLedgerState }
  | { kind: 'reverse'; voucher: LedgerVoucher };
const kindLabel: Record<string, string> = {
  revenue: 'إيراد مباشر',
  receipt: 'سند تحصيل',
  credit_note: 'إشعار دائن',
};

export function Revenues({ overview, reload, action, go, notify }: ViewProps) {
  const mutate = useMutate();
  const load = useCallback(
    async () => ({
      invoices: (await read<{ invoices: InvoiceLedgerState[] }>('/invoices')).invoices,
      vouchers: (
        await read<{ vouchers: LedgerVoucher[] }>('/vouchers?kind=revenue,receipt,credit_note')
      ).vouchers,
    }),
    [],
  );
  const { data, error, run } = useLoad(load);
  const [form, setForm] = useState<Form | null>(action === 'new' ? { kind: 'revenue' } : null);
  useEffect(() => {
    void run();
  }, [run]);
  const done = async (message: string) => {
    setForm(null);
    go('revenues');
    await Promise.all([run(), reload()]);
    notify(message);
  };
  const close = () => {
    setForm(null);
    go('revenues');
  };
  const { accounts, settings } = overview;
  const cash = (account: (typeof accounts)[number]) => account.isCash;
  const revenue = (account: (typeof accounts)[number]) =>
    account.type === 'revenue' && !account.systemKey;

  // ---- form state (one form is open at a time)
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [reference, setReference] = useState('');
  const [customer, setCustomer] = useState('');
  const [account, setAccount] = useState(settings.defaultRevenueAccount);
  const [cashAccount, setCashAccount] = useState(settings.defaultCashAccount);
  const [taxCode, setTaxCode] = useState<TaxCode>('S');
  const [zeroCode, setZeroCode] = useState<TaxCode | ''>('');
  const [portion, setPortion] = useState<'taxable' | 'zero'>('taxable');
  const open = (next: Form) => {
    setDate(today());
    setAmount(
      next.kind === 'receipt' && next.invoice.voucher
        ? (next.invoice.voucher.outstandingHalalas / 100).toFixed(2)
        : '',
    );
    setText('');
    setReference('');
    setCustomer('');
    setAccount(settings.defaultRevenueAccount);
    setCashAccount(settings.defaultCashAccount);
    setTaxCode('S');
    setZeroCode('');
    setPortion(
      (next.kind === 'credit' || next.kind === 'post') && !next.invoice.hasTaxableLines
        ? 'zero'
        : 'taxable',
    );
    setForm(next);
    window.scrollTo({ top: 0 });
  };

  if (form?.kind === 'reverse')
    return (
      <ReverseForm voucher={form.voucher} close={close} done={() => done('سُجّل القيد العكسي.')} />
    );
  if (form?.kind === 'revenue') {
    const net = toHalalas(amount),
      vat = taxCode === 'S' ? Math.floor((net * 1500 + 5000) / 10000) : 0;
    return (
      <LedgerForm
        title="تسجيل إيراد مباشر"
        close={close}
        submitLabel="حفظ وترحيل"
        note="للإيراد الذي لم تصدر فاتورته من هذا النظام، مثل إيراد منصة إعلانية أو مبلغ محصل نقدًا. الإيراد الخاضع للضريبة لا يُسجَّل بلا رقم فاتورته الضريبية."
        submit={async () => {
          await mutate('/revenues', {
            date,
            description: text,
            accountCode: account,
            taxCode,
            net: amountText(amount),
            cashAccountCode: cashAccount,
            customerName: customer,
            reference,
          });
          await done('سُجّل الإيراد ورُحّل قيده.');
        }}
      >
        <div className="fin-grid">
          <Field label="التاريخ">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="البيان">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={300}
              required
            />
          </Field>
          <Field label="حساب الإيراد">
            <AccountSelect
              accounts={accounts}
              value={account}
              onChange={setAccount}
              filter={revenue}
            />
          </Field>
          <Field label="المعالجة الضريبية">
            <select value={taxCode} onChange={(e) => setTaxCode(e.target.value as TaxCode)}>
              {salesTaxCodes.map((code) => (
                <option key={code} value={code}>
                  {taxCodeLabel[code]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="المبلغ قبل الضريبة">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="أودع في">
            <AccountSelect
              accounts={accounts}
              value={cashAccount}
              onChange={setCashAccount}
              filter={cash}
            />
          </Field>
          <Field label="العميل أو الجهة (اختياري)">
            <input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={200} />
          </Field>
          <Field
            label={taxCode === 'S' ? 'رقم الفاتورة الضريبية' : 'مرجع (اختياري)'}
            hint={taxCode === 'S' ? 'رقم الفاتورة الصادرة من نظام الفوترة المعتمد.' : undefined}
          >
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={120}
              required={taxCode === 'S'}
            />
          </Field>
        </div>
        <div className="fin-quote-totals">
          <span>
            الصافي <b>{fmt(net)}</b>
          </span>
          <span>
            ضريبة القيمة المضافة <b>{fmt(vat)}</b>
          </span>
          <strong>
            الإجمالي المودع <b>{fmt(net + vat)}</b>
          </strong>
        </div>
      </LedgerForm>
    );
  }
  if (form?.kind === 'post') {
    const invoice = form.invoice;
    const needsZero =
      invoice.hasZeroLines &&
      invoice.documentType !== 'zero_rated' &&
      invoice.documentType !== 'out_of_scope';
    return (
      <LedgerForm
        title={`ترحيل الفاتورة ${invoice.number} إلى الدفاتر`}
        close={close}
        submitLabel="ترحيل القيد"
        note={
          <>
            يُسجَّل القيد بتاريخ الفاتورة {ltr(invoice.issueDate)}: مدين العملاء{' '}
            {fmt(invoice.totalHalalas)}، دائن الإيراد {fmt(invoice.subtotalHalalas)} وضريبة المخرجات{' '}
            {fmt(invoice.taxHalalas)}. الضريبة تُستحق بتاريخ الفاتورة لا عند التحصيل. الترحيل قيد
            محاسبي داخلي ولا يعني اعتماد الهيئة للفاتورة.
          </>
        }
        submit={async () => {
          await mutate(`/invoices/${invoice.invoiceId}/post`, {
            revenueAccountCode: account,
            ...(needsZero ? { zeroLinesTaxCode: zeroCode } : {}),
          });
          await done('رُحّلت الفاتورة إلى الدفاتر.');
        }}
      >
        <div className="fin-grid">
          <Field label="حساب الإيراد">
            <AccountSelect
              accounts={accounts}
              value={account}
              onChange={setAccount}
              filter={revenue}
            />
          </Field>
          {needsZero && (
            <Field
              label="معالجة البنود التي بلا ضريبة"
              hint="في الفاتورة بنود بنسبة صفر؛ تحديد نوعها يضعها في خانتها الصحيحة من الإقرار."
            >
              <select
                value={zeroCode}
                onChange={(e) => setZeroCode(e.target.value as TaxCode)}
                required
              >
                <option value="">اختر</option>
                {(['ZD', 'ZE', 'E', 'O'] as const).map((code) => (
                  <option key={code} value={code}>
                    {taxCodeLabel[code]}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </LedgerForm>
    );
  }
  if (form?.kind === 'receipt' && form.invoice.voucher) {
    const invoice = form.invoice,
      voucher = form.invoice.voucher;
    return (
      <LedgerForm
        title={`تحصيل الفاتورة ${invoice.number}`}
        close={close}
        submitLabel="تسجيل التحصيل"
        note={`المتبقي على ${invoice.customerName}: ${fmt(voucher.outstandingHalalas)} ر.س. يمكن تسجيل دفعة جزئية.`}
        submit={async () => {
          await mutate(`/invoices/${invoice.invoiceId}/receipts`, {
            date,
            amount: amountText(amount),
            cashAccountCode: cashAccount,
            reference,
          });
          await done('سُجّل التحصيل.');
        }}
      >
        <div className="fin-grid">
          <Field label="تاريخ التحصيل">
            <input
              type="date"
              value={date}
              min={voucher.date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="المبلغ المحصل">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="أودع في">
            <AccountSelect
              accounts={accounts}
              value={cashAccount}
              onChange={setCashAccount}
              filter={cash}
            />
          </Field>
          <Field label="مرجع الحوالة (اختياري)">
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={120}
            />
          </Field>
        </div>
      </LedgerForm>
    );
  }
  if (form?.kind === 'credit' && form.invoice.voucher) {
    const invoice = form.invoice;
    const mixed = invoice.hasTaxableLines && invoice.hasZeroLines;
    return (
      <LedgerForm
        title={`إشعار دائن على الفاتورة ${invoice.number}`}
        close={close}
        submitLabel="تسجيل الإشعار"
        note="الفاتورة الصادرة لا تُلغى ولا تُعدّل؛ تخفيضها أو إلغاؤها يكون بإشعار دائن. هذا قيد الإشعار في الدفاتر، والإشعار الضريبي نفسه يصدر من نظام الفوترة المعتمد. يظهر أثره في عمود التعديلات بإقرار الفترة التي صدر فيها."
        submit={async () => {
          await mutate(`/invoices/${invoice.invoiceId}/credit-notes`, {
            date,
            net: amountText(amount),
            portion,
            reason: text,
          });
          await done('سُجّل الإشعار الدائن.');
        }}
      >
        <div className="fin-grid">
          <Field label="تاريخ الإشعار">
            <input
              type="date"
              value={date}
              min={invoice.issueDate}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="المبلغ قبل الضريبة" hint="تُحسب ضريبته تلقائيًا بنسبة الفاتورة.">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          {mixed && (
            <Field label="يخص">
              <select
                value={portion}
                onChange={(e) => setPortion(e.target.value as 'taxable' | 'zero')}
              >
                <option value="taxable">البنود الخاضعة 15٪</option>
                <option value="zero">البنود التي بلا ضريبة</option>
              </select>
            </Field>
          )}
          <Field label="السبب">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={300}
              required
            />
          </Field>
        </div>
      </LedgerForm>
    );
  }

  return (
    <>
      {error && <Alert>{error}</Alert>}
      <section className="fin-section">
        <div className="fin-section-head">
          <div>
            <h2>الفواتير في الدفاتر</h2>
            <p>كل فاتورة تُرحَّل مرة واحدة بتاريخ إصدارها، ثم تُحصَّل كاملة أو على دفعات.</p>
          </div>
          <button className="button secondary" onClick={() => go('billing')}>
            عروض الأسعار والفواتير
          </button>
        </div>
        {data?.invoices.length ? (
          <div className="fin-table-wrap">
            <table className="fin-table">
              <thead>
                <tr>
                  <th>الفاتورة</th>
                  <th>العميل</th>
                  <th>التاريخ</th>
                  <th>الإجمالي</th>
                  <th>المتبقي</th>
                  <th>حالة الدفاتر</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((invoice) => {
                  const voucher = invoice.voucher;
                  return (
                    <tr key={invoice.invoiceId}>
                      <td>
                        <b>{invoice.number}</b>
                        <small>{invoice.title}</small>
                      </td>
                      <td>{invoice.customerName}</td>
                      <td className="num">{invoice.issueDate}</td>
                      <td className="num">
                        <Money value={invoice.totalHalalas} />
                      </td>
                      <td className="num">
                        {voucher ? <Money value={voucher.outstandingHalalas} /> : '—'}
                      </td>
                      <td>
                        {!voucher ? (
                          <Status text="غير مرحّلة" kind="waiting" />
                        ) : voucher.outstandingHalalas <= 0 ? (
                          <Status text="مسددة" kind="good" />
                        ) : voucher.settledHalalas > 0 ? (
                          <Status text="مسددة جزئيًا" kind="waiting" />
                        ) : (
                          <Status text={`مرحّلة · ${voucher.entryNumber}`} />
                        )}
                      </td>
                      <td className="fin-actions">
                        {!voucher ? (
                          <button
                            className="text-button"
                            disabled={invoice.status === 'rejected'}
                            onClick={() => open({ kind: 'post', invoice })}
                          >
                            ترحيل
                          </button>
                        ) : (
                          <>
                            <button
                              className="text-button"
                              disabled={voucher.outstandingHalalas <= 0}
                              onClick={() => open({ kind: 'receipt', invoice })}
                            >
                              تحصيل
                            </button>
                            <button
                              className="text-button"
                              onClick={() => open({ kind: 'credit', invoice })}
                            >
                              إشعار دائن
                            </button>
                            <button
                              className="text-button"
                              onClick={() => open({ kind: 'reverse', voucher })}
                            >
                              عكس الترحيل
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="لا توجد فواتير بعد"
            detail="حوّل عرض سعر إلى فاتورة من قسم الفواتير، ثم رحّلها هنا."
          />
        )}
      </section>
      <section className="fin-section">
        <div className="fin-section-head">
          <div>
            <h2>الإيرادات المباشرة وسندات التحصيل</h2>
            <p>إيرادات بلا فاتورة من هذا النظام، وما حُصّل من العملاء، والإشعارات الدائنة.</p>
          </div>
          <button className="button primary" onClick={() => open({ kind: 'revenue' })}>
            <Plus size={17} />
            تسجيل إيراد
          </button>
        </div>
        {data?.vouchers.length ? (
          <div className="fin-table-wrap">
            <table className="fin-table">
              <thead>
                <tr>
                  <th>المستند</th>
                  <th>النوع</th>
                  <th>التاريخ</th>
                  <th>البيان</th>
                  <th>الصافي</th>
                  <th>الضريبة</th>
                  <th>الإجمالي</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {data.vouchers.map((voucher) => (
                  <tr
                    key={voucher.id}
                    className={voucher.status === 'reversed' ? 'led-reversed' : ''}
                  >
                    <td>
                      <b>{voucher.number}</b>
                      <small>القيد {voucher.entryNumber}</small>
                    </td>
                    <td>
                      {kindLabel[voucher.kind]}
                      {voucher.taxCode && <small>{taxCodeLabel[voucher.taxCode]}</small>}
                    </td>
                    <td className="num">{voucher.date}</td>
                    <td>{voucher.description}</td>
                    <td className="num">
                      <Money value={voucher.netHalalas} />
                    </td>
                    <td className="num">
                      <Money value={voucher.vatHalalas} />
                    </td>
                    <td className="num">
                      <Money value={voucher.totalHalalas} />
                    </td>
                    <td className="fin-actions">
                      {voucher.status === 'reversed' ? (
                        <Status text="معكوس" kind="bad" />
                      ) : (
                        <button
                          className="text-button"
                          onClick={() => open({ kind: 'reverse', voucher })}
                        >
                          عكس
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="لا توجد حركات إيراد بعد" detail="سجّل إيرادًا مباشرًا أو حصّل فاتورة مرحّلة." />
        )}
      </section>
    </>
  );
}
