import { money, PayslipPaper } from './PayslipPaper';
import { PayrollRegisterPaper, PayrollRegisterView } from './PayrollRegister';
import { PayrollPolicyForm } from './PayrollPolicyForm';
import { GosiExplainer } from './GosiExplainer';
import { GOSI_CATEGORIES, GOSI_CATEGORY_LABEL } from '../../shared/gosi';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check,
  CircleDollarSign,
  Download,
  FileSpreadsheet,
  FileText,
  Printer,
  RefreshCw,
  Send,
} from 'lucide-react';
import type { PayrollLine, PayrollPolicyOption, PayrollRun } from '../../shared/administration';
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
  pending_approver: 'بانتظار اعتماد المدير العام',
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
    [paymentReference, setPaymentReference] = useState(''),
    [policies, setPolicies] = useState<PayrollPolicyOption[] | null>(null),
    [policyId, setPolicyId] = useState(''),
    [exclusions, setExclusions] = useState<{ code: string; label: string; count: number }[]>([]),
    [notice, setNotice] = useState(''),
    [printMode, setPrintMode] = useState<'payslip' | 'register'>('payslip');
  const seesPolicies = ['hr', 'finance', 'approver', 'auditor'].includes(actor.role);
  const loadPolicies = useCallback(async () => {
    if (!seesPolicies) return;
    try {
      const result = await request<{ policies: PayrollPolicyOption[] }>(
        `/policies?period=${encodeURIComponent(period)}`,
      );
      setPolicies(result.policies);
      setPolicyId((current) =>
        result.policies.some((p) => p.id === current) ? current : (result.policies[0]?.id ?? ''),
      );
    } catch (e) {
      setPolicies([]);
      setError((e as Error).message);
    }
  }, [period, seesPolicies]);
  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);
  useEffect(() => {
    const reset = () => setPrintMode('payslip');
    window.addEventListener('afterprint', reset);
    return () => window.removeEventListener('afterprint', reset);
  }, []);
  const printRegister = () => {
    setPrintMode('register');
    // Let React render the register paper before the print dialog opens.
    window.setTimeout(() => window.print(), 50);
  };
  const exportXlsx = async (run: PayrollRun) => {
    try {
      const response = await fetch(`/api/admin/payroll/${run.id}/register.xlsx`);
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => null))?.error?.message || 'تعذر تصدير المسير.',
        );
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-${run.period}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const selectedPolicy = policies?.find((p) => p.id === policyId);
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
      const result = await request<{
        run: PayrollRun;
        excludedCount?: number;
        exclusions?: { code: string; label: string; count: number }[];
      }>('', 'POST', {
        period: targetPeriod,
        ...(correctionOf ? { correctionOf } : { policyId }),
        reason,
      });
      setSelected(result.run);
      setExcludedCount(result.excludedCount ?? 0);
      setExclusions(result.exclusions ?? []);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const nextPeriod = (value: string) => {
    const [year, month] = value.split('-').map(Number);
    return month === 12 ? `${year! + 1}-01` : `${year}-${String(month! + 1).padStart(2, '0')}`;
  };
  const copyToNext = async (run: PayrollRun) => {
    setBusy(true);
    setError('');
    const target = nextPeriod(run.period);
    try {
      const result = await request<{
        run: PayrollRun;
        excludedCount?: number;
        exclusions?: { code: string; label: string; count: number }[];
      }>(`/${run.id}/copy`, 'POST', {
        period: target,
        reason: reason.trim().length >= 3 ? reason : `نسخ مسير ${run.period} إلى ${target}`,
      });
      setSelected(result.run);
      setPeriod(target);
      setExcludedCount(result.excludedCount ?? 0);
      setExclusions(result.exclusions ?? []);
      setNotice(`أُنشئت مسودة ${target} نسخةً من مسير ${run.period}. عدّل ما يلزم ثم أرسلها للمالية.`);
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
  return (
    <section className="payroll-page" dir="rtl" aria-label="إدارة مسيرات الرواتب">
      <header className="payroll-heading">
        <div>
          <span className="payroll-eyebrow">إدارة مالية داخلية</span>
          <h1>مسيرات الرواتب</h1>
          <p>
            يُعد المسير من الملف الوظيفي وإصدار قواعد معتمد، ويمر بمراجعة المالية ثم اعتماد المدير
            العام. لا ينفذ تحويلًا ماليًا.
          </p>
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
      {notice && (
        <div className="payroll-notice" role="status">
          {notice}
        </div>
      )}
      {(excludedCount > 0 || exclusions.length > 0) && (
        <div className="payroll-warning" role="status">
          {excludedCount > 0
            ? `لم يدخل ${excludedCount} موظفًا في المسير. أكمل ملفاتهم ثم أضفهم أو أعد إعداد المسودة:`
            : 'ملاحظات إعداد المسير:'}
          {exclusions.length > 0 && (
            <ul>
              {exclusions.map((item) => (
                <li key={item.code}>
                  {item.label}: {item.count}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {seesPolicies && (
        <section className="payroll-policy" aria-label="إصدار قواعد الرواتب">
          <CircleDollarSign />
          {policies === null ? (
            <div>
              <strong>جارٍ تحميل قواعد الرواتب…</strong>
            </div>
          ) : selectedPolicy ? (
            <div>
              <strong>
                {selectedPolicy.name} · الإصدار {selectedPolicy.version}
              </strong>
              <span>
                يسري من {selectedPolicy.effectiveFrom}
                {selectedPolicy.effectiveTo ? ` حتى ${selectedPolicy.effectiveTo}` : ''} · المصدر:{' '}
                {selectedPolicy.source}
              </span>
              {selectedPolicy.gosiInvalid ? (
                <span className="payroll-error-text">
                  قسم التأمينات في هذا الإصدار غير صالح؛ لا يُعد به مسير.
                </span>
              ) : selectedPolicy.gosi ? (
                <ul className="policy-rate-list">
                  {GOSI_CATEGORIES.map((key) => (
                    <li key={key}>
                      {GOSI_CATEGORY_LABEL[key]}: الموظف{' '}
                      {(selectedPolicy.gosi!.categories[key].employeeBps / 100).toFixed(2)}% · صاحب
                      العمل {(selectedPolicy.gosi!.categories[key].employerBps / 100).toFixed(2)}%
                    </li>
                  ))}
                  <li>
                    الأجر الخاضع:{' '}
                    {selectedPolicy.gosi.wageComponents.includes('housingAllowance')
                      ? 'الأساسي + السكن'
                      : 'الأساسي'}{' '}
                    بحد أعلى {(selectedPolicy.gosi.maxWageMinor / 100).toLocaleString('en-US')} ريال
                  </li>
                </ul>
              ) : null}
              {selectedPolicy.gosi && !selectedPolicy.gosiInvalid && (
                <GosiExplainer rule={selectedPolicy.gosi} />
              )}
              {selectedPolicy.gosiInvalid || selectedPolicy.gosi ? null : (
                <span>هذا الإصدار بلا قسم تأمينات؛ لا يُحسم تأمين في المسير.</span>
              )}
              {policies.length > 1 && actor.role === 'hr' && (
                <label>
                  الإصدار المستخدم
                  <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                    {policies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · الإصدار {p.version}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ) : (
            <div>
              <strong>لا يوجد إصدار قواعد رواتب معتمد يسري على {period}</strong>
              <span>
                تنشئ الموارد البشرية الإصدار بنسب التأمينات من مصدرها الرسمي، ثم يعتمده المعتمد
                المستقل من صفحة السياسات. لا يُعد مسير قبل ذلك.
              </span>
            </div>
          )}
        </section>
      )}
      {actor.role === 'hr' && (
        <PayrollPolicyForm
          onCreated={(message) => {
            setNotice(message);
            void loadPolicies();
          }}
        />
      )}
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
            disabled={busy || reason.trim().length < 3 || !policyId}
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
                  {['hr', 'finance', 'approver', 'auditor'].includes(actor.role) && (
                    <>
                      <button className="payroll-button secondary" onClick={printRegister}>
                        <Printer size={16} /> طباعة المسير
                      </button>
                      <button
                        className="payroll-button secondary"
                        onClick={() => void exportXlsx(selected)}
                      >
                        <FileSpreadsheet size={16} /> Excel
                      </button>
                      <button
                        className="payroll-button secondary"
                        onClick={() => void exportCsv(selected)}
                      >
                        <Download size={16} /> CSV
                      </button>
                    </>
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
                  {actor.role === 'hr' &&
                    !selected.correctionOf &&
                    selected.state !== 'rejected' &&
                    !runs.some(
                      (run) =>
                        run.period === nextPeriod(selected.period) &&
                        !run.correctionOf &&
                        run.state !== 'rejected',
                    ) && (
                      <button
                        className="payroll-button secondary"
                        onClick={() => void copyToNext(selected)}
                        disabled={busy}
                      >
                        نسخ إلى {nextPeriod(selected.period)}
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
              {selected.correctionOf && (
                <div className="payroll-summary">
                  <span>
                    صافي فرق التصحيح <b>{money(selected.totals.netMinor)}</b>
                  </span>
                  <span>
                    فرق الاستحقاقات <b>{money(selected.totals.earningsMinor)}</b>
                  </span>
                  <span>
                    فرق الخصومات <b>{money(selected.totals.deductionsMinor)}</b>
                  </span>
                </div>
              )}
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
              {!editing && <PayrollRegisterView run={selected} />}
              <details className="payroll-lines" open={editing}>
                <summary>الأسطر التفصيلية ومصادرها</summary>
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
              </details>
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
                  <small className="payroll-edit-note">
                    يُعاد حساب «تأمين الموظف» وحصة صاحب العمل تلقائيًا من إصدار القواعد عند الحفظ.
                  </small>
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
                            ? 'راجعها ووقعها مدير الإدارة المالية'
                            : event.action === 'approve'
                              ? 'اعتمدها ووقعها المدير العام'
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
      {selected && printMode === 'register' && <PayrollRegisterPaper run={selected} />}
      {printMode === 'payslip' && selected?.state === 'closed' && printableLines.length > 0 && (
        <PayslipPaper run={selected} employeeId={printableLines[0]!.employeeId} />
      )}
    </section>
  );
}
