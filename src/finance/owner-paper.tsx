// The printed statement of amounts the owner paid for the company and has not been refunded yet
// (landscape A4). Shared by the in-app preview and the server PDF; no hooks, API calls or CSS
// imports here.
import type { OwnerStatement } from '../../shared/ledger';
import { SellerBlock } from './SellerBlock';

const amount = (halalas: number) =>
  new Intl.NumberFormat('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    halalas / 100,
  );
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

export function OwnerStatementPaper({ statement }: { statement: OwnerStatement }) {
  const refunds = statement.refunds.filter((r) => r.status === 'posted');
  const open = statement.claims.filter((c) => c.outstandingHalalas > 0);
  return (
    <article className="fin-document-paper fin-statement-paper fin-owner-paper" dir="rtl" lang="ar">
      <header className="fin-doc-head">
        <SellerBlock seller={statement.seller} />
        <aside className="fin-doc-heading">
          <h1>كشف المبالغ المستحقة للمالك</h1>
          <span>مصروفات سددها من ماله الخاص ولم تُرد بعد</span>
        </aside>
      </header>
      <div className="fin-document-rule" />
      <dl className="fin-statement-stats">
        <div>
          <dt>حتى تاريخ</dt>
          <dd dir="ltr">{statement.asOf}</dd>
        </div>
        <div>
          <dt>إجمالي ما سدده المالك</dt>
          <dd dir="ltr" className="fin-statement-debit">
            {amount(statement.paidHalalas)}
          </dd>
        </div>
        <div>
          <dt>ما رُدّ له</dt>
          <dd dir="ltr" className="fin-statement-credit">
            {amount(statement.refundedHalalas)}
          </dd>
        </div>
        <div>
          <dt>عدد البنود المفتوحة</dt>
          <dd dir="ltr">{open.length}</dd>
        </div>
        <div className="fin-statement-closing">
          <dt>المتبقي المستحق للمالك</dt>
          <dd dir="ltr">{amount(statement.outstandingHalalas)}</dd>
        </div>
      </dl>
      <h2 className="fin-document-title">البنود غير المستردة</h2>
      <div className="fin-paper-table-wrap">
        <table className="fin-paper-table fin-statement-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">التاريخ</th>
              <th scope="col">المستند</th>
              <th scope="col" className="fin-paper-description">
                البيان
              </th>
              <th scope="col">المورد</th>
              <th scope="col">رقم فاتورة المورد</th>
              <th scope="col">الحساب</th>
              <th scope="col">المبلغ</th>
              <th scope="col">المسترد</th>
              <th scope="col">المتبقي</th>
              <th scope="col">الفاتورة مرفقة</th>
            </tr>
          </thead>
          <tbody>
            {open.map((row, index) => (
              <tr key={row.voucherId}>
                <td dir="ltr">{index + 1}</td>
                <td dir="ltr">{row.date}</td>
                <td dir="ltr">{row.number}</td>
                <td className="fin-paper-description">{row.description}</td>
                <td className="fin-owner-wrap">{row.partyName || '—'}</td>
                <td dir="ltr">{row.reference || '—'}</td>
                <td className="fin-owner-wrap">{row.accountName || '—'}</td>
                <td dir="ltr">{amount(row.totalHalalas)}</td>
                <td dir="ltr" className="fin-statement-credit">
                  {row.refundedHalalas ? amount(row.refundedHalalas) : '—'}
                </td>
                <td dir="ltr" className="fin-statement-debit">
                  <b>{amount(row.outstandingHalalas)}</b>
                </td>
                <td>{row.attachmentCount ? `نعم (${row.attachmentCount})` : 'لا'}</td>
              </tr>
            ))}
            {!open.length && (
              <tr>
                <td colSpan={11} className="fin-statement-empty">
                  لا توجد مبالغ مستحقة للمالك حتى هذا التاريخ.
                </td>
              </tr>
            )}
          </tbody>
          {open.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={9}>
                  <b>الإجمالي المستحق للمالك</b>
                </td>
                <td dir="ltr" className="fin-statement-debit">
                  <b>{amount(statement.outstandingHalalas)}</b>
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {refunds.length > 0 && (
        <>
          <h2 className="fin-document-title">ما رُدّ للمالك من الصحيفة</h2>
          <div className="fin-paper-table-wrap">
            <table className="fin-paper-table fin-statement-table">
              <thead>
                <tr>
                  <th scope="col">التاريخ</th>
                  <th scope="col">سند الصرف</th>
                  <th scope="col">دُفع من</th>
                  <th scope="col">مرجع التحويل</th>
                  <th scope="col" className="fin-paper-description">
                    عن المستندات
                  </th>
                  <th scope="col">المبلغ</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((row) => (
                  <tr key={row.voucherId}>
                    <td dir="ltr">{row.date}</td>
                    <td dir="ltr">{row.number}</td>
                    <td>{row.cashAccountName || '—'}</td>
                    <td dir="ltr">{row.reference || '—'}</td>
                    <td className="fin-paper-description">
                      {row.allocations
                        .map((a) => `${a.claimNumber} (${amount(a.amountHalalas)})`)
                        .join('، ')}
                    </td>
                    <td dir="ltr" className="fin-statement-credit">
                      {amount(row.totalHalalas)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {statement.ledgerBalanceHalalas !== statement.outstandingHalalas && (
        <p className="fin-owner-mismatch">
          تنبيه: رصيد حساب «{statement.accountName}» في الدفتر{' '}
          <bdi>{amount(statement.ledgerBalanceHalalas)}</bdi> يختلف عن مجموع البنود؛ يوجد قيد يدوي
          على الحساب يحتاج مراجعة المحاسب.
        </p>
      )}
      <div className="fin-owner-signatures">
        <div>
          <span>أعدّه</span>
          <i />
        </div>
        <div>
          <span>راجعه (المالية)</span>
          <i />
        </div>
        <div>
          <span>اعتمد الصرف</span>
          <i />
        </div>
      </div>
      <footer className="fin-paper-footer">
        <span>
          المبالغ بالريال السعودي · تاريخ الطباعة: <bdi>{today()}</bdi> · الحساب{' '}
          <bdi>{statement.accountCode}</bdi>
        </span>
        <span>أُنشئ هذا المستند إلكترونيًا من الدفتر المحاسبي</span>
      </footer>
    </article>
  );
}
