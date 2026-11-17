import { useCallback, useEffect, useState } from 'react';
import type {
  RenewalSettlementDetails,
  RenewalSettlementVoucherOption,
} from '../../../shared/renewal-settlements';
import { Alert } from '../index';
import { ConfirmDialog, useApp } from '../../lib';
import { errorText, fmt, read, useMutate } from './shared';

/**
 * Finance-only reconciliation card for embedding beside a renewed document case.
 * It points to the ordinary expense form when the owner has not yet recorded a voucher.
 */
export function RenewalSettlement({
  renewalId,
  onChanged,
}: {
  renewalId: string;
  onChanged?: () => void | Promise<void>;
}) {
  const [data, setData] = useState<RenewalSettlementDetails | null>(null);
  const [selected, setSelected] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const { notify } = useApp();
  const mutate = useMutate();
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await read<RenewalSettlementDetails>(
        `/renewal-settlements/${encodeURIComponent(renewalId)}`,
      );
      setData(next);
      setSelected(next.settlement?.voucherId ?? '');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  }, [renewalId]);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (voucherId: string | null) => {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      if (data.settlement) {
        if (!reason.trim()) {
          setError('سبب التصحيح مطلوب.');
          return;
        }
        await mutate(`/renewal-settlements/${encodeURIComponent(renewalId)}/correct`, {
          voucherId,
          version: data.version,
          reason: reason.trim(),
        });
      } else {
        if (!voucherId) return;
        await mutate(`/renewal-settlements/${encodeURIComponent(renewalId)}`, {
          voucherId,
          version: data.version,
          reason: reason.trim(),
        });
      }
      setConfirming(false);
      setReason('');
      await load();
      await onChanged?.();
      notify('حُفظت مطابقة التجديد.');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <section className="fin-section">جارٍ تحميل المطابقة المالية…</section>;
  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return null;

  const current = data.settlement?.voucher;
  const option = (item: RenewalSettlementVoucherOption) => (
    <option key={item.id} value={item.id}>
      {item.number} · {fmt(item.totalHalalas)} ر.س.
      {item.warning ? ' · المبلغ مختلف عن التقديري' : ''}
    </option>
  );
  return (
    <section className="fin-section" dir="rtl" aria-label="مطابقة رسوم التجديد">
      <div className="fin-section-head">
        <div>
          <h3>مطابقة رسوم التجديد</h3>
          <p>تربط الحالة بسند مصروف مالك مرحّل قائم، ولا تنشئ قيدًا أو مرفقًا ثانيًا.</p>
        </div>
        {!data.eligible && (
          <span className="status status-neutral">بانتظار التجديد والدفع من المالك</span>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {current ? (
        <div className="led-note">
          السند <bdi>{current.number}</bdi> · إجمالي {fmt(current.totalHalalas)} ر.س. · المسترد{' '}
          {fmt(current.refundedHalalas)} ر.س. · المتبقي {fmt(current.remainingHalalas)} ر.س.
          {current.status === 'reversed' && ' · السند معكوس'}
        </div>
      ) : data.eligible ? (
        <div className="fin-grid">
          <label>
            السند المرحّل
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              <option value="">اختر سند مصروف مالك</option>
              {data.options.map(option)}
            </select>
          </label>
          <label>
            سبب أو ملاحظة (اختياري)
            <input
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      {data.eligible && !current && data.options.length === 0 && (
        <p>
          لا يوجد سند مصروف مالك مرحّل صالح للمطابقة.{' '}
          <a href="/finance?view=expenses&action=new">تسجيل مصروف عادي</a> ثم العودة للمطابقة.
        </p>
      )}
      {data.eligible && !current && (
        <button
          className="button primary"
          disabled={busy || !selected}
          onClick={() => void submit(selected)}
        >
          {busy ? 'جارٍ الحفظ…' : 'ربط السند بالحالة'}
        </button>
      )}
      {current && (
        <>
          <label>
            سبب التصحيح
            <input
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="button secondary"
            disabled={busy || !reason.trim()}
            onClick={() => setConfirming(true)}
          >
            {busy ? 'جارٍ الحفظ…' : 'إزالة المطابقة'}
          </button>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="إزالة مطابقة التجديد"
          close={() => setConfirming(false)}
          warning="سيُزال رابط الحالة فقط، ولن يتغير السند المالي أو يُحذف أي قيد."
          confirmLabel={busy ? 'جارٍ الحفظ…' : 'تأكيد الإزالة'}
          confirmDisabled={!reason.trim()}
          busy={busy}
          onConfirm={() => void submit(null)}
        >
          <p>اكتب سبب التصحيح قبل التأكيد.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
