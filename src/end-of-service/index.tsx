// Verified service periods and the end-of-service award (decision 016).
// HR: records and verifies service periods, drafts the rule version, prepares settlements.
// Finance reviews; the approver or system owner approves the rule and the settlement.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BadgeCheck, Calculator, FileText, Scale } from 'lucide-react';
import { api, Empty, PageHeading, useApp } from '../lib';
import {
  EOS_CALCULATION,
  EOS_POLICY_KEY,
  EOS_REASONS,
  EOS_TREATMENTS,
  EOS_WAGE_COMPONENTS,
  type EosReason,
  type EosRuleValues,
  type EosTreatment,
} from '../../shared/end-of-service';
import '../leave/leave.css';
import './eos.css';

type PolicyRecord = {
  id: string;
  key: string;
  version: number;
  effectiveFrom: string;
  source: string;
  state: 'draft' | 'synthetic_approved' | 'retired';
  values: EosRuleValues;
  createdBy: string;
};
type Period = {
  id: string;
  startDate: string;
  endDate: string | null;
  relationshipType: string;
  source: string;
  status: string;
  statusLabel: string;
};
type PersonPeriods = {
  id: string;
  name: string;
  joinDate: string | null;
  status: string;
  periods: Period[];
  verified: boolean;
};
type Calculation = {
  employeeName: string;
  lastDay: string;
  reasonType: EosReason;
  treatment: EosTreatment;
  ruleVersion: number;
  sourceKind: 'official' | 'secondary';
  periods: { startDate: string; endDate: string | null; source: string }[];
  grossServiceDays: number;
  excludedDays: number;
  excludedReason: string | null;
  components: { key: string; label: string; minor: number }[];
  monthlyWageMinor: number;
  firstTierYears: number;
  firstTierMonthsMilli: number;
  laterMonthsMilli: number;
  yearDays: number;
  award: {
    serviceDays: number;
    serviceYears: number;
    fullAwardMinor: number;
    share: { numerator: number; denominator: number };
    amountMinor: number;
    firstTierDays: number;
    laterDays: number;
  };
};
type Settlement = {
  id: string;
  employeeName: string;
  state: 'pending_finance' | 'pending_approver' | 'approved' | 'rejected' | 'cancelled';
  version: number;
  lastDay: string;
  reasonType: EosReason;
  serviceDays: number;
  calculation: Calculation | null;
  preparedBy: string;
  canAct: boolean;
};

const STATE: Record<Settlement['state'], [string, string]> = {
  pending_finance: ['بانتظار مراجعة المالية', 'pending'],
  pending_approver: ['بانتظار الاعتماد', 'pending'],
  approved: ['معتمدة', 'approved'],
  rejected: ['مرفوضة', 'rejected'],
  cancelled: ['ملغاة', ''],
};
const money = (minor: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    minor / 100,
  ) + ' ر.س';
const months = (milli: number) => (milli / 1000).toLocaleString('en-US');
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify(body),
});
const DEFAULT_TREATMENT: Record<EosReason, EosTreatment> = {
  resignation: 'resignation',
  resignation_art87: 'full',
  contract_end: 'full',
  employer: 'full',
  mutual: 'full',
  worker_art81: 'full',
  dismissal_art80: 'none',
  death_disability: 'full',
};

export function EndOfServicePage() {
  const { data, notify } = useApp();
  const role = data.me.role;
  const isHr = role === 'hr';
  const canApprove = role === 'approver' || data.me.systemOwner === true;
  const allowed = isHr || role === 'finance' || role === 'approver';
  const [policies, setPolicies] = useState<PolicyRecord[]>([]);
  const [people, setPeople] = useState<PersonPeriods[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [onlyPending, setOnlyPending] = useState(true);
  const [openPerson, setOpenPerson] = useState('');
  const [periodForm, setPeriodForm] = useState({ startDate: '', endDate: '', source: '' });
  const [ruleForm, setRuleForm] = useState({
    effectiveFrom: '',
    firstTierYears: '5',
    firstTierMonths: '0.5',
    laterMonths: '1',
    tiers: '2:1/3, 5:2/3, 10:1/1',
    components: ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'],
    treatment: DEFAULT_TREATMENT,
    excludeContractors: true,
    sourceKind: 'secondary' as 'official' | 'secondary',
    source: '',
  });
  const [prep, setPrep] = useState({
    employeeId: '',
    lastDay: '',
    reasonType: 'resignation' as EosReason,
    excludedDays: '0',
    excludedReason: '',
  });
  const [preview, setPreview] = useState<Calculation | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      await Promise.all([
        api<{ policies: PolicyRecord[] }>('/admin/policies').then((r) =>
          setPolicies(r.policies.filter((p) => p.key === EOS_POLICY_KEY)),
        ),
        api<{ settlements: Settlement[] }>('/eos/settlements').then((r) =>
          setSettlements(r.settlements),
        ),
        api<{ employees: PersonPeriods[] }>('/eos/service-periods').then((r) =>
          setPeople(r.employees),
        ),
      ]);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (allowed) void load();
  }, []);
  const pendingCount = useMemo(() => people.filter((p) => !p.verified).length, [people]);
  if (!allowed)
    return <Empty title="نهاية الخدمة" detail="هذه الصفحة للموارد البشرية والمالية والاعتماد." />;

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
  const parseTiers = () =>
    ruleForm.tiers
      .split(/[,،]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const m = t.match(/^(\d+)\s*:\s*(\d+)\s*\/\s*(\d+)$/);
        if (!m) throw new Error(`صيغة الشريحة غير صحيحة: ${t} (مثال 2:1/3)`);
        return { fromYears: Number(m[1]), numerator: Number(m[2]), denominator: Number(m[3]) };
      });
  const createRule = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api(
        '/admin/policies',
        post({
          key: EOS_POLICY_KEY,
          name: 'قاعدة مكافأة نهاية الخدمة',
          effectiveFrom: ruleForm.effectiveFrom,
          source: ruleForm.source,
          values: {
            calculation: EOS_CALCULATION,
            firstTierYears: Number(ruleForm.firstTierYears),
            firstTierMonthsMilli: Math.round(Number(ruleForm.firstTierMonths) * 1000),
            laterMonthsMilli: Math.round(Number(ruleForm.laterMonths) * 1000),
            yearDays: 365,
            resignationTiers: parseTiers(),
            reasonTreatment: ruleForm.treatment,
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
        post({ action: 'approve', version: p.version, reason: 'اعتماد قاعدة مكافأة نهاية الخدمة' }),
      );
      notify('اعتُمدت القاعدة.');
      await load();
    });
  const addPeriod = (person: PersonPeriods) => (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api(
        '/eos/service-periods',
        post({
          employeeId: person.id,
          startDate: periodForm.startDate,
          endDate: periodForm.endDate || null,
          source: periodForm.source,
        }),
      );
      notify('سُجلت الفترة بانتظار التحقق.');
      setPeriodForm({ startDate: '', endDate: '', source: '' });
      await load();
    });
  };
  const verify = (period: Period) =>
    run(async () => {
      await api(`/eos/service-periods/${period.id}/verify`, post({ reason: null }));
      notify('تم التحقق من الفترة.');
      await load();
    });
  const previewSettlement = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const q = new URLSearchParams(prep as Record<string, string>);
      setPreview((await api<{ calculation: Calculation }>(`/eos/preview?${q}`)).calculation);
    });
  };
  const createSettlement = () =>
    run(async () => {
      await api(
        '/eos/settlements',
        post({ ...prep, excludedDays: Number(prep.excludedDays || 0) }),
      );
      notify('أُرسلت التسوية إلى المالية للمراجعة.');
      setPreview(null);
      await load();
    });
  const act = (s: Settlement, action: 'approve' | 'reject' | 'cancel') =>
    run(async () => {
      await api(
        `/eos/settlements/${s.id}/actions`,
        post({ action, version: s.version, reason: reasons[s.id] ?? '' }),
      );
      notify(
        action === 'approve'
          ? s.state === 'pending_finance'
            ? 'رُوجعت التسوية وأُحيلت للاعتماد.'
            : 'اعتُمدت مكافأة نهاية الخدمة.'
          : action === 'reject'
            ? 'رُفضت التسوية.'
            : 'أُلغيت التسوية.',
      );
      await load();
    });
  const visiblePeople = people.filter((p) => !onlyPending || !p.verified);

  return (
    <>
      <PageHeading
        title="نهاية الخدمة"
        subtitle="فترات خدمة متحقق منها بمصدرها، ومكافأة تُحسب من قاعدة معتمدة، بإعداد ومراجعة واعتماد مستقل."
      />
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <section className="panel policy-panel">
        <h2>
          <BadgeCheck size={20} /> فترات الخدمة
        </h2>
        <p className="field-hint">
          لا تُحسب المكافأة ولا تصدر شهادة الخبرة إلا من فترات متحقق منها. {pendingCount} من{' '}
          {people.length} موظفًا لديهم فترة ناقصة أو بانتظار التحقق. الفترة المتحقق منها لا تُعدّل.
        </p>
        <label className="ent-toggle">
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)}
          />
          اعرض من يحتاج تحققًا فقط
        </label>
        <div className="ent-list">
          {visiblePeople.map((p) => (
            <article className="ent-settlement" key={p.id}>
              <header>
                <strong>{p.name}</strong>
                <span className={`adm-state ${p.verified ? 'approved' : 'pending'}`}>
                  {p.verified ? 'متحقق منها' : p.periods.length ? 'بانتظار التحقق' : 'لا توجد فترة'}
                </span>
                <span className="ent-muted">
                  المباشرة في الملف: <bdi dir="ltr">{p.joinDate ?? '—'}</bdi>
                </span>
                {isHr && p.id !== data.me.id && (
                  <button
                    className="button quiet"
                    onClick={() => {
                      setOpenPerson(openPerson === p.id ? '' : p.id);
                      setPeriodForm({ startDate: p.joinDate ?? '', endDate: '', source: '' });
                    }}
                  >
                    {openPerson === p.id ? 'إغلاق' : 'إضافة فترة'}
                  </button>
                )}
              </header>
              {p.periods.map((period) => (
                <div className="ent-period" key={period.id}>
                  <bdi dir="ltr">
                    {period.startDate} → {period.endDate ?? 'مستمرة'}
                  </bdi>
                  <span className="ent-muted">
                    {period.statusLabel} · {period.source}
                  </span>
                  {isHr && period.status === 'pending-review' && p.id !== data.me.id && (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => verify(period)}
                    >
                      تحققت من المصدر
                    </button>
                  )}
                </div>
              ))}
              {openPerson === p.id && (
                <form className="policy-form" onSubmit={addPeriod(p)}>
                  <label className="form-field">
                    من
                    <input
                      type="date"
                      required
                      max={data.today}
                      value={periodForm.startDate}
                      onChange={(e) => setPeriodForm({ ...periodForm, startDate: e.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    إلى (اتركه فارغًا إن كانت مستمرة)
                    <input
                      type="date"
                      value={periodForm.endDate}
                      onChange={(e) => setPeriodForm({ ...periodForm, endDate: e.target.value })}
                    />
                  </label>
                  <label className="form-field ent-wide">
                    المصدر الذي تحققت منه
                    <input
                      required
                      value={periodForm.source}
                      onChange={(e) => setPeriodForm({ ...periodForm, source: e.target.value })}
                      placeholder="مثال: العقد الموقع، وسجل قوى، وشهادة التأمينات"
                    />
                  </label>
                  <button className="button primary" disabled={busy}>
                    تسجيل الفترة
                  </button>
                </form>
              )}
            </article>
          ))}
          {visiblePeople.length === 0 && <p className="quiet-empty">لا أحد يحتاج تحققًا.</p>}
        </div>
      </section>

      <section className="panel policy-panel">
        <h2>
          <Scale size={20} /> قاعدة مكافأة نهاية الخدمة
        </h2>
        {policies.length === 0 && (
          <p className="field-hint">لا توجد قاعدة بعد. لا تُحسب أي مكافأة قبل اعتماد إصدار.</p>
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
                <dt>المكافأة</dt>
                <dd>
                  أجر {months(p.values.firstTierMonthsMilli)} شهر عن كل سنة من أول{' '}
                  {p.values.firstTierYears} سنوات، ثم {months(p.values.laterMonthsMilli)} عن كل سنة
                  بعدها، وأجزاء السنة بنسبتها
                </dd>
              </div>
              <div>
                <dt>الاستقالة</dt>
                <dd>
                  {p.values.resignationTiers.length
                    ? p.values.resignationTiers
                        .map((t) => `من ${t.fromYears} سنوات: ${t.numerator}/${t.denominator}`)
                        .join(' · ')
                    : 'لا شرائح'}
                </dd>
              </div>
              <div>
                <dt>الأجر</dt>
                <dd>
                  {p.values.wageComponents
                    .map((c) => EOS_WAGE_COMPONENTS[c as keyof typeof EOS_WAGE_COMPONENTS] ?? c)
                    .join(' + ')}
                </dd>
              </div>
              <div className="ent-wide">
                <dt>المعاملة حسب السبب</dt>
                <dd>
                  {Object.entries(p.values.reasonTreatment)
                    .map(
                      ([k, v]) =>
                        `${EOS_REASONS[k as EosReason] ?? k}: ${EOS_TREATMENTS[v as EosTreatment]}`,
                    )
                    .join(' · ')}
                </dd>
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
                سنوات الشريحة الأولى
                <input
                  inputMode="numeric"
                  required
                  value={ruleForm.firstTierYears}
                  onChange={(e) => setRuleForm({ ...ruleForm, firstTierYears: e.target.value })}
                />
              </label>
              <label className="form-field">
                أشهر الأجر عن كل سنة فيها
                <input
                  inputMode="decimal"
                  required
                  value={ruleForm.firstTierMonths}
                  onChange={(e) => setRuleForm({ ...ruleForm, firstTierMonths: e.target.value })}
                />
              </label>
              <label className="form-field">
                أشهر الأجر عن كل سنة بعدها
                <input
                  inputMode="decimal"
                  required
                  value={ruleForm.laterMonths}
                  onChange={(e) => setRuleForm({ ...ruleForm, laterMonths: e.target.value })}
                />
              </label>
              <label className="form-field ent-wide">
                شرائح الاستقالة (سنوات:نسبة)
                <input
                  dir="ltr"
                  required
                  value={ruleForm.tiers}
                  onChange={(e) => setRuleForm({ ...ruleForm, tiers: e.target.value })}
                />
              </label>
              <fieldset className="form-field ent-wide">
                <legend>المعاملة حسب سبب انتهاء الخدمة</legend>
                {(Object.keys(EOS_REASONS) as EosReason[]).map((k) => (
                  <label key={k} className="ent-treatment">
                    <span>{EOS_REASONS[k]}</span>
                    <select
                      value={ruleForm.treatment[k]}
                      onChange={(e) =>
                        setRuleForm({
                          ...ruleForm,
                          treatment: { ...ruleForm.treatment, [k]: e.target.value as EosTreatment },
                        })
                      }
                    >
                      {(Object.keys(EOS_TREATMENTS) as EosTreatment[]).map((t) => (
                        <option key={t} value={t}>
                          {EOS_TREATMENTS[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </fieldset>
              <fieldset className="form-field ent-wide policy-days">
                <legend>مكونات الأجر المحتسبة</legend>
                {Object.entries(EOS_WAGE_COMPONENTS).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={ruleForm.components.includes(key)}
                      disabled={key === 'basicSalary'}
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
                  المتعاون بمبلغ مقطوع خارج المكافأة
                </label>
              </fieldset>
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
              <label className="form-field ent-wide">
                المصدر والمواد
                <textarea
                  required
                  rows={2}
                  value={ruleForm.source}
                  onChange={(e) => setRuleForm({ ...ruleForm, source: e.target.value })}
                  placeholder="مثال: نظام العمل م84 وم85 وم87 وم88؛ مصادر ثانوية لم تُطابق بالنص الرسمي."
                />
              </label>
              <button className="button primary" disabled={busy}>
                حفظ مسودة للاعتماد
              </button>
            </form>
          </details>
        )}
      </section>

      <section className="panel policy-panel">
        <h2>
          <Calculator size={20} /> تسوية مكافأة نهاية الخدمة
        </h2>
        <p className="field-hint">
          تعدّها الموارد البشرية، وتراجعها المالية، ويعتمدها المعتمد أو مالك النظام. لا يتخذ أحد
          قرارين في التسوية نفسها، ولا تُحوَّل أموال من النظام. بدل رصيد الإجازة له تسوية مستقلة في
          صفحة استحقاق الإجازات.
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
                onChange={(e) => {
                  setPrep({ ...prep, reasonType: e.target.value as EosReason });
                  setPreview(null);
                }}
              >
                {(Object.keys(EOS_REASONS) as EosReason[]).map((k) => (
                  <option key={k} value={k}>
                    {EOS_REASONS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              أيام مستبعدة من الخدمة
              <input
                inputMode="numeric"
                value={prep.excludedDays}
                onChange={(e) => {
                  setPrep({ ...prep, excludedDays: e.target.value });
                  setPreview(null);
                }}
              />
            </label>
            {Number(prep.excludedDays) > 0 && (
              <label className="form-field ent-wide">
                سبب الاستبعاد ومصدره
                <input
                  required
                  value={prep.excludedReason}
                  onChange={(e) => setPrep({ ...prep, excludedReason: e.target.value })}
                  placeholder="مثال: إجازة بدون أجر تجاوزت 20 يومًا من … إلى …"
                />
              </label>
            )}
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
          <p className="quiet-empty">لا توجد تسويات.</p>
        ) : (
          <div className="ent-list">
            {settlements.map((s) => (
              <article className="ent-settlement" key={s.id}>
                <header>
                  <strong>{s.employeeName}</strong>
                  <span className={`adm-state ${STATE[s.state][1]}`}>{STATE[s.state][0]}</span>
                  <span className="ent-muted">
                    آخر يوم <bdi dir="ltr">{s.lastDay}</bdi> · {EOS_REASONS[s.reasonType]}
                  </span>
                </header>
                {s.calculation ? (
                  <CalculationView calc={s.calculation} />
                ) : (
                  <p className="ent-muted">مدة الخدمة: {s.serviceDays} يومًا</p>
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
                    {s.canAct ? (
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
                    ) : (
                      <button
                        className="button quiet danger-text"
                        disabled={busy}
                        onClick={() => act(s, 'cancel')}
                      >
                        إلغاء التسوية
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
        <FileText size={14} /> المرجع: نظام العمل م84 (نصف شهر عن كل سنة من الخمس الأولى ثم شهر عن
        كل سنة بعدها، على الأجر الأخير)، م85 (الاستقالة: الثلث بعد سنتين، والثلثان بعد خمس، وكاملة
        بعد عشر)، م87 (استحقاق كامل في حالات محددة)، م80 (لا مكافأة)، م88 (مهلة الصرف). مصادر ثانوية
        حتى تُطابق بالنص الرسمي، والأرقام تُقرأ من إصدار القاعدة المعتمد لا من الشيفرة.
      </p>
    </>
  );
}

function CalculationView({ calc }: { calc: Calculation }) {
  const a = calc.award;
  return (
    <dl className="ent-facts ent-calc-facts">
      <div>
        <dt>مدة الخدمة</dt>
        <dd>
          {a.serviceDays} يومًا ≈ {a.serviceYears} سنة
          <small>
            {calc.periods.map((p) => `${p.startDate} → ${p.endDate ?? calc.lastDay}`).join(' · ')}
            {calc.excludedDays
              ? ` − ${calc.excludedDays} يومًا مستبعدة (${calc.excludedReason})`
              : ''}
          </small>
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
        <dt>المكافأة الكاملة</dt>
        <dd>
          {money(a.fullAwardMinor)}
          <small>
            {a.firstTierDays} يومًا × {months(calc.firstTierMonthsMilli)} شهر + {a.laterDays} يومًا ×{' '}
            {months(calc.laterMonthsMilli)} شهر، ÷ {calc.yearDays}
          </small>
        </dd>
      </div>
      <div>
        <dt>المعاملة</dt>
        <dd>
          {EOS_TREATMENTS[calc.treatment]}
          {calc.treatment === 'resignation' && (
            <small>
              النسبة {a.share.numerator}/{a.share.denominator}
            </small>
          )}
        </dd>
      </div>
      <div className="ent-total">
        <dt>المكافأة المستحقة</dt>
        <dd>{money(a.amountMinor)}</dd>
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
