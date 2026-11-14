// Annual leave entitlement and leave encashment on separation (decision 015).
// HR: drafts the rule version, posts accrual, prepares settlements.
// Approver or system owner: approves the rule version and the settlement.
// Finance: reviews the settlement before the final approval.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, Calculator, FileText, Scale } from 'lucide-react';
import { api, Empty, PageHeading, useApp } from '../lib';
import './leave.css';

type Rule = {
  id: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  values: {
    baseDays: number;
    seniorDays: number;
    seniorAfterYears: number;
    yearDays: number;
    dailyRateDivisor: number;
    wageComponents: string[];
    excludeContractors: boolean;
    sourceKind: 'official' | 'secondary';
  };
};
type PolicyRecord = {
  id: string;
  key: string;
  name: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  state: 'draft' | 'synthetic_approved' | 'retired';
  values: Rule['values'];
  createdBy: string;
  approvedBy: string | null;
};
type Statement = {
  employeeId: string;
  employeeName: string;
  eligible: boolean;
  problem: string | null;
  joinDate: string | null;
  serviceYears: number;
  currentDaysPerYear: number | null;
  seniorFrom: string | null;
  accrualStart: string | null;
  accruedMilli: number;
  postedDays: number;
  postedThrough: string | null;
  ledger: { allocated: number; reserved: number; used: number; available: number };
  exactBalanceMilli: number;
};
type Calculation = {
  employeeName: string;
  joinDate: string;
  lastDay: string;
  serviceYears: number;
  ruleVersion: number;
  sourceKind: 'official' | 'secondary';
  components: { key: string; label: string; minor: number }[];
  monthlyWageMinor: number;
  divisor: number;
  dailyMinor: number;
  ledgerAvailable: number;
  postedDays: number;
  accruedMilli: number;
  balanceMilli: number;
  amountMinor: number;
};
type Settlement = {
  id: string;
  employeeId: string;
  employeeName: string;
  state: 'pending_finance' | 'pending_approver' | 'approved' | 'rejected' | 'cancelled' | 'draft';
  version: number;
  lastDay: string;
  reasonType: string;
  balanceMilli: number;
  amountMinor: number | null;
  calculation: Calculation | null;
  preparedBy: string;
  canAct: boolean;
};

const KEY = 'annual-leave-entitlement';
const COMPONENTS: Record<string, string> = {
  basicSalary: 'الراتب الأساسي',
  housingAllowance: 'بدل السكن',
  transportAllowance: 'بدل النقل',
  otherAllowance: 'بدلات أخرى ثابتة',
};
const REASONS: Record<string, string> = {
  resignation: 'استقالة',
  contract_end: 'انتهاء العقد',
  employer: 'إنهاء من صاحب العمل',
  mutual: 'اتفاق الطرفين',
  other: 'سبب آخر',
};
const STATE: Record<Settlement['state'], [string, string]> = {
  draft: ['مسودة', ''],
  pending_finance: ['بانتظار مراجعة المالية', 'pending'],
  pending_approver: ['بانتظار الاعتماد', 'pending'],
  approved: ['معتمدة', 'approved'],
  rejected: ['مرفوضة', 'rejected'],
  cancelled: ['ملغاة', ''],
};
const days = (milli: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    milli / 1000,
  );
const money = (minor: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    minor / 100,
  ) + ' ر.س';
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify(body),
});

export function LeaveEntitlementPage() {
  const { data, notify } = useApp();
  const role = data.me.role;
  const isHr = role === 'hr';
  const canApprove = role === 'approver' || data.me.systemOwner === true;
  const allowed = isHr || role === 'finance' || role === 'approver';
  const [policies, setPolicies] = useState<PolicyRecord[]>([]);
  const [rows, setRows] = useState<Statement[]>([]);
  const [lastPosted, setLastPosted] = useState<string | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [through, setThrough] = useState(data.today);
  const [ruleForm, setRuleForm] = useState({
    effectiveFrom: '',
    baseDays: '21',
    seniorDays: '30',
    seniorAfterYears: '5',
    dailyRateDivisor: '30',
    components: ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'],
    excludeContractors: true,
    sourceKind: 'secondary' as 'official' | 'secondary',
    source: '',
  });
  const [prep, setPrep] = useState({ employeeId: '', lastDay: '', reasonType: 'resignation' });
  const [preview, setPreview] = useState<Calculation | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const tasks: Promise<void>[] = [
        api<{ policies: PolicyRecord[] }>('/admin/policies').then((r) =>
          setPolicies(r.policies.filter((p) => p.key === KEY)),
        ),
        api<{ settlements: Settlement[] }>('/leave-settlements').then((r) =>
          setSettlements(r.settlements),
        ),
      ];
      if (isHr)
        tasks.push(
          api<{ rows: Statement[]; lastPostedThrough: string | null }>(
            '/leave-entitlement/overview',
          ).then((r) => {
            setRows(r.rows);
            setLastPosted(r.lastPostedThrough);
          }),
        );
      await Promise.all(tasks);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (allowed) void load();
  }, []);
  const eligibleCount = useMemo(() => rows.filter((r) => r.eligible).length, [rows]);
  if (!allowed)
    return (
      <Empty
        title="استحقاق الإجازات والتصفية"
        detail="هذه الصفحة للموارد البشرية والمالية والاعتماد. رصيدك يظهر في صفحة الإجازات."
      />
    );

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const createRule = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api(
        '/admin/policies',
        post({
          key: KEY,
          name: 'قاعدة استحقاق الإجازة السنوية وتصفيتها',
          effectiveFrom: ruleForm.effectiveFrom,
          source: ruleForm.source,
          values: {
            calculation: 'annual-leave-accrual-v1',
            baseDays: Number(ruleForm.baseDays),
            seniorDays: Number(ruleForm.seniorDays),
            seniorAfterYears: Number(ruleForm.seniorAfterYears),
            yearDays: 365,
            dailyRateDivisor: Number(ruleForm.dailyRateDivisor),
            wageComponents: ruleForm.components,
            excludeContractors: ruleForm.excludeContractors,
            sourceKind: ruleForm.sourceKind,
          },
        }),
      );
      notify('حُفظت مسودة القاعدة؛ لا تعمل حتى يعتمدها المعتمد أو مالك النظام.');
      await load();
    });
  };
  const approveRule = (p: PolicyRecord) =>
    run(async () => {
      await api(
        `/admin/policies/${p.id}/actions`,
        post({ action: 'approve', version: p.version, reason: 'اعتماد قاعدة الاستحقاق' }),
      );
      notify('اعتُمدت القاعدة.');
      await load();
    });
  const postAccrual = () =>
    run(async () => {
      const r = await api<{ results: { addedDays: number; skipped: string | null }[] }>(
        '/leave-entitlement/accruals',
        post({ throughDate: through }),
      );
      const added = r.results.reduce((a, x) => a + x.addedDays, 0);
      notify(`رُحّل الاستحقاق حتى ${through}: أضيف ${added} يومًا كاملًا إلى الأرصدة.`);
      await load();
    });
  const previewSettlement = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const q = new URLSearchParams({ employeeId: prep.employeeId, lastDay: prep.lastDay });
      setPreview(
        (await api<{ calculation: Calculation }>(`/leave-settlements/preview?${q}`)).calculation,
      );
    });
  };
  const createSettlement = () =>
    run(async () => {
      await api('/leave-settlements', post(prep));
      notify('أُرسلت التصفية إلى المالية للمراجعة.');
      setPreview(null);
      await load();
    });
  const act = (s: Settlement, action: 'approve' | 'reject' | 'cancel') =>
    run(async () => {
      await api(
        `/leave-settlements/${s.id}/actions`,
        post({ action, version: s.version, reason: reasons[s.id] ?? '' }),
      );
      notify(
        action === 'approve'
          ? s.state === 'pending_finance'
            ? 'رُوجعت التصفية وأُحيلت للاعتماد.'
            : 'اعتُمدت التصفية وصُفّر رصيد الموظف.'
          : action === 'reject'
            ? 'رُفضت التصفية.'
            : 'أُلغيت التصفية.',
      );
      await load();
    });
  const approvedRule = policies.find((p) => p.state === 'synthetic_approved');

  return (
    <>
      <PageHeading
        title="استحقاق الإجازات والتصفية"
        subtitle="استحقاق يتراكم يوميًا وفق قاعدة معتمدة، وتصفية الرصيد عند انتهاء الخدمة بإعداد ومراجعة واعتماد مستقل."
      />
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <section className="panel policy-panel">
        <h2>
          <Scale size={20} /> قاعدة الاستحقاق
        </h2>
        {policies.length === 0 && (
          <p className="field-hint">لا توجد قاعدة بعد. لا يتراكم أي رصيد قبل اعتماد قاعدة.</p>
        )}
        {policies.map((p) => (
          <div className="ent-rule" key={p.id}>
            <div className="ent-rule-head">
              <strong>الإصدار {p.version}</strong>
              <span className={`adm-state ${p.state === 'synthetic_approved' ? 'approved' : ''}`}>
                {p.state === 'synthetic_approved'
                  ? 'معتمدة'
                  : p.state === 'draft'
                    ? 'مسودة بانتظار الاعتماد'
                    : 'موقوفة'}
              </span>
              <span className={`ent-source ${p.values.sourceKind}`}>
                {p.values.sourceKind === 'official' ? 'مصدر رسمي' : 'مصدر ثانوي'}
              </span>
            </div>
            <dl className="ent-facts">
              <div>
                <dt>يسري من</dt>
                <dd>
                  <bdi dir="ltr">{p.effectiveFrom}</bdi>
                </dd>
              </div>
              <div>
                <dt>الاستحقاق السنوي</dt>
                <dd>
                  {p.values.baseDays} يومًا، ثم {p.values.seniorDays} بعد {p.values.seniorAfterYears}{' '}
                  سنوات متصلة
                </dd>
              </div>
              <div>
                <dt>الأجر اليومي</dt>
                <dd>
                  ({p.values.wageComponents.map((c) => COMPONENTS[c] ?? c).join(' + ')}) ÷{' '}
                  {p.values.dailyRateDivisor}
                </dd>
              </div>
              <div>
                <dt>المتعاون بمبلغ مقطوع</dt>
                <dd>{p.values.excludeContractors ? 'لا يتراكم له استحقاق' : 'يتراكم له'}</dd>
              </div>
              <div className="ent-wide">
                <dt>المصدر</dt>
                <dd>{p.source}</dd>
              </div>
            </dl>
            {p.state === 'draft' && canApprove && p.createdBy !== data.me.id && (
              <button className="button primary" disabled={busy} onClick={() => approveRule(p)}>
                اعتماد هذا الإصدار
              </button>
            )}
          </div>
        ))}
        {isHr && (
          <details className="ent-details">
            <summary>إنشاء إصدار جديد</summary>
            <form className="policy-form" onSubmit={createRule}>
              <label className="form-field">
                يسري من
                <input
                  type="date"
                  required
                  value={ruleForm.effectiveFrom}
                  onChange={(e) => setRuleForm({ ...ruleForm, effectiveFrom: e.target.value })}
                />
              </label>
              <label className="form-field">
                أيام الاستحقاق السنوي
                <input
                  inputMode="numeric"
                  required
                  value={ruleForm.baseDays}
                  onChange={(e) => setRuleForm({ ...ruleForm, baseDays: e.target.value })}
                />
              </label>
              <label className="form-field">
                الأيام بعد مدة الخدمة
                <input
                  inputMode="numeric"
                  required
                  value={ruleForm.seniorDays}
                  onChange={(e) => setRuleForm({ ...ruleForm, seniorDays: e.target.value })}
                />
              </label>
              <label className="form-field">
                سنوات الخدمة المتصلة للانتقال
                <input
                  inputMode="numeric"
                  required
                  value={ruleForm.seniorAfterYears}
                  onChange={(e) => setRuleForm({ ...ruleForm, seniorAfterYears: e.target.value })}
                />
              </label>
              <label className="form-field">
                يقسم الأجر الشهري على
                <input
                  inputMode="numeric"
                  required
                  value={ruleForm.dailyRateDivisor}
                  onChange={(e) => setRuleForm({ ...ruleForm, dailyRateDivisor: e.target.value })}
                />
              </label>
              <label className="form-field">
                نوع المصدر
                <select
                  value={ruleForm.sourceKind}
                  onChange={(e) =>
                    setRuleForm({
                      ...ruleForm,
                      sourceKind: e.target.value as 'official' | 'secondary',
                    })
                  }
                >
                  <option value="secondary">ثانوي (لم يُطابق بالنص الرسمي)</option>
                  <option value="official">رسمي (طوبق بالنص المنشور)</option>
                </select>
              </label>
              <fieldset className="form-field ent-wide policy-days">
                <legend>مكونات الأجر المحتسبة</legend>
                {Object.entries(COMPONENTS).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={ruleForm.components.includes(key)}
                      onChange={(e) =>
                        setRuleForm({
                          ...ruleForm,
                          components: e.target.checked
                            ? [...ruleForm.components, key]
                            : ruleForm.components.filter((c) => c !== key),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={ruleForm.excludeContractors}
                    onChange={(e) =>
                      setRuleForm({ ...ruleForm, excludeContractors: e.target.checked })
                    }
                  />
                  لا يتراكم للمتعاون بمبلغ مقطوع
                </label>
              </fieldset>
              <label className="form-field ent-wide">
                المصدر والمواد
                <textarea
                  required
                  rows={2}
                  value={ruleForm.source}
                  onChange={(e) => setRuleForm({ ...ruleForm, source: e.target.value })}
                  placeholder="مثال: نظام العمل م109 وم111، واللائحة م24؛ مصادر ثانوية لم تُطابق بالنص الرسمي."
                />
              </label>
              <button className="button primary" disabled={busy}>
                حفظ مسودة للاعتماد
              </button>
            </form>
          </details>
        )}
      </section>

      {isHr && (
        <section className="panel policy-panel">
          <h2>
            <CalendarClock size={20} /> أرصدة الاستحقاق
          </h2>
          <p className="field-hint">
            كل يوم خدمة يضيف (الاستحقاق السنوي ÷ 365). يُرحّل إلى الرصيد القابل للطلب باليوم الكامل،
            ويبقى الكسر محفوظًا للتصفية. {eligibleCount} من {rows.length} موظفًا مؤهلون؛ آخر ترحيل:{' '}
            {lastPosted ? <bdi dir="ltr">{lastPosted}</bdi> : 'لم يُرحّل بعد'}.
          </p>
          <div className="ent-toolbar">
            <label className="form-field">
              ترحيل الاستحقاق حتى
              <input
                type="date"
                max={data.today}
                value={through}
                onChange={(e) => setThrough(e.target.value)}
              />
            </label>
            <button
              className="button primary"
              disabled={busy || !approvedRule}
              onClick={postAccrual}
            >
              ترحيل
            </button>
          </div>
          <div className="adm-table-wrap" role="region" aria-label="أرصدة الاستحقاق" tabIndex={0}>
            <table className="adm-table ent-table">
              <thead>
                <tr>
                  <th>الموظف</th>
                  <th>المباشرة</th>
                  <th>الخدمة</th>
                  <th>الاستحقاق السنوي</th>
                  <th>المتراكم من</th>
                  <th>متاح للطلب</th>
                  <th>الرصيد الدقيق</th>
                  <th>ملاحظة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employeeId}>
                    <td>{r.employeeName}</td>
                    <td className="num">{r.joinDate ?? '—'}</td>
                    <td className="num">{r.joinDate ? `${r.serviceYears} سنة` : '—'}</td>
                    <td className="num">{r.currentDaysPerYear ?? '—'}</td>
                    <td className="num">{r.accrualStart ?? '—'}</td>
                    <td className="num">{r.ledger.available}</td>
                    <td className="num">{r.eligible ? days(r.exactBalanceMilli) : '—'}</td>
                    <td className="ent-note">{r.problem ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel policy-panel">
        <h2>
          <Calculator size={20} /> تصفية رصيد الإجازة عند انتهاء الخدمة
        </h2>
        <p className="field-hint">
          تعدّها الموارد البشرية، وتراجعها المالية، ويعتمدها المعتمد أو مالك النظام. لا يتخذ أحد
          قرارين في التصفية نفسها، ولا تُحوَّل أموال من النظام.
        </p>
        {isHr && (
          <form className="policy-form" onSubmit={previewSettlement}>
            <label className="form-field">
              الموظف
              <select
                required
                value={prep.employeeId}
                onChange={(e) => {
                  setPrep({ ...prep, employeeId: e.target.value });
                  setPreview(null);
                }}
              >
                <option value="">اختر الموظف</option>
                {data.employees
                  .filter((e) => e.id !== data.me.id)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="form-field">
              آخر يوم عمل
              <input
                type="date"
                required
                value={prep.lastDay}
                onChange={(e) => {
                  setPrep({ ...prep, lastDay: e.target.value });
                  setPreview(null);
                }}
              />
            </label>
            <label className="form-field">
              سبب انتهاء الخدمة
              <select
                value={prep.reasonType}
                onChange={(e) => setPrep({ ...prep, reasonType: e.target.value })}
              >
                {Object.entries(REASONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button className="button primary" disabled={busy}>
              احتساب
            </button>
          </form>
        )}
        {preview && (
          <div className="ent-calc">
            <CalculationView calc={preview} />
            <button className="button primary" disabled={busy} onClick={createSettlement}>
              إرسال للمراجعة المالية
            </button>
          </div>
        )}
        {settlements.length === 0 ? (
          <p className="quiet-empty">لا توجد تصفيات.</p>
        ) : (
          <div className="ent-list">
            {settlements.map((s) => (
              <article className="ent-settlement" key={s.id}>
                <header>
                  <strong>{s.employeeName}</strong>
                  <span className={`adm-state ${STATE[s.state][1]}`}>{STATE[s.state][0]}</span>
                  <span className="ent-muted">
                    آخر يوم <bdi dir="ltr">{s.lastDay}</bdi> · {REASONS[s.reasonType]}
                  </span>
                </header>
                {s.calculation ? (
                  <CalculationView calc={s.calculation} />
                ) : (
                  <p className="ent-muted">الرصيد المصفّى: {days(s.balanceMilli)} يوم</p>
                )}
                {(s.canAct ||
                  (isHr && s.preparedBy === data.me.id && s.state.startsWith('pending'))) && (
                  <div className="ent-actions">
                    <input
                      aria-label="سبب الرفض أو الإلغاء"
                      placeholder="السبب (مطلوب للرفض أو الإلغاء)"
                      value={reasons[s.id] ?? ''}
                      onChange={(e) => setReasons({ ...reasons, [s.id]: e.target.value })}
                    />
                    {s.canAct && (
                      <>
                        <button
                          className="button primary"
                          disabled={busy}
                          onClick={() => act(s, 'approve')}
                        >
                          {s.state === 'pending_finance' ? 'مراجعة وإحالة للاعتماد' : 'اعتماد'}
                        </button>
                        <button
                          className="button quiet danger-text"
                          disabled={busy}
                          onClick={() => act(s, 'reject')}
                        >
                          رفض
                        </button>
                      </>
                    )}
                    {!s.canAct && (
                      <button
                        className="button quiet danger-text"
                        disabled={busy}
                        onClick={() => act(s, 'cancel')}
                      >
                        إلغاء التصفية
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="field-hint ent-footnote">
        <FileText size={14} /> المرجع: نظام العمل م109 (21 يومًا ثم 30 بعد خمس سنوات متصلة)، م111
        (أجر الأيام غير المستخدمة وأجزاء السنة عند ترك العمل)، واللائحة م24 (العطل والراحة الأسبوعية
        لا تُحسب من الإجازة). الأرقام تُقرأ من إصدار القاعدة المعتمد لا من الشيفرة.
      </p>
    </>
  );
}

function CalculationView({ calc }: { calc: Calculation }) {
  return (
    <dl className="ent-facts ent-calc-facts">
      <div>
        <dt>المباشرة / الخدمة</dt>
        <dd>
          <bdi dir="ltr">{calc.joinDate}</bdi> · {calc.serviceYears} سنة
        </dd>
      </div>
      <div>
        <dt>الأجر الشهري المحتسب</dt>
        <dd>
          {money(calc.monthlyWageMinor)}
          <small>{calc.components.map((c) => `${c.label} ${money(c.minor)}`).join(' + ')}</small>
        </dd>
      </div>
      <div>
        <dt>أجر اليوم</dt>
        <dd>
          {money(calc.dailyMinor)} <small>÷ {calc.divisor}</small>
        </dd>
      </div>
      <div>
        <dt>الرصيد المستحق</dt>
        <dd>
          {days(calc.balanceMilli)} يوم
          <small>
            متاح بالسجل {calc.ledgerAvailable} − مرحّل {calc.postedDays} + متراكم بدقة{' '}
            {days(calc.accruedMilli)}
          </small>
        </dd>
      </div>
      <div className="ent-total">
        <dt>بدل الرصيد</dt>
        <dd>{money(calc.amountMinor)}</dd>
      </div>
      <div>
        <dt>القاعدة</dt>
        <dd>
          الإصدار {calc.ruleVersion} · {calc.sourceKind === 'official' ? 'مصدر رسمي' : 'مصدر ثانوي'}
        </dd>
      </div>
    </dl>
  );
}
