import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpLeft,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronsUpDown,
  CircleHelp,
  ClipboardCheck,
  Home,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  UserRound,
  Users,
  X,
  Files,
  BriefcaseBusiness,
  Clock3,
  ChartNoAxesCombined,
  WalletCards,
  Settings2,
  History,
} from 'lucide-react';
import type { Bootstrap, DemoPersona, Employee } from '../shared/contracts';
import type { AdministrativeOverview } from '../shared/administration';
import { api, AppContext, Avatar, Modal, roleLabel } from './lib';
import {
  ApprovalsPage,
  CalendarPage,
  Dashboard,
  LeavesPage,
  PeoplePage,
  ProfilePage,
  WorkspaceArt,
} from './pages';
import {
  HelpDialog,
  LeaveDetailDialog,
  NewLeaveDialog,
  NotificationsDialog,
  SearchDialog,
} from './dialogs';
import {
  EmployeeFilePage,
  ServicesPage,
  RequestsPage,
  RequestDetailPage,
  AttendancePage,
  DocumentsPage,
  PoliciesPage,
  ReportsPage,
  AuditPage,
  AdminOverviewPanel,
  RequestsInbox,
} from './administration';
import { PayrollPage } from './payroll';
import { EmployeeImportPage } from './imports';

function EmployeeFileRoute() {
  const { id } = useParams();
  return <EmployeeFilePage employeeId={id} />;
}
function RequestRoute() {
  const { id } = useParams();
  return <RequestDetailPage requestId={id!} />;
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className={`brand ${light ? 'brand-light' : ''}`}>
      <img className="brand-logo" src="/brand/sabq-logo.svg" alt="سبق" width="88" height="78" />
      <span className="brand-divider" />
      <span className="brand-description">
        مساحة
        <br />
        <b>الفريق</b>
      </span>
    </span>
  );
}
function PersonaPicker({
  personas,
  onSelect,
  busy,
}: {
  personas: DemoPersona[];
  onSelect: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="persona-list">
      {personas.map((p) => (
        <button
          key={p.id}
          className="persona-button"
          disabled={busy}
          onClick={() => onSelect(p.id)}
        >
          <span className={`persona-symbol ${p.role}`}>
            {p.role === 'hr' ? (
              <Users size={21} />
            ) : p.role === 'manager' ? (
              <ShieldCheck size={21} />
            ) : (
              <UserRound size={21} />
            )}
          </span>
          <span>
            <strong>{p.name}</strong>
            <small>
              {roleLabel[p.role]} · {p.title}
            </small>
          </span>
          {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowLeft size={18} />}
        </button>
      ))}
    </div>
  );
}
function Login({
  personas,
  onSelect,
  busy,
  error,
  hosted,
  privateData,
  privateHosted,
  needsAccess,
  onAccess,
}: {
  personas: DemoPersona[];
  onSelect: (id: string) => void;
  busy: boolean;
  error: string;
  hosted: boolean;
  privateData: boolean;
  privateHosted: boolean;
  needsAccess: boolean;
  onAccess: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  return (
    <main className="login-page">
      <section className="login-story">
        <Brand light />
        <div className="login-story-copy">
          <span>من أجل من يصنعون الخبر.</span>
          <h1>
            فريـق واحـد.
            <br />
            مساحـة تجمعنـا.
          </h1>
          <p>
            تفاصيل أقل تشغلك، ومساحة أكبر لتصنع أثرًا.
            <br />
            أهلًا بك في مساحة فريق سبق.
          </p>
        </div>
        <div className="login-art">
          <WorkspaceArt />
        </div>
        <div className="login-story-footer">
          <span>سبق</span>
          <span>صحافة تصنع الفارق</span>
        </div>
      </section>
      <section className="login-form">
        <div className="login-mobile-brand">
          <Brand />
        </div>
        <div className="login-content">
          <span className="demo-pill">
            {needsAccess || privateHosted
              ? 'بيانات خاصة · دخول محمي'
              : privateData
                ? 'بيانات خاصة · هذا الجهاز فقط'
                : 'معاينة تفاعلية'}
          </span>
          <h2>أهـلًا بك في مساحتـك</h2>
          <p>
            {needsAccess
              ? 'أدخل كلمة مرور الدخول التي حددها مسؤول النظام.'
              : privateData
                ? personas.length
                  ? 'اختر حسابك من الحسابات الممنوحة صلاحية.'
                  : 'لا توجد حسابات ممنوحة بعد. امنح صلاحية الموارد البشرية لحسابك عبر أداة الصلاحيات ثم أعد التحميل.'
                : 'اختر حسابًا لتستكشف التجربة من زاوية مختلفة.'}
          </p>
          {needsAccess ? (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (password) onAccess(password);
              }}
            >
              <label htmlFor="access-password">كلمة المرور</label>
              <input
                id="access-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                required
              />
              <button className="button primary" type="submit" disabled={busy || !password}>
                دخول
              </button>
            </form>
          ) : (
            <PersonaPicker personas={personas} onSelect={onSelect} busy={busy} />
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="login-privacy">
            <ShieldCheck size={19} />
            <p>
              {needsAccess || privateHosted ? (
                <>
                  بيانات موظفين حقيقية محفوظة ومشفرة.
                  <br />
                  لا تشارك كلمة المرور، وأغلق الجلسة على الأجهزة المشتركة.
                </>
              ) : privateData ? (
                <>
                  بيانات موظفين حقيقية محفوظة ومشفرة على هذا الجهاز فقط.
                  <br />
                  لا تشارك الشاشة أو ملف القاعدة أو مفتاح التشفير.
                </>
              ) : (
                <>
                  حسابات وأسماء وهمية للتجربة فقط.
                  <br />
                  لا تستخدم بيانات موظفين حقيقية.
                </>
              )}
              {hosted && (
                <>
                  <br />
                  تجربتك مستقلة عن الزوار الآخرين، وتغييراتك مؤقتة.
                </>
              )}
            </p>
          </div>
        </div>
        <span className="login-footnote">سبق © {new Date().getFullYear()} · مساحة الفريق</span>
      </section>
    </main>
  );
}

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [personas, setPersonas] = useState<DemoPersona[]>([]);
  const [loading, setLoading] = useState(true);
  const [hosted, setHosted] = useState(false);
  const [privateData, setPrivateData] = useState(false);
  const [privateHosted, setPrivateHosted] = useState(false);
  const [needsAccess, setNeedsAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<
    'leave' | 'search' | 'notifications' | 'help' | 'personas' | 'nav' | null
  >(null);
  const [leaveId, setLeaveId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [administrativePending, setAdministrativePending] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    let current = true;
    setAdministrativePending(0);
    if (data)
      void api<{ overview: AdministrativeOverview }>('/admin/overview')
        .then(({ overview }) => {
          if (current)
            setAdministrativePending(overview.requests.filter((request) => request.canAct).length);
        })
        .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [data?.me.id, location.pathname]);
  const refresh = useCallback(async () => {
    const result = await api<Bootstrap>('/bootstrap');
    setData(result);
    setPersonas(result.personas);
  }, []);
  const initialize = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const session = await api<{
        me: Employee | null;
        personas: DemoPersona[];
        mode?: 'synthetic-local' | 'synthetic-hosted' | 'private-local' | 'private-hosted';
      }>('/session');
      setNeedsAccess(false);
      setPersonas(session.personas);
      setHosted(session.mode === 'synthetic-hosted');
      setPrivateData(session.mode === 'private-local' || session.mode === 'private-hosted');
      setPrivateHosted(session.mode === 'private-hosted');
      setData(null);
      if (session.me) await refresh();
    } catch (e) {
      if ((e as { code?: string }).code === 'ACCESS_REQUIRED') setNeedsAccess(true);
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [refresh]);
  const unlock = async (password: string) => {
    setBusy(true);
    setError('');
    try {
      await api('/access', { method: 'POST', body: JSON.stringify({ password }) });
      await initialize();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void initialize();
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [initialize]);
  const signIn = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      // Re-establish an expired preview workspace before selecting a persona.
      await api('/session');
      await api('/demo/session', { method: 'POST', body: JSON.stringify({ employeeId: id }) });
      await refresh();
      setDialog(null);
      setLeaveId(null);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      await api('/session', { method: 'DELETE' });
      setData(null);
      setDialog(null);
      setLeaveId(null);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 6500);
  }, []);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (data) setDialog('search');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [data]);
  useEffect(() => {
    window.scrollTo(0, 0);
    setDialog((d) => (d === 'nav' ? null : d));
    const titles: Record<string, string> = {
      '/': 'لوحة العمل',
      '/profile': 'ملفي الوظيفي',
      '/leaves': 'الإجازات',
      '/approvals': 'الموافقات',
      '/employees': 'دليل الفريق',
      '/calendar': 'تقويم الفريق',
      '/services': 'الخدمات الإدارية',
      '/requests': 'الطلبات الإدارية',
      '/attendance': 'الحضور والعمل',
      '/documents': 'المستندات',
      '/payroll': 'الرواتب',
      '/reports': 'التقارير',
      '/settings/policies': 'القواعد والسياسات',
      '/audit': 'سجل التدقيق',
      '/employees/import': 'استيراد ملفات الموظفين',
    };
    document.title = `${titles[location.pathname] || 'الملف الوظيفي'} | مساحة فريق سبق`;
  }, [location.pathname]);
  if (loading)
    return (
      <main className="boot-state">
        <Brand />
        <LoaderCircle className="spin" size={28} />
        <p>نجهّز مساحتك…</p>
      </main>
    );
  if (!data) {
    if (error && !personas.length && !needsAccess)
      return (
        <main className="boot-state">
          <Brand />
          <h1>تعذّر الاتصال بمساحة العمل</h1>
          <p role="alert">{error}</p>
          <button className="button primary" onClick={() => void initialize()}>
            إعادة المحاولة
          </button>
        </main>
      );
    return (
      <Login
        personas={personas}
        onSelect={(id) => void signIn(id)}
        busy={busy}
        error={error}
        hosted={hosted}
        privateData={privateData}
        privateHosted={privateHosted}
        needsAccess={needsAccess}
        onAccess={(password) => void unlock(password)}
      />
    );
  }
  const actionable = data.leaves.filter(
    (l) =>
      l.employeeId !== data.me.id &&
      ((data.me.role === 'hr' && l.status === 'pending_hr') ||
        (data.me.role === 'manager' &&
          l.status === 'pending_manager' &&
          data.employees.find((e) => e.id === l.employeeId)?.managerId === data.me.id)),
  ).length;
  const navItems = [
    { to: '/', label: 'لوحة العمل', Icon: LayoutGrid },
    { to: '/profile', label: 'ملفي الوظيفي', Icon: UserRound },
    { to: '/leaves', label: 'الإجازات', Icon: CalendarDays },
    { to: '/services', label: 'الخدمات الإدارية', Icon: BriefcaseBusiness },
    { to: '/requests', label: 'طلباتي ومتابعاتي', Icon: Files },
    { to: '/attendance', label: 'الحضور والعمل', Icon: Clock3 },
    ...(['hr', 'manager', 'finance', 'approver'].includes(data.me.role)
      ? [{ to: '/approvals', label: 'الموافقات', Icon: ClipboardCheck }]
      : []),
    ...(['hr', 'manager'].includes(data.me.role)
      ? [{ to: '/employees', label: 'دليل الفريق', Icon: Users }]
      : []),
    { to: '/calendar', label: 'تقويم الفريق', Icon: CalendarDays },
    { to: '/documents', label: 'المستندات', Icon: Files },
    {
      to: '/payroll',
      label: ['employee', 'manager'].includes(data.me.role) ? 'قسائم راتبي' : 'الرواتب',
      Icon: WalletCards,
    },
    ...(['hr', 'finance', 'auditor'].includes(data.me.role)
      ? [{ to: '/reports', label: 'التقارير', Icon: ChartNoAxesCombined }]
      : []),
    ...(['hr', 'approver', 'auditor'].includes(data.me.role)
      ? [{ to: '/settings/policies', label: 'القواعد والسياسات', Icon: Settings2 }]
      : []),
    ...(['hr', 'auditor'].includes(data.me.role)
      ? [{ to: '/audit', label: 'سجل التدقيق', Icon: History }]
      : []),
  ];
  const nav = (
    <nav aria-label="التنقل الرئيسي">
      {navItems.map(({ to, label, Icon }) => (
        <NavLink
          end={to === '/'}
          to={to}
          key={to}
          className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
        >
          <Icon size={20} />
          <span>{label}</span>
          {to === '/approvals' && actionable + administrativePending > 0 && (
            <b className="nav-count">{actionable + administrativePending}</b>
          )}
        </NavLink>
      ))}
    </nav>
  );
  const selectedLeave = leaveId ? data.leaves.find((l) => l.id === leaveId) : null;
  const unread = data.notifications.filter((n) => !n.read).length;
  return (
    <AppContext.Provider
      value={{
        data,
        refresh,
        newLeave: () => setDialog('leave'),
        showLeave: (leave) => setLeaveId(leave.id),
        notify,
      }}
    >
      <a className="skip-link" href="#main-content">
        تجاوز إلى المحتوى
      </a>
      <div
        className="app-shell"
        onClickCapture={(event) => {
          // Safari does not focus pointer-activated buttons. Keep a real opener
          // focused before a dialog mounts so closing it restores focus consistently.
          const button = (event.target as HTMLElement).closest('button');
          button?.focus({ preventScroll: true });
        }}
      >
        <aside className="sidebar">
          <Link to="/" className="brand-link" aria-label="سبق، لوحة العمل">
            <Brand />
          </Link>
          <div className="workspace-label">مساحتك في سبق</div>
          {nav}
          <div className="sidebar-bottom">
            <div className="help-card">
              <span className="help-card-icon">
                <CircleHelp size={23} />
              </span>
              <strong>كل خطوة أوضح</strong>
              <p>دليل سريع يساعدك تبدأ بسهولة.</p>
              <button onClick={() => setDialog('help')}>
                تعرّف على مساحتك
                <ArrowUpLeft size={16} />
              </button>
            </div>
            <button
              className="switch-persona"
              onClick={() => {
                setError('');
                setDialog('personas');
              }}
            >
              <Avatar person={data.me} size="sm" />
              <span>
                <strong>{data.me.name}</strong>
                <small>{roleLabel[data.me.role]}</small>
              </span>
              <ChevronsUpDown size={16} />
            </button>
            <div className="demo-caption">
              <i />
              {privateHosted
                ? 'بيانات خاصة · دخول محمي'
                : privateData
                  ? 'بيانات خاصة · هذا الجهاز فقط'
                  : 'بيئة تجريبية · بيانات وهمية'}
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="topbar-start">
              <button
                className="icon-button mobile-menu"
                onClick={() => setDialog('nav')}
                aria-label="فتح القائمة"
              >
                <Menu size={23} />
              </button>
              <span className="breadcrumb">
                <Home size={15} />
                <ChevronLeft size={13} />
                <span>مساحة الفريق</span>
              </span>
            </div>
            <button className="global-search" onClick={() => setDialog('search')}>
              <Search size={18} />
              <span>ابحث في مساحتك…</span>
              <kbd>⌘ K</kbd>
            </button>
            <div className="topbar-actions">
              <button
                className="icon-button mobile-search"
                onClick={() => setDialog('search')}
                aria-label="البحث"
              >
                <Search size={21} />
              </button>
              <button
                className="icon-button notification-button"
                onClick={() => setDialog('notifications')}
                aria-label={`الإشعارات، ${unread} غير مقروءة`}
              >
                <Bell size={21} />
                {unread > 0 && <span className="notification-dot" />}
              </button>
              <span className="header-divider" />
              <Link to="/profile" className="header-profile" aria-label="عرض ملفي الوظيفي">
                <Avatar person={data.me} size="sm" />
                <span>
                  {data.me.name.split(' ')[0]}
                  <small>{roleLabel[data.me.role]}</small>
                </span>
              </Link>
            </div>
          </header>
          <main id="main-content" className="main-content" tabIndex={-1}>
            <Routes key={data.me.id}>
              <Route
                path="/"
                element={
                  <>
                    <Dashboard />
                    <AdminOverviewPanel openRequest={(id) => navigate(`/requests/${id}`)} />
                  </>
                }
              />
              <Route path="/profile" element={<ProfilePage self />} />
              <Route path="/profile/file" element={<EmployeeFilePage />} />
              <Route path="/employees" element={<PeoplePage />} />
              <Route path="/employees/import" element={<EmployeeImportPage />} />
              <Route path="/employees/:id" element={<ProfilePage />} />
              <Route path="/employees/:id/file" element={<EmployeeFileRoute />} />
              <Route path="/leaves" element={<LeavesPage />} />
              <Route
                path="/approvals"
                element={
                  <>
                    <ApprovalsPage />
                    <RequestsInbox openRequest={(id) => navigate(`/requests/${id}`)} />
                  </>
                }
              />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/services" element={<ServicesPage />} />
              <Route
                path="/requests"
                element={<RequestsPage openRequest={(id) => navigate(`/requests/${id}`)} />}
              />
              <Route path="/requests/:id" element={<RequestRoute />} />
              <Route path="/attendance" element={<AttendancePage />} />
              <Route path="/documents" element={<DocumentsPage />} />
              <Route path="/payroll" element={<PayrollPage actor={data.me} />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/settings/policies" element={<PoliciesPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="*" element={<Navigate replace to="/" />} />
            </Routes>
          </main>
          <footer className="app-footer">
            <span>سبق · مساحة الفريق</span>
            <span>
              {privateHosted
                ? 'بيانات خاصة · دخول محمي بكلمة مرور'
                : privateData
                  ? 'بيانات خاصة · على هذا الجهاز فقط'
                  : hosted
                    ? 'تجربتك مستقلة · بيانات وهمية وتغييرات مؤقتة'
                    : 'بيانات تجريبية فقط'}
            </span>
          </footer>
        </div>
      </div>
      {dialog === 'leave' && (
        <NewLeaveDialog close={() => setDialog(null)} switchPersona={() => setDialog('personas')} />
      )}
      {dialog === 'search' && <SearchDialog close={() => setDialog(null)} />}
      {dialog === 'notifications' && <NotificationsDialog close={() => setDialog(null)} />}
      {dialog === 'help' && <HelpDialog close={() => setDialog(null)} />}
      {dialog === 'nav' && (
        <Modal title="مساحة الفريق" close={() => setDialog(null)} className="mobile-nav-dialog">
          {nav}
          <div className="mobile-nav-actions">
            <button className="button quiet" onClick={() => setDialog('help')}>
              <CircleHelp size={18} />
              دليل الاستخدام
            </button>
            <button className="button quiet" onClick={() => setDialog('personas')}>
              <Users size={18} />
              تبديل حساب التجربة
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'personas' && (
        <Modal
          title="تبديل حساب التجربة"
          close={() => {
            if (!busy) setDialog(null);
          }}
        >
          <div className="dialog-body">
            <p className="dialog-intro">استكشف اختلاف البيانات والصلاحيات بين الأدوار.</p>
            <PersonaPicker personas={personas} onSelect={(id) => void signIn(id)} busy={busy} />
            {error && (
              <div role="alert" className="form-error">
                {error}
              </div>
            )}
            <button
              className="button quiet logout-button"
              onClick={() => void signOut()}
              disabled={busy}
            >
              <LogOut size={17} />
              تسجيل الخروج من التجربة
            </button>
          </div>
        </Modal>
      )}
      {selectedLeave && (
        <LeaveDetailDialog
          key={selectedLeave.id}
          leave={selectedLeave}
          close={() => setLeaveId(null)}
        />
      )}
      <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">
        {toast && (
          <>
            <span>
              <Check size={18} />
            </span>
            {toast}
            <button onClick={() => setToast('')} aria-label="إغلاق التنبيه">
              <X size={16} />
            </button>
          </>
        )}
      </div>
    </AppContext.Provider>
  );
}
