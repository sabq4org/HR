import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, FileText, Plus, ShieldCheck } from 'lucide-react';
import type { LeavePolicy } from '../../shared/contracts';
import { api, Empty, PageHeading, useApp } from '../lib';
import './leave.css';

const weekdays = [
  ['الأحد', 0],
  ['الاثنين', 1],
  ['الثلاثاء', 2],
  ['الأربعاء', 3],
  ['الخميس', 4],
  ['الجمعة', 5],
  ['السبت', 6],
] as const;

export function LeavePoliciesPage() {
  const { data, notify } = useApp();
  const [policies, setPolicies] = useState<LeavePolicy[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [days, setDays] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>([]);
  const [holidays, setHolidays] = useState('');
  const [source, setSource] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [approvalRefs, setApprovalRefs] = useState<Record<string, string>>({});
  const [assignmentReasons, setAssignmentReasons] = useState<Record<string, string>>({});
  const [assignment, setAssignment] = useState({
    policyId: '',
    employeeId: '',
    effectiveFrom: '',
    effectiveTo: '',
    openingBalance: '',
    approvalReference: '',
  });
  const draftKey = useRef(crypto.randomUUID());
  const load = async () => {
    try {
      const [result, assigned] = await Promise.all([
        api<{ policies: LeavePolicy[] }>('/leave-policies'),
        api<{ assignments: any[] }>('/leave-policy-assignments'),
      ]);
      setPolicies(result.policies);
      setAssignments(assigned.assignments);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (!['hr', 'approver', 'auditor'].includes(data.me.role))
    return (
      <Empty
        title="إدارة السياسات"
        detail="تحتاج هذه الصفحة صلاحية موارد بشرية أو اعتماد أو تدقيق."
      />
    );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/leave-policies', {
        method: 'POST',
        headers: { 'Idempotency-Key': draftKey.current },
        body: JSON.stringify({
          version,
          effectiveFrom: from,
          effectiveTo: to || null,
          allocatedDays: Number(days),
          workingDays,
          holidayDates: holidays
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          source,
          sourceReference,
        }),
      });
      draftKey.current = crypto.randomUUID();
      notify('حُفظت نسخة السياسة كمسودة. يلزم اعتماد صاحب صلاحية مستقل قبل الإسناد.');
      setVersion('');
      setFrom('');
      setTo('');
      setDays('');
      setWorkingDays([]);
      setHolidays('');
      setSource('');
      setSourceReference('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const approve = async (policy: LeavePolicy) => {
    setBusy(true);
    setError('');
    try {
      await api(`/leave-policies/${policy.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvalReference: approvalRefs[policy.id] ?? '' }),
      });
      notify('اعتُمدت نسخة السياسة.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decideAssignment = async (id: string, decision: 'reject' | 'cancel') => {
    setBusy(true);
    setError('');
    try {
      await api(`/leave-policy-assignments/${id}/decision`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ decision, reason: assignmentReasons[id] ?? '' }),
      });
      notify(
        decision === 'reject'
          ? 'رُفض الإسناد ولم يتغير الرصيد.'
          : 'سُحب الإسناد المعلّق ولم يتغير الرصيد.',
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const assign = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/leave-policies/${assignment.policyId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          employeeId: assignment.employeeId,
          effectiveFrom: assignment.effectiveFrom,
          effectiveTo: assignment.effectiveTo || null,
          openingBalance: Number(assignment.openingBalance),
          approvalReference: assignment.approvalReference,
        }),
      });
      notify('أُرسل الإسناد لاعتماد مستقل؛ لا يتغير الرصيد قبل الموافقة.');
      setAssignment({
        policyId: '',
        employeeId: '',
        effectiveFrom: '',
        effectiveTo: '',
        openingBalance: '',
        approvalReference: '',
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading
        title="سياسات الإجازة السنوية"
        subtitle="إصدارات موثقة وموافقات مستقلة، مع سجل رصيد لا يُستبدل."
      />
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {data.me.role === 'hr' && (
        <section className="panel policy-panel">
          <h2>
            <FileText size={20} /> إنشاء مسودة سياسة سنوية
          </h2>
          <p className="field-hint">
            أدخل القيم المعتمدة من مصدر داخلي موثق. لا تُنشأ سياسة فعالة تلقائيًا ولا تُمنح أرصدة حتى
            الإسناد الصريح.
          </p>
          <form className="policy-form" onSubmit={submit}>
            <label className="form-field">
              رقم الإصدار
              <input
                required
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="مثال: 2026-1"
              />
            </label>
            <label className="form-field">
              سريان من
              <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="form-field">
              سريان إلى <span className="optional">اختياري</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="form-field">
              أيام الرصيد المعتمدة
              <input
                type="number"
                min="0"
                max="366"
                required
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </label>
            <fieldset className="policy-days">
              <legend>أيام العمل</legend>
              {weekdays.map(([label, value]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={workingDays.includes(value)}
                    onChange={(e) =>
                      setWorkingDays(
                        e.target.checked
                          ? [...workingDays, value]
                          : workingDays.filter((d) => d !== value),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <label className="form-field">
              تواريخ العطل الرسمية <span className="optional">افصل بفاصلة YYYY-MM-DD</span>
              <input
                value={holidays}
                onChange={(e) => setHolidays(e.target.value)}
                placeholder="2026-09-23, 2026-12-..."
              />
            </label>
            <label className="form-field">
              مصدر القاعدة
              <input
                required
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="اسم الوثيقة أو قرار المنشأة"
              />
            </label>
            <label className="form-field">
              مرجع المصدر
              <input
                required
                value={sourceReference}
                onChange={(e) => setSourceReference(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy || !workingDays.length}>
              <Plus size={17} />
              حفظ كمسودة
            </button>
          </form>
        </section>
      )}
      <section className="panel policy-panel">
        <h2>
          <ShieldCheck size={20} /> إصدارات السياسة
        </h2>
        {!policies.length ? (
          <p className="quiet-empty">لا توجد نسخ سياسة بعد.</p>
        ) : (
          policies.map((policy) => (
            <article className="policy-row" key={policy.id}>
              <div>
                <strong>
                  {policy.version} ·{' '}
                  {policy.approvalStatus === 'approved'
                    ? 'معتمدة'
                    : policy.approvalStatus === 'draft'
                      ? 'مسودة'
                      : 'تجريبية'}
                </strong>
                <p>
                  {policy.source} · {policy.sourceReference || 'لا يوجد مرجع مصدر'}
                </p>
                <small>
                  من {policy.effectiveFrom}
                  {policy.effectiveTo ? ` إلى ${policy.effectiveTo}` : ''} · {policy.allocatedDays}{' '}
                  يوم · أيام العمل: {policy.workingDays.join('، ')} · العطل:{' '}
                  {policy.holidayDates.join('، ') || 'لا توجد'}
                </small>
              </div>
              {policy.approvalStatus === 'draft' && data.me.role === 'approver' && (
                <div className="policy-approve">
                  <input
                    aria-label={`مرجع اعتماد ${policy.version}`}
                    placeholder="مرجع الاعتماد الداخلي"
                    value={approvalRefs[policy.id] ?? ''}
                    onChange={(e) =>
                      setApprovalRefs({ ...approvalRefs, [policy.id]: e.target.value })
                    }
                  />
                  <button
                    className="button primary"
                    disabled={busy || !approvalRefs[policy.id]?.trim()}
                    onClick={() => approve(policy)}
                  >
                    <Check size={16} />
                    اعتماد
                  </button>
                </div>
              )}
            </article>
          ))
        )}
      </section>
      {data.me.role === 'approver' && (
        <section className="panel policy-panel">
          <h2>
            <ShieldCheck size={20} /> إسنادات بانتظار اعتماد مستقل
          </h2>
          {assignments.filter((a) => a.approval_status === 'pending').length === 0 ? (
            <p className="quiet-empty">لا توجد إسنادات معلّقة.</p>
          ) : (
            assignments
              .filter((a) => a.approval_status === 'pending')
              .map((assignmentRow) => (
                <article className="policy-row" key={assignmentRow.id}>
                  <div>
                    <strong>
                      {assignmentRow.employee_name} · سياسة {assignmentRow.policy_version}
                    </strong>
                    <p>
                      رصيد افتتاحي {assignmentRow.opening_balance} يوم · من{' '}
                      {assignmentRow.effective_from}
                      {assignmentRow.effective_to ? ` إلى ${assignmentRow.effective_to}` : ''}
                    </p>
                    <small>مرجع الإسناد: {assignmentRow.approval_reference}</small>
                  </div>
                  <div className="policy-approve">
                    <input
                      aria-label={`مرجع اعتماد رصيد ${assignmentRow.employee_name}`}
                      placeholder="مرجع اعتماد الرصيد"
                      value={approvalRefs[assignmentRow.id] ?? ''}
                      onChange={(e) =>
                        setApprovalRefs({ ...approvalRefs, [assignmentRow.id]: e.target.value })
                      }
                    />
                    <button
                      className="button primary"
                      disabled={busy || !approvalRefs[assignmentRow.id]?.trim()}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          await api(`/leave-policy-assignments/${assignmentRow.id}/approve`, {
                            method: 'POST',
                            headers: { 'Idempotency-Key': crypto.randomUUID() },
                            body: JSON.stringify({
                              approvalReference: approvalRefs[assignmentRow.id],
                            }),
                          });
                          notify('اعتُمد الإسناد وأُضيف الرصيد الافتتاحي مرة واحدة.');
                          await load();
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Check size={16} />
                      اعتماد الإسناد
                    </button>
                  </div>
                  <div className="policy-approve">
                    <input
                      aria-label={`سبب رفض إسناد ${assignmentRow.employee_name}`}
                      placeholder="سبب الرفض"
                      value={assignmentReasons[assignmentRow.id] ?? ''}
                      onChange={(e) =>
                        setAssignmentReasons({
                          ...assignmentReasons,
                          [assignmentRow.id]: e.target.value,
                        })
                      }
                    />
                    <button
                      className="button quiet danger-text"
                      disabled={busy || !assignmentReasons[assignmentRow.id]?.trim()}
                      onClick={() => decideAssignment(assignmentRow.id, 'reject')}
                    >
                      رفض الإسناد
                    </button>
                  </div>
                </article>
              ))
          )}
        </section>
      )}
      {data.me.role === 'hr' &&
        assignments.some(
          (a) => a.approval_status === 'pending' && a.assigned_by === data.me.id,
        ) && (
          <section className="panel policy-panel">
            <h2>إسناداتي بانتظار الاعتماد</h2>
            {assignments
              .filter((a) => a.approval_status === 'pending' && a.assigned_by === data.me.id)
              .map((a) => (
                <article className="policy-row" key={a.id}>
                  <div>
                    <strong>
                      {a.employee_name} · سياسة {a.policy_version}
                    </strong>
                    <p>رصيد افتتاحي {a.opening_balance} يوم · بانتظار اعتماد مستقل</p>
                  </div>
                  <div className="policy-approve">
                    <input
                      aria-label={`سبب سحب إسناد ${a.employee_name}`}
                      placeholder="سبب السحب"
                      value={assignmentReasons[a.id] ?? ''}
                      onChange={(e) =>
                        setAssignmentReasons({ ...assignmentReasons, [a.id]: e.target.value })
                      }
                    />
                    <button
                      className="button quiet danger-text"
                      disabled={busy || !assignmentReasons[a.id]?.trim()}
                      onClick={() => decideAssignment(a.id, 'cancel')}
                    >
                      سحب الإسناد
                    </button>
                  </div>
                </article>
              ))}
          </section>
        )}
      {data.me.role === 'hr' && (
        <section className="panel policy-panel">
          <h2>إسناد سياسة ورصيد افتتاحي</h2>
          <p className="field-hint">
            الإسناد يضيف حركة تخصيص جديدة بمفتاح فريد. تغيير السياسة لاحقًا لا يحذف أو يستبدل الحركة
            السابقة.
          </p>
          {!policies.some((p) => p.approvalStatus === 'approved') ? (
            <p className="quiet-empty">اعتمد نسخة سياسة أولًا.</p>
          ) : (
            <form className="policy-form" onSubmit={assign}>
              <label className="form-field">
                السياسة المعتمدة
                <select
                  required
                  value={assignment.policyId}
                  onChange={(e) => setAssignment({ ...assignment, policyId: e.target.value })}
                >
                  <option value="">اختر نسخة</option>
                  {policies
                    .filter((p) => p.approvalStatus === 'approved')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.version}
                      </option>
                    ))}
                </select>
              </label>
              <label className="form-field">
                الموظف
                <select
                  required
                  value={assignment.employeeId}
                  onChange={(e) => setAssignment({ ...assignment, employeeId: e.target.value })}
                >
                  <option value="">اختر موظفًا</option>
                  {data.employees
                    .filter((e) => e.status === 'active')
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} · {e.employeeNumber}
                      </option>
                    ))}
                </select>
              </label>
              <label className="form-field">
                تبدأ في
                <input
                  type="date"
                  required
                  value={assignment.effectiveFrom}
                  onChange={(e) => setAssignment({ ...assignment, effectiveFrom: e.target.value })}
                />
              </label>
              <label className="form-field">
                تنتهي في <span className="optional">اختياري</span>
                <input
                  type="date"
                  value={assignment.effectiveTo}
                  onChange={(e) => setAssignment({ ...assignment, effectiveTo: e.target.value })}
                />
              </label>
              <label className="form-field">
                الرصيد الافتتاحي المعتمد
                <input
                  type="number"
                  min="0"
                  max="366"
                  required
                  value={assignment.openingBalance}
                  onChange={(e) => setAssignment({ ...assignment, openingBalance: e.target.value })}
                />
              </label>
              <label className="form-field">
                مرجع اعتماد الرصيد
                <input
                  required
                  value={assignment.approvalReference}
                  onChange={(e) =>
                    setAssignment({ ...assignment, approvalReference: e.target.value })
                  }
                />
              </label>
              <button className="button primary" disabled={busy}>
                <Check size={16} />
                إسناد السياسة وتسجيل الرصيد
              </button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
