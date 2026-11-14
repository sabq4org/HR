import { useCallback, useEffect, useState } from 'react';
import { Lock, LockOpen, Plus } from 'lucide-react';
import {
  purchaseTaxCodes,
  taxCodeLabel,
  type AccountStatement,
  type AccountType,
  type LedgerAccount,
  type PeriodLock,
} from '../../../shared/ledger';
import { Alert, Empty, Field, Status } from '../index';
import {
  AccountSelect,
  downloadCsv,
  errorText,
  fmt,
  LedgerForm,
  Money,
  read,
  today,
  useLoad,
  useMutate,
  yearStart,
  type ViewProps,
} from './shared';

const typeLabel: Record<AccountType, string> = {
  asset: 'أصول',
  liability: 'خصوم',
  equity: 'حقوق ملكية',
  revenue: 'إيرادات',
  expense: 'مصروفات',
};
const months = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];
type Tab = 'chart' | 'statement' | 'periods' | 'settings';
type Form = { kind: 'add' } | { kind: 'edit'; account: LedgerAccount };

function Statement({ accounts, initial }: { accounts: LedgerAccount[]; initial: string }) {
  const [code, setCode] = useState(initial);
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const load = useCallback(
    async () =>
      code ? read<AccountStatement>(`/reports/account/${code}?from=${from}&to=${to}`) : null,
    [code, from, to],
  );
  const { data, error, run } = useLoad(load);
  useEffect(() => {
    void run();
  }, [run]);
  return (
    <>
      <div className="led-filters">
        <Field label="الحساب">
          <AccountSelect accounts={accounts} value={code} onChange={setCode} filter={() => true} />
        </Field>
        <Field label="من">
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="إلى">
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <button
          className="button secondary"
          disabled={!data}
          onClick={() =>
            data &&
            downloadCsv(`account-${data.account.code}-${from}-${to}`, [
              ['التاريخ', 'رقم القيد', 'البيان', 'مدين', 'دائن', 'الرصيد'],
              ['', '', 'رصيد أول المدة', '', '', (data.openingHalalas / 100).toFixed(2)],
              ...data.rows.map((row) => [
                row.date,
                row.entryNumber,
                row.memo || row.description,
                (row.debitHalalas / 100).toFixed(2),
                (row.creditHalalas / 100).toFixed(2),
                (row.balanceHalalas / 100).toFixed(2),
              ]),
            ])
          }
        >
          تصدير CSV
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {data?.truncated && (
        <Alert>
          تُعرض أول 2000 حركة فقط، والرصيد الختامي يشمل كل الحركات. ضيّق المدة لرؤية الباقي.
        </Alert>
      )}
      {!code ? (
        <Empty title="اختر حسابًا" detail="كشف الحساب يعرض كل حركة ورصيدها الجاري." />
      ) : (
        data && (
          <div className="fin-table-wrap">
            <table className="fin-table">
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>القيد</th>
                  <th>البيان</th>
                  <th>مدين</th>
                  <th>دائن</th>
                  <th>الرصيد</th>
                </tr>
              </thead>
              <tbody>
                <tr className="led-subtotal">
                  <td colSpan={5}>رصيد أول المدة</td>
                  <td className="num">
                    <Money value={data.openingHalalas} signed />
                  </td>
                </tr>
                {data.rows.map((row, index) => (
                  <tr key={`${row.entryId}-${index}`}>
                    <td className="num">{row.date}</td>
                    <td className="num">{row.entryNumber}</td>
                    <td>{row.memo || row.description}</td>
                    <td className="num">{row.debitHalalas ? fmt(row.debitHalalas) : ''}</td>
                    <td className="num">{row.creditHalalas ? fmt(row.creditHalalas) : ''}</td>
                    <td className="num">
                      <Money value={row.balanceHalalas} signed />
                    </td>
                  </tr>
                ))}
                <tr className="led-subtotal">
                  <td colSpan={5}>
                    رصيد آخر المدة ({data.account.normalSide === 'debit' ? 'مدين' : 'دائن'} بطبيعته)
                  </td>
                  <td className="num">
                    <Money value={data.closingHalalas} signed />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
}

function Periods({
  locks,
  reload,
  notify,
}: { locks: PeriodLock[] } & Pick<ViewProps, 'reload' | 'notify'>) {
  const mutate = useMutate();
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(0);
  const toggle = async (month: number, locked: boolean) => {
    setBusy(month);
    setError('');
    try {
      await mutate('/periods', { year, month, locked });
      await reload();
      notify(locked ? 'أُقفل الشهر.' : 'أُعيد فتح الشهر.');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(0);
    }
  };
  return (
    <>
      <div className="led-filters">
        <Field label="السنة">
          <input
            type="number"
            value={year}
            min={2000}
            max={2100}
            onChange={(e) => setYear(Number(e.target.value))}
          />
        </Field>
        <p className="led-muted">
          الشهر المقفل لا يقبل قيودًا جديدة ولا قيودًا عكسية بتاريخه. شهور الإقرار الضريبي المقفل لا
          تُفتح.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="led-months">
        {months.map((name, index) => {
          const lock = locks.find(
            (item) => item.year === year && item.month === index + 1 && item.locked,
          );
          return (
            <div key={name} className={lock ? 'locked' : ''}>
              {lock ? <Lock size={16} /> : <LockOpen size={16} />}
              <b>{name}</b>
              <small>
                {lock ? (lock.reason === 'vat' ? 'مقفل بإقرار ضريبي' : 'مقفل') : 'مفتوح'}
              </small>
              {lock?.reason !== 'vat' && (
                <button
                  className="text-button"
                  disabled={busy === index + 1}
                  onClick={() => void toggle(index + 1, !lock)}
                >
                  {lock ? 'إعادة فتح' : 'إقفال'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Settings({ overview, reload, notify }: Pick<ViewProps, 'overview' | 'reload' | 'notify'>) {
  const mutate = useMutate();
  const { settings, accounts } = overview;
  const [frequency, setFrequency] = useState(settings.filingFrequency);
  const [revenue, setRevenue] = useState(settings.defaultRevenueAccount);
  const [cash, setCash] = useState(settings.defaultCashAccount);
  const [limit, setLimit] = useState((settings.vatCorrectionLimitHalalas / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="fin-dialog-form led-settings"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        mutate(
          '/settings',
          {
            version: settings.version,
            filingFrequency: frequency,
            defaultRevenueAccount: revenue,
            defaultCashAccount: cash,
            vatCorrectionLimit: limit,
          },
          'PATCH',
        )
          .then(async () => {
            await reload();
            notify('حُفظت إعدادات الدفاتر.');
          })
          .catch((failure: unknown) => setError(errorText(failure)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="fin-grid">
        <Field
          label="دورية الإقرار الضريبي"
          hint="شهري إذا تجاوزت التوريدات السنوية 40 مليون ريال، وربعي لما دون ذلك. الدورية تحددها الهيئة في شهادة التسجيل."
        >
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as typeof frequency)}
          >
            <option value="quarterly">ربع سنوي</option>
            <option value="monthly">شهري</option>
          </select>
        </Field>
        <Field label="حساب الإيراد الافتراضي" hint="يُستخدم عند ترحيل الفواتير المعتمدة تلقائيًا.">
          <AccountSelect
            accounts={accounts}
            value={revenue}
            onChange={setRevenue}
            filter={(account) => account.type === 'revenue' && !account.systemKey}
          />
        </Field>
        <Field label="حساب البنك الافتراضي">
          <AccountSelect
            accounts={accounts}
            value={cash}
            onChange={setCash}
            filter={(account) => account.isCash}
          />
        </Field>
        <Field
          label="حد تصحيح الأخطاء في إقرار لاحق (ر.س)"
          hint="15,000 ريال بحسب المادة 63 من اللائحة التنفيذية. يعدّله محاسبك إن تغيّر الحد."
        >
          <input
            inputMode="decimal"
            dir="ltr"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            required
          />
        </Field>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="fin-form-actions">
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
        </button>
      </div>
    </form>
  );
}

export function Accounts({ overview, reload, notify }: ViewProps) {
  const mutate = useMutate();
  const [tab, setTab] = useState<Tab>('chart');
  const [statementCode, setStatementCode] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [isCash, setIsCash] = useState(false);
  const [taxCode, setTaxCode] = useState('');
  const [active, setActive] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const { accounts } = overview;
  const open = (next: Form) => {
    setCode('');
    setName(next.kind === 'edit' ? next.account.name : '');
    setParent('');
    setIsCash(false);
    setTaxCode('');
    setActive(next.kind === 'edit' ? next.account.active : true);
    setForm(next);
    window.scrollTo({ top: 0 });
  };
  const done = async (message: string) => {
    setForm(null);
    await reload();
    notify(message);
  };
  if (form?.kind === 'add') {
    const group = accounts.find((item) => item.code === parent);
    return (
      <LedgerForm
        title="إضافة حساب"
        close={() => setForm(null)}
        submitLabel="إضافة الحساب"
        note="الحساب الجديد يرث نوعه وطبيعته (مدين أو دائن) من مجموعته. رمز الحساب لا يتغير بعد إنشائه."
        submit={async () => {
          await mutate('/accounts', {
            code,
            name,
            parentCode: parent,
            isCash,
            defaultTaxCode: taxCode || null,
          });
          await done('أُضيف الحساب.');
        }}
      >
        <div className="fin-grid">
          <Field label="المجموعة">
            <select value={parent} onChange={(e) => setParent(e.target.value)} required>
              <option value="">اختر المجموعة</option>
              {accounts
                .filter((item) => !item.postable && item.code.length >= 2)
                .map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code} · {item.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="رمز الحساب"
            hint={group ? `يبدأ بـ ${group.code}، أرقام فقط.` : 'أرقام فقط.'}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              pattern="\d{3,8}"
              required
            />
          </Field>
          <Field label="اسم الحساب">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
          </Field>
          {group?.type === 'asset' && (
            <Field label="نوع الأصل">
              <select value={isCash ? '1' : ''} onChange={(e) => setIsCash(e.target.value === '1')}>
                <option value="">أصل عادي</option>
                <option value="1">نقد أو بنك (يظهر في التحصيل والسداد)</option>
              </select>
            </Field>
          )}
          {(group?.type === 'expense' || group?.type === 'asset') && !isCash && (
            <Field label="المعالجة الضريبية المقترحة" hint="تُقترح عند تسجيل مصروف على هذا الحساب.">
              <select value={taxCode} onChange={(e) => setTaxCode(e.target.value)}>
                <option value="">بلا اقتراح</option>
                {purchaseTaxCodes.map((item) => (
                  <option key={item} value={item}>
                    {taxCodeLabel[item]}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </LedgerForm>
    );
  }
  if (form?.kind === 'edit') {
    const account = form.account;
    return (
      <LedgerForm
        title={`تعديل الحساب ${account.code}`}
        close={() => setForm(null)}
        submitLabel="حفظ"
        note="إيقاف الحساب يمنع الترحيل عليه مستقبلًا ولا يمس حركاته السابقة. الحسابات لا تُحذف."
        submit={async () => {
          await mutate(
            `/accounts/${account.code}`,
            { version: account.version, name, active },
            'PATCH',
          );
          await done('حُفظ الحساب.');
        }}
      >
        <div className="fin-grid">
          <Field label="اسم الحساب">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
          </Field>
          <Field
            label="الحالة"
            hint={account.systemKey ? 'حساب نظامي تعتمد عليه القيود الآلية؛ لا يُوقف.' : undefined}
          >
            <select
              value={active ? '1' : ''}
              onChange={(e) => setActive(e.target.value === '1')}
              disabled={Boolean(account.systemKey)}
            >
              <option value="1">نشط</option>
              <option value="">موقوف</option>
            </select>
          </Field>
        </div>
      </LedgerForm>
    );
  }
  const visible = accounts.filter((item) => showInactive || item.active);
  // A group's balance is the sum of its postable descendants, in the group's normal direction.
  const groupBalance = (group: LedgerAccount) =>
    accounts
      .filter((item) => item.postable && item.code.startsWith(group.code))
      .reduce(
        (sum, item) =>
          sum + (item.normalSide === group.normalSide ? item.balanceHalalas : -item.balanceHalalas),
        0,
      );
  return (
    <section className="fin-section">
      <div className="fin-section-head">
        <div>
          <h2>الحسابات والأستاذ العام</h2>
          <p>دليل الحسابات بأرصدته، وكشف كل حساب، وإقفال الشهور، وإعدادات الدفاتر.</p>
        </div>
        {tab === 'chart' && (
          <button className="button primary" onClick={() => open({ kind: 'add' })}>
            <Plus size={17} />
            إضافة حساب
          </button>
        )}
      </div>
      <div className="led-subtabs" role="tablist">
        {(
          [
            ['chart', 'دليل الحسابات'],
            ['statement', 'كشف حساب'],
            ['periods', 'إقفال الشهور'],
            ['settings', 'إعدادات الدفاتر'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'chart' && (
        <>
          <label className="led-check">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            إظهار الحسابات الموقوفة
          </label>
          <div className="fin-table-wrap">
            <table className="fin-table led-chart-table">
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th>الحساب</th>
                  <th>النوع</th>
                  <th>طبيعته</th>
                  <th>الرصيد</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((account) => (
                  <tr
                    key={account.code}
                    className={`${account.postable ? '' : `group depth-${account.code.length}`}${account.active ? '' : ' led-reversed'}`}
                  >
                    <td className="num">{account.code}</td>
                    <td>
                      <span className={`led-indent d${Math.min(account.code.length, 4)}`}>
                        {account.name}
                      </span>
                      {account.systemKey && <Status text="نظامي" />}
                      {!account.active && <Status text="موقوف" kind="bad" />}
                    </td>
                    <td>{typeLabel[account.type]}</td>
                    <td>{account.normalSide === 'debit' ? 'مدين' : 'دائن'}</td>
                    <td className="num">
                      <Money
                        value={account.postable ? account.balanceHalalas : groupBalance(account)}
                        signed
                      />
                    </td>
                    <td className="fin-actions">
                      {account.postable && (
                        <>
                          <button
                            className="text-button"
                            onClick={() => {
                              setStatementCode(account.code);
                              setTab('statement');
                            }}
                          >
                            كشف
                          </button>
                          <button
                            className="text-button"
                            onClick={() => open({ kind: 'edit', account })}
                          >
                            تعديل
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === 'statement' && (
        <Statement key={statementCode} accounts={accounts} initial={statementCode} />
      )}
      {tab === 'periods' && <Periods locks={overview.locks} reload={reload} notify={notify} />}
      {tab === 'settings' && (
        <Settings
          key={overview.settings.version}
          overview={overview}
          reload={reload}
          notify={notify}
        />
      )}
    </section>
  );
}
