import { useCallback, useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { BudgetLine, BudgetReport } from '../../../shared/ledger';
import { Alert, Empty, Field } from '../index';
import {
  downloadCsv,
  fmt,
  LedgerForm,
  read,
  today,
  toHalalas,
  useLoad,
  useMutate,
  type ViewProps,
} from './shared';

const monthNames = [
  'ينا',
  'فبر',
  'مار',
  'أبر',
  'ماي',
  'يون',
  'يول',
  'أغس',
  'سبت',
  'أكت',
  'نوف',
  'ديس',
];
const sum = (values: number[], upTo = 12) =>
  values.slice(0, upTo).reduce((total, value) => total + value, 0);
const plain = (halalas: number) => (halalas ? (halalas / 100).toFixed(2) : '');
/** Spreads an annual amount over twelve months; the last month absorbs the rounding remainder. */
const spread = (annual: number) => {
  const base = Math.floor(annual / 12);
  return Array.from({ length: 12 }, (_, index) => plain(index === 11 ? annual - base * 11 : base));
};

function BudgetForm({
  report,
  close,
  done,
}: {
  report: BudgetReport;
  close: () => void;
  done: (report: BudgetReport) => Promise<void>;
}) {
  const mutate = useMutate();
  const [draft, setDraft] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(report.lines.map((line) => [line.accountCode, line.budget.map(plain)])),
  );
  const [monthly, setMonthly] = useState<string | null>(null);
  const annual = (code: string) =>
    draft[code].reduce((total, value) => total + toHalalas(value), 0);
  const group = (type: 'revenue' | 'expense', title: string) => {
    const lines = report.lines.filter((line) => line.type === type);
    return (
      <fieldset className="led-budget-edit">
        <legend>
          {title}
          <b>{fmt(lines.reduce((total, line) => total + annual(line.accountCode), 0))}</b>
        </legend>
        {lines.map((line) => (
          <div key={line.accountCode} className="led-budget-row">
            <label htmlFor={`budget-${line.accountCode}`}>
              <span className="num">{line.accountCode}</span> {line.accountName}
            </label>
            <input
              id={`budget-${line.accountCode}`}
              inputMode="decimal"
              placeholder="المبلغ السنوي"
              value={plain(annual(line.accountCode))}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  [line.accountCode]: spread(toHalalas(e.target.value)),
                }))
              }
            />
            <button
              type="button"
              className="text-button"
              aria-expanded={monthly === line.accountCode}
              onClick={() => setMonthly(monthly === line.accountCode ? null : line.accountCode)}
            >
              {monthly === line.accountCode ? 'إخفاء الشهور' : 'توزيع شهري'}
            </button>
            {monthly === line.accountCode && (
              <div className="led-budget-months">
                {monthNames.map((name, index) => (
                  <label key={name}>
                    <span>{name}</span>
                    <input
                      inputMode="decimal"
                      value={draft[line.accountCode][index]}
                      onChange={(e) =>
                        setDraft((current) => ({
                          ...current,
                          [line.accountCode]: current[line.accountCode].map((value, at) =>
                            at === index ? e.target.value : value,
                          ),
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </fieldset>
    );
  };
  return (
    <LedgerForm
      title={`موازنة سنة ${report.year}`}
      close={close}
      submitLabel="حفظ الموازنة"
      note="أدخل المبلغ السنوي لكل حساب فيُوزَّع بالتساوي على الشهور، أو افتح التوزيع الشهري للحسابات الموسمية. الموازنة خطة تقديرية تُعدَّل متى شئت ولا تنشئ قيودًا."
      submit={async () => {
        const saved = await mutate<BudgetReport>(
          `/budgets/${report.year}`,
          {
            version: report.version,
            lines: Object.entries(draft)
              .filter(([, months]) => months.some((value) => toHalalas(value) > 0))
              .map(([accountCode, months]) => ({
                accountCode,
                months: months.map((value) => (toHalalas(value) / 100).toFixed(2)),
              })),
          },
          'PATCH',
        );
        await done(saved);
      }}
    >
      {group('revenue', 'الإيرادات المستهدفة')}
      {group('expense', 'المصروفات المعتمدة')}
    </LedgerForm>
  );
}

export function Budget({ notify }: ViewProps) {
  const thisYear = Number(today().slice(0, 4)),
    thisMonth = Number(today().slice(5, 7));
  const [year, setYear] = useState(thisYear);
  const load = useCallback(() => read<BudgetReport>(`/reports/budget?year=${year}`), [year]);
  const { data, error, run } = useLoad(load);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    void run();
  }, [run]);
  if (editing && data)
    return (
      <BudgetForm
        report={data}
        close={() => setEditing(false)}
        done={async () => {
          setEditing(false);
          await run();
          notify('حُفظت الموازنة.');
        }}
      />
    );
  // Compare like with like: the budget up to the current month against actuals to date.
  const upTo = year < thisYear ? 12 : year > thisYear ? 0 : thisMonth;
  const hasBudget = data?.lines.some((line) => sum(line.budget) > 0);
  const section = (type: 'revenue' | 'expense', title: string) => {
    const lines = (data?.lines ?? []).filter(
      (line) => line.type === type && (sum(line.budget) > 0 || sum(line.actual) !== 0),
    );
    const total = (pick: (line: BudgetLine) => number) =>
      lines.reduce((value, line) => value + pick(line), 0);
    const row = (
      key: string,
      name: React.ReactNode,
      annual: number,
      planned: number,
      actual: number,
      bold = false,
    ) => {
      const variance = type === 'revenue' ? actual - planned : planned - actual;
      const ratio = planned > 0 ? actual / planned : null;
      const over = type === 'expense' && ratio !== null && ratio > 1;
      return (
        <tr key={key} className={bold ? 'led-subtotal' : ''}>
          <td>{name}</td>
          <td className="num">{fmt(annual)}</td>
          <td className="num">{fmt(planned)}</td>
          <td className="num">{fmt(actual)}</td>
          <td className={`num ${variance < 0 ? 'led-bad' : 'led-good'}`}>
            {planned || actual ? `${variance < 0 ? '−' : '+'}${fmt(Math.abs(variance))}` : '—'}
          </td>
          <td>
            {ratio === null ? (
              <span className="led-muted">{actual ? 'بلا موازنة' : '—'}</span>
            ) : (
              <span className={`led-meter${over ? ' over' : ''}`}>
                <i style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
                <b>{Math.round(ratio * 100)}٪</b>
              </span>
            )}
          </td>
        </tr>
      );
    };
    return (
      <>
        <tr className="group">
          <td colSpan={6}>{title}</td>
        </tr>
        {lines.map((line) =>
          row(
            line.accountCode,
            <>
              <span className="num">{line.accountCode}</span> {line.accountName}
            </>,
            sum(line.budget),
            sum(line.budget, upTo),
            sum(line.actual, upTo || 12),
          ),
        )}
        {row(
          `${type}-total`,
          `إجمالي ${title}`,
          total((line) => sum(line.budget)),
          total((line) => sum(line.budget, upTo)),
          total((line) => sum(line.actual, upTo || 12)),
          true,
        )}
      </>
    );
  };
  const net = (pick: (line: BudgetLine) => number) =>
    (data?.lines ?? []).reduce(
      (value, line) => value + (line.type === 'revenue' ? pick(line) : -pick(line)),
      0,
    );
  return (
    <section className="fin-section">
      <div className="fin-section-head">
        <div>
          <h2>الموازنة التقديرية</h2>
          <p>
            خطة الإيرادات والمصروفات للسنة مقابل الفعلي من الدفاتر.
            {upTo > 0 && upTo < 12 && ` المقارنة حتى نهاية ${monthNames[upTo - 1]}.`}
          </p>
        </div>
        <div className="led-head-actions">
          <button
            className="button secondary"
            disabled={!data}
            onClick={() =>
              data &&
              downloadCsv(`budget-${year}`, [
                ['الرمز', 'الحساب', 'الموازنة السنوية', 'موازنة المدة', 'الفعلي', 'الانحراف'],
                ...data.lines.map((line) => [
                  line.accountCode,
                  line.accountName,
                  (sum(line.budget) / 100).toFixed(2),
                  (sum(line.budget, upTo) / 100).toFixed(2),
                  (sum(line.actual, upTo || 12) / 100).toFixed(2),
                  (
                    ((line.type === 'revenue' ? 1 : -1) *
                      (sum(line.actual, upTo || 12) - sum(line.budget, upTo))) /
                    100
                  ).toFixed(2),
                ]),
              ])
            }
          >
            تصدير CSV
          </button>
          <button className="button primary" disabled={!data} onClick={() => setEditing(true)}>
            <Pencil size={16} />
            {hasBudget ? 'تعديل الموازنة' : 'إعداد الموازنة'}
          </button>
        </div>
      </div>
      <div className="led-filters">
        <Field label="السنة المالية">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error && <Alert>{error}</Alert>}
      {data &&
        (!hasBudget && !data.lines.some((line) => sum(line.actual) !== 0) ? (
          <Empty
            title={`لا موازنة لسنة ${year} بعد`}
            detail="أعدّ الموازنة لتقارن ما خططت له بما تحقق فعلًا شهرًا بشهر."
          />
        ) : (
          <div className="fin-table-wrap">
            <table className="fin-table led-vat-table">
              <thead>
                <tr>
                  <th>الحساب</th>
                  <th>الموازنة السنوية</th>
                  <th>موازنة المدة</th>
                  <th>الفعلي</th>
                  <th>الانحراف</th>
                  <th>نسبة التنفيذ</th>
                </tr>
              </thead>
              <tbody>
                {section('revenue', 'الإيرادات')}
                {section('expense', 'المصروفات')}
                <tr className="total">
                  <td>صافي الربح</td>
                  <td className="num">{fmt(net((line) => sum(line.budget)))}</td>
                  <td className="num">{fmt(net((line) => sum(line.budget, upTo)))}</td>
                  <td className="num">{fmt(net((line) => sum(line.actual, upTo || 12)))}</td>
                  <td className="num">
                    {fmt(
                      net((line) => sum(line.actual, upTo || 12)) -
                        net((line) => sum(line.budget, upTo)),
                    )}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
