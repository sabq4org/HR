import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import type { VatComputation, VatPeriodSummary, VatReturn } from '../../../shared/ledger';
import { Alert, Field, Status } from '../index';
import {
  AccountSelect,
  amountText,
  downloadCsv,
  fmt,
  LedgerForm,
  read,
  today,
  useLoad,
  useMutate,
  type ViewProps,
} from './shared';

interface VatView {
  periods: VatPeriodSummary[];
  selected: VatPeriodSummary;
  computation: VatComputation;
  return: VatReturn | null;
}
const statusLabel: Record<VatPeriodSummary['status'], string> = {
  open: 'مفتوحة',
  closed: 'مقفلة · لم تُقدَّم',
  filed: 'قُدّمت · لم تُسدَّد',
  paid: 'مسددة',
};
const statusKind = {
  open: 'neutral',
  closed: 'waiting',
  filed: 'waiting',
  paid: 'good',
} as const;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function Vat({ overview, reload, notify }: ViewProps) {
  const mutate = useMutate();
  const [start, setStart] = useState('');
  const load = useCallback(() => read<VatView>(`/vat${start ? `?start=${start}` : ''}`), [start]);
  const { data, error, run } = useLoad(load);
  const [form, setForm] = useState<'close' | 'file' | 'pay' | null>(null);
  const [correction, setCorrection] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [cash, setCash] = useState(overview.settings.defaultCashAccount);
  useEffect(() => {
    void run();
  }, [run]);
  const done = async (message: string) => {
    setForm(null);
    await Promise.all([run(), reload()]);
    notify(message);
  };
  const open = (next: 'close' | 'file' | 'pay') => {
    setCorrection('');
    setNote('');
    setDate(today());
    setReference('');
    setForm(next);
    window.scrollTo({ top: 0 });
  };
  if (!data) return error ? <Alert>{error}</Alert> : null;
  const { selected, computation: c } = data,
    filed = data.return;
  const limit = overview.settings.vatCorrectionLimitHalalas;

  if (form === 'close')
    return (
      <LedgerForm
        title={`إقفال إقرار ${selected.label}`}
        close={() => setForm(null)}
        submitLabel="إقفال الفترة وتثبيت الإقرار"
        note={
          <>
            الإقفال يثبّت أرقام الخانات، وينقل رصيد ضريبة المخرجات والمدخلات إلى حساب التسوية مع
            الهيئة، ويقفل شهور الفترة فلا يُرحَّل فيها قيد بعد ذلك. هذا إجراء داخل دفاترك فقط؛ تقديم
            الإقرار نفسه تقوم به أنت في بوابة هيئة الزكاة والضريبة والجمارك.
          </>
        }
        submit={async () => {
          await mutate('/vat/close', {
            periodStart: selected.periodStart,
            correction: amountText(correction),
            correctionNote: note,
          });
          await done('أُقفلت الفترة الضريبية.');
        }}
      >
        <div className="fin-grid">
          <Field
            label="تصحيح فترات سابقة (خانة 14)"
            hint={`اتركه فارغًا إن لم يوجد. موجب لضريبة ناقصة سابقًا وسالب (-) لزيادة. الحد ${fmt(limit)} ر.س؛ ما زاد عنه لضريبة ناقصة يُعدَّل به الإقرار الأصلي في بوابة الهيئة.`}
          >
            <input
              inputMode="decimal"
              dir="ltr"
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="سبب التصحيح">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              required={Boolean(correction.trim()) && Number(amountText(correction)) !== 0}
            />
          </Field>
        </div>
        <div className="fin-quote-totals">
          <span>
            ضريبة الفترة (خانة 13) <b>{fmt(c.currentPeriodHalalas)}</b>
          </span>
          <span>
            رصيد دائن مرحّل (خانة 15) <b>{fmt(c.creditBroughtForwardHalalas)}</b>
          </span>
          <strong>
            الصافي قبل التصحيح <b>{fmt(c.netDueHalalas)}</b>
          </strong>
        </div>
      </LedgerForm>
    );
  if (form === 'file' && filed)
    return (
      <LedgerForm
        title={`تسجيل تقديم إقرار ${selected.label}`}
        close={() => setForm(null)}
        submitLabel="تسجيل التقديم"
        note="سجّل هنا ما تم فعلًا في بوابة الهيئة. النظام لا يرسل شيئًا إلى الهيئة."
        submit={async () => {
          await mutate(`/vat/${filed.id}/file`, {
            version: filed.version,
            filedAt: date,
            reference,
          });
          await done('سُجّل تقديم الإقرار.');
        }}
      >
        <div className="fin-grid">
          <Field label="تاريخ التقديم">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="الرقم المرجعي للإقرار في بوابة الهيئة">
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={120}
              dir="ltr"
              required
            />
          </Field>
        </div>
      </LedgerForm>
    );
  if (form === 'pay' && filed)
    return (
      <LedgerForm
        title={`سداد ضريبة ${selected.label}`}
        close={() => setForm(null)}
        submitLabel="تسجيل السداد"
        note={`يُسجَّل قيد: مدين تسوية الضريبة مع الهيئة ${fmt(filed.netDueHalalas)}، دائن البنك. السداد نفسه يتم عبر فاتورة سداد من بوابة الهيئة.`}
        submit={async () => {
          await mutate(`/vat/${filed.id}/pay`, {
            version: filed.version,
            date,
            cashAccountCode: cash,
          });
          await done('سُجّل سداد الضريبة.');
        }}
      >
        <div className="fin-grid">
          <Field label="تاريخ السداد">
            <input
              type="date"
              value={date}
              min={filed.periodEnd}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="سُدّد من">
            <AccountSelect
              accounts={overview.accounts}
              value={cash}
              onChange={setCash}
              filter={(account) => account.isCash}
            />
          </Field>
        </div>
      </LedgerForm>
    );

  const now = today(),
    ended = selected.periodEnd < now,
    left = daysBetween(now, c.dueDate);
  const sales = c.boxes.filter((box) => box.box <= 6),
    purchases = c.boxes.filter((box) => box.box >= 7 && box.box <= 12),
    totals = c.boxes.filter((box) => box.box >= 13);
  const exportCsv = () =>
    downloadCsv(`vat-return-${selected.periodStart}`, [
      ['الخانة', 'البيان', 'المبلغ', 'التعديل', 'الضريبة'],
      ...c.boxes.map((box) => [
        box.box,
        box.label,
        (box.amountHalalas / 100).toFixed(2),
        (box.adjustmentHalalas / 100).toFixed(2),
        (box.vatHalalas / 100).toFixed(2),
      ]),
    ]);
  const rows = (boxes: typeof c.boxes) =>
    boxes.map((box) => (
      <tr key={box.box} className={box.box === 6 || box.box === 12 ? 'total' : ''}>
        <td className="num">{box.box}</td>
        <td>{box.label}</td>
        <td className="num">{box.box === 2 ? '—' : fmt(box.amountHalalas)}</td>
        <td className="num">{box.box === 2 ? '—' : fmt(box.adjustmentHalalas)}</td>
        <td className="num">
          {box.box === 3 || box.box === 4 || box.box === 5 || box.box === 10 || box.box === 11
            ? '—'
            : fmt(box.vatHalalas)}
        </td>
      </tr>
    ));
  return (
    <section className="fin-section">
      <div className="fin-section-head">
        <div>
          <h2>إقرار ضريبة القيمة المضافة</h2>
          <p>
            الخانات تُحسب من القيود المرحّلة مباشرة، بترتيب نموذج الهيئة نفسه، لتنقلها إلى بوابة
            الهيئة كما هي.
          </p>
        </div>
        <button className="button secondary" onClick={exportCsv}>
          تصدير CSV
        </button>
      </div>
      <div className="led-filters">
        <Field label="الفترة الضريبية">
          <select value={selected.periodStart} onChange={(e) => setStart(e.target.value)}>
            {data.periods.map((period) => (
              <option key={period.periodStart} value={period.periodStart}>
                {period.label} · {statusLabel[period.status]}
              </option>
            ))}
          </select>
        </Field>
        <div className="led-period-facts">
          <span>
            من <b className="num">{c.periodStart}</b> إلى <b className="num">{c.periodEnd}</b>
          </span>
          <span>
            آخر موعد للتقديم والسداد <b className="num">{c.dueDate}</b>
          </span>
          <Status text={statusLabel[selected.status]} kind={statusKind[selected.status]} />
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {c.warnings.map((warning) => (
        <Alert key={warning}>{warning}</Alert>
      ))}
      {selected.status !== 'paid' && ended && (
        <div className={`led-health ${left < 0 ? 'bad' : left <= 10 ? 'warn' : 'good'}`}>
          {left < 0 ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
          {left < 0
            ? `تجاوز الإقرار موعده بـ ${-left} يومًا. غرامة التأخر في التقديم من 5٪ إلى 25٪ من الضريبة، وغرامة التأخر في السداد 5٪ عن كل شهر.`
            : `باقٍ ${left} يومًا على آخر موعد. الموعد لا يُمدَّد إن وافق إجازة نهاية الأسبوع أو عطلة رسمية.`}
        </div>
      )}
      <div className="led-vat-grid">
        <div className="fin-table-wrap">
          <table className="fin-table led-vat-table">
            <thead>
              <tr>
                <th>الخانة</th>
                <th>البيان</th>
                <th>المبلغ (ر.س)</th>
                <th>مبلغ التعديل</th>
                <th>مبلغ الضريبة</th>
              </tr>
            </thead>
            <tbody>
              <tr className="group">
                <td colSpan={5}>ضريبة المبيعات</td>
              </tr>
              {rows(sales)}
              <tr className="group">
                <td colSpan={5}>ضريبة المشتريات</td>
              </tr>
              {rows(purchases)}
              <tr className="group">
                <td colSpan={5}>صافي الضريبة</td>
              </tr>
              {totals.map((box) => (
                <tr key={box.box} className={box.box === 16 ? 'total' : ''}>
                  <td className="num">{box.box}</td>
                  <td colSpan={3}>{box.label}</td>
                  <td className="num">{fmt(box.vatHalalas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="led-card led-vat-side">
          <h3>{c.netDueHalalas >= 0 ? 'المستحق للهيئة' : 'رصيد دائن لصالح المنشأة'}</h3>
          <strong className="led-big">{fmt(Math.abs(c.netDueHalalas))}</strong>
          <dl>
            <div>
              <dt>ضريبة المخرجات</dt>
              <dd>{fmt(c.outputVatHalalas)}</dd>
            </div>
            <div>
              <dt>ضريبة المدخلات المخصومة</dt>
              <dd>{fmt(c.inputVatHalalas)}</dd>
            </div>
            {filed?.filedAt && (
              <div>
                <dt>قُدّم بتاريخ</dt>
                <dd>{filed.filedAt}</dd>
              </div>
            )}
            {filed?.filingReference && (
              <div>
                <dt>مرجع الهيئة</dt>
                <dd>{filed.filingReference}</dd>
              </div>
            )}
          </dl>
          <div
            className={`led-recon ${c.unexplainedOutputHalalas || c.unexplainedInputHalalas ? 'bad' : 'good'}`}
          >
            {c.unexplainedOutputHalalas || c.unexplainedInputHalalas
              ? `فرق مطابقة مع حسابات الضريبة: مخرجات ${fmt(c.unexplainedOutputHalalas)} · مدخلات ${fmt(c.unexplainedInputHalalas)}`
              : 'الخانات مطابقة لأرصدة حسابات الضريبة في الأستاذ.'}
          </div>
          {selected.status === 'open' && (
            <button className="button primary" disabled={!ended} onClick={() => open('close')}>
              {ended ? 'مراجعة وإقفال الفترة' : 'تُقفل بعد نهاية الفترة'}
            </button>
          )}
          {selected.status === 'closed' && (
            <button className="button primary" onClick={() => open('file')}>
              تسجيل التقديم للهيئة
            </button>
          )}
          {selected.status === 'filed' &&
            (c.netDueHalalas > 0 ? (
              <button className="button primary" onClick={() => open('pay')}>
                تسجيل السداد
              </button>
            ) : (
              <p className="led-muted">
                لا مبلغ مستحقًا. الرصيد الدائن يُرحَّل للفترة التالية (خانة 15).
              </p>
            ))}
          {selected.status === 'paid' && <Status text="قُدّم وسُدّد" kind="good" />}
        </aside>
      </div>
      <details className="led-guide">
        <summary>كيف تُملأ الخانات؟</summary>
        <ul>
          <li>
            الضريبة تُستحق بتاريخ الفاتورة أو التوريد أو استلام المبلغ، أيها أسبق؛ لا عند التحصيل.
          </li>
          <li>الإشعارات الدائنة والمرتجعات تظهر في عمود التعديل للفترة التي صدرت فيها.</li>
          <li>
            خدمات الموردين الأجانب (استضافة، إعلانات، برمجيات) تدخل الخانة 9 فقط بآلية الاحتساب
            العكسي: ضريبتها تُستحق وتُخصم معًا فأثرها صفر، ولا تُكرَّر في الخانة 1.
          </li>
          <li>
            الضريبة غير القابلة للخصم (الضيافة والترفيه وما في حكمها) تُحمَّل على المصروف ولا تدخل
            الخانة 7.
          </li>
          <li>الخانة 2 (مبيعات المواطنين) لا تنطبق على نشاط الصحيفة وتبقى صفرًا.</li>
          <li>الرواتب والرسوم الحكومية والزكاة خارج نطاق الضريبة ولا تظهر في الإقرار.</li>
        </ul>
      </details>
    </section>
  );
}
