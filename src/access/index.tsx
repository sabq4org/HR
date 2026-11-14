import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, roleLabel, useApp } from '../lib';
import type { Role } from '../../shared/contracts';
import type { AccountSummary } from '../../shared/access';
import './access.css';

type Authenticated = { me: { id: string; name: string; employeeNumber: string; role: Role } };
type AccountRows = { accounts: AccountSummary[] };
type Candidates = {
  employees: Array<{
    id: string;
    name: string;
    employee_number: string;
    role: Role;
    status: string;
    email: string;
  }>;
};
type PendingChanges = {
  changes: Array<{
    id: string;
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    currentRole: Role;
    requestedRole: Role;
    requestedBy: string;
    state: string;
    createdAt: string;
  }>;
};

export function AccountLogin({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api<Authenticated>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginName, password, otp }),
      });
      await onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تسجيل الدخول.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-login account-login-branded" dir="rtl">
      <aside className="account-brand-side">
        <img src="/brand/sabq-logo.svg" alt="سبق" />
        <span>مساحة الفريق</span>
        <h2>وصول آمن إلى شؤون الموظفين</h2>
        <p>حسابات داخلية محمية بكلمة مرور ومصادقة ثنائية.</p>
      </aside>
      <section className="account-login-card" aria-labelledby="account-login-title">
        <span className="account-kicker">مساحة الفريق · دخول الموظفين</span>
        <h1 id="account-login-title">تسجيل الدخول</h1>
        <p>استخدم حسابك ورمز المصادقة الثنائية للمتابعة.</p>
        <form onSubmit={submit}>
          <label className="account-field">
            البريد الإلكتروني
            <input
              autoComplete="username"
              type="email"
              required
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              dir="ltr"
            />
          </label>
          <label className="account-field">
            كلمة المرور
            <input
              autoComplete="current-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              dir="ltr"
            />
          </label>
          <label className="account-field">
            {recovery ? 'رمز استرداد لمرة واحدة' : 'رمز المصادقة'}
            <input
              autoComplete="one-time-code"
              inputMode={recovery ? 'text' : 'numeric'}
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              dir="ltr"
            />
          </label>
          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}
          <button className="account-primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ التحقق…' : 'دخول آمن'}
          </button>
        </form>
        <button
          className="account-link"
          type="button"
          onClick={() => {
            setRecovery(!recovery);
            setOtp('');
          }}
        >
          {recovery ? 'استخدم رمز المصادقة' : 'استخدم رمز استرداد'}
        </button>
      </section>
    </main>
  );
}

export function AccountActivationPage({ onComplete }: { onComplete?: () => void }) {
  const [token] = useState(() => {
    return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  });
  const consumedFragment = useRef(false);
  const [setup, setSetup] = useState<{ secret: string; uri: string; loginName: string }>();
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) {
      setError('رابط التفعيل غير صالح أو انتهت صلاحيته.');
      return;
    }
    if (!consumedFragment.current) {
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
      consumedFragment.current = true;
    }
    void api<{ secret: string; uri: string; loginName: string }>('/auth/activation/setup', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then(setSetup)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'تعذر بدء التفعيل.'),
      );
  }, [token]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ activated: boolean; recoveryCodes: string[] }>(
        '/auth/activation/complete',
        { method: 'POST', body: JSON.stringify({ token, password, otp }) },
      );
      setCodes(result.recoveryCodes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تفعيل الحساب.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-login" dir="rtl">
      <section
        className="account-login-card account-activation-card"
        aria-labelledby="activation-title"
      >
        <span className="account-kicker">تفعيل حساب الموظف</span>
        <h1 id="activation-title">إعداد الدخول الآمن</h1>
        {codes ? (
          <>
            <p className="account-error">احفظ رموز الاسترداد الآن؛ لن تظهر مرة أخرى.</p>
            <ul className="recovery-codes" dir="ltr">
              {codes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <button
              className="account-primary"
              onClick={
                onComplete ??
                (() => {
                  window.location.assign('/');
                })
              }
            >
              تم الحفظ والعودة
            </button>
          </>
        ) : (
          <>
            <p>
              أضف حسابًا يدويًا في تطبيق المصادقة باستخدام المفتاح التالي، ثم أدخل الرمز الظاهر فيه.
            </p>
            {setup && (
              <div className="account-setup-box">
                <b>حساب المصادقة</b>
                <code>{setup.loginName}</code>
                <b>مفتاح الإعداد اليدوي</b>
                <code dir="ltr">{setup.secret}</code>
                <details>
                  <summary>رابط تطبيق المصادقة</summary>
                  <code dir="ltr">{setup.uri}</code>
                </details>
              </div>
            )}
            <form onSubmit={submit}>
              <label className="account-field">
                كلمة مرور جديدة
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                />
                <small>12 حرفًا على الأقل</small>
              </label>
              <label className="account-field">
                رمز المصادقة من ستة أرقام
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  dir="ltr"
                />
              </label>
              {error && (
                <p className="account-error" role="alert">
                  {error}
                </p>
              )}
              <button className="account-primary" disabled={busy || !setup}>
                {busy ? 'جارٍ التفعيل…' : 'تفعيل الحساب'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

export function AccountsPage() {
  const { data, notify } = useApp();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [candidates, setCandidates] = useState<Candidates['employees']>([]);
  const [changes, setChanges] = useState<PendingChanges['changes']>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [loginName, setLoginName] = useState('');
  const [provisionRole, setProvisionRole] = useState<Role>('employee');
  const [provisionOtp, setProvisionOtp] = useState('');
  const [activationUrl, setActivationUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rotationOtp, setRotationOtp] = useState('');
  const [rotatedCodes, setRotatedCodes] = useState<string[]>();
  const isHr = data.me.role === 'hr';
  const canReview = data.me.role === 'approver';
  const reload = async () => {
    if (isHr) {
      const [a, c, r] = await Promise.all([
        api<AccountRows>('/accounts'),
        api<Candidates>('/accounts/candidates'),
        api<PendingChanges>('/accounts/role-changes'),
      ]);
      setAccounts(a.accounts);
      setCandidates(c.employees);
      setChanges(r.changes);
    } else if (canReview) {
      const r = await api<PendingChanges>('/accounts/role-changes');
      setChanges(r.changes);
    }
  };
  useEffect(() => {
    void reload().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : 'تعذر تحميل الحسابات.'),
    );
  }, []);
  async function provision(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ activationUrl: string }>(
        '/accounts/' + encodeURIComponent(employeeId) + '/provision',
        { method: 'POST', body: JSON.stringify({ loginName, otp: provisionOtp }) },
      );
      setActivationUrl(new URL(result.activationUrl, window.location.origin).href);
      setEmployeeId('');
      setLoginName('');
      setProvisionRole('employee');
      setProvisionOtp('');
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إنشاء الحساب.');
    } finally {
      setBusy(false);
    }
  }
  async function accountAction(id: string, action: 'disable' | 'reset') {
    setError('');
    const otp =
      action === 'reset' ? window.prompt('رمز المصادقة الجديد لتأكيد إعادة الضبط') : undefined;
    if (action === 'reset' && otp === null) return;
    try {
      const result = await api<{ activationUrl?: string }>(
        '/accounts/' + encodeURIComponent(id) + '/' + action,
        { method: 'POST', body: JSON.stringify(action === 'reset' ? { otp } : {}) },
      );
      if (result?.activationUrl)
        setActivationUrl(new URL(result.activationUrl, window.location.origin).href);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إكمال الإجراء.');
    }
  }
  async function proposeRole(id: string, role: Role) {
    try {
      await api(`/accounts/${encodeURIComponent(id)}/role-change`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      });
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر اقتراح الدور.');
    }
  }
  async function decideRole(id: string, decision: 'approve' | 'reject') {
    const otp =
      decision === 'approve'
        ? window.prompt('رمز مصادقة جديد لتأكيد اعتماد تغيير الدور')
        : undefined;
    if (decision === 'approve' && otp === null) return;
    try {
      await api(`/accounts/role-changes/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, otp }),
      });
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر حسم الطلب.');
    }
  }
  async function logout() {
    try {
      await api('/auth/session', { method: 'DELETE' });
      window.location.assign('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تسجيل الخروج.');
    }
  }
  async function rotateRecoveryCodes(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const result = await api<{ recoveryCodes: string[] }>('/auth/recovery-codes/rotate', {
        method: 'POST',
        body: JSON.stringify({ otp: rotationOtp }),
      });
      setRotatedCodes(result.recoveryCodes);
      setRotationOtp('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إصدار الرموز.');
    }
  }
  return (
    <section className="accounts-page" dir="rtl">
      <header className="accounts-header">
        <div>
          <span className="account-kicker">إدارة الوصول</span>
          <h1>حسابات الموظفين</h1>
          <p>دخول بكلمة مرور ومصادقة ثنائية إلزامية.</p>
        </div>
        <button className="account-secondary" onClick={logout}>
          تسجيل الخروج
        </button>
      </header>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      {activationUrl && (
        <section className="account-activation-notice">
          <b>رابط تفعيل لمرة واحدة</b>
          <p>أرسله للموظف عبر قناة داخلية موثوقة. ينتهي بعد 30 دقيقة.</p>
          <code dir="ltr">{activationUrl}</code>
          <button
            className="account-secondary"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(activationUrl)
                .then(() => notify('نُسخ رابط التفعيل'))
            }
          >
            نسخ الرابط
          </button>
        </section>
      )}
      <section className="account-panel">
        <h2>رموز الاسترداد الخاصة بي</h2>
        <p>أصدر مجموعة جديدة باستخدام رمز المصادقة الحالي؛ تُلغى الرموز السابقة.</p>
        <form className="recovery-rotation-form" onSubmit={rotateRecoveryCodes}>
          <label className="account-field">
            رمز المصادقة
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={rotationOtp}
              onChange={(e) => setRotationOtp(e.target.value)}
              dir="ltr"
            />
          </label>
          <button className="account-secondary">تدوير الرموز</button>
        </form>
        {rotatedCodes && (
          <>
            <p className="account-error">احفظ الرموز الجديدة الآن؛ لن تظهر مرة أخرى.</p>
            <ul className="recovery-codes" dir="ltr">
              {rotatedCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          </>
        )}
      </section>
      {isHr && (
        <section className="account-panel">
          <h2>إنشاء حساب</h2>
          <form className="account-provision-form" onSubmit={provision}>
            <label className="account-field">
              الموظف
              <select
                required
                value={employeeId}
                onChange={(e) => {
                  setEmployeeId(e.target.value);
                  const c = candidates.find((x) => x.id === e.target.value);
                  setLoginName(c?.email ?? '');
                  setProvisionRole(c?.role ?? 'employee');
                }}
              >
                <option value="">اختر موظفًا</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.employee_number} · {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="account-field">
              بريد الدخول
              <input
                type="email"
                required
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                dir="ltr"
              />
            </label>
            {['hr', 'approver', 'finance'].includes(provisionRole) && (
              <label className="account-field">
                رمز مصادقة جديد لتأكيد إصدار حساب ذي صلاحيات مرتفعة
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={provisionOtp}
                  onChange={(e) => setProvisionOtp(e.target.value)}
                  dir="ltr"
                />
              </label>
            )}
            <button className="account-primary" disabled={busy || !employeeId}>
              إصدار رابط تفعيل
            </button>
          </form>
        </section>
      )}
      {isHr && (
        <section className="account-panel">
          <h2>الحسابات الحالية</h2>
          <div className="account-table-wrap">
            <table className="account-table">
              <thead>
                <tr>
                  <th>الموظف</th>
                  <th>دخول</th>
                  <th>الدور</th>
                  <th>الحالة</th>
                  <th>الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.employeeId}>
                    <td>
                      {a.employeeName}
                      <small>{a.employeeNumber}</small>
                    </td>
                    <td dir="ltr">{a.loginName}</td>
                    <td>{roleLabel[a.role]}</td>
                    <td>{a.enabled ? (a.activatedAt ? 'نشط' : 'بانتظار التفعيل') : 'معطل'}</td>
                    <td className="account-actions">
                      {a.employeeId !== data.me.id && (
                        <>
                          <button
                            onClick={() =>
                              void accountAction(a.employeeId, a.enabled ? 'disable' : 'reset')
                            }
                          >
                            {a.enabled ? 'تعطيل' : 'إعادة ضبط'}
                          </button>
                          <select
                            aria-label={`اقتراح دور ${a.employeeName}`}
                            value=""
                            onChange={(e) => {
                              if (e.target.value)
                                void proposeRole(a.employeeId, e.target.value as Role);
                            }}
                          >
                            <option value="">اقتراح دور</option>
                            {(
                              [
                                'employee',
                                'manager',
                                'hr',
                                'finance',
                                'approver',
                                'auditor',
                              ] as Role[]
                            )
                              .filter((r) => r !== a.role)
                              .map((r) => (
                                <option value={r} key={r}>
                                  {roleLabel[r]}
                                </option>
                              ))}
                          </select>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {accounts.length === 0 && <p className="account-empty">لا توجد حسابات بعد.</p>}
          </div>
        </section>
      )}
      {changes.length > 0 && (
        <section className="account-panel">
          <h2>طلبات تغيير الدور</h2>
          {changes.map((change) => (
            <article className="role-change-row" key={change.id}>
              <div>
                <b>{change.employeeName}</b>
                <small>
                  {roleLabel[change.currentRole]} ← {roleLabel[change.requestedRole]}
                </small>
              </div>
              {canReview ? (
                <div className="account-actions">
                  <button onClick={() => void decideRole(change.id, 'approve')}>اعتماد</button>
                  <button onClick={() => void decideRole(change.id, 'reject')}>رفض</button>
                </div>
              ) : (
                <span>بانتظار المعتمد</span>
              )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
