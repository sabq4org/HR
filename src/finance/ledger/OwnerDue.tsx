import { useCallback, useEffect, useMemo, useState } from 'react';
import { HandCoins, Paperclip } from 'lucide-react';
import type { LedgerOverview, OwnerStatement } from '../../../shared/ledger';
import { ExportPdfButton } from '../ExportPdf';
import { Alert, Empty, Field, Status } from '../index';
import {
  AccountSelect,
  amountText,
  fmt,
  LedgerForm,
  Money,
  read,
  today,
  useLoad,
  useMutate,
} from './shared';

/**
 * What the company owes the owner for expenses he paid from his own card, the PDF of it, and the
 * refund form (company bank -> owner) that settles chosen items or the oldest first.
 */
export function OwnerDue({
  overview,
  changed,
  openAttachments,
}: {
  overview: LedgerOverview;
  changed: () => Promise<void>;
  openAttachments: (voucherId: string) => void;
}) {
  const [asOf, setAsOf] = useState(today());
  const load = useCallback(
    () => read<OwnerStatement>(`/owner?asOf=${encodeURIComponent(asOf)}&all=1`),
    [asOf],
  );
  const { data, error, run } = useLoad(load);
  const mutate = useMutate();
  const [selected, setSelected] = useState<string[]>([]);
  const [refunding, setRefunding] = useState(false);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState(overview.settings.defaultCashAccount);
  const [reference, setReference] = useState('');
  useEffect(() => {
    void run();
  }, [run]);
  const open = useMemo(() => data?.claims.filter((c) => c.outstandingHalalas > 0) ?? [], [data]);
  const settled = useMemo(
    () => data?.claims.filter((c) => c.outstandingHalalas === 0) ?? [],
    [data],
  );
  const chosen = selected.length ? open.filter((c) => selected.includes(c.voucherId)) : open;
  const chosenTotal = chosen.reduce((sum, c) => sum + c.outstandingHalalas, 0);
  const toggle = (id: string) =>
    setSelected((items) => (items.includes(id) ? items.filter((x) => x !== id) : [...items, id]));

  if (refunding)
    return (
      <LedgerForm
        title="تسجيل رد مبلغ للمالك"
        close={() => setRefunding(false)}
        submitLabel="حفظ وترحيل"
        note={
          <>
            يُسجَّل سند صرف من حساب البنك: مدين «{data?.accountName}» ودائن البنك. المصروف نفسه سُجّل في
            دفاتر الصحيفة يوم سداده، وهذا السند يُظهر خروج المبلغ فعليًا من البنك ويقفل المستحق
            للمالك. المستحق على{' '}
            {selected.length ? `${chosen.length} بند مختار` : 'كل البنود المفتوحة (الأقدم أولًا)'}:{' '}
            {fmt(chosenTotal)} ر.س.
          </>
        }
        submit={async () => {
          await mutate('/owner/refunds', {
            date,
            amount: amountText(amount),
            cashAccountCode: bank,
            reference,
            claimIds: selected.length ? chosen.map((c) => c.voucherId) : [],
          });
          setRefunding(false);
          setSelected([]);
          await Promise.all([run(), changed()]);
        }}
      >
        <div className="fin-grid">
          <Field label="تاريخ التحويل للمالك">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="المبلغ المحوَّل" hint="يمكن أن يكون جزئيًا؛ يُوزَّع على البنود بالترتيب.">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="دُفع من">
            <AccountSelect
              accounts={overview.accounts}
              value={bank}
              onChange={setBank}
              filter={(a) => a.isCash}
            />
          </Field>
          <Field label="مرجع التحويل البنكي (اختياري)">
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={120}
            />
          </Field>
        </div>
      </LedgerForm>
    );

  return (
    <section className="fin-section">
      <div className="fin-section-head">
        <div>
          <h2>مستحقات المالك</h2>
          <p>
            المصروفات التي سددها المالك من بطاقته الشخصية، وما رُدّ له من حساب الصحيفة، والمتبقي له.
          </p>
        </div>
        <div className="fin-actions">
          <ExportPdfButton
            path={`/ledger/owner.pdf?asOf=${encodeURIComponent(asOf)}`}
            filename={`مستحقات-المالك-${asOf}`}
            label="تصدير PDF بالمستحق"
          />
          <button
            className="button primary"
            disabled={!open.length}
            onClick={() => {
              setDate(today());
              setAmount((chosenTotal / 100).toFixed(2));
              setReference('');
              setRefunding(true);
            }}
          >
            <HandCoins size={17} />
            {selected.length ? 'رد المبلغ عن البنود المختارة' : 'تسجيل رد مبلغ للمالك'}
          </button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {data && (
        <div className="led-owner-summary">
          <span>
            المستحق للمالك حتى{' '}
            <input
              type="date"
              value={asOf}
              aria-label="حتى تاريخ"
              onChange={(e) => e.target.value && setAsOf(e.target.value)}
            />
          </span>
          <strong className="led-bad">
            <Money value={data.outstandingHalalas} /> ر.س.
          </strong>
          <span>
            سدد <Money value={data.paidHalalas} /> · رُدّ له <Money value={data.refundedHalalas} />
          </span>
          {data.ledgerBalanceHalalas !== data.outstandingHalalas && (
            <Status
              text={`رصيد الحساب في الدفتر ${fmt(data.ledgerBalanceHalalas)}: يوجد قيد يدوي عليه`}
              kind="waiting"
            />
          )}
        </div>
      )}
      {open.length ? (
        <div className="fin-table-wrap">
          <table className="fin-table">
            <thead>
              <tr>
                <th>
                  <span className="led-visually-hidden">اختيار</span>
                </th>
                <th>المستند</th>
                <th>التاريخ</th>
                <th>البيان</th>
                <th>المبلغ</th>
                <th>رُدّ</th>
                <th>المتبقي</th>
                <th>الفاتورة</th>
              </tr>
            </thead>
            <tbody>
              {open.map((claim) => (
                <tr key={claim.voucherId}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`اختيار ${claim.number}`}
                      checked={selected.includes(claim.voucherId)}
                      onChange={() => toggle(claim.voucherId)}
                    />
                  </td>
                  <td>
                    <b>{claim.number}</b>
                    {claim.reference && <small>فاتورة {claim.reference}</small>}
                  </td>
                  <td className="num">{claim.date}</td>
                  <td>
                    {claim.description}
                    {claim.partyName && <small>{claim.partyName}</small>}
                  </td>
                  <td className="num">
                    <Money value={claim.totalHalalas} />
                  </td>
                  <td className="num">
                    <Money value={claim.refundedHalalas} />
                  </td>
                  <td className="num">
                    <b>
                      <Money value={claim.outstandingHalalas} />
                    </b>
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => openAttachments(claim.voucherId)}
                    >
                      <Paperclip size={14} />
                      {claim.attachmentCount ? `${claim.attachmentCount} ملف` : 'إرفاق'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        data && (
          <Empty
            title="لا شيء مستحق للمالك"
            detail="عند تسجيل مصروف اختر «سددها المالك من بطاقته الشخصية» ليظهر هنا."
          />
        )
      )}
      {data && data.refunds.length > 0 && (
        <>
          <h3>ما رُدّ للمالك</h3>
          <div className="fin-table-wrap">
            <table className="fin-table">
              <thead>
                <tr>
                  <th>سند الصرف</th>
                  <th>التاريخ</th>
                  <th>دُفع من</th>
                  <th>عن</th>
                  <th>المبلغ</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {data.refunds.map((refund) => (
                  <tr
                    key={refund.voucherId}
                    className={refund.status === 'reversed' ? 'led-reversed' : ''}
                  >
                    <td>
                      <b>{refund.number}</b>
                      {refund.reference && <small>{refund.reference}</small>}
                    </td>
                    <td className="num">{refund.date}</td>
                    <td>{refund.cashAccountName}</td>
                    <td>
                      {refund.allocations
                        .map((a) => `${a.claimNumber} (${fmt(a.amountHalalas)})`)
                        .join('، ')}
                    </td>
                    <td className="num">
                      <Money value={refund.totalHalalas} />
                    </td>
                    <td>
                      {refund.status === 'reversed' ? (
                        <Status text="معكوس" kind="bad" />
                      ) : (
                        <Status text="مرحّل" kind="good" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {settled.length > 0 && (
        <p className="led-note">{settled.length} بند آخر سدده المالك ورُدّ له كاملًا.</p>
      )}
    </section>
  );
}
