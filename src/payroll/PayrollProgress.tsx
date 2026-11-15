// Where a payroll run stands: the four stages with who signed each, whom the run is waiting on,
// then the full history in plain sentences, newest last.
import { Check, CircleAlert } from 'lucide-react';
import type { PayrollRun } from '../../shared/administration';

const ACTION_LABEL: Record<string, string> = {
  created: 'أنشأ المسودة',
  edited: 'عدّل أسطر المسير',
  payment_recorded: 'سجّل حالة دفع',
  people_changed: 'غيّر الموظفين في المسير',
  submit: 'أرسله لمراجعة المالية',
  review: 'راجعه ووقّعه عن الإدارة المالية',
  approve: 'اعتمده ووقّعه وأغلقه',
  reject: 'رفضه',
  withdrawn: 'سحبه إلى المسودة للتعديل',
  reopened: 'أعاد فتحه مسودة',
  cancelled: 'ألغى المسير',
};

const timeFormat = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Riyadh',
});

type Stage = { key: string; title: string; who: string | null | undefined; done: boolean };

export function PayrollProgress({
  run,
  actorId,
  approves,
}: {
  run: PayrollRun;
  actorId: string;
  /** The viewer can approve payroll (approver or system owner). */
  approves: boolean;
}) {
  const ended = run.state === 'rejected';
  const order = ['draft', 'pending_finance', 'pending_approver', 'closed'];
  const at = ended ? -1 : order.indexOf(run.state);
  const stages: Stage[] = [
    { key: 'draft', title: 'إعداد المسير', who: run.preparedByName, done: at > 0 },
    {
      key: 'pending_finance',
      title: 'مراجعة الإدارة المالية',
      who: run.reviewedByName,
      done: at > 1,
    },
    {
      key: 'pending_approver',
      title: 'اعتماد المدير العام',
      who: run.approvedByName,
      done: at > 2,
    },
    { key: 'closed', title: 'مغلق ونهائي', who: null, done: run.state === 'closed' },
  ];
  const waiting = run.waitingOn ?? [];
  const ownRunAwaitingMe =
    approves && run.state === 'pending_approver' && run.preparedBy === actorId;
  return (
    <section className="payroll-progress" aria-label="مراحل المسير وسجل المراجعة">
      <h3>أين وصل المسير؟</h3>
      {ended ? (
        <p className="payroll-progress-ended">
          {run.cancelled
            ? 'أُلغي هذا المسير، ولا يُكمل دورته. يبقى هنا للتوثيق فقط.'
            : 'رُفض هذا المسير. يستطيع معدّه إعادة فتحه مسودة وتصحيحه ثم إرساله من جديد، أو إلغاءه.'}
        </p>
      ) : (
        <ol className="payroll-stages">
          {stages.map((stage, index) => {
            const current = index === at && run.state !== 'closed';
            return (
              <li
                key={stage.key}
                className={stage.done ? 'done' : current ? 'current' : 'upcoming'}
                aria-current={current ? 'step' : undefined}
              >
                <span className="payroll-stage-mark">
                  {stage.done ? <Check size={16} /> : index + 1}
                </span>
                <span className="payroll-stage-text">
                  <strong>{stage.title}</strong>
                  {stage.done && stage.who ? (
                    <small>{stage.who}</small>
                  ) : current && stage.key !== 'closed' ? (
                    <small>
                      {waiting.length ? `بانتظار: ${waiting.join('، ')}` : 'لا يوجد من يتخذ الخطوة'}
                    </small>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {ownRunAwaitingMe && (
        <p className="payroll-progress-warning" role="note">
          <CircleAlert size={18} />
          أنت معدّ هذا المسير، ولا يعتمد أحد ما أعدّه بنفسه حتى لو كان مالك النظام. ليعتمده أنت، يُعدّه
          غيرك (مثل الموارد البشرية). تستطيع سحبه إلى المسودة أو إلغاءه.
        </p>
      )}
      {!ended && run.state === 'pending_approver' && !waiting.length && !ownRunAwaitingMe && (
        <p className="payroll-progress-warning" role="note">
          <CircleAlert size={18} />
          لا يوجد معتمد غير معدّ المسير ومراجعه، فلن يُغلق. يسحبه معدّه أو يلغيه.
        </p>
      )}
      <h3>سجل المراجعة</h3>
      <ol className="payroll-history">
        {run.timeline.map((event) => (
          <li key={event.id} className={`event-${event.action}`}>
            <div>
              <strong>{event.actorName}</strong> {ACTION_LABEL[event.action] ?? event.action}
            </div>
            <time dateTime={event.createdAt}>{timeFormat.format(new Date(event.createdAt))}</time>
            {event.reason && <p>{event.reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
