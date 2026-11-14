import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BookOpenText,
  ChartNoAxesCombined,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  LoaderCircle,
  ReceiptText,
  Scale,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from 'lucide-react';
import type { LedgerOverview } from '../../shared/ledger';
import { PageHeading, useApp } from '../lib';
import { Alert, FinancePage } from './index';
import { errorText, read, type View } from './ledger/shared';
import { Home } from './ledger/Home';
import { Revenues } from './ledger/Revenues';
import { Expenses } from './ledger/Expenses';
import { Journal } from './ledger/Journal';
import { Accounts } from './ledger/Accounts';
import { Vat } from './ledger/Vat';
import { Budget } from './ledger/Budget';
import { Reports } from './ledger/Reports';
import './finance.css';
import './ledger/ledger.css';

const views = [
  ['home', 'البوابة', LayoutDashboard],
  ['revenues', 'الإيرادات', TrendingUp],
  ['expenses', 'المصروفات', TrendingDown],
  ['journal', 'القيد اليومي', BookOpenText],
  ['accounts', 'الحسابات والأستاذ', Landmark],
  ['vat', 'الإقرار الضريبي', Scale],
  ['budget', 'الموازنة', ChartNoAxesCombined],
  ['reports', 'التقارير', FileSpreadsheet],
  ['billing', 'الفواتير وعروض الأسعار', ReceiptText],
] as const;

/** Entry point of the finance workspace: the accounting ledger around the existing billing pages. */
export function FinancePortal() {
  const { data, notify } = useApp();
  const access = (data as typeof data & { financeAccess?: boolean }).financeAccess === true;
  const [params, setParams] = useSearchParams();
  const requested = params.get('view');
  // Older links (?tab=settings, ?form=quote) keep opening the billing pages.
  const view: View = views.some(([id]) => id === requested)
    ? (requested as View)
    : params.get('tab') || params.get('form')
      ? 'billing'
      : 'home';
  const action = params.get('action') ?? undefined;
  const [overview, setOverview] = useState<LedgerOverview | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setError('');
    try {
      setOverview(await read<LedgerOverview>(''));
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);
  useEffect(() => {
    if (access) void reload();
  }, [access, reload]);
  const go = (next: View, nextAction?: string) => {
    setParams(next === 'home' ? {} : { view: next, ...(nextAction ? { action: nextAction } : {}) });
    window.scrollTo({ top: 0 });
  };
  if (!access)
    return (
      <section className="finance-page">
        <PageHeading title="النظام المالي" subtitle="لا تتوفر لك صلاحية دخول هذا القسم." />
      </section>
    );
  const props = overview ? { overview, reload, go, action, notify } : null;
  const needsSetup = overview && !overview.initialized && view !== 'billing' && view !== 'home';
  return (
    <>
      <section className="finance-page led-shell" dir="rtl">
        <PageHeading
          title="النظام المالي"
          subtitle="الإيرادات والمصروفات والقيود والإقرار الضريبي والموازنة، مرتبطة بالفواتير وعروض الأسعار."
        />
        <nav className="fin-tabs led-nav" aria-label="أقسام النظام المالي">
          {views.map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? 'active' : ''}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => go(id)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        {error && <Alert>{error}</Alert>}
        {view !== 'billing' &&
          (!props ? (
            <section className="fin-loading" aria-live="polite">
              {error ? (
                <button className="button secondary" onClick={() => void reload()}>
                  إعادة المحاولة
                </button>
              ) : (
                <>
                  <LoaderCircle className="spin" size={20} /> جارٍ تحميل الدفاتر…
                </>
              )}
            </section>
          ) : needsSetup ? (
            <section className="fin-empty led-setup-hint">
              <span>
                <WalletCards size={20} />
              </span>
              <b>الدفاتر غير مهيأة بعد</b>
              <p>هيّئ دليل الحسابات من البوابة لتبدأ التسجيل.</p>
              <button className="button primary" onClick={() => go('home')}>
                الذهاب إلى البوابة
              </button>
            </section>
          ) : (
            <>
              {view === 'home' && <Home {...props} />}
              {view === 'revenues' && <Revenues {...props} />}
              {view === 'expenses' && <Expenses {...props} />}
              {view === 'journal' && <Journal {...props} />}
              {view === 'accounts' && <Accounts {...props} />}
              {view === 'vat' && <Vat {...props} />}
              {view === 'budget' && <Budget {...props} />}
              {view === 'reports' && <Reports {...props} />}
            </>
          ))}
      </section>
      {view === 'billing' && <FinancePage embedded />}
    </>
  );
}
