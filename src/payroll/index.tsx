import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, CircleDollarSign, Download, FileText, RefreshCw, Send } from 'lucide-react';
import type { PayrollLine, PayrollRun } from '../../shared/administration';
import './payroll.css';

type Actor = {
  id: string;
  role: 'employee' | 'manager' | 'hr' | 'finance' | 'approver' | 'auditor';
};
type Props = { actor: Actor };
type SourceOption = {
  id: string;
  kind: 'reward' | 'overtime';
  employeeId: string;
  employeeName: string;
  amountMinor: number;
  label: string;
};
const label: Record<string, string> = {
  draft: 'مسودة',
  pending_finance: 'بانتظار مراجعة المالية',
  pending_approver: 'بانتظار اعتماد مستقل',
  closed: 'مغلق',
  rejected: 'مرفوض',
};
const currentPeriodInRiyadh = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    timeZone: 'Asia/Riyadh',
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`;
};
const money = (n: number) =>
  new Intl.NumberFormat('ar-SA-u-nu-latn', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n / 100) + ' ر.س';
const parseRiyal = (value: string): number | null => {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
};
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/admin/payroll${path}`, {
    method,
    headers: {
      ...(body
        ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error?.message || 'تعذرت العملية.');
  return value as T;
}
export function PayrollPage({ actor }: Props) {
  const [searchParams] = useSearchParams();
  const linkedRun = searchParams.get('run');
  const linkedEmployee = searchParams.get('employee');
  const [runs, setRuns] = useState<PayrollRun[]>([]),
    [selected, setSelected] = useState<PayrollRun | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [excludedCount, setExcludedCount] = useState(0),
    [period, setPeriod] = useState(currentPeriodInRiyadh),
    [reason, setReason] = useState(''),
    [actionReason, setActionReason] = useState(''),
    [editing, setEditing] = useState(false),
    [draftLines, setDraftLines] = useState<PayrollLine[]>([]),
    [sourceOptions, setSourceOptions] = useState<SourceOption[]>([]),
    [draftAmounts, setDraftAmounts] = useState<Record<string, string>>({}),
    [paymentEmployee, setPaymentEmployee] = useState(''),
    [printEmployeeId, setPrintEmployeeId] = useState(''),
    [paymentState, setPaymentState] = useState<'paid' | 'failed' | 'partial'>('paid'),
    [paidMinor, setPaidMinor] = useState(''),
    [paymentReference, setPaymentReference] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await request<{ runs: PayrollRun[] }>('');
      setRuns(result.runs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [actor.id]);
  useEffect(() => {
    setRuns([]);
    setSelected(null);
    setEditing(false);
    setSourceOptions([]);
    setExcludedCount(0);
    void load();
  }, [actor.id, load]);
  useEffect(() => {
    if (!linkedRun) return;
    let active = true;
    // The server checks run and employee access; query parameters grant no permissions.
    void request<{ run: PayrollRun }>(`/${encodeURIComponent(linkedRun)}`)
      .then(({ run }) => {
        if (!active) return;
        if (run.state !== 'closed') {
          setError('الكشف المرتبط غير متاح حتى إغلاق المسير.');
          return;
        }
        setSelected(run);
        setPrintEmployeeId(
          linkedEmployee && run.lines.some((line) => line.employeeId === linkedEmployee)
            ? linkedEmployee
            : '',
        );
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [actor.id, linkedRun, linkedEmployee]);
  const create = async (correctionOf?: string, targetPeriod = period) => {
    setBusy(true);
    setError('');
    try {
      const result = await request<{ run: PayrollRun; excludedCount?: number }>('', 'POST', {
        period: targetPeriod,
        policyId: 'payroll-policy-demo-v2',
        reason,
        ...(correctionOf ? { correctionOf } : {}),
      });
      setSelected(result.run);
      setExcludedCount(result.excludedCount ?? 0);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const action = async (run: PayrollRun, verb: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await request<{ run: PayrollRun }>(`/${run.id}/actions`, 'POST', {
        version: run.version,
        action: verb,
        reason: actionReason.trim() || 'إجراء تجريبي موثق',
      });
      setSelected(result.run);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveLines = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ run: PayrollRun }>(`/${selected.id}`, 'PATCH', {
        version: selected.version,
        lines: draftLines.map((line) => ({
          ...line,
          amountMinor:
            parseRiyal(draftAmounts[line.id] ?? (line.amountMinor / 100).toFixed(2)) ?? Number.NaN,
        })),
        reason: 'تعديل أسطر مسير تجريبي',
      });
      setSelected(result.run);
      setEditing(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const recordPayment = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ run: PayrollRun }>(`/${selected.id}/payments`, 'POST', {
        version: selected.version,
        employeeId: paymentEmployee,
        state: paymentState,
        paidMinor: parseRiyal(paidMinor),
        reference: paymentReference,
      });
      setSelected(result.run);
      setPaidMinor('');
      setPaymentReference('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportCsv = async (run: PayrollRun) => {
    try {
      const response = await fetch(`/api/admin/payroll/${run.id}/export`);
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => null))?.error?.message || 'تعذر تصدير المسير.',
        );
      const url = URL.createObjectURL(
        new Blob(['\ufeff', await response.blob()], { type: 'text/csv;charset=utf-8' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-${run.period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = async (run: PayrollRun) => {
    setSelected(run);
    setPrintEmployeeId(actor.role === 'employee' || actor.role === 'manager' ? actor.id : '');
    try {
      const result = await request<{ run: PayrollRun }>(`/${run.id}`);
      setSelected(result.run);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const printableLines =
    selected?.lines.filter(
      (line) =>
        line.employeeId ===
        (actor.role === 'employee' || actor.role === 'manager' ? actor.id : printEmployeeId),
    ) ?? [];
  const printableEarnings = printableLines
    .filter((line) => line.kind === 'earning')
    .reduce((sum, line) => sum + line.amountMinor, 0);
  const printableDeductions = printableLines
    .filter((line) => line.kind === 'deduction')
    .reduce((sum, line) => sum + line.amountMinor, 0);
  const printableEmployee = printableLines[0]?.employeeName ?? '';
  return (
    <section className="payroll-page" dir="rtl" aria-label="إدارة مسيرات الرواتب">
      <header className="payroll-heading">
        <div>
          <span className="payroll-eyebrow">إدارة مالية داخلية</span>
          <h1>مسيرات الرواتب</h1>
          <p>معاينة اصطناعية مستقلة. لا تمثل احتسابًا نظاميًا أو تحويلًا ماليًا.</p>
        </div>
        <button className="payroll-button secondary" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={16} /> تحديث
        </button>
      </header>
      {error && (
        <div className="payroll-error" role="alert">
          {error}
        </div>
      )}
      {excludedCount > 0 && (
        <div className="payroll-warning" role="status">
          استُبعد {excludedCount} موظفًا لعدم اكتمال مكونات الراتب الاصطناعية في ملفاتهم.
        </div>
      )}
      <section className="payroll-policy" aria-label="مصدر القواعد">
        <CircleDollarSign />
        <div>
          <strong>قواعد رواتب تجريبية · الإصدار 2</strong>
          <span>
            تُقرأ المكونات من ملفات اصطناعية للعرض فقط؛ لا تمثل احتسابًا نظاميًا أو بيانات حقيقية.
          </span>
        </div>
      </section>
      {actor.role === 'hr' && (
        <section className="payroll-create">
          <h2>إعداد مسير جديد</h2>
          <label>
            الفترة <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </label>
          <label>
            سبب الإنشاء <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            className="payroll-button"
            onClick={() => void create()}
            disabled={busy || reason.trim().length < 3}
          >
            <FileText size={16} /> إنشاء مسودة
          </button>
          <small>تُستبعد رواتب معدّ المسير والمالية والمعتمد من هذا المسير.</small>
        </section>
      )}
      <div className="payroll-layout">
        <section className="payroll-runs">
          <h2>المسيرات</h2>
          {runs.length === 0 ? (
            <p className="payroll-empty">لا توجد مسيرات متاحة لهذا الدور.</p>
          ) : (
            runs.map((run) => (
              <button
                className={`payroll-run ${selected?.id === run.id ? 'selected' : ''}`}
                key={run.id}
                onClick={() => void open(run)}
              >
                <span>
                  <strong>{run.period}</strong>
                  <small>{label[run.state] || run.state}</small>
                </span>
                <span className="payroll-total">{money(run.totals.netMinor)}</span>
              </button>
            ))
          )}
        </section>
        <section className="payroll-detail">
          {selected ? (
            <>
              <div className="payroll-detail-title">
                <div>
                  <h2>مسير {selected.period}</h2>
                  <span className={`payroll-state ${selected.state}`}>{label[selected.state]}</span>
                </div>
                <div>
                  {selected.state === 'closed' &&
                    ['hr', 'finance', 'approver', 'auditor'].includes(actor.role) && (
                      <button
                        className="payroll-button secondary"
                        onClick={() => void exportCsv(selected)}
                      >
                        <Download size={16} /> CSV
                      </button>
                    )}
                  {selected.canEdit && !editing && (
                    <button
                      className="payroll-button secondary"
                      onClick={async () => {
                        setDraftLines(selected.lines.map((line) => ({ ...line })));
                        setDraftAmounts(
                          Object.fromEntries(
                            selected.lines.map((line) => [
                              line.id,
                              (line.amountMinor / 100).toFixed(2),
                            ]),
                          ),
                        );
                        try {
                          const result = await request<{ sources: SourceOption[] }>('/sources');
                          setSourceOptions(result.sources);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                        setEditing(true);
                      }}
                    >
                      تعديل الأسطر
                    </button>
                  )}
                  {actor.role === 'hr' && selected.state === 'closed' && (
                    <button
                      className="payroll-button secondary"
                      onClick={() => {
                        setPeriod(selected.period);
                        void create(selected.id, selected.period);
                      }}
                      disabled={busy || reason.trim().length < 3}
                    >
                      إنشاء مسير تصحيح مرتبط
                    </button>
                  )}
                </div>
              </div>
              <p className="payroll-reason">{selected.reason}</p>
              <div className="payroll-summary">
                <span>
                  {selected.correctionOf ? 'صافي فرق التصحيح' : 'الإجمالي المستحق'}{' '}
                  <b>{money(selected.totals.netMinor)}</b>
                </span>
                <span>
                  الإيرادات <b>{money(selected.totals.earningsMinor)}</b>
                </span>
                <span>
                  الاستقطاعات <b>{money(selected.totals.deductionsMinor)}</b>
                </span>
              </div>
              {selected.payments.length > 0 && (
                <section className="payroll-payments" aria-label="حالات الدفع المسجلة">
                  <h3>حالة الدفع المسجلة</h3>
                  {selected.payments.map((payment, index) => (
                    <p key={`${payment.employeeId}-${index}`}>
                      {selected.lines.find((line) => line.employeeId === payment.employeeId)
                        ?.employeeName || 'الموظف'}
                      {' · '}
                      {payment.state === 'paid'
                        ? 'مدفوع'
                        : payment.state === 'failed'
                          ? 'تعذر الدفع'
                          : 'مدفوع جزئيًا'}
                      {' · '}
                      {money(payment.paidMinor)}
                    </p>
                  ))}
                </section>
              )}
              <div
                className="payroll-table-wrap"
                role="region"
                aria-label="جدول مكونات المسير"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th>الموظف</th>
                      <th>المكوّن</th>
                      <th>النوع</th>
                      <th>المبلغ</th>
                      <th>مصدر الطلب</th>
                      <th>المصدر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(editing ? draftLines : selected.lines).map((line, index) => (
                      <tr key={line.id}>
                        <td>
                          {editing ? (
                            <select
                              aria-label="الموظف"
                              value={line.employeeId}
                              onChange={(e) =>
                                setDraftLines((lines) =>
                                  lines.map((x, i) =>
                                    i === index
                                      ? {
                                          ...x,
                                          employeeId: e.target.value,
                                          sourceRequestId: null,
                                          employeeName:
                                            selected.lines.find(
                                              (person) => person.employeeId === e.target.value,
                                            )?.employeeName || x.employeeName,
                                        }
                                      : x,
                                  ),
                                )
                              }
                            >
                              {[
                                ...new Map(
                                  [...selected.lines, ...draftLines].map((person) => [
                                    person.employeeId,
                                    person,
                                  ]),
                                ).values(),
                              ].map((person) => (
                                <option key={person.employeeId} value={person.employeeId}>
                                  {person.employeeName}
                                </option>
                              ))}
                            </select>
                          ) : (
                            line.employeeName
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <input
                              aria-label="اسم المكوّن"
                              value={line.component}
                              onChange={(e) =>
                                setDraftLines((lines) =>
                                  lines.map((x, i) =>
                                    i === index ? { ...x, component: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          ) : (
                            line.component
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <select
                              aria-label="نوع المكوّن"
                              value={line.kind}
                              onChange={(e) =>
                                setDraftLines((lines) =>
                                  lines.map((x, i) =>
                                    i === index
                                      ? { ...x, kind: e.target.value as PayrollLine['kind'] }
                                      : x,
                                  ),
                                )
                              }
                            >
                              <option value="earning">استحقاق</option>
                              <option value="deduction">استقطاع</option>
                            </select>
                          ) : line.kind === 'earning' ? (
                            'استحقاق'
                          ) : (
                            'استقطاع'
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <input
                              aria-label="المبلغ بالريال"
                              type="number"
                              min="0"
                              step="0.01"
                              value={draftAmounts[line.id] ?? (line.amountMinor / 100).toFixed(2)}
                              onChange={(e) => {
                                const value = e.target.value;
                                setDraftAmounts((current) => ({ ...current, [line.id]: value }));
                                const amount = parseRiyal(value);
                                if (amount !== null)
                                  setDraftLines((lines) =>
                                    lines.map((x, i) =>
                                      i === index ? { ...x, amountMinor: amount } : x,
                                    ),
                                  );
                              }}
                            />
                          ) : (
                            money(line.amountMinor)
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <select
                              aria-label="مصدر الطلب المعتمد"
                              value={line.sourceRequestId || ''}
                              onChange={(e) => {
                                const source = sourceOptions.find(
                                  (option) => option.id === e.target.value,
                                );
                                if (source)
                                  setDraftAmounts((current) => ({
                                    ...current,
                                    [line.id]: (source.amountMinor / 100).toFixed(2),
                                  }));
                                setDraftLines((lines) =>
                                  lines.map((x, i) =>
                                    i === index
                                      ? source
                                        ? {
                                            ...x,
                                            sourceRequestId: source.id,
                                            component: source.label,
                                            kind: 'earning',
                                            amountMinor: source.amountMinor,
                                            source: source.label,
                                          }
                                        : { ...x, sourceRequestId: null }
                                      : x,
                                  ),
                                );
                              }}
                            >
                              <option value="">سطر يدوي تجريبي</option>
                              {sourceOptions
                                .filter(
                                  (option) =>
                                    option.employeeId === line.employeeId &&
                                    !draftLines.some(
                                      (candidate, rowIndex) =>
                                        rowIndex !== index &&
                                        candidate.sourceRequestId === option.id,
                                    ),
                                )
                                .map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label} · {money(option.amountMinor)}
                                  </option>
                                ))}
                            </select>
                          ) : line.sourceRequestId ? (
                            <a
                              href={`/requests/${line.sourceRequestId}`}
                              className="payroll-source-link"
                            >
                              عرض الطلب
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{line.source}</td>
                        {editing && (
                          <td>
                            <button
                              type="button"
                              className="payroll-button secondary"
                              onClick={() =>
                                setDraftLines((lines) => lines.filter((_, i) => i !== index))
                              }
                              aria-label="حذف السطر"
                            >
                              حذف
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {editing && (
                <div className="payroll-actions">
                  <button
                    className="payroll-button secondary"
                    type="button"
                    onClick={() => {
                      const person = selected.lines[0];
                      if (person)
                        setDraftLines((lines) => [
                          ...lines,
                          {
                            id: crypto.randomUUID(),
                            employeeId: person.employeeId,
                            employeeName: person.employeeName,
                            component: 'مكوّن إضافي',
                            kind: 'earning',
                            amountMinor: 0,
                            source: 'Adjustment pending review',
                          },
                        ]);
                    }}
                  >
                    إضافة سطر
                  </button>
                  <button
                    className="payroll-button"
                    onClick={() => void saveLines()}
                    disabled={busy}
                  >
                    حفظ التعديلات
                  </button>
                  <button className="payroll-button secondary" onClick={() => setEditing(false)}>
                    إلغاء
                  </button>
                </div>
              )}
              <div className="payroll-timeline">
                <h3>سجل المراجعة</h3>
                {selected.timeline.map((event) => (
                  <p key={event.id}>
                    <span>
                      {event.action === 'created'
                        ? 'أُنشئت المسودة'
                        : event.action === 'submit'
                          ? 'أُرسلت للمراجعة'
                          : event.action === 'review'
                            ? 'راجعتها المالية'
                            : event.action === 'approve'
                              ? 'اعتمدها معتمد مستقل'
                              : event.action === 'reject'
                                ? 'رُفضت'
                                : 'عُدلت'}{' '}
                      · {event.actorName}
                    </span>
                    <time>
                      {new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'Asia/Riyadh',
                      }).format(new Date(event.createdAt))}
                    </time>
                    {event.reason && <small>{event.reason}</small>}
                  </p>
                ))}
              </div>
              {actor.role === 'finance' && selected.state === 'closed' && (
                <section className="payroll-payment">
                  <h3>تسجيل حالة دفع يدوية</h3>
                  <p>تسجيل توثيقي فقط؛ لا ينفذ تحويلًا ماليًا.</p>
                  <label>
                    الموظف{' '}
                    <select
                      value={paymentEmployee}
                      onChange={(e) => setPaymentEmployee(e.target.value)}
                    >
                      <option value="">اختر موظفًا</option>
                      {[
                        ...new Map(selected.lines.map((line) => [line.employeeId, line])).values(),
                      ].map((line) => (
                        <option key={line.employeeId} value={line.employeeId}>
                          {line.employeeName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    الحالة{' '}
                    <select
                      value={paymentState}
                      onChange={(e) => setPaymentState(e.target.value as typeof paymentState)}
                    >
                      <option value="paid">مدفوع</option>
                      <option value="partial">مدفوع جزئيًا</option>
                      <option value="failed">تعذر الدفع</option>
                    </select>
                  </label>
                  <label>
                    المبلغ بالريال{' '}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={paidMinor}
                      onChange={(e) => setPaidMinor(e.target.value)}
                    />
                  </label>
                  <label>
                    مرجع داخلي{' '}
                    <input
                      value={paymentReference}
                      onChange={(e) => setPaymentReference(e.target.value)}
                    />
                  </label>
                  <button
                    className="payroll-button"
                    onClick={() => void recordPayment()}
                    disabled={
                      busy ||
                      !paymentEmployee ||
                      parseRiyal(paidMinor) === null ||
                      !paymentReference
                    }
                  >
                    حفظ الحالة يدويًا
                  </button>
                </section>
              )}
              <div className="payroll-actions">
                {['pending_finance', 'pending_approver'].includes(selected.state) && (
                  <label className="payroll-action-reason">
                    سبب الرفض عند الحاجة
                    <input
                      value={actionReason}
                      onChange={(e) => setActionReason(e.target.value)}
                      placeholder="اكتب سببًا قبل الرفض"
                    />
                  </label>
                )}
                {selected.canEdit && !editing && (
                  <button
                    className="payroll-button"
                    onClick={() => void action(selected, 'submit')}
                    disabled={busy}
                  >
                    <Send size={16} /> إرسال للمالية
                  </button>
                )}
                {selected.canReview && (
                  <button
                    className="payroll-button"
                    onClick={() => void action(selected, 'review')}
                    disabled={busy}
                  >
                    <Check size={16} /> إكمال المراجعة وإرساله للمعتمد
                  </button>
                )}
                {actor.role === 'approver' && selected.state === 'pending_approver' && (
                  <button
                    className="payroll-button"
                    onClick={() => void action(selected, 'approve')}
                    disabled={busy}
                  >
                    <Check size={16} /> اعتماد وإغلاق
                  </button>
                )}
                {actor.role === 'finance' && selected.state === 'pending_finance' && (
                  <button
                    className="payroll-button secondary"
                    onClick={() => void action(selected, 'reject')}
                    disabled={busy || actionReason.trim().length < 3}
                  >
                    رفض مع السبب
                  </button>
                )}
                {actor.role === 'approver' && selected.state === 'pending_approver' && (
                  <button
                    className="payroll-button secondary"
                    onClick={() => void action(selected, 'reject')}
                    disabled={busy || actionReason.trim().length < 3}
                  >
                    رفض مع السبب
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="payroll-empty">
              <FileText size={28} />
              <p>اختر مسيرًا لعرض تفاصيله.</p>
            </div>
          )}
        </section>
      </div>
      {selected?.state === 'closed' && ['employee', 'manager', 'hr'].includes(actor.role) && (
        <section className="payroll-print-controls" aria-label="طباعة كشف راتب">
          {actor.role === 'hr' && (
            <label>
              الموظف لطباعة كشفه
              <select
                value={printEmployeeId}
                onChange={(event) => setPrintEmployeeId(event.target.value)}
              >
                <option value="">اختر موظفًا</option>
                {[...new Map(selected.lines.map((line) => [line.employeeId, line])).values()].map(
                  (line) => (
                    <option key={line.employeeId} value={line.employeeId}>
                      {line.employeeName}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
          <button
            className="payroll-button secondary"
            onClick={() => window.print()}
            disabled={!printableLines.length}
          >
            طباعة كشف الراتب
          </button>
          <p>الكشف للمعاينة الاصطناعية فقط، ولا ينشئ استحقاقًا ماليًا.</p>
        </section>
      )}
      {selected?.state === 'closed' && printableLines.length > 0 && (
        <section className="payroll-print-sheet" aria-label="كشف راتب الموظف">
          <header>
            <div>
              <h1>كشف راتب تجريبي</h1>
              <p>{printableEmployee}</p>
              <p>الفترة {selected.period}</p>
            </div>
            <strong>{selected.correctionOf ? 'فرق تصحيحي مرتبط' : 'مسير مغلق'}</strong>
          </header>
          <div className="print-total">
            صافي {selected.correctionOf ? 'فرق التصحيح' : 'الراتب'}:{' '}
            {money(printableEarnings - printableDeductions)}
          </div>
          <table>
            <thead>
              <tr>
                <th>المكوّن</th>
                <th>النوع</th>
                <th>المبلغ</th>
              </tr>
            </thead>
            <tbody>
              {printableLines.map((line) => (
                <tr key={line.id}>
                  <td>{line.component}</td>
                  <td>{line.kind === 'earning' ? 'استحقاق' : 'استقطاع'}</td>
                  <td>{money(line.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <footer>
            هذا كشف داخلي لبيانات اصطناعية، ولا يمثل احتسابًا نظاميًا أو أمر تحويل مالي.
          </footer>
        </section>
      )}
    </section>
  );
}
