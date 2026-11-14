import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, CircleHelp, FileClock, ShieldCheck } from 'lucide-react';
import type { EmployeeFile, FormField } from '../../shared/administration';
import { employeeFields } from '../../shared/catalog';

const fields = employeeFields as FormField[];
const readinessGroups: Record<string, string[]> = {
  البيانات: ['البيانات الأساسية', 'التواصل', 'العمل', 'المؤهلات', 'انتهاء العلاقة'],
  العقد: ['العقد'],
  الراتب: ['المالية'],
  البنك: ['البنك'],
  التأمينات: ['التأمينات'],
  'التأمين الطبي': ['التأمين الطبي'],
  الإجازات: ['الإجازات'],
};
type Readiness = {
  completed: number;
  total: number;
  missing: string[];
  status: EmployeeFile['sectionReadiness'][string]['status'];
};
function readinessFor(file: EmployeeFile, tab: string): Readiness | undefined {
  const entries = (readinessGroups[tab] || [])
    .map((group) => file.sectionReadiness?.[group])
    .filter((entry) => entry && entry.total > 0);
  return entries.length
    ? {
        completed: entries.reduce((sum, entry) => sum + entry.completed, 0),
        total: entries.reduce((sum, entry) => sum + entry.total, 0),
        missing: entries.flatMap((entry) => entry.missing),
        status: entries.some((entry) => entry.status === 'incomplete')
          ? 'incomplete'
          : entries.some((entry) => entry.status === 'unverified')
            ? 'unverified'
            : entries.every((entry) => entry.status === 'not_applicable')
              ? 'not_applicable'
              : 'complete',
      }
    : undefined;
}
function allowedFieldKeys(file: EmployeeFile) {
  return new Set(file.visibleFieldKeys);
}
const groups: Record<string, { title: string; groups: string[]; keys?: string[] }> = {
  البيانات: {
    title: 'البيانات الوظيفية',
    groups: ['البيانات الأساسية', 'التواصل', 'العمل', 'المؤهلات', 'انتهاء العلاقة'],
  },
  العقد: { title: 'العقد وفترات العمل', groups: ['العقد'], keys: ['relationshipType', 'bio'] },
  الراتب: {
    title: 'الراتب والمزايا',
    groups: ['المالية'],
    keys: [
      'salaryEffectiveDate',
      'salarySource',
      'wagesProtectionAmount',
      'wagesProtectionSource',
      'wagesProtectionDate',
    ],
  },
  البنك: {
    title: 'البيانات البنكية',
    groups: ['البنك'],
    keys: [
      'bankName',
      'iban',
      'bankCountry',
      'accountNumber',
      'accountType',
      'currency',
      'bankUpdatedAt',
      'bankVerificationStatus',
      'bankVerificationSource',
      'bankVerifiedAt',
      'swiftCode',
      'bankBranch',
    ],
  },
  التأمينات: {
    title: 'التأمينات الاجتماعية',
    groups: ['التأمينات'],
    keys: [
      'insuranceRegistrationStatus',
      'insuranceStartDate',
      'employeeContributionPercent',
      'employerContributionPercent',
      'insuranceSource',
      'insuranceEffectiveDate',
      'insuranceVerificationStatus',
    ],
  },
  'التأمين الطبي': {
    title: 'التأمين الطبي',
    groups: ['التأمين الطبي'],
    keys: [
      'medicalCoverageStatus',
      'medicalProvider',
      'medicalPolicyNumber',
      'medicalStartDate',
      'medicalEndDate',
      'medicalMemberNumber',
    ],
  },
};
const date = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
        dateStyle: 'medium',
        timeZone: 'Asia/Riyadh',
      }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value))
    : '—';
const statusLabels: Record<string, string> = {
  unverified: 'غير متحقق',
  pending: 'قيد التحقق',
  verified: 'متحقق',
  rejected: 'مرفوض',
  active: 'ساري',
  inactive: 'غير ساري',
  covered: 'مشمول',
  not_covered: 'غير مشمول',
  employee: 'موظف',
  collaborator: 'متعاون',
  allocation: 'تخصيص',
  reserve: 'حجز',
  release: 'إعادة رصيد',
  consume: 'استهلاك',
  adjustment: 'تسوية',
};
const readinessLabels: Record<Readiness['status'], string> = {
  complete: 'مكتمل وفق السجل',
  incomplete: 'يحتاج استكمالًا',
  unverified: 'بانتظار التحقق',
  not_applicable: 'لا ينطبق',
};
function valueLabel(value: unknown, field?: FormField) {
  if (value === null || value === undefined || value === '') return 'غير مسجل';
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (field?.type === 'date' && typeof value === 'string') return date(value);
  if (field?.type === 'select')
    return (
      field.options?.find((o) => o.value === String(value))?.label ||
      statusLabels[String(value)] ||
      String(value)
    );
  return statusLabels[String(value)] || String(value);
}
function authorizedFields(file: EmployeeFile, tab: string) {
  const config = groups[tab];
  if (!config) return [];
  const allowed = allowedFieldKeys(file);
  const legacyBankFields = ['bankName', 'iban'];
  return fields.filter(
    (field) =>
      (config.groups.includes(field.group || 'البيانات الأساسية') ||
        config.keys?.includes(field.key)) &&
      !(tab === 'الراتب' && legacyBankFields.includes(field.key)) &&
      allowed.has(field.key),
  );
}
export function visibleEmployeeFields(file: EmployeeFile) {
  const allowed = allowedFieldKeys(file);
  return fields.filter((field) => allowed.has(field.key));
}
export function isProfileFieldVisible(file: EmployeeFile, key: string) {
  return allowedFieldKeys(file).has(key);
}
function Details({ file, tab }: { file: EmployeeFile; tab: string }) {
  const items = authorizedFields(file, tab);
  const visibleKeys = new Set(items.map((item) => item.key));
  for (const key of groups[tab]?.keys || []) {
    if (allowedFieldKeys(file).has(key) && !visibleKeys.has(key)) {
      items.push({ key, label: key, type: 'text' });
    }
  }
  const labelOverrides: Record<string, string> = {
    relationshipType: 'نوع العلاقة',
    bio: 'نبذة وظيفية',
    salaryEffectiveDate: 'سريان الراتب من',
    salarySource: 'مصدر بيانات الراتب',
    wagesProtectionAmount: 'مبلغ حماية الأجور',
    wagesProtectionSource: 'مصدر حماية الأجور',
    wagesProtectionDate: 'تاريخ حماية الأجور',
    bankName: 'البنك',
    iban: 'الآيبان',
    bankCountry: 'دولة البنك',
    bankAccountName: 'الاسم لدى البنك',
    accountNumber: 'رقم الحساب',
    accountType: 'نوع الحساب',
    currency: 'العملة',
    bankUpdatedAt: 'آخر تحديث للبيانات البنكية',
    bankVerificationStatus: 'حالة التحقق البنكي',
    bankVerificationSource: 'مصدر التحقق البنكي',
    bankVerifiedAt: 'تاريخ التحقق البنكي',
    swiftCode: 'رمز سويفت',
    bankBranch: 'فرع البنك',
    insuranceRegistrationStatus: 'حالة التسجيل',
    insuranceStartDate: 'تاريخ بدء التسجيل',
    employeeContributionPercent: 'نسبة اشتراك الموظف',
    employerContributionPercent: 'نسبة اشتراك جهة العمل',
    insuranceSource: 'مصدر البيانات',
    insuranceEffectiveDate: 'سريان البيانات من',
    insuranceVerificationStatus: 'حالة التحقق',
    medicalCoverageStatus: 'حالة التغطية',
    medicalProvider: 'شركة التأمين',
    medicalPolicyNumber: 'رقم الوثيقة',
    medicalMemberNumber: 'رقم العضوية',
    medicalStartDate: 'بداية التغطية',
    medicalEndDate: 'نهاية التغطية',
  };
  return items.length ? (
    <dl className="adm-details">
      {items.map((field) => (
        <div key={field.key}>
          <dt>{labelOverrides[field.key] || field.label}</dt>
          <dd>{valueLabel(file.values[field.key], field)}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="profile-unavailable">
      <CircleHelp size={16} /> لا توجد بيانات متاحة لهذا القسم.
    </p>
  );
}

export function profileTabs(file: EmployeeFile) {
  const order = ['البيانات', 'العقد', 'الراتب', 'البنك', 'التأمينات', 'التأمين الطبي', 'الإجازات'];
  return order.filter((tab) =>
    tab === 'الإجازات'
      ? allowedFieldKeys(file).has('annualLeaveEntitlement') ||
        !!file.leaveMovements.length ||
        file.leaveSummary.balanceKnown
      : authorizedFields(file, tab).length > 0,
  );
}

export function ProfileTab({ file, tab }: { file: EmployeeFile; tab: string }) {
  if (tab === 'الإجازات') return <LeaveProfile file={file} />;
  const readiness = readinessFor(file, tab);
  return (
    <section className="adm-section profile-section">
      <div className="profile-section-heading">
        <div>
          <h3>{groups[tab]?.title || tab}</h3>
          {readiness && (
            <p>
              {readiness.completed} من {readiness.total} حقول · {readinessLabels[readiness.status]}
            </p>
          )}
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
      <Details file={file} tab={tab} />
      {tab === 'الراتب' && <SalarySummary file={file} />}
    </section>
  );
}

function SalarySummary({ file }: { file: EmployeeFile }) {
  const salaryKeys = ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'];
  const allowed = allowedFieldKeys(file);
  if (!salaryKeys.some((key) => allowed.has(key))) return null;
  const present = salaryKeys.every(
    (key) =>
      allowed.has(key) &&
      Object.prototype.hasOwnProperty.call(file.values, key) &&
      file.values[key] !== null &&
      file.values[key] !== '',
  );
  const total = present ? salaryKeys.reduce((sum, key) => sum + Number(file.values[key]), 0) : null;
  return (
    <div className="profile-total">
      <span>إجمالي العناصر الثابتة المسجلة</span>
      <strong>
        {total === null
          ? 'غير متاح'
          : `${new Intl.NumberFormat('ar-SA-u-nu-latn').format(total)} ر.س`}
      </strong>
      <small>
        {total === null
          ? 'يلزم اكتمال جميع مكونات الراتب لعرض الإجمالي.'
          : `يشمل العناصر الثابتة الظاهرة أعلاه. السريان: ${valueLabel(file.values.salaryEffectiveDate, { key: 'salaryEffectiveDate', label: '', type: 'date' })}`}
      </small>
      {file.closedPayslips.length > 0 && (
        <ul className="profile-payslips">
          {file.closedPayslips.map((run) => (
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
  const entitlement = Object.prototype.hasOwnProperty.call(file.values, 'annualLeaveEntitlement')
    ? file.values.annualLeaveEntitlement
    : null;
  const source = file.values.annualLeaveSource;
  const movements = file.leaveMovements || [];
  const additionalLeaveFields = visibleEmployeeFields(file).filter(
    (field) =>
      field.group === 'الإجازات' &&
      field.key !== 'annualLeaveEntitlement' &&
      field.key !== 'annualLeaveSource' &&
      field.key !== 'annualLeaveEffectiveDate' &&
      field.key !== 'annualLeaveVerificationStatus',
  );
  const [showAll, setShowAll] = useState(false);
  return (
    <section className="adm-section profile-section">
      <div className="profile-section-heading">
        <div>
          <h3>الإجازات</h3>
          <p>أرصدة وحركات مسجلة وفق البيانات المتاحة</p>
        </div>
        <Link className="adm-link" to="/services?kind=leave_adjustment">
          <CalendarDays size={15} /> طلب تصحيح أو افتتاح رصيد
        </Link>
      </div>
      <div className="profile-leave-stats">
        <div>
          <span>الاستحقاق السنوي المسجل</span>
          <strong>{entitlement === null ? 'غير مسجل' : `${entitlement} يوم`}</strong>
          <small>
            {source ? `المصدر: ${source}` : 'لا يوجد مصدر مسجل'}
            {file.values.annualLeaveEffectiveDate
              ? ` · السريان: ${date(String(file.values.annualLeaveEffectiveDate))}`
              : ''}
          </small>
        </div>
        <div>
          <span>الرصيد الافتتاحي المسجل</span>
          <strong>
            {file.leaveSummary.openingBalance === null
              ? 'غير محدد'
              : `${file.leaveSummary.openingBalance} يوم`}
          </strong>
          <small>قيد افتتاحي معروف من سجل الحركات</small>
        </div>
        <div>
          <span>الرصيد المتاح المسجل</span>
          <strong>
            {Number.isFinite(file.leaveSummary.available)
              ? `${file.leaveSummary.available} يوم`
              : 'غير متاح'}
          </strong>
          <small>آخر رصيد محفوظ</small>
        </div>
        <div>
          <span>الرصيد المحجوز</span>
          <strong>{file.leaveSummary.reserved} يوم</strong>
          <small>طلبات مرتبطة بحركات الحجز</small>
        </div>
        <div>
          <span>الإجازات المسجلة</span>
          <strong>{file.leaveSummary.taken} يوم</strong>
          <small>المستهلك حسب السجل</small>
        </div>
        <div>
          <span>سياسة الإجازة السنوية</span>
          <strong>{file.leaveSummary.policyApproved ? 'معتمدة' : 'غير معتمدة'}</strong>
          <small>حالة اعتماد السياسة السارية</small>
        </div>
      </div>
      {Object.prototype.hasOwnProperty.call(file.values, 'annualLeaveVerificationStatus') && (
        <p className="profile-policy-state">
          حالة التحقق من الاستحقاق: {valueLabel(file.values.annualLeaveVerificationStatus)}
        </p>
      )}
      {additionalLeaveFields.length > 0 && (
        <dl className="adm-details profile-leave-details">
          {additionalLeaveFields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>{valueLabel(file.values[field.key], field)}</dd>
            </div>
          ))}
        </dl>
      )}
      {movements.length ? (
        <>
          <h4 className="profile-subheading">
            <FileClock size={17} /> سجل الحركات
          </h4>
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
        </>
      ) : (
        <p className="profile-unavailable">
          <ShieldCheck size={16} /> لا توجد حركات رصيد مسجلة.
        </p>
      )}
    </section>
  );
}

export function ProfileReadiness({ file }: { file: EmployeeFile }) {
  const sections = profileTabs(file).map((tab) => {
    const readiness = readinessFor(file, tab);
    return { tab, readiness };
  });
  return (
    <div className="profile-readiness" aria-label="اكتمال أقسام الملف">
      {sections.map(({ tab, readiness }) => (
        <div key={tab}>
          <span>{tab}</span>
          <strong>
            {readiness && readiness.total
              ? `${Math.round((readiness.completed / readiness.total) * 100)}٪`
              : tab === 'الإجازات'
                ? 'سجل'
                : '—'}
          </strong>
          {readiness && <small>{readinessLabels[readiness.status]}</small>}
          <div className="profile-progress">
            <i
              style={{
                width: `${readiness?.total ? Math.round((readiness.completed / readiness.total) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
