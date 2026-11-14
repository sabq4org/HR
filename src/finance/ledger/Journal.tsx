import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { JournalEntry, JournalKind, JournalTax } from '../../../shared/ledger';
import { Alert, Empty, Field, Status } from '../index';
import {
  AccountSelect,
  amountText,
  downloadCsv,
  fmt,
  LedgerForm,
  read,
  today,
  toHalalas,
  useLoad,
  useMutate,
  yearStart,
  type ViewProps,
} from './shared';

export const kindLabel: Record<JournalKind, string> = {
  manual: 'قيد يدوي',
  opening: 'قيد افتتاحي',
  invoice: 'فاتورة مبيعات',
  credit_note: 'إشعار دائن',
  receipt: 'سند تحصيل',
  revenue: 'إيراد مباشر',
  expense: 'مصروف',
  payment: 'سند صرف',
  vat_close: 'إقفال إقرار ضريبي',
  vat_payment: 'سداد ضريبة',
  reversal: 'قيد عكسي',
};
/** Only tags that land in a box of the VAT return are offered on a manual line. */
const taxTags: [string, string][] = [
  ['sales:S:base', 'مبيعات 15٪ · الأساس (خانة 1)'],
  ['sales:S:output', 'مبيعات 15٪ · ضريبة المخرجات (خانة 1)'],
  ['sales:ZD:base', 'مبيعات بنسبة صفر محلية (خانة 3)'],
  ['sales:ZE:base', 'صادرات (خانة 4)'],
  ['sales:E:base', 'مبيعات معفاة (خانة 5)'],
  ['purchases:S:base', 'مشتريات 15٪ · الأساس (خانة 7)'],
  ['purchases:S:input', 'مشتريات 15٪ · ضريبة المدخلات (خانة 7)'],
  ['purchases:IMP:base', 'استيراد عبر الجمارك · الأساس (خانة 8)'],
  ['purchases:IMP:input', 'استيراد عبر الجمارك · الضريبة (خانة 8)'],
  ['purchases:RC:base', 'احتساب عكسي · الأساس (خانة 9)'],
  ['purchases:RC:output', 'احتساب عكسي · ضريبة مستحقة (خانة 9)'],
  ['purchases:RC:input', 'احتساب عكسي · ضريبة مخصومة (خانة 9)'],
  ['purchases:ZD:base', 'مشتريات بنسبة صفر (خانة 10)'],
  ['purchases:E:base', 'مشتريات معفاة (خانة 11)'],
];
const parseTag = (value: string): JournalTax | null => {
  if (!value) return null;
  const [side, code, role] = value.split(':');
  return { side, code, role } as JournalTax;
};
interface DraftLine {
  key: number;
  accountCode: string;
  debit: string;
  credit: string;
  memo: string;
  tag: string;
}
const blank = (key: number): DraftLine => ({
  key,
  accountCode: '',
  debit: '',
  credit: '',
  memo: '',
  tag: '',
});

function EntryForm({
  overview,
  close,
  done,
}: Pick<ViewProps, 'overview'> & { close: () => void; done: (message: string) => Promise<void> }) {
  const mutate = useMutate();
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'manual' | 'opening'>('manual');
  const [lines, setLines] = useState<DraftLine[]>([blank(1), blank(2)]);
  const [showTax, setShowTax] = useState(false);
  const set = (key: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const debit = lines.reduce((sum, line) => sum + toHalalas(line.debit), 0),
    credit = lines.reduce((sum, line) => sum + toHalalas(line.credit), 0),
    difference = debit - credit,
    balanced = debit > 0 && difference === 0;
  const vatAccount = (code: string) => {
    const key = overview.accounts.find((item) => item.code === code)?.systemKey;
    return key === 'vat_input' || key === 'vat_output';
  };
  const needsTax = showTax || lines.some((line) => vatAccount(line.accountCode));
  return (
    <LedgerForm
      title={kind === 'opening' ? 'قيد الأرصدة الافتتاحية' : 'قيد يومي جديد'}
      close={close}
      submitLabel="ترحيل القيد"
      note={
        kind === 'opening'
          ? 'أدخل رصيد كل حساب كما في آخر ميزان مراجعة معتمد: الأصول مدينة، والخصوم وحقوق الملكية دائنة. الفرق إن وُجد يُقفل في حساب «أرصدة افتتاحية» 3901 إلى أن يراجعه محاسبك.'
          : 'للتسويات التي ليس لها شاشة: إهلاك، رواتب مستحقة، إيراد مقدم، تحويل بين البنوك. القيد لا يُعدّل بعد ترحيله؛ تصحيحه بقيد عكسي.'
      }
      submit={async () => {
        await mutate('/entries', {
          date,
          description,
          kind,
          lines: lines
            .filter((line) => line.accountCode || line.debit || line.credit)
            .map((line) => ({
              accountCode: line.accountCode,
              debit: amountText(line.debit) || '0',
              credit: amountText(line.credit) || '0',
              memo: line.memo,
              tax: parseTag(line.tag),
            })),
        });
        await done('رُحّل القيد.');
      }}
    >
      <div className="fin-grid">
        <Field label="التاريخ">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="نوع القيد">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'manual' | 'opening')}>
            <option value="manual">قيد يومي</option>
            <option value="opening">أرصدة افتتاحية</option>
          </select>
        </Field>
        <Field label="البيان">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            required
          />
        </Field>
      </div>
      <div className="led-lines" role="group" aria-label="أطراف القيد">
        <div className={`led-line head${needsTax ? ' with-tax' : ''}`} aria-hidden="true">
          <span>الحساب</span>
          <span>مدين</span>
          <span>دائن</span>
          <span>بيان السطر</span>
          {needsTax && <span>الأثر في الإقرار</span>}
          <span />
        </div>
        {lines.map((line, index) => (
          <div className={`led-line${needsTax ? ' with-tax' : ''}`} key={line.key}>
            <AccountSelect
              accounts={overview.accounts}
              value={line.accountCode}
              onChange={(accountCode) => set(line.key, { accountCode })}
              filter={(account) => account.systemKey !== 'vat_settlement'}
              placeholder={`حساب الطرف ${index + 1}`}
              required={index < 2}
            />
            <input
              inputMode="decimal"
              aria-label={`مدين السطر ${index + 1}`}
              placeholder="0.00"
              value={line.debit}
              onChange={(e) =>
                set(line.key, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })
              }
            />
            <input
              inputMode="decimal"
              aria-label={`دائن السطر ${index + 1}`}
              placeholder="0.00"
              value={line.credit}
              onChange={(e) =>
                set(line.key, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })
              }
            />
            <input
              aria-label={`بيان السطر ${index + 1}`}
              value={line.memo}
              maxLength={300}
              onChange={(e) => set(line.key, { memo: e.target.value })}
            />
            {needsTax && (
              <select
                aria-label={`الأثر الضريبي للسطر ${index + 1}`}
                value={line.tag}
                onChange={(e) => set(line.key, { tag: e.target.value })}
                required={vatAccount(line.accountCode)}
              >
                <option value="">لا يدخل الإقرار</option>
                {taxTags.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={`حذف السطر ${index + 1}`}
              disabled={lines.length <= 2}
              onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
      <div className="led-line-tools">
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            setLines((current) => [...current, blank(Math.max(...current.map((l) => l.key)) + 1)])
          }
        >
          <Plus size={16} />
          إضافة سطر
        </button>
        {!needsTax && (
          <button type="button" className="text-button" onClick={() => setShowTax(true)}>
            للقيد أثر في الإقرار الضريبي؟
          </button>
        )}
        <div className={`led-balance ${balanced ? 'good' : 'bad'}`} aria-live="polite">
          <span>
            مدين <b>{fmt(debit)}</b>
          </span>
          <span>
            دائن <b>{fmt(credit)}</b>
          </span>
          <strong>
            {balanced
              ? 'القيد متوازن'
              : debit === 0 && credit === 0
                ? 'أدخل المبالغ'
                : `الفرق ${fmt(Math.abs(difference))} ${difference > 0 ? 'ينقص الدائن' : 'ينقص المدين'}`}
          </strong>
        </div>
      </div>
    </LedgerForm>
  );
}

function ReverseEntryForm({
  entry,
  close,
  done,
}: {
  entry: JournalEntry;
  close: () => void;
  done: (message: string) => Promise<void>;
}) {
  const mutate = useMutate();
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  return (
    <LedgerForm
      title={`عكس القيد ${entry.number}`}
      close={close}
      submitLabel="تسجيل القيد العكسي"
      note="يُسجَّل قيد جديد يعكس أطراف القيد الأصلي، ويبقى الاثنان ظاهرين في دفتر اليومية."
      submit={async () => {
        await mutate(`/entries/${entry.id}/reverse`, { date, reason });
        await done('سُجّل القيد العكسي.');
      }}
    >
      <div className="fin-grid">
        <Field label="تاريخ القيد العكسي" hint="في فترة مفتوحة، ولا يسبق تاريخ القيد.">
          <input
            type="date"
            value={date}
            min={entry.date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="السبب">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            required
          />
        </Field>
      </div>
    </LedgerForm>
  );
}

export function Journal({ overview, reload, action, go, notify }: ViewProps) {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [account, setAccount] = useState('');
  const load = useCallback(
    async () =>
      (
        await read<{ entries: JournalEntry[] }>(
          `/entries?from=${from}&to=${to}${account ? `&account=${account}` : ''}`,
        )
      ).entries,
    [from, to, account],
  );
  const { data, error, run } = useLoad(load);
  const [form, setForm] = useState<'new' | JournalEntry | null>(action === 'new' ? 'new' : null);
  useEffect(() => {
    void run();
  }, [run]);
  const close = () => {
    setForm(null);
    go('journal');
  };
  const done = async (message: string) => {
    close();
    await Promise.all([run(), reload()]);
    notify(message);
  };
  if (form === 'new') return <EntryForm overview={overview} close={close} done={done} />;
  if (form) return <ReverseEntryForm entry={form} close={close} done={done} />;
  const exportCsv = () =>
    downloadCsv(`journal-${from}-${to}`, [
      [
        'رقم القيد',
        'التاريخ',
        'النوع',
        'البيان',
        'رمز الحساب',
        'الحساب',
        'مدين',
        'دائن',
        'بيان السطر',
      ],
      ...(data ?? []).flatMap((entry) =>
        entry.lines.map((line) => [
          entry.number,
          entry.date,
          kindLabel[entry.kind],
          entry.description,
          line.accountCode,
          line.accountName,
          (line.debitHalalas / 100).toFixed(2),
          (line.creditHalalas / 100).toFixed(2),
          line.memo,
        ]),
      ),
    ]);
  return (
    <section className="fin-section">
      <div className="fin-section-head">
        <div>
          <h2>دفتر اليومية</h2>
          <p>
            كل حركة مالية قيد مزدوج متوازن. القيود الآلية تأتي من الفواتير والمصروفات، واليدوية
            تُدخلها هنا.
          </p>
        </div>
        <button className="button primary" onClick={() => setForm('new')}>
          <Plus size={17} />
          قيد جديد
        </button>
      </div>
      <div className="led-filters">
        <Field label="من">
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="إلى">
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="الحساب">
          <AccountSelect
            accounts={overview.accounts}
            value={account}
            onChange={setAccount}
            filter={() => true}
            placeholder="كل الحسابات"
            required={false}
          />
        </Field>
        <button className="button secondary" onClick={exportCsv} disabled={!data?.length}>
          تصدير CSV
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {data?.length ? (
        <div className="led-entries">
          {data.map((entry) => (
            <article
              key={entry.id}
              className={`led-entry${entry.reversedBy ? ' reversed' : ''}`}
              aria-label={`القيد ${entry.number}`}
            >
              <header>
                <b className="num">{entry.number}</b>
                <span className="num">{entry.date}</span>
                <Status text={kindLabel[entry.kind]} />
                <p>{entry.description}</p>
                {entry.reversedBy ? (
                  <Status text="معكوس" kind="bad" />
                ) : entry.kind === 'manual' || entry.kind === 'opening' ? (
                  <button className="text-button" onClick={() => setForm(entry)}>
                    عكس القيد
                  </button>
                ) : null}
              </header>
              <table>
                <thead>
                  <tr>
                    <th>الحساب</th>
                    <th>البيان</th>
                    <th>مدين</th>
                    <th>دائن</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((line) => (
                    <tr key={line.lineNo} className={line.creditHalalas ? 'credit' : ''}>
                      <td>
                        <span className="num">{line.accountCode}</span> {line.accountName}
                      </td>
                      <td>{line.memo}</td>
                      <td className="num">{line.debitHalalas ? fmt(line.debitHalalas) : ''}</td>
                      <td className="num">{line.creditHalalas ? fmt(line.creditHalalas) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>الإجمالي</td>
                    <td className="num">{fmt(entry.totalHalalas)}</td>
                    <td className="num">{fmt(entry.totalHalalas)}</td>
                  </tr>
                </tfoot>
              </table>
            </article>
          ))}
          {data.length >= 500 && (
            <p className="led-muted">تُعرض أحدث 500 قيد. ضيّق المدة لرؤية ما قبلها.</p>
          )}
        </div>
      ) : (
        data && <Empty title="لا قيود في هذه المدة" detail="غيّر المدة أو سجّل قيدًا جديدًا." />
      )}
    </section>
  );
}
