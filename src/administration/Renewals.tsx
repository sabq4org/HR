import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpLeft, CalendarClock, ClipboardCheck } from 'lucide-react';
import type { DocumentExpiryItem } from '../../shared/administration';
import type { DocumentRenewalCase, RenewalsResponse } from '../../shared/renewals';
import type { RenewalSettlementSummary } from '../../shared/renewal-settlements';
import { dateLabel, PageHeading, useApp } from '../lib';
import { docCategoryLabel, expiryLabel, riyals } from './index';
import { useLoadRaw } from './useLoadRaw';
import { StartRenewal, CompleteRenewal, AttachSourceDocument } from './RenewalForms';
import { RenewalSettlement } from '../finance/ledger/RenewalSettlement';
import './renewals.css';

const fullDate = (value: string) =>
  dateLabel(value, { day: 'numeric', month: 'long', year: 'numeric' });
const caseUrl = (id: string) => '/renewals?case=' + encodeURIComponent(id);
const docUrl = (id: string) => '/renewals?document=' + encodeURIComponent(id);
const settlementLabels: Record<RenewalSettlementSummary['state'], string> = {
  unlinked: 'بانتظار ربط المصروف',
  outstanding: 'بانتظار رد المبلغ',
  partial: 'رُدّ جزء من المبلغ',
  settled: 'استرد المالك المبلغ',
  reversed: 'السند معكوس ويحتاج مراجعة',
};

function useRenewalDesk() {
  const { data } = useApp();
  const records = useLoadRaw<RenewalsResponse>('/admin/renewals');
  const expiries = useLoadRaw<{ items: DocumentExpiryItem[] }>('/admin/expiries');
  const finance = useLoadRaw<{ renewals: RenewalSettlementSummary[] }>(
    data.financeAccess ? '/finance/ledger/renewal-settlements/summary' : null,
  );
  const cases = records.value?.cases ?? [];
  const items = expiries.value?.items ?? [];
  const summary = new Map(finance.value?.renewals.map((row) => [row.renewalId, row]));
  const open = new Map(cases.filter((c) => c.status === 'open').map((c) => [c.documentId, c]));
  const urgent = items.filter((i) => i.daysLeft <= 30);
  const refresh = () => {
    void records.reload();
    void expiries.reload();
    void finance.reload();
  };
  return { records, expiries, finance, cases, items, open, urgent, summary, refresh };
}

function Failure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <p className="form-error" role="alert">
      {message}{' '}
      <button type="button" className="adm-link" onClick={retry}>
        إعادة المحاولة
      </button>
    </p>
  );
}

function ExpiringLink({
  item,
  current,
}: {
  item: DocumentExpiryItem;
  current?: DocumentRenewalCase;
}) {
  const to = current
    ? caseUrl(current.id)
    : item.documentId
      ? docUrl(item.documentId)
      : '/renewals?profile=' + encodeURIComponent(item.id);
  return (
    <Link className="renewal-row" to={to}>
      <span>
        <b>
          {item.title} · {item.employeeName}
        </b>
        <small>
          {current
            ? 'يتابعها ' + current.assigneeName
            : item.documentId
              ? 'تحتاج إسناد التجديد'
              : 'تاريخ مسجّل في الملف الوظيفي'}
        </small>
      </span>
      <span className="renewal-timing">
        {expiryLabel(item.daysLeft)} <ArrowUpLeft size={15} aria-hidden="true" />
      </span>
    </Link>
  );
}

export function OwnerDesk({ approvals }: { approvals: number | null }) {
  const { data } = useApp();
  const desk = useRenewalDesk();
  const pendingMoney = [...desk.summary.values()].filter((s) => s.state !== 'settled');
  const openCases = desk.cases.filter((c) => c.status === 'open');
  return (
    <section className="admin-page renewal-desk" aria-labelledby="owner-desk-title">
      <header className="renewal-header">
        <h2 id="owner-desk-title">
          {data.me.systemOwner || data.financeAccess ? 'مكتب المالك' : 'متابعة الوثائق'}
        </h2>
        <Link className="adm-link" to="/renewals">
          معاملات التجديد <ArrowUpLeft size={15} />
        </Link>
      </header>
      <div className="renewal-shortcuts">
        <Link to="/approvals">
          <ClipboardCheck size={17} />{' '}
          {approvals === null ? (
            'فتح الموافقات'
          ) : (
            <>
              بانتظار قرارك <strong>{approvals}</strong>
            </>
          )}
        </Link>
        {desk.records.value && (
          <Link to="/renewals">
            <CalendarClock size={17} /> تجديدات مفتوحة <strong>{openCases.length}</strong>
          </Link>
        )}
        {data.financeAccess && desk.finance.value && (
          <Link to="/renewals?view=finance">
            متابعة مالية <strong>{pendingMoney.length}</strong>
          </Link>
        )}
      </div>
      {desk.records.error && <Failure message={desk.records.error} retry={desk.refresh} />}
      {desk.finance.error && (
        <Failure message={desk.finance.error} retry={() => void desk.finance.reload()} />
      )}
      {desk.expiries.error ? (
        <Failure message={desk.expiries.error} retry={desk.refresh} />
      ) : desk.expiries.loading || desk.records.loading ? (
        <p role="status">جارٍ تحميل المتابعات…</p>
      ) : desk.urgent.length ? (
        desk.urgent
          .slice(0, 3)
          .map((i) => (
            <ExpiringLink key={i.id} item={i} current={desk.open.get(i.documentId ?? '')} />
          ))
      ) : (
        <p>لا توجد وثائق منتهية أو تنتهي خلال 30 يومًا.</p>
      )}
    </section>
  );
}

function DetailHeader({
  name,
  category,
  expiry,
  fee,
  assignee,
}: {
  name: string;
  category: string;
  expiry: string;
  fee: number | null;
  assignee?: string;
}) {
  return (
    <>
      <h2>
        {docCategoryLabel(category)} · {name}
      </h2>
      <dl className="renewal-facts">
        <div>
          <dt>تاريخ الانتهاء قبل التجديد</dt>
          <dd>{fullDate(expiry)}</dd>
        </div>
        <div>
          <dt>رسوم التجديد المسجّلة</dt>
          <dd>{fee === null ? 'لم تُحدّد' : riyals(fee)}</dd>
        </div>
        {assignee && (
          <div>
            <dt>مسؤول المتابعة</dt>
            <dd>{assignee}</dd>
          </div>
        )}
      </dl>
    </>
  );
}

export function RenewalsPage() {
  const { data } = useApp();
  const [params] = useSearchParams();
  const desk = useRenewalDesk();
  const [search, setSearch] = useState('');
  const documentId = params.get('document');
  const caseId = params.get('case');
  const profileId = params.get('profile');
  const focus = documentId || caseId || profileId;
  const financeView = params.get('view') === 'finance' && data.financeAccess;
  const item = caseId ? desk.cases.find((c) => c.id === caseId) : desk.open.get(documentId ?? '');
  const candidate = desk.items.find(
    (i) =>
      (documentId && i.documentId === documentId) ||
      (profileId && i.id === profileId && i.source === 'profile'),
  );
  const match = (name: string, category: string) =>
    (name + ' ' + docCategoryLabel(category)).includes(search.trim());
  const canEdit = (employeeId: string) => employeeId !== data.me.id || data.me.systemOwner;
  const visibleCases = desk.cases.filter(
    (c) =>
      match(c.employeeName, c.category) &&
      (!financeView ||
        (c.status === 'renewed' &&
          c.payment === 'owner' &&
          desk.summary.get(c.id)?.state !== 'settled')),
  );
  const remaining = desk.items.filter(
    (i) => !desk.open.has(i.documentId ?? '') && match(i.employeeName, i.category),
  );
  return (
    <section className="admin-page renewal-page">
      <PageHeading
        title="معاملات التجديد"
        subtitle="إسناد الوثائق ومتابعة إثبات التجديد والسداد."
        action={
          <Link
            className="adm-button secondary"
            to={focus || financeView ? '/renewals' : '/documents'}
          >
            {focus || financeView ? 'كل المعاملات' : 'وثائق الموظفين'}
          </Link>
        }
      />
      {desk.records.error || desk.expiries.error ? (
        <Failure message={desk.records.error || desk.expiries.error} retry={desk.refresh} />
      ) : desk.records.loading || desk.expiries.loading || !desk.records.value ? (
        <p role="status">جارٍ التحميل…</p>
      ) : focus ? (
        <article className="adm-section">
          {item ? (
            <>
              <DetailHeader
                name={item.employeeName}
                category={item.category}
                expiry={item.originalExpiry}
                fee={item.feeHalalas}
                assignee={item.assigneeName}
              />
              <p>آخر إجراء في {fullDate(item.updatedAt)}</p>
              {item.status === 'open' ? (
                canEdit(item.employeeId) ? (
                  <CompleteRenewal
                    key={item.id}
                    item={item}
                    cases={desk.cases}
                    changed={desk.refresh}
                  />
                ) : (
                  <p>يتولى مسؤول آخر تأكيد تجديد هذه الوثيقة.</p>
                )
              ) : item.status === 'cancelled' ? (
                <p>أُلغيت معاملة التجديد.</p>
              ) : (
                <>
                  <h3>تم تجديد الوثيقة</h3>
                  {item.newExpiry && <p>الانتهاء الجديد {fullDate(item.newExpiry)}</p>}
                  {item.proofDocumentId && (
                    <a
                      className="adm-link"
                      href={
                        '/api/admin/documents/' +
                        encodeURIComponent(item.proofDocumentId) +
                        '/download'
                      }
                    >
                      تنزيل إثبات التجديد
                    </a>
                  )}
                  {item.payment === 'owner' ? (
                    data.financeAccess ? (
                      <RenewalSettlement
                        key={item.id}
                        renewalId={item.id}
                        onChanged={desk.finance.reload}
                      />
                    ) : (
                      <p>
                        سجّل مسؤول التجديد أن المالك سدّد الرسوم. يتابع صاحب الصلاحية المالية ربط
                        السند.
                      </p>
                    )
                  ) : (
                    <p>دون مطالبة للمالك.</p>
                  )}
                </>
              )}
            </>
          ) : candidate && desk.records.value ? (
            <>
              <DetailHeader
                name={candidate.employeeName}
                category={candidate.category}
                expiry={candidate.expiresAt}
                fee={candidate.renewalFeeHalalas}
              />
              {candidate.source === 'profile' && canEdit(candidate.employeeId) ? (
                <AttachSourceDocument key={candidate.id} item={candidate} changed={desk.refresh} />
              ) : canEdit(candidate.employeeId) ? (
                <StartRenewal
                  key={candidate.id}
                  document={candidate}
                  assignees={desk.records.value.assignees}
                  changed={desk.refresh}
                />
              ) : (
                <p>يتولى مسؤول آخر فتح معاملة تجديد وثيقتك.</p>
              )}
            </>
          ) : (
            <p>هذه المعاملة أو الوثيقة غير متاحة في قائمة المتابعة الحالية.</p>
          )}
        </article>
      ) : (
        <>
          <label className="adm-field renewal-search">
            بحث في معاملات التجديد
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="اسم الموظف أو نوع الوثيقة"
            />
          </label>
          {desk.finance.error && (
            <Failure message={desk.finance.error} retry={() => void desk.finance.reload()} />
          )}
          <section className="adm-section">
            <h2>{financeView ? 'معاملات تحتاج متابعة مالية' : 'سجل معاملات التجديد'}</h2>
            {financeView && desk.finance.loading ? (
              <p role="status">جارٍ تحميل المتابعة المالية…</p>
            ) : visibleCases.length ? (
              visibleCases.map((c) => (
                <Link className="renewal-row" key={c.id} to={caseUrl(c.id)}>
                  <span>
                    <b>
                      {docCategoryLabel(c.category)} · {c.employeeName}
                    </b>
                    <small>
                      {c.assigneeName} · {fullDate(c.originalExpiry)}
                    </small>
                  </span>
                  <span>
                    {c.status === 'open'
                      ? 'قيد التجديد'
                      : c.status === 'cancelled'
                        ? 'ملغاة'
                        : desk.summary.has(c.id)
                          ? settlementLabels[desk.summary.get(c.id)!.state]
                          : 'تم تجديد الوثيقة'}
                  </span>
                </Link>
              ))
            ) : (
              <p>{search ? 'لا توجد نتائج مطابقة.' : 'لا توجد معاملات في هذه القائمة.'}</p>
            )}
          </section>
          {!financeView && (
            <section className="adm-section">
              <h2>وثائق تحتاج متابعة</h2>
              {remaining.length ? (
                remaining.map((i) => <ExpiringLink key={i.id} item={i} />)
              ) : (
                <p>لا توجد وثائق مطابقة تحتاج إسنادًا.</p>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
