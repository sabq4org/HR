import { useState, type FormEvent, type ReactNode } from 'react';
import type { FinanceInvoice } from '../../shared/finance';
import type { InvoiceLedgerState, LedgerAccount } from '../../shared/ledger';
import { api } from '../lib';

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
const amountText = (value: string) =>
  value
    .trim()
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[,،\s]/g, '')
    .replace('٫', '.');

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="fin-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function InvoicePaymentForm({
  invoice,
  state,
  accounts,
  close,
  onDone,
}: {
  invoice: FinanceInvoice;
  state: InvoiceLedgerState;
  accounts: LedgerAccount[];
  close: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const voucher = state.voucher;
  const cashAccounts = accounts.filter((item) => item.isCash && item.active);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState(
    voucher ? (voucher.outstandingHalalas / 100).toFixed(2) : '',
  );
  const [cashAccount, setCashAccount] = useState(cashAccounts[0]?.code ?? '');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!voucher) return null;
  const remaining = (voucher.outstandingHalalas / 100).toFixed(2);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/finance/ledger/invoices/${invoice.id}/receipts`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          date,
          amount: amountText(amount),
          cashAccountCode: cashAccount,
          reference: reference.trim() || undefined,
        }),
      });
      await onDone('سُجّلت الدفعة.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'تعذّر تسجيل الدفعة.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fin-form-page" aria-labelledby="fin-receipt-title">
      <header className="fin-form-page-head">
        <button type="button" className="button secondary small" onClick={close}>
          رجوع
        </button>
        <h2 id="fin-receipt-title">تسجيل دفعة · {invoice.number}</h2>
      </header>
      <form className="fin-dialog-form" onSubmit={(event) => void submit(event)}>
        <p>
          المتبقي على {invoice.customer.name}: {remaining} ر.س. يمكن تسجيل دفعة جزئية. يُرحَّل سند
          القبض بتاريخ السداد، ويُرفض التاريخ إذا كانت فترته مقفلة.
        </p>
        {error && (
          <p className="fin-alert" role="alert">
            {error}
          </p>
        )}
        <div className="fin-grid">
          <Field label="تاريخ السداد" hint="تاريخ قديم مسموح إذا كانت الفترة مفتوحة.">
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
          <Field label="الحساب البنكي">
            <select value={cashAccount} onChange={(e) => setCashAccount(e.target.value)} required>
              <option value="">اختر الحساب</option>
              {cashAccounts.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} · {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="المرجع (اختياري)">
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={120}
            />
          </Field>
        </div>
        <div className="fin-form-actions">
          <button className="button primary" type="submit" disabled={busy || !cashAccount}>
            {busy ? 'جارٍ التسجيل…' : 'تسجيل الدفعة'}
          </button>
          <button className="button secondary" type="button" onClick={close}>
            إلغاء
          </button>
        </div>
      </form>
    </section>
  );
}
