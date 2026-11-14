import { useState } from 'react';
import {
  BookOpenText,
  CircleAlert,
  CircleCheck,
  FileText,
  Landmark,
  Scale,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { LedgerDashboard, LedgerOverview } from '../../../shared/ledger';
import { RiyalSign } from '../RiyalSign';
import { Alert } from '../index';
import { compact, errorText, fmt, ltr, useMutate, type ViewProps } from './shared';

const monthName = (key: string) =>
  new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { month: 'short', timeZone: 'UTC' }).format(
    new Date(`${key}-01T00:00:00Z`),
  );
const daysUntil = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function Kpi({
  label,
  value,
  hint,
  tone = 'neutral',
  wide = false,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'neutral' | 'good' | 'bad';
  wide?: boolean;
}) {
  return (
    <div className={`led-kpi ${tone}${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      <strong>
        {fmt(value)}
        <RiyalSign />
      </strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Revenue against expenses for the last twelve months: one axis, two series, values on hover. */
function MonthlyChart({ data }: { data: LedgerDashboard['monthly'] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...data.flatMap((item) => [item.revenueHalalas, item.expenseHalalas]));
  const width = 720,
    height = 220,
    left = 8,
    bottom = 26,
    top = 12;
  const band = (width - left) / data.length,
    bar = Math.min(18, band / 2 - 4),
    plot = height - bottom - top;
  const y = (value: number) => top + plot - (Math.max(0, value) / max) * plot;
  const shown = active === null ? null : data[active];
  return (
    <figure className="led-chart">
      <figcaption>
        <b>الإيرادات والمصروفات · آخر 12 شهرًا</b>
        <span className="led-legend">
          <i className="rev" /> الإيرادات
          <i className="exp" /> المصروفات
        </span>
      </figcaption>
      <div className="led-chart-tip" aria-live="polite">
        {shown
          ? `${monthName(shown.month)} ${shown.month.slice(0, 4)} · الإيرادات ${fmt(shown.revenueHalalas)} · المصروفات ${fmt(shown.expenseHalalas)} · الصافي ${fmt(shown.revenueHalalas - shown.expenseHalalas)}`
          : `أعلى قيمة شهرية ${compact(max)} ر.س · مرّر على الأعمدة لقراءة الأرقام`}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="أعمدة الإيرادات والمصروفات الشهرية"
      >
        {[0, 0.5, 1].map((step) => (
          <line
            key={step}
            x1={left}
            x2={width}
            y1={top + plot * step}
            y2={top + plot * step}
            className="led-grid"
          />
        ))}
        {data.map((item, index) => {
          // Time runs right to left, like the rest of the page: the newest month is on the left.
          const slot = data.length - 1 - index;
          const center = left + band * slot + band / 2;
          return (
            <g
              key={item.month}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              tabIndex={0}
              role="img"
              aria-label={`${monthName(item.month)}: الإيرادات ${fmt(item.revenueHalalas)}، المصروفات ${fmt(item.expenseHalalas)}`}
            >
              <rect x={left + band * slot} y={0} width={band} height={height} fill="transparent" />
              {/* RTL reading order: revenue sits on the right of each pair. */}
              <rect
                className="led-bar rev"
                x={center + 1}
                width={bar}
                y={y(item.revenueHalalas)}
                height={top + plot - y(item.revenueHalalas)}
                rx={3}
              />
              <rect
                className="led-bar exp"
                x={center - bar - 1}
                width={bar}
                y={y(item.expenseHalalas)}
                height={top + plot - y(item.expenseHalalas)}
                rx={3}
              />
              <text x={center} y={height - 8} textAnchor="middle" className="led-axis">
                {monthName(item.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="led-visually-hidden">
        <caption>الإيرادات والمصروفات الشهرية بالريال</caption>
        <thead>
          <tr>
            <th>الشهر</th>
            <th>الإيرادات</th>
            <th>المصروفات</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.month}>
              <td>{item.month}</td>
              <td>{fmt(item.revenueHalalas)}</td>
              <td>{fmt(item.expenseHalalas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Setup({ reload, notify }: Pick<ViewProps, 'reload' | 'notify'>) {
  const mutate = useMutate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await mutate<LedgerOverview>('/setup', {});
      await reload();
      notify('تمت تهيئة دليل الحسابات.');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="led-setup">
      <div>
        <h2>ابدأ دفاترك المحاسبية</h2>
        <p>
          يُنشئ النظام دليل حسابات مقترحًا لصحيفة رقمية (أصول، خصوم، حقوق ملكية، إيرادات، مصروفات) مع
          حسابات ضريبة القيمة المضافة. بعدها يتحول كل إيراد ومصروف وفاتورة إلى قيد مزدوج متوازن
          تلقائيًا.
        </p>
        <ul>
          <li>الدليل اقتراح يعدّله محاسبك: تضيف حسابات وتعيد تسميتها وتوقف ما لا تحتاجه.</li>
          <li>لا تُضاف أي أرصدة أو حركات. الأرصدة الافتتاحية تدخلها بقيد افتتاحي.</li>
          <li>القيود لا تُعدّل ولا تُحذف بعد ترحيلها؛ التصحيح بقيد عكسي.</li>
        </ul>
        {error && <Alert>{error}</Alert>}
        <button className="button primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'جارٍ التهيئة…' : 'تهيئة دليل الحسابات المقترح'}
        </button>
      </div>
    </section>
  );
}

export function Home({ overview, reload, go, notify }: ViewProps) {
  const d = overview.dashboard;
  if (!overview.initialized || !d) return <Setup reload={reload} notify={notify} />;
  const yearNet = d.yearRevenueHalalas - d.yearExpenseHalalas;
  const vat = d.currentVatPeriod,
    overdue = d.overdueVatPeriods;
  const alerts: { tone: 'bad' | 'warn'; text: string; view: Parameters<typeof go>[0] }[] = [];
  for (const period of overdue) {
    const left = daysUntil(d.today, period.dueDate);
    alerts.push({
      tone: left < 0 ? 'bad' : 'warn',
      text:
        period.status === 'closed'
          ? `إقرار ${period.label} مقفل ولم يُسجَّل تقديمه للهيئة. آخر موعد ${ltr(period.dueDate)}.`
          : left < 0
            ? `إقرار ${period.label} تجاوز موعده ${ltr(period.dueDate)} ولم يُقفل في النظام.`
            : `إقرار ${period.label} جاهز للمراجعة والإقفال. باقٍ ${left} يومًا على آخر موعد ${ltr(period.dueDate)}.`,
      view: 'vat',
    });
  }
  if (d.unpostedInvoices)
    alerts.push({
      tone: 'warn',
      text: `${d.unpostedInvoices} فاتورة لم تُرحَّل إلى الدفاتر بعد.`,
      view: 'revenues',
    });
  if (d.overdueReceivablesHalalas > 0)
    alerts.push({
      tone: 'warn',
      text: `مستحقات متأخرة على العملاء: ${fmt(d.overdueReceivablesHalalas)} ر.س.`,
      view: 'reports',
    });
  if (!d.booksBalanced)
    alerts.push({
      tone: 'bad',
      text: 'يوجد قيد غير متوازن في الدفاتر. راجع دفتر اليومية.',
      view: 'journal',
    });
  return (
    <div className="led-home">
      <div className={`led-health ${d.booksBalanced ? 'good' : 'bad'}`}>
        {d.booksBalanced ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
        {d.booksBalanced
          ? 'الدفاتر متوازنة: مجموع المدين يساوي مجموع الدائن في كل القيود.'
          : 'الدفاتر غير متوازنة.'}
        <span>
          الفترة الضريبية الحالية: {vat.label} · آخر موعد لتقديمها {ltr(vat.dueDate)}
        </span>
      </div>
      {alerts.length > 0 && (
        <ul className="led-alerts">
          {alerts.map((alert) => (
            <li key={alert.text} className={alert.tone}>
              <CircleAlert size={15} />
              <span>{alert.text}</span>
              <button className="text-button" onClick={() => go(alert.view)}>
                فتح
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="led-kpis">
        <Kpi label="إيرادات هذا الشهر" value={d.monthRevenueHalalas} />
        <Kpi label="مصروفات هذا الشهر" value={d.monthExpenseHalalas} />
        <Kpi
          label="صافي الربح منذ بداية السنة"
          wide
          value={yearNet}
          tone={yearNet < 0 ? 'bad' : 'good'}
          hint={`إيرادات ${compact(d.yearRevenueHalalas)} · مصروفات ${compact(d.yearExpenseHalalas)}`}
        />
        <Kpi
          label="النقد والبنوك"
          value={d.cashHalalas}
          tone={d.cashHalalas < 0 ? 'bad' : 'neutral'}
        />
        <Kpi label="مستحق على العملاء" value={d.receivablesHalalas} />
        <Kpi label="مستحق للموردين" value={d.payablesHalalas} />
        <Kpi
          label="مركز ضريبة القيمة المضافة"
          value={d.vatPositionHalalas}
          hint={d.vatPositionHalalas >= 0 ? 'مستحق للهيئة حتى اليوم' : 'رصيد لصالح المنشأة'}
        />
      </div>
      <div className="led-home-grid">
        <MonthlyChart data={d.monthly} />
        <section className="led-card">
          <h3>أعلى المصروفات هذه السنة</h3>
          {d.topExpenses.length ? (
            <ol className="led-rank">
              {d.topExpenses.map((item) => (
                <li key={item.code}>
                  <span>{item.name}</span>
                  <b>{fmt(item.amountHalalas)}</b>
                  <i
                    style={{
                      width: `${Math.max(4, (item.amountHalalas / d.topExpenses[0].amountHalalas) * 100)}%`,
                    }}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <p className="led-muted">لا مصروفات مسجلة هذه السنة.</p>
          )}
        </section>
      </div>
      <section className="led-quick" aria-label="إجراءات سريعة">
        {(
          [
            ['revenues', 'new', 'تسجيل إيراد', 'إيراد مباشر أو ترحيل فاتورة وتحصيلها', TrendingUp],
            ['expenses', 'new', 'تسجيل مصروف', 'فاتورة مورد بضريبتها ومعالجتها', TrendingDown],
            ['journal', 'new', 'قيد يومي', 'قيد يدوي أو أرصدة افتتاحية', BookOpenText],
            ['vat', undefined, 'الإقرار الضريبي', 'خانات الإقرار ومطابقتها وإقفال الفترة', Scale],
            [
              'billing',
              undefined,
              'عرض سعر أو فاتورة',
              'العملاء وعروض الأسعار والفواتير',
              FileText,
            ],
            ['accounts', undefined, 'دليل الحسابات', 'الأرصدة وكشف الحساب وإقفال الشهور', Landmark],
          ] as const
        ).map(([view, action, title, detail, Icon]) => (
          <button key={title} onClick={() => go(view, action)}>
            <Icon size={20} />
            <b>{title}</b>
            <small>{detail}</small>
          </button>
        ))}
      </section>
    </div>
  );
}
