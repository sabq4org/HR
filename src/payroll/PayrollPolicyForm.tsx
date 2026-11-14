// HR drafts a payroll rule version with its GOSI section. The version is a draft until an
// independent approver approves it on the policies page; payroll runs only use approved
// versions. The form holds no default rate: every number is typed from the cited source.
import { useState, type FormEvent } from 'react';
import { GOSI_CATEGORIES, GOSI_CATEGORY_LABEL, type GosiCategory } from '../../shared/gosi';

const toBps = (value: string): number | null => {
  const match = value.trim().match(/^(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
};
const toMinor = (value: string): number | null => {
  const match = value.trim().match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
};

export function PayrollPolicyForm({ onCreated }: { onCreated: (message: string) => void }) {
  const [form, setForm] = useState({
    name: 'قواعد الرواتب والتأمينات الاجتماعية',
    effectiveFrom: '',
    effectiveTo: '',
    source: '',
    includeHousing: true,
    maxWage: '',
    minWage: '',
  });
  const [rates, setRates] = useState<Record<GosiCategory, { employee: string; employer: string }>>({
    saudi_existing: { employee: '', employer: '' },
    saudi_new: { employee: '', employer: '' },
    non_saudi: { employee: '', employer: '' },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const categories = Object.fromEntries(
      GOSI_CATEGORIES.map((key) => [
        key,
        { employeeBps: toBps(rates[key].employee), employerBps: toBps(rates[key].employer) },
      ]),
    );
    const maxWageMinor = toMinor(form.maxWage);
    const minWageMinor = form.minWage.trim() ? toMinor(form.minWage) : 0;
    if (
      Object.values(categories).some((c) => c.employeeBps === null || c.employerBps === null) ||
      !maxWageMinor ||
      minWageMinor === null
    ) {
      setError('أدخل كل النسب بصيغة مثل 9.75، والحد الأعلى للأجر الخاضع بالريال.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/admin/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          key: 'payroll',
          name: form.name,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || undefined,
          source: form.source,
          values: {
            currency: 'SAR',
            calculation: 'profile-components',
            gosi: {
              wageComponents: form.includeHousing
                ? ['basicSalary', 'housingAllowance']
                : ['basicSalary'],
              maxWageMinor,
              minWageMinor,
              categories,
            },
          },
        }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value?.error?.message || 'تعذر حفظ المسودة.');
      onCreated('حُفظت مسودة إصدار القواعد؛ تُعتمد من صفحة السياسات بواسطة المعتمد المستقل.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="payroll-policy-form">
      <summary>إعداد إصدار جديد لقواعد الرواتب والتأمينات</summary>
      <form onSubmit={(e) => void submit(e)}>
        <p>
          تُدخل النسب كما في المصدر الرسمي للمؤسسة العامة للتأمينات الاجتماعية بتاريخ السريان، ولا
          يضع النظام نسبة افتراضية. يُطبق الإصدار بعد اعتماده على كل موظفي الفئة بالطريقة نفسها،
          ويُراجعه مختص قبل أول مسير حقيقي.
        </p>
        <div className="policy-grid">
          <label>
            اسم الإصدار
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label>
            يسري من
            <input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              required
            />
          </label>
          <label>
            حتى (اختياري)
            <input
              type="date"
              value={form.effectiveTo}
              onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })}
            />
          </label>
          <label className="wide">
            المصدر الرسمي وتاريخ الاطلاع
            <input
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              placeholder="رابط صفحة التأمينات الاجتماعية أو رقم القرار وتاريخه"
              required
            />
          </label>
          <label>
            الحد الأعلى للأجر الخاضع (ريال)
            <input
              inputMode="decimal"
              value={form.maxWage}
              onChange={(e) => setForm({ ...form, maxWage: e.target.value })}
              required
            />
          </label>
          <label>
            الحد الأدنى للأجر الخاضع (ريال، اختياري)
            <input
              inputMode="decimal"
              value={form.minWage}
              onChange={(e) => setForm({ ...form, minWage: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.includeHousing}
              onChange={(e) => setForm({ ...form, includeHousing: e.target.checked })}
            />
            الأجر الخاضع = الأساسي + بدل السكن
          </label>
        </div>
        <table className="policy-rates">
          <thead>
            <tr>
              <th>الفئة</th>
              <th>حصة الموظف %</th>
              <th>حصة صاحب العمل %</th>
            </tr>
          </thead>
          <tbody>
            {GOSI_CATEGORIES.map((key) => (
              <tr key={key}>
                <td>{GOSI_CATEGORY_LABEL[key]}</td>
                {(['employee', 'employer'] as const).map((side) => (
                  <td key={side}>
                    <input
                      aria-label={`${GOSI_CATEGORY_LABEL[key]} ${side === 'employee' ? 'حصة الموظف' : 'حصة صاحب العمل'}`}
                      inputMode="decimal"
                      value={rates[key][side]}
                      onChange={(e) =>
                        setRates({ ...rates, [key]: { ...rates[key], [side]: e.target.value } })
                      }
                      required
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {error && (
          <p className="payroll-error" role="alert">
            {error}
          </p>
        )}
        <button className="payroll-button" disabled={busy}>
          حفظ كمسودة للاعتماد
        </button>
      </form>
    </details>
  );
}
