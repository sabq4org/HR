import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  CircleHelp,
  Clock3,
  Info,
  LoaderCircle,
  Plus,
  Search,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { LeaveChangeKind, LeaveRequest } from '../shared/contracts';
import { annualLeaveDays } from '../shared/leave';
import {
  addDays,
  api,
  Avatar,
  canDecide,
  dateLabel,
  Empty,
  isPending,
  Modal,
  Status,
  useApp,
} from './lib';

export function NewLeaveDialog({
  close,
  switchPersona,
}: {
  close: () => void;
  switchPersona: () => void;
}) {
  const { data, refresh, notify } = useApp();
  const [start, setStart] = useState(addDays(data.today, 3));
  const [end, setEnd] = useState(addDays(data.today, 5));
  const [note, setNote] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef({ signature: '', key: crypto.randomUUID() });
  const days = annualLeaveDays(start, end, data.policy.workingDays, data.policy.holidayDates ?? []);
  const enough = days <= data.balance.available;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!days || !enough || start < data.today) {
      setError(
        !days
          ? 'اختر فترة تحتوي يوم عمل واحدًا على الأقل.'
          : !enough
            ? 'الرصيد المتاح لا يكفي لهذه الفترة.'
            : 'اختر تاريخ بداية من اليوم أو بعده.',
      );
      return;
    }
    if (!review) {
      setReview(true);
      return;
    }
    setBusy(true);
    const payload = { startDate: start, endDate: end, note };
    const signature = JSON.stringify(payload);
    if (key.current.signature !== signature) key.current = { signature, key: crypto.randomUUID() };
    try {
      await api('/leaves', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current.key },
        body: signature,
      });
      await refresh();
      notify('أُرسل طلبك إلى المدير، وحُجز الرصيد مرة واحدة.');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hasRoute =
    !!data.me.managerId &&
    data.personas.some((p) => p.id === data.me.managerId && p.role === 'manager') &&
    data.personas.some((p) => p.role === 'hr' && p.id !== data.me.id);
  if (!hasRoute)
    return (
      <Modal title="إكمال مسار الموافقة أولًا" close={close}>
        <div className="dialog-body">
          <div className="route-warning">
            لا يتوفر لهذا الحساب مسار موافقة كامل دون اعتماد ذاتي. يلزم تحديد معتمد بديل قبل إتاحة
            طلباته.
            <br />
            لتجربة الرحلة كاملة الآن، استخدم حساب سارة القحطاني ثم راجع الطلب بحساب المدير والموارد
            البشرية.
          </div>
          <button className="button primary" onClick={switchPersona}>
            اختيار حساب التجربة
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={review ? 'راجع طلبك قبل الإرسال' : 'مساحة لاستراحة جديدة'}
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          <div className="form-stepper">
            <span className={!review ? 'current' : 'complete'}>
              <i>{review ? <Check size={12} /> : 1}</i>تفاصيل الإجازة
            </span>
            <span className="step-line" />
            <span className={review ? 'current' : ''}>
              <i>2</i>المراجعة والإرسال
            </span>
          </div>
          {!review ? (
            <>
              <div className="leave-type">
                <span className="icon-tile">
                  <CalendarDays size={21} />
                </span>
                <div>
                  <strong>إجازة سنوية</strong>
                  <small>لديك {data.balance.available} يومًا متاحًا في التجربة</small>
                </div>
                <Check size={18} />
              </div>
              <div className="form-grid">
                <label className="form-field">
                  من تاريخ
                  <input
                    type="date"
                    value={start}
                    min={data.today}
                    required
                    onChange={(e) => {
                      setStart(e.target.value);
                      if (e.target.value > end) setEnd(e.target.value);
                    }}
                  />
                </label>
                <label className="form-field">
                  إلى تاريخ
                  <input
                    type="date"
                    value={end}
                    min={start || data.today}
                    required
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </label>
              </div>
              <div className={`calculation ${!enough ? 'calculation-error' : ''}`}>
                <span>
                  <Clock3 size={18} />
                  {days} أيام عمل
                </span>
                <span>
                  الرصيد بعد الحجز: <b>{data.balance.available - days}</b> يومًا
                </span>
              </div>
              <p className="field-hint">
                يُحتسب وفق جدول ونسخة سياسة الإجازة المعروضة، مع استبعاد أيام العطل المسجلة. يعتمد
                الخادم الاحتساب النهائي.
              </p>
              <label className="form-field">
                ملاحظة للطلب <span className="optional">اختياري</span>
                <textarea
                  rows={3}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="أي تفاصيل تساعد فريقك على ترتيب التغطية…"
                />
              </label>
              <p className="field-hint">
                اكتفِ بتفاصيل التغطية، ولا تضف معلومات صحية أو شخصية حساسة.
              </p>
            </>
          ) : (
            <>
              <div className="review-leave">
                <span className="review-icon">
                  <CalendarDays size={28} />
                </span>
                <h3>إجازة سنوية</h3>
                <p>
                  {dateLabel(start)} — {dateLabel(end)}
                </p>
                <strong>
                  {days}
                  <small>أيام عمل</small>
                </strong>
              </div>
              <dl className="review-details">
                <div>
                  <dt>صاحب الطلب</dt>
                  <dd>{data.me.name}</dd>
                </div>
                <div>
                  <dt>الرصيد المتاح بعد الحجز</dt>
                  <dd>{data.balance.available - days} يومًا</dd>
                </div>
                <div>
                  <dt>المسار التالي</dt>
                  <dd>المدير المباشر، ثم الموارد البشرية</dd>
                </div>
                {note && (
                  <div>
                    <dt>ملاحظتك</dt>
                    <dd>{note}</dd>
                  </div>
                )}
              </dl>
            </>
          )}
          <div className="policy-note">
            <Info size={17} />
            <span>هذه تجربة ببيانات وهمية وسياسة اختبار؛ لا تمثّل استحقاقًا معتمدًا.</span>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          <button
            type="button"
            className="button quiet"
            disabled={busy}
            onClick={() => (review ? setReview(false) : close())}
          >
            {review ? 'تعديل التفاصيل' : 'إلغاء'}
          </button>
          <button className="button primary" type="submit" disabled={busy || !days || !enough}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : review ? (
              <Send size={17} />
            ) : null}
            {busy ? 'جارٍ الإرسال…' : review ? 'إرسال الطلب' : 'مراجعة الطلب'}
            {!busy && !review && <ArrowLeft size={17} />}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function LeaveDetailDialog({ leave, close }: { leave: LeaveRequest; close: () => void }) {
  const { data, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [changeKind, setChangeKind] = useState<LeaveChangeKind>('extend');
  const [changeStart, setChangeStart] = useState(leave.startDate);
  const [changeEnd, setChangeEnd] = useState(leave.endDate);
  const [changing, setChanging] = useState(false);
  const [rejectingChange, setRejectingChange] = useState('');
  const keys = useRef<Record<string, string>>({});
  const mayDecide = canDecide(data.me, leave, data.employees);
  const mayCancel = leave.employeeId === data.me.id && isPending(leave);
  const mayRequestChange =
    leave.employeeId === data.me.id && leave.status === 'approved' && leave.current !== false;
  const mayDecideChange = (change: NonNullable<LeaveRequest['changeHistory']>[number]) =>
    change.status === 'pending_manager'
      ? data.me.role === 'manager' &&
        data.employees.some((e) => e.id === change.employeeId && e.managerId === data.me.id)
      : change.status === 'pending_hr' && data.me.role === 'hr' && data.me.id !== change.employeeId;
  const mutateChange = async (
    changeId: string,
    decision: 'approve' | 'reject',
    version: number,
    decisionReason = '',
  ) => {
    setError('');
    setBusy(true);
    const payload = { decision, version, reason: decision === 'reject' ? decisionReason : '' };
    const signature = `change:${changeId}:${JSON.stringify(payload)}`;
    keys.current[signature] ??= crypto.randomUUID();
    try {
      await api(`/leave-changes/${changeId}/decision`, {
        method: 'POST',
        headers: { 'Idempotency-Key': keys.current[signature] },
        body: JSON.stringify(payload),
      });
      await refresh();
      notify(
        decision === 'approve' ? 'حُفظ قرار مراجعة التغيير.' : 'رُفض التغيير وأُعيد الحجز الإضافي.',
      );
      close();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const cancelChange = async (changeId: string, version: number) => {
    setError('');
    setBusy(true);
    const payload = { version };
    const signature = `cancel-change:${changeId}:${version}`;
    keys.current[signature] ??= crypto.randomUUID();
    try {
      await api(`/leave-changes/${changeId}/cancel`, {
        method: 'POST',
        headers: { 'Idempotency-Key': keys.current[signature] },
        body: JSON.stringify(payload),
      });
      await refresh();
      notify('سُحب طلب التغيير وأُعيد الحجز الإضافي.');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submitChange = async () => {
    setError('');
    setBusy(true);
    const payload = {
      kind: changeKind,
      version: leave.version,
      startDate: changeKind === 'amend' ? changeStart : leave.startDate,
      endDate: changeKind === 'cancel' ? leave.endDate : changeEnd,
      reason: reason.trim(),
    };
    const signature = `request-change:${JSON.stringify(payload)}`;
    keys.current[signature] ??= crypto.randomUUID();
    try {
      await api(`/leaves/${leave.id}/changes`, {
        method: 'POST',
        headers: { 'Idempotency-Key': keys.current[signature] },
        body: JSON.stringify(payload),
      });
      await refresh();
      notify('أُرسل طلب التغيير إلى المدير، وتبقى الإجازة الأصلية كما اعتُمدت.');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (action: 'approve' | 'reject' | 'cancel') => {
    setError('');
    setBusy(true);
    const payload =
      action === 'cancel'
        ? { version: leave.version }
        : { decision: action, version: leave.version, ...(reason ? { reason } : {}) };
    const signature = `${action}:${JSON.stringify(payload)}`;
    keys.current[signature] ??= crypto.randomUUID();
    try {
      await api(`/leaves/${leave.id}/${action === 'cancel' ? 'cancel' : 'decision'}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': keys.current[signature] },
        body: JSON.stringify(payload),
      });
      await refresh();
      notify(
        action === 'approve'
          ? 'حُفظ قرار الموافقة.'
          : action === 'reject'
            ? 'رُفض الطلب وأُعيد الرصيد المحجوز.'
            : 'سُحب الطلب وأُعيد الرصيد المحجوز.',
      );
      close();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const next =
    leave.status === 'pending_manager'
      ? 'الطلب لدى المدير المباشر لمراجعة التغطية.'
      : leave.status === 'pending_hr'
        ? 'وافق المدير. الطلب لدى الموارد البشرية للتحقق النهائي.'
        : leave.status === 'approved'
          ? 'اكتملت الموافقات، وسُجّلت الإجازة في التقويم.'
          : leave.status === 'rejected'
            ? 'رُفض الطلب وأُعيد رصيده المحجوز.'
            : 'سُحب الطلب وأُعيد رصيده المحجوز.';
  return (
    <Modal
      title="تفاصيل طلب الإجازة"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="dialog-body">
        <div className="request-person">
          <Avatar person={leave} size="lg" />
          <div>
            <h3>{leave.employeeName}</h3>
            <p>{leave.employeeTitle}</p>
          </div>
          <Status value={leave.status} />
        </div>
        <div className="request-dates">
          <div>
            <small>من</small>
            <strong>
              {dateLabel(leave.startDate, { day: 'numeric', month: 'long', year: 'numeric' })}
            </strong>
          </div>
          <ArrowLeft size={18} />
          <div>
            <small>إلى</small>
            <strong>
              {dateLabel(leave.endDate, { day: 'numeric', month: 'long', year: 'numeric' })}
            </strong>
          </div>
          <span>{leave.days} أيام</span>
        </div>
        <div className="approval-track">
          <div className="done">
            <span>
              <Check size={14} />
            </span>
            <div>
              <strong>تقديم الطلب</strong>
              <small>
                {dateLabel(leave.createdAt, {
                  day: 'numeric',
                  month: 'long',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </small>
            </div>
          </div>
          <div
            className={
              leave.status === 'rejected' && !leave.hrDecisionAt
                ? 'rejected'
                : leave.managerDecisionAt
                  ? 'done'
                  : leave.status === 'pending_manager'
                    ? 'current'
                    : ''
            }
          >
            <span>
              {leave.status === 'rejected' && !leave.hrDecisionAt ? (
                <X size={14} />
              ) : leave.managerDecisionAt ? (
                <Check size={14} />
              ) : (
                2
              )}
            </span>
            <div>
              <strong>
                {leave.status === 'rejected' && !leave.hrDecisionAt
                  ? 'رفض المدير الطلب'
                  : 'مراجعة المدير'}
              </strong>
              <small>
                {leave.managerDecisionAt
                  ? dateLabel(leave.managerDecisionAt)
                  : leave.status === 'pending_manager'
                    ? 'الخطوة الحالية'
                    : 'بانتظار الوصول'}
              </small>
            </div>
          </div>
          <div
            className={
              leave.status === 'rejected' && leave.hrDecisionAt
                ? 'rejected'
                : leave.hrDecisionAt
                  ? 'done'
                  : leave.status === 'pending_hr'
                    ? 'current'
                    : ''
            }
          >
            <span>
              {leave.status === 'rejected' && leave.hrDecisionAt ? (
                <X size={14} />
              ) : leave.hrDecisionAt ? (
                <Check size={14} />
              ) : (
                3
              )}
            </span>
            <div>
              <strong>
                {leave.status === 'rejected' && leave.hrDecisionAt
                  ? 'رفضت الموارد البشرية الطلب'
                  : 'مراجعة الموارد البشرية'}
              </strong>
              <small>
                {leave.hrDecisionAt
                  ? dateLabel(leave.hrDecisionAt)
                  : leave.status === 'pending_hr'
                    ? 'الخطوة الحالية'
                    : leave.status === 'rejected' || leave.status === 'cancelled'
                      ? 'توقف المسار'
                      : 'بانتظار الوصول'}
              </small>
            </div>
          </div>
        </div>
        <p className="next-step">
          <Info size={17} />
          {next}
        </p>
        {leave.note && (
          <div className="request-note">
            <h4>ملاحظة الطلب</h4>
            <p>{leave.note}</p>
          </div>
        )}
        {leave.decisionReason && (
          <div className="request-note">
            <h4>سبب القرار</h4>
            <p>{leave.decisionReason}</p>
          </div>
        )}
        {leave.changeHistory?.length ? (
          <section className="leave-change-history" aria-label="سجل تغييرات الإجازة">
            <h4>سجل التغييرات المرتبطة</h4>
            {leave.changeHistory.map((change) => (
              <article key={change.id} className="leave-change-item">
                <strong>
                  {change.kind === 'cancel'
                    ? 'إلغاء'
                    : change.kind === 'extend'
                      ? 'تمديد'
                      : change.kind === 'early_return'
                        ? 'عودة مبكرة'
                        : 'تعديل'}{' '}
                  ·{' '}
                  {change.status === 'pending_manager'
                    ? 'بانتظار المدير'
                    : change.status === 'pending_hr'
                      ? 'بانتظار HR'
                      : change.status === 'approved'
                        ? 'معتمد'
                        : change.status === 'rejected'
                          ? 'مرفوض'
                          : 'مسحوب'}
                </strong>
                <small>
                  الأصل: {dateLabel(change.original.startDate)} —{' '}
                  {dateLabel(change.original.endDate)} ({change.original.days} أيام)
                </small>
                <small>
                  المقترح: {dateLabel(change.proposed.startDate)} —{' '}
                  {dateLabel(change.proposed.endDate)} ({change.proposed.days} أيام)
                </small>
                <p>{change.reason}</p>
                {change.managerDecisionAt && (
                  <small>
                    مراجعة المدير:{' '}
                    {dateLabel(change.managerDecisionAt, {
                      day: 'numeric',
                      month: 'long',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                )}
                {change.hrDecisionAt && (
                  <small>
                    قرار HR:{' '}
                    {dateLabel(change.hrDecisionAt, {
                      day: 'numeric',
                      month: 'long',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                )}
                {change.decisionReason && <small>سبب القرار: {change.decisionReason}</small>}
                {data.me.id === change.employeeId &&
                  ['pending_manager', 'pending_hr'].includes(change.status) && (
                    <button
                      className="button quiet danger-text"
                      disabled={busy}
                      onClick={() => cancelChange(change.id, change.version)}
                    >
                      سحب طلب التغيير
                    </button>
                  )}
                {mayDecideChange(change) && (
                  <div className="footer-actions">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => mutateChange(change.id, 'approve', change.version)}
                    >
                      موافقة
                    </button>
                    <button
                      className="button quiet danger-text"
                      disabled={busy}
                      onClick={() => setRejectingChange(change.id)}
                    >
                      رفض
                    </button>
                  </div>
                )}
                {rejectingChange === change.id && (
                  <div>
                    <label className="form-field">
                      سبب رفض التغيير
                      <textarea
                        rows={2}
                        maxLength={1000}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                    <button
                      className="button danger"
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        mutateChange(change.id, 'reject', change.version, reason.trim())
                      }
                    >
                      تأكيد الرفض
                    </button>
                  </div>
                )}
              </article>
            ))}
          </section>
        ) : null}
        {mayRequestChange && !changing && (
          <button
            className="button quiet"
            onClick={() => {
              setChanging(true);
              setReason('');
            }}
          >
            طلب إلغاء أو تعديل الإجازة
          </button>
        )}
        {changing && (
          <section className="leave-change-form">
            <h4>طلب تغيير مرتبط بالإجازة المعتمدة</h4>
            <p className="field-hint">
              لن تتغير الإجازة الأصلية إلا بعد موافقة المدير ثم HR. يظل كل إصدار محفوظًا في السجل.
            </p>
            <label className="form-field">
              نوع الطلب
              <select
                value={changeKind}
                onChange={(e) => setChangeKind(e.target.value as LeaveChangeKind)}
              >
                <option value="extend">تمديد</option>
                <option value="early_return">عودة مبكرة</option>
                <option value="amend">تعديل الفترة</option>
                <option value="cancel">إلغاء</option>
              </select>
            </label>
            {changeKind === 'amend' && (
              <label className="form-field">
                تاريخ البداية المقترح
                <input
                  type="date"
                  min={data.today}
                  value={changeStart}
                  onChange={(e) => setChangeStart(e.target.value)}
                />
              </label>
            )}
            {changeKind !== 'cancel' && (
              <label className="form-field">
                تاريخ النهاية المقترح
                <input
                  type="date"
                  min={leave.startDate}
                  max={changeKind === 'early_return' ? leave.endDate : undefined}
                  value={changeEnd}
                  onChange={(e) => setChangeEnd(e.target.value)}
                />
              </label>
            )}
            <label className="form-field">
              سبب الطلب
              <textarea
                rows={2}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="footer-actions">
              <button
                className="button primary"
                disabled={busy || !reason.trim()}
                onClick={submitChange}
              >
                إرسال للمراجعة
              </button>
              <button className="button quiet" disabled={busy} onClick={() => setChanging(false)}>
                رجوع
              </button>
            </div>
          </section>
        )}
        {rejecting && (
          <label className="form-field">
            سبب الرفض
            <textarea
              autoFocus
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="اكتب سببًا واضحًا لصاحب الطلب"
            />
          </label>
        )}
        {cancelling && (
          <div className="confirmation-note">
            هل تريد سحب الطلب؟ سيُعاد {leave.days} أيام إلى رصيدك المتاح.
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className="dialog-footer">
        <button className="button quiet" disabled={busy} onClick={close}>
          إغلاق
        </button>
        <div className="footer-actions">
          {mayCancel &&
            (cancelling ? (
              <button className="button danger" disabled={busy} onClick={() => mutate('cancel')}>
                تأكيد سحب الطلب
              </button>
            ) : (
              <button
                className="button quiet danger-text"
                disabled={busy}
                onClick={() => setCancelling(true)}
              >
                سحب الطلب
              </button>
            ))}
          {mayDecide &&
            (rejecting ? (
              <>
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                >
                  تراجع
                </button>
                <button
                  className="button danger"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => mutate('reject')}
                >
                  {busy ? 'جارٍ الحفظ…' : 'تأكيد الرفض'}
                </button>
              </>
            ) : (
              <>
                <button
                  className="button quiet danger-text"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                >
                  رفض الطلب
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => mutate('approve')}
                >
                  {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}موافقة
                </button>
              </>
            ))}
        </div>
      </footer>
    </Modal>
  );
}
export function NotificationsDialog({ close }: { close: () => void }) {
  const { data, refresh, showLeave } = useApp();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mark = async () => {
    setBusy(true);
    try {
      await api('/notifications/read', { method: 'POST', body: '{}' });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="الإشعارات" close={close} className="notifications-dialog">
      <div className="dialog-body">
        <div className="notification-tools">
          <span>{data.notifications.filter((n) => !n.read).length} غير مقروءة</span>
          <button
            className="text-button small"
            disabled={busy || !data.notifications.some((n) => !n.read)}
            onClick={mark}
          >
            <CheckCheck size={16} />
            تحديد الكل كمقروء
          </button>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {data.notifications.length ? (
          data.notifications.map((n) => (
            <div className={`notification ${!n.read ? 'unread' : ''}`} key={n.id}>
              <span className="notification-icon">
                <CalendarDays size={19} />
              </span>
              <div>
                <h3>{n.title}</h3>
                <p>{n.body}</p>
                <small>
                  {dateLabel(n.createdAt, {
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </small>
                {n.leaveId && data.leaves.some((l) => l.id === n.leaveId) && (
                  <button
                    className="text-button small"
                    onClick={() => {
                      close();
                      showLeave(data.leaves.find((l) => l.id === n.leaveId)!);
                    }}
                  >
                    عرض الطلب
                    <ChevronLeft size={14} />
                  </button>
                )}
                {n.requestId && (
                  <button
                    className="text-button small"
                    onClick={() => {
                      close();
                      navigate(`/requests/${n.requestId}`);
                    }}
                  >
                    عرض الطلب
                    <ChevronLeft size={14} />
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <Empty
            title="كل شيء هادئ هنا"
            detail="سنخبرك هنا عندما تتغير حالة طلبك أو يصل طلب يحتاج مراجعتك."
          />
        )}
      </div>
    </Modal>
  );
}
export function SearchDialog({ close }: { close: () => void }) {
  const { data, showLeave } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const q = query.trim();
  const people = q
    ? data.employees.filter((e) => `${e.name} ${e.title} ${e.employeeNumber}`.includes(q))
    : [];
  const leaves = q
    ? data.leaves.filter((l) => `${l.employeeName} إجازة ${l.startDate}`.includes(q))
    : [];
  return (
    <Modal title="ابحث في مساحتك" close={close}>
      <div className="dialog-body">
        <label className="search-field search-dialog-input">
          <Search size={20} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="اسم، طلب إجازة، أو تاريخ…"
            aria-label="بحث شامل"
          />
        </label>
        {!q ? (
          <div className="search-shortcuts">
            <p>وصول سريع</p>
            {[
              ['ملفي الوظيفي', '/profile'],
              ['طلباتي وإجازاتي', '/leaves'],
              ['تقويم الفريق', '/calendar'],
            ].map(([label, path]) => (
              <button
                key={path}
                onClick={() => {
                  close();
                  navigate(path);
                }}
              >
                {label}
                <ArrowLeft size={17} />
              </button>
            ))}
          </div>
        ) : (
          <div className="search-results">
            {people.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  close();
                  navigate(`/employees/${p.id}`);
                }}
              >
                <Avatar person={p} size="sm" />
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.title}</small>
                </span>
                <ChevronLeft size={16} />
              </button>
            ))}
            {leaves.slice(0, 5).map((l) => (
              <button
                key={l.id}
                onClick={() => {
                  close();
                  showLeave(l);
                }}
              >
                <span className="icon-tile">
                  <CalendarDays size={18} />
                </span>
                <span>
                  <strong>طلب {l.employeeName}</strong>
                  <small>
                    {dateLabel(l.startDate)} — {dateLabel(l.endDate)}
                  </small>
                </span>
                <Status value={l.status} />
              </button>
            ))}
            {!people.length && !leaves.length && (
              <Empty title="لا توجد نتائج مطابقة" detail="جرّب اسمًا آخر أو تاريخ بداية الإجازة." />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
export function HelpDialog({ close }: { close: () => void }) {
  return (
    <Modal title="أهلًا بك في مساحة الفريق" close={close}>
      <div className="dialog-body help-content">
        <span className="help-illustration">
          <CircleHelp size={36} />
        </span>
        <h3>عملك أوضح، بخطوات بسيطة.</h3>
        <section>
          <h4>خطّط لإجازتك</h4>
          <p>
            اختر «طلب إجازة»، حدّد الفترة وراجع الأيام والرصيد، ثم أرسل الطلب. يمكنك سحبه ما دام قيد
            المراجعة.
          </p>
        </section>
        <section>
          <h4>اعرف الخطوة التالية</h4>
          <p>
            افتح الطلب لتتابع مراجعة المدير ثم الموارد البشرية. تُعرض الموافقات التي تحتاج قرارك في
            صندوق الموافقات.
          </p>
        </section>
        <section>
          <h4>جرّب الأدوار المختلفة</h4>
          <p>
            من «تبديل حساب التجربة» في القائمة يمكنك تجربة الموظف، ومدير الفريق، والموارد البشرية.
            لكل دور نطاقه.
          </p>
        </section>
        <div className="policy-note">
          <ShieldCheck size={18} />
          <span>
            كل الأسماء والأرصدة اصطناعية. إدارة الوثائق والرواتب والتكاملات ليست مفعّلة في هذه
            الدفعة.
          </span>
        </div>
      </div>
      <footer className="dialog-footer">
        <button className="button primary" onClick={close}>
          واضح، لنبدأ
        </button>
      </footer>
    </Modal>
  );
}
