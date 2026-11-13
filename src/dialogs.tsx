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
import type { LeaveRequest } from '../shared/contracts';
import {
  addDays,
  api,
  Avatar,
  canDecide,
  countDays,
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
  const days = countDays(start, end, data.policy.workingDays);
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
                يُستبعد الجمعة والسبت وفق جدول التجربة. يُراجع الاحتساب في الخادم عند الإرسال.
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
  const keys = useRef<Record<string, string>>({});
  const mayDecide = canDecide(data.me, leave, data.employees);
  const mayCancel = leave.employeeId === data.me.id && isPending(leave);
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
