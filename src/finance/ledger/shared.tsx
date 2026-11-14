import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { LedgerAccount, LedgerOverview, LedgerVoucher } from '../../../shared/ledger';
import { api } from '../../lib';
import { Alert, Field, FormPage } from '../index';

export type View =
  | 'home'
  | 'revenues'
  | 'expenses'
  | 'journal'
  | 'accounts'
  | 'vat'
  | 'budget'
  | 'reports'
  | 'billing';
export interface ViewProps {
  overview: LedgerOverview;
  reload: () => Promise<void>;
  go: (view: View, action?: string) => void;
  action?: string;
  notify: (message: string) => void;
}
const number = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const fmt = (halalas: number) => number.format(halalas / 100);
export const compact = (halalas: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    halalas / 100,
  );
/** Keeps an ISO date or code left-to-right inside an Arabic sentence. */
export const ltr = (value: string) => `\u2066${value}\u2069`;
export const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
export const yearStart = () => `${today().slice(0, 4)}-01-01`;
/** Accepts Arabic-Indic digits and thousands separators; the server validates the rest. */
export const amountText = (value: string) =>
  value
    .trim()
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[,،\s]/g, '')
    .replace('٫', '.');
export const toHalalas = (value: string) => {
  const parsed = Number(amountText(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'تعذّر إكمال العملية. أعد المحاولة.';

export function Money({ value, signed = false }: { value: number; signed?: boolean }) {
  return <span className={`led-money${signed && value < 0 ? ' negative' : ''}`}>{fmt(value)}</span>;
}
/** One idempotency key per pending path, dropped after success so a retry never posts twice. */
export function useMutate() {
  const keys = useRef<Record<string, string>>({});
  return useCallback(async <T,>(path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST') => {
    const key = keys.current[path] ?? (keys.current[path] = crypto.randomUUID());
    const result = await api<T>(`/finance/ledger${path}`, {
      method,
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    delete keys.current[path];
    return result;
  }, []);
}
export const read = <T,>(path: string) => api<T>(`/finance/ledger${path}`);

export function AccountSelect({
  accounts,
  value,
  onChange,
  filter,
  placeholder = 'اختر الحساب',
  required = true,
}: {
  accounts: LedgerAccount[];
  value: string;
  onChange: (code: string) => void;
  filter: (account: LedgerAccount) => boolean;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
      <option value="">{placeholder}</option>
      {accounts
        .filter((item) => item.postable && item.active && filter(item))
        .map((item) => (
          <option key={item.code} value={item.code}>
            {item.code} · {item.name}
          </option>
        ))}
    </select>
  );
}
/** Full-page form shell: submit, busy state and the server's error message in one place. */
export function LedgerForm({
  title,
  close,
  submit,
  submitLabel,
  children,
  note,
}: {
  title: string;
  close: () => void;
  submit: () => Promise<void>;
  submitLabel: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await submit();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormPage title={title} close={close}>
      <form className="fin-dialog-form" onSubmit={(event) => void onSubmit(event)}>
        {note && <div className="led-note">{note}</div>}
        {children}
        {error && <Alert>{error}</Alert>}
        <div className="fin-form-actions">
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : submitLabel}
          </button>
          <button className="button secondary" type="button" onClick={close}>
            إلغاء
          </button>
        </div>
      </form>
    </FormPage>
  );
}
/** Reversal is the only way to cancel a posted document, so every list shares this form. */
export function ReverseForm({
  voucher,
  close,
  done,
}: {
  voucher: LedgerVoucher;
  close: () => void;
  done: () => Promise<void>;
}) {
  const mutate = useMutate();
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  return (
    <LedgerForm
      title={`عكس المستند ${voucher.number}`}
      close={close}
      submitLabel="تسجيل القيد العكسي"
      note="لا يُحذف المستند ولا يُعدّل. يُسجَّل قيد عكسي بالتاريخ الذي تختاره، ويبقى الأصل والعكس ظاهرين في دفتر اليومية."
      submit={async () => {
        await mutate(`/vouchers/${voucher.id}/reverse`, { version: voucher.version, date, reason });
        await done();
      }}
    >
      <div className="fin-grid">
        <Field label="تاريخ القيد العكسي" hint="في فترة مفتوحة، ولا يسبق تاريخ المستند.">
          <input
            type="date"
            value={date}
            min={voucher.date}
            onChange={(event) => setDate(event.target.value)}
            required
          />
        </Field>
        <Field label="السبب">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={300}
            required
          />
        </Field>
      </div>
    </LedgerForm>
  );
}
export function downloadCsv(name: string, rows: (string | number)[][]) {
  const cell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const blob = new Blob(['﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${name}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const run = useCallback(async () => {
    setError('');
    try {
      setData(await load());
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [load]);
  return { data, error, run };
}
