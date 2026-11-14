import { useEffect, useState } from 'react';
import { api, dateLabel, useApp } from '../lib';

type Status = {
  storage: string;
  dialect: string;
  mfaRequired: boolean;
  notifications: string;
  runs: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
    remindersCreated: number;
    failureCode: string | null;
  }[];
};
export function OperationsPage() {
  const { data } = useApp();
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const allowed = ['hr', 'auditor'].includes(data.me.role);
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setStatus(await api<Status>('/operations/status'));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (allowed) void refresh();
  }, [allowed]);
  if (!allowed) return <p role="alert">متابعة التشغيل متاحة للمختصين فقط.</p>;
  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">مساحة الفريق</span>
          <h1>حالة التشغيل</h1>
          <p>متابعة الحفظ والتنبيهات الداخلية.</p>
        </div>
        <button className="button quiet" disabled={loading} onClick={() => void refresh()}>
          تحديث
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <>
          <p>الحفظ دائم · التحقق بخطوتين إلزامي · التنبيهات داخل النظام</p>
          <h2>آخر عمليات التنبيه</h2>
          {!status.runs.length ? (
            <p>لم تُسجل دورة تنبيه بعد.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>وقت البداية</th>
                    <th>النتيجة</th>
                    <th>التنبيهات</th>
                  </tr>
                </thead>
                <tbody>
                  {status.runs.map((run, index) => (
                    <tr key={`${run.startedAt}-${index}`}>
                      <td>
                        {dateLabel(run.startedAt, { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td>
                        {run.status === 'succeeded'
                          ? 'اكتملت'
                          : run.status === 'running'
                            ? 'قيد التنفيذ'
                            : 'تحتاج متابعة'}
                      </td>
                      <td>{run.remindersCreated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            اختبار الاستعادة واعتماد النسخ الاحتياطية على الاستضافة الفعلية مطلوبان قبل إدخال بيانات
            الموظفين.
          </p>
        </>
      )}
    </section>
  );
}
