import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import type { FinanceCustomer } from '../../shared/finance';
import type { CustomerStatement } from '../../shared/ledger';
import { api, Modal } from '../lib';
import { StatementPaper } from './statement-paper';

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

/** Customer statement preview; prints on landscape A4 in the same paper style as the invoice. */
export function CustomerStatementModal({
  customer,
  close,
}: {
  customer: FinanceCustomer;
  close: () => void;
}) {
  const [range, setRange] = useState({ from: '', to: today() });
  const [statement, setStatement] = useState<CustomerStatement | null>(null);
  // The range the visible statement was loaded for; printing waits until it matches the inputs.
  const [loaded, setLoaded] = useState('');
  const wanted = `${range.from}|${range.to}`;
  const [error, setError] = useState('');
  useEffect(() => {
    if (!range.to || (range.from && range.from > range.to)) {
      setError('بداية الفترة يجب ألا تتجاوز نهايتها.');
      return;
    }
    let live = true;
    const query = new URLSearchParams({
      to: range.to,
      ...(range.from ? { from: range.from } : {}),
    });
    api<{ statement: CustomerStatement }>(
      `/finance/customers/${encodeURIComponent(customer.id)}/statement?${query}`,
    )
      .then((result) => {
        if (!live) return;
        setStatement(result.statement);
        setLoaded(wanted);
        setError('');
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : 'تعذّر تحميل كشف الحساب.');
      });
    return () => {
      live = false;
    };
  }, [customer.id, range.from, range.to, wanted]);
  // Browsers without named-page support still need the sheet turned to landscape.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = '@page { size: A4 landscape; margin: 10mm 12mm; }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  return (
    <Modal
      title={`كشف حساب · ${customer.name}`}
      close={close}
      wide
      className="fin-statement-dialog"
    >
      <div className="fin-preview-actions fin-statement-actions">
        <label>
          <span>من</span>
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </label>
        <label>
          <span>إلى</span>
          <input
            type="date"
            required
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </label>
        <button
          className="button primary"
          disabled={!statement || Boolean(error) || loaded !== wanted}
          onClick={() => window.print()}
        >
          <Printer size={16} />
          طباعة أو حفظ PDF
        </button>
        {statement && statement.unpostedInvoices > 0 && (
          <small>
            {statement.unpostedInvoices === 1
              ? 'فاتورة واحدة معتمدة لم تُرحَّل'
              : `${statement.unpostedInvoices} فواتير معتمدة لم تُرحَّل`}{' '}
            إلى الدفاتر بعد، فلا يظهر عليها سداد حتى تُرحَّل من صفحة الإيرادات.
          </small>
        )}
      </div>
      {error && (
        <p className="fin-alert" role="alert">
          {error}
        </p>
      )}
      {statement && (
        <div
          aria-busy={loaded !== wanted}
          className={loaded !== wanted ? 'fin-statement-stale' : ''}
        >
          <StatementPaper statement={statement} />
        </div>
      )}
    </Modal>
  );
}
