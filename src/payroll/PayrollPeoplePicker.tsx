// Choose who is in a draft payroll run: every on-duty employee with a checkbox, select all,
// and a search. Saving adds the newly ticked from their profiles and removes the unticked.
import { useEffect, useMemo, useState } from 'react';
import type { PayrollCandidate, PayrollRun } from '../../shared/administration';

type Skipped = { employeeId: string; name: string; reason: string };

export function PayrollPeoplePicker({
  run,
  request,
  onSaved,
  onClose,
}: {
  run: PayrollRun;
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  onSaved: (run: PayrollRun, message: string, skipped: Skipped[]) => void;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<PayrollCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    request<{ candidates: PayrollCandidate[] }>(`/${run.id}/candidates`)
      .then(({ candidates }) => {
        if (!active) return;
        setCandidates(candidates);
        setChosen(new Set(candidates.filter((c) => c.inRun).map((c) => c.employeeId)));
      })
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [run.id, request]);
  const shown = useMemo(
    () =>
      (candidates ?? []).filter(
        (c) => !query.trim() || `${c.name} ${c.title}`.includes(query.trim()),
      ),
    [candidates, query],
  );
  const add = (candidates ?? []).filter((c) => !c.inRun && chosen.has(c.employeeId));
  const remove = (candidates ?? []).filter((c) => c.inRun && !chosen.has(c.employeeId));
  const allShownChosen = shown.length > 0 && shown.every((c) => chosen.has(c.employeeId));
  const toggleAll = () =>
    setChosen((current) => {
      const next = new Set(current);
      for (const c of shown) {
        if (allShownChosen) next.delete(c.employeeId);
        else next.add(c.employeeId);
      }
      return next;
    });
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await request<{
        run: PayrollRun;
        added: number;
        removed: number;
        skipped: Skipped[];
      }>(`/${run.id}/people`, 'POST', {
        version: run.version,
        add: add.map((c) => c.employeeId),
        remove: remove.map((c) => c.employeeId),
        reason: 'تعديل الموظفين في المسير من قائمة الاختيار',
      });
      const parts = [
        result.added ? `أضيف ${result.added}` : '',
        result.removed ? `أزيل ${result.removed}` : '',
        result.skipped.length ? `لم يُضف ${result.skipped.length} لنقص في ملفاتهم` : '',
      ].filter(Boolean);
      onSaved(result.run, parts.join('، ') || 'لم يتغير أحد.', result.skipped);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="payroll-people" aria-label="الموظفون في المسير">
      <header>
        <h3>الموظفون في المسير</h3>
        <p>
          ضع علامة على من يدخل مسير {run.period}. تُؤخذ رواتب المضافين من ملفاتهم الوظيفية، ويُعاد
          حساب التأمينات تلقائيًا. إزالة موظف تحذف كل أسطره من هذه المسودة.
        </p>
      </header>
      {error && (
        <div className="payroll-error" role="alert">
          {error}
        </div>
      )}
      {candidates === null ? (
        <p>جارٍ تحميل الموظفين على رأس العمل…</p>
      ) : (
        <>
          <div className="payroll-people-tools">
            <input
              type="search"
              placeholder="ابحث بالاسم أو المسمى"
              aria-label="بحث في الموظفين"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="payroll-people-all">
              <input type="checkbox" checked={allShownChosen} onChange={toggleAll} />
              تحديد الكل ({shown.length})
            </label>
            <span>
              المختارون: <b>{chosen.size}</b> من {candidates.length}
            </span>
          </div>
          <ul className="payroll-people-list">
            {shown.map((c) => (
              <li key={c.employeeId}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(c.employeeId)}
                    onChange={() =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (next.has(c.employeeId)) next.delete(c.employeeId);
                        else next.add(c.employeeId);
                        return next;
                      })
                    }
                  />
                  <span>
                    <strong>{c.name}</strong>
                    {c.title && <small>{c.title}</small>}
                  </span>
                  {c.inRun && !chosen.has(c.employeeId) && (
                    <em className="payroll-people-tag remove">سيُزال</em>
                  )}
                  {!c.inRun && chosen.has(c.employeeId) && (
                    <em className="payroll-people-tag add">سيُضاف</em>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <footer className="payroll-actions">
            <button
              className="payroll-button"
              onClick={() => void save()}
              disabled={busy || (!add.length && !remove.length)}
            >
              {busy ? 'جارٍ الحفظ…' : `حفظ (إضافة ${add.length} · إزالة ${remove.length})`}
            </button>
            <button className="payroll-button secondary" onClick={onClose} disabled={busy}>
              إغلاق
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
