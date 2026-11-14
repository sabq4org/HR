// The payroll register in the owner's template layout: the on-screen table and the printed
// A4 landscape register with electronic sign-off blocks. Both read buildPayrollRegister.
import type { PayrollRun } from '../../shared/administration';
import { GOSI_CATEGORY_LABEL } from '../../shared/gosi';
import {
  buildPayrollRegister,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATE_LABEL,
  REGISTER_COLUMNS,
  type PayrollRegister,
  type RegisterAmounts,
} from '../../shared/payroll-register';

const amount = (minor: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
const stamp = (iso: string) =>
  new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Riyadh',
  }).format(new Date(iso));
export const periodName = (period: string) => {
  const [year, month] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year!, month! - 1, 1)));
};
const STATE_LABEL: Record<PayrollRun['state'], string> = {
  draft: 'مسودة',
  pending_finance: 'بانتظار مراجعة المالية',
  pending_approver: 'بانتظار اعتماد المدير العام',
  closed: 'معتمد ومغلق',
  rejected: 'مرفوض',
};

/**
 * Electronic sign-off read from the run's append-only timeline: who acted, in which role, when
 * and on which run version. Nothing here is a legal e-signature service.
 */
export function signatures(run: PayrollRun) {
  const last = (actions: string[]) =>
    [...run.timeline].reverse().find((event) => actions.includes(event.action));
  const rejectedAfter = (at?: string) =>
    !!at && run.timeline.some((e) => e.action === 'reject' && e.createdAt > at);
  const block = (title: string, role: string, actions: string[]) => {
    const event = last(actions);
    const valid = event && !rejectedAfter(event.createdAt);
    return {
      title,
      role,
      name: valid ? event!.actorName : '',
      at: valid ? event!.createdAt : '',
      version: valid ? event!.version : 0,
    };
  };
  return [
    block('الموارد البشرية', 'إعداد المسير وإرساله', ['submit']),
    block('مدير الإدارة المالية', 'مراجعة وتوقيع', ['review']),
    block('المدير العام', 'اعتماد وتوقيع', ['approve']),
  ];
}

function AmountCells({ values }: { values: RegisterAmounts }) {
  return (
    <>
      {REGISTER_COLUMNS.map(([key]) => (
        <td
          key={key}
          className={`num ${key === 'netMinor' ? 'net' : ''} ${key === 'totalDeductionsMinor' || key === 'insuranceMinor' || key === 'deductionsMinor' ? 'minus' : ''}`}
        >
          {amount(values[key])}
        </td>
      ))}
    </>
  );
}

function RegisterTables({ register, compact }: { register: PayrollRegister; compact?: boolean }) {
  let index = 0;
  return (
    <>
      {register.groups.map((group) => (
        <section className="register-group" key={group.method}>
          <h3>
            {group.label} <small>({group.rows.length} موظف)</small>
          </h3>
          <div
            className="payroll-table-wrap register-wrap"
            role="region"
            aria-label={`جدول ${group.label}`}
            tabIndex={0}
          >
            <table className="register-table">
              <thead>
                <tr>
                  <th>م</th>
                  <th>اسم الموظف</th>
                  <th>المسمى الوظيفي</th>
                  {REGISTER_COLUMNS.map(([key, label]) => (
                    <th key={key}>{label}</th>
                  ))}
                  {!compact && <th>فئة التأمينات</th>}
                  <th>حالة الدفع</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="num">{++index}</td>
                    <td className="name">{row.employeeName}</td>
                    <td className="muted">{row.title || '—'}</td>
                    <AmountCells values={row} />
                    {!compact && (
                      <td className="muted">
                        {row.employmentType === 'contractor'
                          ? 'متعاون · بلا تأمينات'
                          : row.insuranceCategory
                            ? `${GOSI_CATEGORY_LABEL[row.insuranceCategory]}${row.insuranceCategoryInferred ? ' (مستنتجة)' : ''}`
                            : '—'}
                      </td>
                    )}
                    <td className={`pay-state ${row.paymentState}`}>
                      {PAYMENT_STATE_LABEL[row.paymentState]}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>مجموع {group.label}</td>
                  <AmountCells values={group.totals} />
                  {!compact && <td />}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function Summary({ register }: { register: PayrollRegister }) {
  return (
    <dl className="register-summary">
      <div>
        <dt>عدد الموظفين</dt>
        <dd>{register.employeeCount}</dd>
      </div>
      <div>
        <dt>إجمالي الرواتب</dt>
        <dd>{amount(register.totals.grossMinor)}</dd>
      </div>
      <div>
        <dt>إجمالي الخصومات</dt>
        <dd>{amount(register.totals.totalDeductionsMinor)}</dd>
      </div>
      <div className="strong">
        <dt>صافي المسير</dt>
        <dd>{amount(register.totals.netMinor)}</dd>
      </div>
      {register.groups.map((group) => (
        <div key={group.method}>
          <dt>صافي {group.label}</dt>
          <dd>{amount(group.totals.netMinor)}</dd>
        </div>
      ))}
      <div>
        <dt>المدفوع</dt>
        <dd>
          {amount(register.paid.amountMinor)} ({register.paid.count} موظف)
        </dd>
      </div>
      <div>
        <dt>غير المدفوع</dt>
        <dd>
          {amount(register.unpaid.amountMinor)} ({register.unpaid.count} موظف)
        </dd>
      </div>
      <div>
        <dt>حصة صاحب العمل في التأمينات (لا تدخل في الصافي)</dt>
        <dd>{amount(register.employerContributionMinor)}</dd>
      </div>
    </dl>
  );
}

export function PayrollRegisterView({ run }: { run: PayrollRun }) {
  const register = buildPayrollRegister(run);
  if (!register.employeeCount) return <p className="payroll-empty">لا توجد أسطر في هذا المسير.</p>;
  return (
    <div className="payroll-register">
      <RegisterTables register={register} />
      <Summary register={register} />
    </div>
  );
}

export function PayrollRegisterPaper({ run }: { run: PayrollRun }) {
  const register = buildPayrollRegister(run);
  return (
    <section className="payroll-print-sheet register-paper" aria-label="مسير الرواتب للطباعة">
      <header>
        <img src="/brand/sabq-logo.svg" alt="سبق" width="64" height="58" />
        <div>
          <h1>
            {run.correctionOf ? 'مسير فرق تصحيحي' : 'مسير رواتب'} شهر {periodName(run.period)}
          </h1>
          <p>صحيفة سبق الإلكترونية</p>
          <p>
            تاريخ الإصدار:{' '}
            {new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
              dateStyle: 'long',
              timeZone: 'Asia/Riyadh',
            }).format(new Date())}
            {' · '}
            {run.policyName}
          </p>
        </div>
        <strong className={`paper-state ${run.state}`}>{STATE_LABEL[run.state]}</strong>
      </header>
      <RegisterTables register={register} compact />
      <Summary register={register} />
      <div className="register-signatures">
        {signatures(run).map((sign) => (
          <div key={sign.title}>
            <h4>{sign.title}</h4>
            <small>{sign.role}</small>
            {sign.name ? (
              <p>
                <b>{sign.name}</b>
                <span>موقّع إلكترونيًا داخل النظام</span>
                <span>
                  {stamp(sign.at)} · نسخة المسير {sign.version}
                </span>
              </p>
            ) : (
              <p className="pending">بانتظار التوقيع</p>
            )}
          </div>
        ))}
      </div>
      <footer>
        {periodName(run.period)} · {register.employeeCount} موظف · طرق الدفع:{' '}
        {register.groups.map((g) => PAYMENT_METHOD_LABEL[g.method]).join('، ')}. المسير لا ينفذ
        تحويلًا ماليًا.
      </footer>
    </section>
  );
}
