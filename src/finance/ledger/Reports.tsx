import { useCallback, useEffect, useState } from 'react';
import type {
  AgingRow,
  BalanceSheet,
  IncomeStatement,
  StatementSection,
  TrialBalanceRow,
} from '../../../shared/ledger';
import { Alert, Empty, Field } from '../index';
import { downloadCsv, fmt, Money, read, today, useLoad, yearStart, type ViewProps } from './shared';

type Tab = 'income' | 'balance' | 'trial' | 'receivable' | 'payable';
const tabs: [Tab, string][] = [
  ['income', 'قائمة الدخل'],
  ['balance', 'المركز المالي'],
  ['trial', 'ميزان المراجعة'],
  ['receivable', 'أعمار ذمم العملاء'],
  ['payable', 'أعمار ذمم الموردين'],
];
const money = (halalas: number) => (halalas / 100).toFixed(2);
const buckets: [AgingRow['bucket'], string][] = [
  ['current', 'لم يحن'],
  ['1-30', '1–30 يومًا'],
  ['31-60', '31–60'],
  ['61-90', '61–90'],
  ['90+', 'أكثر من 90'],
];

function Sections({ sections }: { sections: StatementSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <tbody key={section.key}>
          <tr className="group">
            <td colSpan={2}>{section.title}</td>
          </tr>
          {section.lines.map((line) => (
            <tr key={`${line.code}-${line.name}`}>
              <td>
                {line.code && <span className="num">{line.code}</span>} {line.name}
              </td>
              <td className="num">
                <Money value={line.amountHalalas} signed />
              </td>
            </tr>
          ))}
          <tr className="led-subtotal">
            <td>إجمالي {section.title.split(' (')[0]}</td>
            <td className="num">
              <Money value={section.totalHalalas} signed />
            </td>
          </tr>
        </tbody>
      ))}
    </>
  );
}

export function Reports(_: ViewProps) {
  const [tab, setTab] = useState<Tab>('income');
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const ranged = tab === 'income' || tab === 'trial';
  const load = useCallback(async () => {
    if (tab === 'income')
      return {
        tab,
        data: await read<IncomeStatement>(`/reports/income-statement?from=${from}&to=${to}`),
      };
    if (tab === 'balance')
      return { tab, data: await read<BalanceSheet>(`/reports/balance-sheet?asOf=${to}`) };
    if (tab === 'trial')
      return {
        tab,
        data: await read<{ rows: TrialBalanceRow[] }>(
          `/reports/trial-balance?from=${from}&to=${to}`,
        ),
      };
    return {
      tab,
      data: await read<{ rows: AgingRow[] }>(`/reports/aging?side=${tab}&asOf=${to}`),
    };
  }, [tab, from, to]);
  const { data: loaded, error, run } = useLoad(load);
  useEffect(() => {
    void run();
  }, [run]);
  // A tab switch keeps the previous payload until the new one arrives; never render a mismatch.
  const result = loaded?.tab === tab ? loaded : null;
  const exportCsv = () => {
    if (!result) return;
    if (result.tab === 'income' || result.tab === 'balance')
      downloadCsv(`${result.tab}-${to}`, [
        ['القسم', 'الرمز', 'البند', 'المبلغ'],
        ...result.data.sections.flatMap((section) => [
          ...section.lines.map((line) => [
            section.title,
            line.code,
            line.name,
            money(line.amountHalalas),
          ]),
          [section.title, '', 'الإجمالي', money(section.totalHalalas)],
        ]),
      ]);
    else if (result.tab === 'trial')
      downloadCsv(`trial-balance-${from}-${to}`, [
        [
          'الرمز',
          'الحساب',
          'افتتاحي مدين',
          'افتتاحي دائن',
          'حركة مدين',
          'حركة دائن',
          'ختامي مدين',
          'ختامي دائن',
        ],
        ...result.data.rows.map((row) => [
          row.code,
          row.name,
          money(row.openingDebit),
          money(row.openingCredit),
          money(row.periodDebit),
          money(row.periodCredit),
          money(row.closingDebit),
          money(row.closingCredit),
        ]),
      ]);
    else
      downloadCsv(`aging-${result.tab}-${to}`, [
        ['المستند', 'الطرف', 'التاريخ', 'الاستحقاق', 'المتبقي', 'أيام التأخر'],
        ...result.data.rows.map((row) => [
          row.number,
          row.partyName,
          row.date,
          row.dueDate,
          money(row.outstandingHalalas),
          row.daysOverdue,
        ]),
      ]);
  };
  let body: React.ReactNode = null;
  if (result?.tab === 'income') {
    const d = result.data;
    body = (
      <div className="fin-table-wrap led-statement">
        <table className="fin-table led-vat-table">
          <Sections sections={d.sections} />
          <tfoot>
            <tr className="total">
              <td>{d.netProfitHalalas >= 0 ? 'صافي الربح' : 'صافي الخسارة'} قبل الزكاة</td>
              <td className="num">
                <Money value={d.netProfitHalalas} signed />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  } else if (result?.tab === 'balance') {
    const d = result.data;
    body = (
      <>
        <div className={`led-health ${d.balanced ? 'good' : 'bad'}`}>
          {d.balanced
            ? `المعادلة المحاسبية متحققة: الأصول ${fmt(d.assetsHalalas)} = الخصوم ${fmt(d.liabilitiesHalalas)} + حقوق الملكية ${fmt(d.equityHalalas)}`
            : 'المركز المالي غير متوازن. راجع دفتر اليومية.'}
        </div>
        <div className="fin-table-wrap led-statement">
          <table className="fin-table led-vat-table">
            <Sections sections={d.sections} />
          </table>
        </div>
      </>
    );
  } else if (result?.tab === 'trial') {
    const rows = result.data.rows;
    const total = (pick: (row: TrialBalanceRow) => number) =>
      rows.reduce((value, row) => value + pick(row), 0);
    const cell = (value: number) => (value ? fmt(value) : '');
    body = rows.length ? (
      <div className="fin-table-wrap">
        <table className="fin-table led-vat-table led-trial">
          <thead>
            <tr>
              <th rowSpan={2}>الرمز</th>
              <th rowSpan={2}>الحساب</th>
              <th colSpan={2}>رصيد أول المدة</th>
              <th colSpan={2}>حركة المدة</th>
              <th colSpan={2}>رصيد آخر المدة</th>
            </tr>
            <tr>
              <th>مدين</th>
              <th>دائن</th>
              <th>مدين</th>
              <th>دائن</th>
              <th>مدين</th>
              <th>دائن</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code}>
                <td className="num">{row.code}</td>
                <td>{row.name}</td>
                <td className="num">{cell(row.openingDebit)}</td>
                <td className="num">{cell(row.openingCredit)}</td>
                <td className="num">{cell(row.periodDebit)}</td>
                <td className="num">{cell(row.periodCredit)}</td>
                <td className="num">{cell(row.closingDebit)}</td>
                <td className="num">{cell(row.closingCredit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="total">
              <td colSpan={2}>الإجمالي</td>
              <td className="num">{fmt(total((row) => row.openingDebit))}</td>
              <td className="num">{fmt(total((row) => row.openingCredit))}</td>
              <td className="num">{fmt(total((row) => row.periodDebit))}</td>
              <td className="num">{fmt(total((row) => row.periodCredit))}</td>
              <td className="num">{fmt(total((row) => row.closingDebit))}</td>
              <td className="num">{fmt(total((row) => row.closingCredit))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    ) : (
      <Empty title="لا حركات في هذه المدة" detail="غيّر المدة أو سجّل قيودًا." />
    );
  } else if (result) {
    const rows = result.data.rows;
    const byBucket = (bucket: AgingRow['bucket']) =>
      rows
        .filter((row) => row.bucket === bucket)
        .reduce((value, row) => value + row.outstandingHalalas, 0);
    body = rows.length ? (
      <>
        <div className="led-kpis aging">
          {buckets.map(([bucket, label]) => (
            <div
              key={bucket}
              className={`led-kpi ${bucket === '90+' && byBucket(bucket) ? 'bad' : 'neutral'}`}
            >
              <span>{label}</span>
              <strong>{fmt(byBucket(bucket))}</strong>
            </div>
          ))}
        </div>
        <div className="fin-table-wrap">
          <table className="fin-table">
            <thead>
              <tr>
                <th>المستند</th>
                <th>{result.tab === 'receivable' ? 'العميل' : 'المورد'}</th>
                <th>التاريخ</th>
                <th>الاستحقاق</th>
                <th>المتبقي</th>
                <th>أيام التأخر</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.voucherId}>
                  <td>
                    <b>{row.number}</b>
                  </td>
                  <td>{row.partyName}</td>
                  <td className="num">{row.date}</td>
                  <td className="num">{row.dueDate || '—'}</td>
                  <td className="num">{fmt(row.outstandingHalalas)}</td>
                  <td className={`num ${row.daysOverdue > 0 ? 'led-bad' : ''}`}>
                    {row.daysOverdue > 0 ? row.daysOverdue : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    ) : (
      <Empty
        title="لا مبالغ قائمة"
        detail={
          result.tab === 'receivable' ? 'كل الفواتير المرحّلة محصّلة.' : 'كل فواتير الموردين مسددة.'
        }
      />
    );
  }
  return (
    <section className="fin-section">
      <div className="fin-section-head">
        <div>
          <h2>التقارير المالية</h2>
          <p>تُحسب لحظيًا من القيود المرحّلة. قوائم إدارية للمتابعة، وليست قوائم مالية مراجعة.</p>
        </div>
        <button className="button secondary" onClick={exportCsv} disabled={!result}>
          تصدير CSV
        </button>
      </div>
      <div className="led-subtabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="led-filters">
        {ranged && (
          <Field label="من">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        )}
        <Field label={ranged ? 'إلى' : 'كما في تاريخ'}>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {error && <Alert>{error}</Alert>}
      {body}
    </section>
  );
}
