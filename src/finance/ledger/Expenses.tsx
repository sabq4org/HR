import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  purchaseTaxCodes,
  purchaseTaxHint,
  taxCodeLabel,
  type LedgerVendor,
  type LedgerVoucher,
  type TaxCode,
} from '../../../shared/ledger';
import { Alert, Empty, Field, Status } from '../index';
import {
  AccountSelect,
  amountText,
  fmt,
  LedgerForm,
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
  | { kind: 'expense' }
  | { kind: 'vendor'; vendor?: LedgerVendor }
  | { kind: 'payment'; voucher: LedgerVoucher }
  | { kind: 'reverse'; voucher: LedgerVoucher };

export function Expenses({ overview, reload, action, go, notify }: ViewProps) {
  const mutate = useMutate();
  const load = useCallback(
    async () =>
      (await read<{ vouchers: LedgerVoucher[] }>('/vouchers?kind=expense,payment')).vouchers,
    [],
  );
  const { data, error, run } = useLoad(load);
  const [tab, setTab] = useState<'expenses' | 'vendors'>('expenses');
  const [form, setForm] = useState<Form | null>(action === 'new' ? { kind: 'expense' } : null);
  useEffect(() => {
    void run();
  }, [run]);
  const { accounts, settings, vendors } = overview;
  const [date, setDate] = useState(today());
  const [text, setText] = useState('');
  const [account, setAccount] = useState('');
  const [taxCode, setTaxCode] = useState<TaxCode>('S');
  const [amount, setAmount] = useState('');
  const [vatText, setVatText] = useState('');
  const [paidFrom, setPaidFrom] = useState(settings.defaultCashAccount);
  const [vendorId, setVendorId] = useState('');
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [vendorForm, setVendorForm] = useState({
    name: '',
    vatNumber: '',
    country: '',
    resident: true,
    notes: '',
  });
  const close = () => {
    setForm(null);
    go('expenses');
  };
  const done = async (message: string) => {
    close();
    await Promise.all([run(), reload()]);
    notify(message);
  };
  const open = (next: Form) => {
    setDate(today());
    setText('');
    setAccount('');
    setTaxCode('S');
    setAmount(next.kind === 'payment' ? (next.voucher.outstandingHalalas / 100).toFixed(2) : '');
    setVatText('');
    setPaidFrom(settings.defaultCashAccount);
    setVendorId('');
    setReference('');
    setDueDate('');
    if (next.kind === 'vendor')
      setVendorForm(
        next.vendor
          ? {
              name: next.vendor.name,
              vatNumber: next.vendor.vatNumber,
              country: next.vendor.country,
              resident: next.vendor.resident,
              notes: next.vendor.notes ?? '',
            }
          : { name: '', vatNumber: '', country: '', resident: true, notes: '' },
      );
    setForm(next);
    window.scrollTo({ top: 0 });
  };
  // Picking the account or a foreign vendor suggests the usual VAT treatment; the user can change it.
  const chooseAccount = (code: string) => {
    setAccount(code);
    const suggested = accounts.find((item) => item.code === code)?.defaultTaxCode;
    const vendor = vendors.find((item) => item.id === vendorId);
    if (vendor && !vendor.resident) setTaxCode('RC');
    else if (suggested) setTaxCode(suggested === 'RC' && vendor?.resident ? 'S' : suggested);
  };
  const chooseVendor = (id: string) => {
    setVendorId(id);
    const vendor = vendors.find((item) => item.id === id);
    if (vendor && !vendor.resident) setTaxCode('RC');
    else if (vendor && taxCode === 'RC') setTaxCode('S');
  };

  if (form?.kind === 'reverse')
    return (
      <ReverseForm voucher={form.voucher} close={close} done={() => done('سُجّل القيد العكسي.')} />
    );
  if (form?.kind === 'vendor') {
    const editing = form.vendor;
    return (
      <LedgerForm
        title={editing ? 'تعديل مورد' : 'إضافة مورد'}
        close={close}
        submitLabel="حفظ المورد"
        submit={async () => {
          if (editing)
            await mutate(
              `/vendors/${editing.id}`,
              { ...vendorForm, version: editing.version, active: true },
              'PATCH',
            );
          else await mutate('/vendors', vendorForm);
          await done('حُفظ المورد.');
        }}
      >
        <div className="fin-grid">
          <Field label="اسم المورد">
            <input
              value={vendorForm.name}
              onChange={(e) => setVendorForm({ ...vendorForm, name: e.target.value })}
              maxLength={200}
              required
            />
          </Field>
          <Field
            label="مقر المورد"
            hint="المورد غير المقيم تُحتسب ضريبة خدماته بآلية الاحتساب العكسي."
          >
            <select
              value={vendorForm.resident ? 'yes' : 'no'}
              onChange={(e) => setVendorForm({ ...vendorForm, resident: e.target.value === 'yes' })}
            >
              <option value="yes">مقيم في المملكة</option>
              <option value="no">غير مقيم (خارج المملكة)</option>
            </select>
          </Field>
          <Field
            label={
              vendorForm.resident ? 'الرقم الضريبي (15 رقمًا)' : 'الرقم الضريبي الأجنبي (اختياري)'
            }
          >
            <input
              value={vendorForm.vatNumber}
              onChange={(e) => setVendorForm({ ...vendorForm, vatNumber: e.target.value })}
              inputMode="numeric"
              maxLength={30}
            />
          </Field>
          <Field label="الدولة">
            <input
              value={vendorForm.country}
              onChange={(e) => setVendorForm({ ...vendorForm, country: e.target.value })}
              maxLength={60}
              placeholder={vendorForm.resident ? 'السعودية' : ''}
            />
          </Field>
        </div>
      </LedgerForm>
    );
  }
  if (form?.kind === 'payment') {
    const voucher = form.voucher;
    return (
      <LedgerForm
        title={`سداد المستحق عن ${voucher.number}`}
        close={close}
        submitLabel="تسجيل السداد"
        note={`المستحق${voucher.partyName ? ` لـ${voucher.partyName}` : ''}: ${fmt(voucher.outstandingHalalas)} ر.س.`}
        submit={async () => {
          await mutate(`/expenses/${voucher.id}/payments`, {
            date,
            amount: amountText(amount),
            cashAccountCode: paidFrom,
            reference,
          });
          await done('سُجّل السداد.');
        }}
      >
        <div className="fin-grid">
          <Field label="تاريخ السداد">
            <input
              type="date"
              value={date}
              min={voucher.date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="المبلغ">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="دُفع من">
            <AccountSelect
              accounts={accounts}
              value={paidFrom}
              onChange={setPaidFrom}
              filter={(a) => a.isCash}
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
  if (form?.kind === 'expense') {
    const net = toHalalas(amount),
      computed = Math.floor((net * 1500 + 5000) / 10000);
    const hasVat = taxCode === 'S' || taxCode === 'ND' || taxCode === 'RC' || taxCode === 'IMP';
    const vat = !hasVat
      ? 0
      : vatText && taxCode !== 'RC'
        ? toHalalas(vatText)
        : taxCode === 'IMP'
          ? 0
          : computed;
    const owed = taxCode === 'RC' ? net : net + vat;
    return (
      <LedgerForm
        title="تسجيل مصروف"
        close={close}
        submitLabel="حفظ وترحيل"
        submit={async () => {
          await mutate('/expenses', {
            date,
            description: text,
            accountCode: account,
            taxCode,
            net: amountText(amount),
            ...(vatText && taxCode !== 'RC' ? { vat: amountText(vatText) } : {}),
            cashAccountCode: paidFrom,
            vendorId,
            reference,
            dueDate: paidFrom ? '' : dueDate,
          });
          await done('سُجّل المصروف ورُحّل قيده.');
        }}
      >
        <div className="fin-grid">
          <Field label="تاريخ فاتورة المورد">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="المورد (اختياري)">
            <select value={vendorId} onChange={(e) => chooseVendor(e.target.value)}>
              <option value="">بلا مورد محدد</option>
              {vendors
                .filter((item) => item.active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.resident ? '' : ' · غير مقيم'}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="البيان">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={300}
              required
            />
          </Field>
          <Field label="الحساب" hint="حساب مصروف، أو حساب أصل عند شراء معدات وأجهزة.">
            <AccountSelect
              accounts={accounts}
              value={account}
              onChange={chooseAccount}
              filter={(a) =>
                (a.type === 'expense' || a.type === 'asset') &&
                !a.isCash &&
                (!a.systemKey || a.systemKey === 'vat_adjustments') &&
                a.normalSide === 'debit'
              }
            />
          </Field>
          <Field label="المعالجة الضريبية" hint={purchaseTaxHint[taxCode]}>
            <select value={taxCode} onChange={(e) => setTaxCode(e.target.value as TaxCode)}>
              {purchaseTaxCodes.map((code) => (
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
          {(taxCode === 'S' || taxCode === 'ND' || taxCode === 'IMP') && (
            <Field
              label={
                taxCode === 'IMP' ? 'الضريبة المسددة للجمارك' : 'مبلغ الضريبة في الفاتورة (اختياري)'
              }
              hint={
                taxCode === 'IMP' ? 'من البيان الجمركي.' : `يُحسب 15٪ تلقائيًا: ${fmt(computed)}.`
              }
            >
              <input
                inputMode="decimal"
                value={vatText}
                onChange={(e) => setVatText(e.target.value)}
                required={taxCode === 'IMP'}
              />
            </Field>
          )}
          <Field
            label={taxCode === 'S' ? 'رقم الفاتورة الضريبية للمورد' : 'رقم المستند (اختياري)'}
            hint={taxCode === 'S' ? 'خصم الضريبة يشترط الاحتفاظ بفاتورة ضريبية صحيحة.' : undefined}
          >
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={120}
              required={taxCode === 'S'}
            />
          </Field>
          <Field label="طريقة السداد">
            <select value={paidFrom} onChange={(e) => setPaidFrom(e.target.value)}>
              <option value="">آجل · يُقيَّد على الموردين</option>
              {accounts
                .filter((item) => item.isCash && item.active)
                .map((item) => (
                  <option key={item.code} value={item.code}>
                    مدفوع من {item.name}
                  </option>
                ))}
            </select>
          </Field>
          {!paidFrom && (
            <Field label="تاريخ الاستحقاق (اختياري)">
              <input
                type="date"
                value={dueDate}
                min={date}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </Field>
          )}
        </div>
        <div className="fin-quote-totals">
          <span>
            الصافي <b>{fmt(net)}</b>
          </span>
          <span>
            {taxCode === 'ND'
              ? 'ضريبة غير قابلة للخصم (تُحمَّل على المصروف)'
              : taxCode === 'RC'
                ? 'ضريبة احتساب عكسي (مستحقة ومخصومة معًا)'
                : 'ضريبة مدخلات قابلة للخصم'}{' '}
            <b>{fmt(vat)}</b>
          </span>
          <strong>
            {paidFrom ? 'المدفوع' : 'المستحق للمورد'} <b>{fmt(owed)}</b>
          </strong>
        </div>
      </LedgerForm>
    );
  }

  return (
    <>
      {error && <Alert>{error}</Alert>}
      <nav className="led-subtabs" aria-label="أقسام المصروفات">
        <button className={tab === 'expenses' ? 'active' : ''} onClick={() => setTab('expenses')}>
          المصروفات والمدفوعات
        </button>
        <button className={tab === 'vendors' ? 'active' : ''} onClick={() => setTab('vendors')}>
          الموردون
        </button>
      </nav>
      {tab === 'expenses' ? (
        <section className="fin-section">
          <div className="fin-section-head">
            <div>
              <h2>المصروفات</h2>
              <p>كل مصروف يُرحَّل بقيده وضريبته، نقدًا أو آجلًا على المورد.</p>
            </div>
            <button className="button primary" onClick={() => open({ kind: 'expense' })}>
              <Plus size={17} />
              تسجيل مصروف
            </button>
          </div>
          {data?.length ? (
            <div className="fin-table-wrap">
              <table className="fin-table">
                <thead>
                  <tr>
                    <th>المستند</th>
                    <th>التاريخ</th>
                    <th>البيان</th>
                    <th>المعالجة</th>
                    <th>الصافي</th>
                    <th>الضريبة</th>
                    <th>الإجمالي</th>
                    <th>الحالة</th>
                    <th>إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((voucher) => (
                    <tr
                      key={voucher.id}
                      className={voucher.status === 'reversed' ? 'led-reversed' : ''}
                    >
                      <td>
                        <b>{voucher.number}</b>
                        <small>القيد {voucher.entryNumber}</small>
                      </td>
                      <td className="num">{voucher.date}</td>
                      <td>
                        {voucher.description}
                        {voucher.partyName && <small>{voucher.partyName}</small>}
                      </td>
                      <td>
                        {voucher.kind === 'payment'
                          ? 'سند سداد'
                          : voucher.taxCode
                            ? taxCodeLabel[voucher.taxCode]
                            : '—'}
                      </td>
                      <td className="num">
                        <Money value={voucher.netHalalas} />
                      </td>
                      <td className="num">
                        <Money value={voucher.vatHalalas} />
                      </td>
                      <td className="num">
                        <Money value={voucher.totalHalalas} />
                      </td>
                      <td>
                        {voucher.status === 'reversed' ? (
                          <Status text="معكوس" kind="bad" />
                        ) : voucher.kind === 'expense' && !voucher.cashAccountCode ? (
                          voucher.outstandingHalalas > 0 ? (
                            <Status
                              text={`مستحق ${fmt(voucher.outstandingHalalas)}`}
                              kind="waiting"
                            />
                          ) : (
                            <Status text="مسدد" kind="good" />
                          )
                        ) : (
                          <Status text="مرحّل" kind="good" />
                        )}
                      </td>
                      <td className="fin-actions">
                        {voucher.status === 'posted' && (
                          <>
                            {voucher.kind === 'expense' && voucher.outstandingHalalas > 0 && (
                              <button
                                className="text-button"
                                onClick={() => open({ kind: 'payment', voucher })}
                              >
                                سداد
                              </button>
                            )}
                            <button
                              className="text-button"
                              onClick={() => open({ kind: 'reverse', voucher })}
                            >
                              عكس
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="لا توجد مصروفات بعد" detail="سجّل أول فاتورة مورد أو مصروف نقدي." />
          )}
        </section>
      ) : (
        <section className="fin-section">
          <div className="fin-section-head">
            <div>
              <h2>الموردون</h2>
              <p>تحديد المورد غير المقيم يقترح الاحتساب العكسي تلقائيًا عند تسجيل مصروفه.</p>
            </div>
            <button className="button primary" onClick={() => open({ kind: 'vendor' })}>
              <Plus size={17} />
              إضافة مورد
            </button>
          </div>
          {vendors.length ? (
            <div className="fin-table-wrap">
              <table className="fin-table">
                <thead>
                  <tr>
                    <th>المورد</th>
                    <th>الرقم الضريبي</th>
                    <th>المقر</th>
                    <th>إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((vendor) => (
                    <tr key={vendor.id}>
                      <td>
                        <b>{vendor.name}</b>
                      </td>
                      <td className="num">{vendor.vatNumber || '—'}</td>
                      <td>
                        {vendor.resident
                          ? 'مقيم'
                          : `غير مقيم${vendor.country ? ` · ${vendor.country}` : ''}`}
                      </td>
                      <td className="fin-actions">
                        <button
                          className="text-button"
                          onClick={() => open({ kind: 'vendor', vendor })}
                        >
                          تعديل
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="لا يوجد موردون بعد"
              detail="أضف الموردين المتكررين لتسريع تسجيل مصروفاتهم."
            />
          )}
        </section>
      )}
    </>
  );
}
