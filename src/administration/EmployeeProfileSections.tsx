export { isProfileFieldVisible, profileTabs, visibleEmployeeFields } from './profile-visibility';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, CircleHelp, ShieldCheck } from 'lucide-react';
import type { EmployeeFile, FormField } from '../../shared/administration';
import { useApp } from '../lib';
import {
  allowedFieldKeys,
  authorizedFields,
  hasFieldValue,
  profileGroups as groups,
  splitFields,
  visibleEmployeeFields,
} from './profile-visibility';

const date = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
        dateStyle: 'medium',
        timeZone: 'Asia/Riyadh',
      }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value))
    : '—';
const statusLabels: Record<string, string> = {
  allocation: 'تخصيص',
  reserve: 'حجز',
  release: 'إعادة رصيد',
  consume: 'استهلاك',
  adjustment: 'تسوية',
  opening: 'رصيد افتتاحي',
};
const money = (value: number) =>
  `${new Intl.NumberFormat('ar-SA-u-nu-latn', { maximumFractionDigits: 2 }).format(value)} ر.س`;
function valueLabel(
  value: unknown,
  field?: FormField,
  employees: { id: string; name: string }[] = [],
) {
  if (value === null || value === undefined || value === '') return 'غير مسجل';
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (field?.type === 'date' && typeof value === 'string') return date(value);
  if (field?.type === 'select')
    return field.options?.find((o) => o.value === String(value))?.label || String(value);
  if (field?.type === 'employee')
    return employees.find((employee) => employee.id === String(value))?.name || 'غير متاح';
  if (field?.type === 'money' && Number.isFinite(Number(value))) return money(Number(value));
  return String(value);
}

function FieldList({ file, items }: { file: EmployeeFile; items: FormField[] }) {
  const { data } = useApp();
  return (
    <dl className="adm-details">
      {items.map((field) => (
        <div key={field.key}>
          <dt>{field.label}</dt>
          <dd>{valueLabel(file.values[field.key], field, data.employees)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Essential fields first; optional fields appear only when they hold a value, folded away. */
function Details({ file, tab }: { file: EmployeeFile; tab: string }) {
  const { essential, extra } = splitFields(authorizedFields(file, tab), file.values);
  const recordedExtras = extra.filter((field) => hasFieldValue(file.values, field.key));
  if (!essential.length && !recordedExtras.length)
    return (
      <p className="profile-unavailable">
        <CircleHelp size={16} /> لا توجد بيانات متاحة لهذا القسم.
      </p>
    );
  return (
    <>
      {essential.length > 0 && <FieldList file={file} items={essential} />}
      {recordedExtras.length > 0 && (
        <details className="profile-extra">
          <summary>بيانات إضافية مسجلة ({recordedExtras.length})</summary>
          <FieldList file={file} items={recordedExtras} />
        </details>
      )}
    </>
  );
}

export function ProfileTab({ file, tab }: { file: EmployeeFile; tab: string }) {
  if (tab === 'الإجازات') return <LeaveProfile file={file} />;
  return (
    <section className="adm-section profile-section">
      <div className="profile-section-heading">
        <div>
          <h3>{groups[tab]?.title || tab}</h3>
        </div>
        {tab === 'الراتب' && file.closedPayslips.length > 0 && (
          <Link
            className="adm-link"
            to={`/payroll?run=${encodeURIComponent(file.closedPayslips[0].runId)}&employee=${encodeURIComponent(file.employee.id)}`}
          >
            المسيرات المغلقة ({file.closedPayslips.length}) <ArrowUpRight size={15} />
          </Link>
        )}
      </div>
      {tab === 'الراتب' && <SalarySummary file={file} />}
      <Details file={file} tab={tab} />
    </section>
  );
}

function SalarySummary({ file }: { file: EmployeeFile }) {
  const salaryKeys = ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'];
  const allowed = allowedFieldKeys(file);
  if (!salaryKeys.some((key) => allowed.has(key))) return null;
  // Absent components are not zero: the total needs the basic salary and counts only what is recorded.
  const present = salaryKeys.filter((key) => allowed.has(key) && hasFieldValue(file.values, key));
  const total = present.includes('basicSalary')
    ? present.reduce((sum, key) => sum + Number(file.values[key]), 0)
    : null;
  return (
    <div className="profile-total">
      <span>إجمالي العناصر الثابتة المسجلة</span>
      <strong>{total === null ? 'غير مسجل' : money(total)}</strong>
      {file.closedPayslips.length > 0 && (
        <ul className="profile-payslips">
          {file.closedPayslips.slice(0, 3).map((run) => (
            <li key={run.runId}>
              <Link
                to={`/payroll?run=${encodeURIComponent(run.runId)}&employee=${encodeURIComponent(file.employee.id)}`}
              >
                مسير {run.period} · مغلق {run.closedAt ? date(run.closedAt) : 'التاريخ غير مسجل'}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LeaveProfile({ file }: { file: EmployeeFile }) {
  const entitlement = hasFieldValue(file.values, 'annualLeaveEntitlement')
    ? file.values.annualLeaveEntitlement
    : null;
  const movements = file.leaveMovements || [];
  const extraLeaveFields = visibleEmployeeFields(file).filter(
    (field) =>
      field.group === 'الإجازات' &&
      field.key !== 'annualLeaveEntitlement' &&
      hasFieldValue(file.values, field.key),
  );
  const [showAll, setShowAll] = useState(false);
  return (
    <section className="adm-section profile-section">
      <div className="profile-section-heading">
        <div>
          <h3>الإجازات</h3>
        </div>
        <Link className="adm-link" to="/services?kind=leave_adjustment">
          <CalendarDays size={15} /> طلب تصحيح رصيد
        </Link>
      </div>
      <div className="profile-leave-stats">
        <div>
          <span>الاستحقاق السنوي</span>
          <strong>{entitlement === null ? 'غير مسجل' : `${entitlement} يوم`}</strong>
        </div>
        <div>
          <span>الرصيد المتاح</span>
          <strong>
            {Number.isFinite(file.leaveSummary.available)
              ? `${file.leaveSummary.available} يوم`
              : 'غير متاح'}
          </strong>
        </div>
        <div>
          <span>المحجوز</span>
          <strong>{file.leaveSummary.reserved} يوم</strong>
        </div>
        <div>
          <span>المستهلك</span>
          <strong>{file.leaveSummary.taken} يوم</strong>
        </div>
      </div>
      {extraLeaveFields.length > 0 && (
        <details className="profile-extra">
          <summary>بيانات إضافية مسجلة ({extraLeaveFields.length})</summary>
          <FieldList file={file} items={extraLeaveFields} />
        </details>
      )}
      {movements.length ? (
        <details className="profile-extra">
          <summary>سجل حركات الرصيد ({movements.length})</summary>
          <div className="profile-movements">
            {(showAll ? movements : movements.slice(0, 5)).map((movement) => (
              <div key={movement.id}>
                <span className="profile-movement-days">
                  {movement.days > 0 ? '+' : ''}
                  {movement.days} يوم
                </span>
                <span>{statusLabels[movement.kind] || movement.kind}</span>
                <span>{date(movement.effectiveAt)}</span>
                <small>{movement.source}</small>
              </div>
            ))}
          </div>
          {movements.length > 5 && (
            <button className="profile-show-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'عرض أقل' : `عرض كل الحركات (${movements.length})`}
            </button>
          )}
        </details>
      ) : (
        <p className="profile-unavailable">
          <ShieldCheck size={16} /> لا توجد حركات رصيد مسجلة.
        </p>
      )}
    </section>
  );
}
