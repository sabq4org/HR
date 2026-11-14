import { ArrowRight, Printer } from 'lucide-react';
import { Children, type ReactNode, useEffect, useState } from 'react';
import type { EmployeeFile, FormField } from '../../shared/administration';
import { documentCategories, employeeFields, formByKind } from '../../shared/catalog';
import { api, useApp } from '../lib';
import {
  isProfileFieldVisible,
  profileTabs,
  visibleEmployeeFields,
} from './EmployeeProfileSections';

const fields = employeeFields as FormField[];
const date = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
        dateStyle: 'medium',
        timeZone: 'Asia/Riyadh',
      }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value))
    : '—';
const titleFor: Record<string, string> = {
  البيانات: 'البيانات الوظيفية',
  العقد: 'العقد وفترات العمل',
  الراتب: 'الراتب والمزايا',
  البنك: 'البيانات البنكية',
  التأمينات: 'التأمينات الاجتماعية',
  'التأمين الطبي': 'التأمين الطبي',
};
const groupFor: Record<string, string[]> = {
  البيانات: ['البيانات الأساسية', 'التواصل', 'العمل', 'المؤهلات', 'انتهاء العلاقة'],
  العقد: ['العقد'],
  الراتب: ['المالية'],
  البنك: ['البنك'],
  التأمينات: ['التأمينات'],
  'التأمين الطبي': ['التأمين الطبي'],
};
const specialKeys: Record<string, string[]> = {
  العقد: ['relationshipType', 'bio'],
  الراتب: [
    'salaryEffectiveDate',
    'salarySource',
    'wagesProtectionAmount',
    'wagesProtectionSource',
    'wagesProtectionDate',
  ],
  البنك: [
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
  التأمينات: [
    'insuranceRegistrationStatus',
    'insuranceStartDate',
    'employeeContributionPercent',
    'employerContributionPercent',
    'insuranceSource',
    'insuranceEffectiveDate',
    'insuranceVerificationStatus',
  ],
  'التأمين الطبي': [
    'medicalCoverageStatus',
    'medicalProvider',
    'medicalPolicyNumber',
    'medicalStartDate',
    'medicalEndDate',
    'medicalMemberNumber',
  ],
};
const labels: Record<string, string> = {
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
const stateLabels: Record<string, string> = {
  active: 'ساري',
  archived: 'مؤرشف',
  draft: 'مسودة',
  pending_manager: 'لدى المدير',
  pending_hr: 'لدى الشؤون الإدارية',
  pending_finance: 'لدى المالية',
  pending_approver: 'بانتظار الاعتماد',
  returned: 'معاد للتعديل',
  approved: 'معتمد',
  rejected: 'مرفوض',
  cancelled: 'ملغي',
  closed: 'مغلق',
  employee: 'موظف',
  collaborator: 'متعاون',
  on_leave: 'في إجازة',
  suspended: 'موقوف',
  terminated: 'منتهية الخدمة',
  allocation: 'تخصيص رصيد',
  reserve: 'حجز رصيد',
  release: 'إعادة رصيد',
  consume: 'استهلاك رصيد',
  opening: 'رصيد افتتاحي',
};
function format(value: unknown, field?: FormField, employees: { id: string; name: string }[] = []) {
  if (value === null || value === undefined || value === '') return 'غير مسجل';
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (field?.type === 'date' && typeof value === 'string') return date(value);
  if (field?.type === 'select')
    return field.options?.find((o) => o.value === String(value))?.label || String(value);
  if (field?.type === 'employee')
    return employees.find((employee) => employee.id === String(value))?.name || 'غير متاح';
  if ((field?.type === 'number' || field?.type === 'money') && Number.isFinite(Number(value)))
    return new Intl.NumberFormat('ar-SA-u-nu-latn', { maximumFractionDigits: 2 }).format(
      Number(value),
    );
  return stateLabels[String(value)] || String(value);
}
function ReportFields({ children }: { children: ReactNode }) {
  const entries = Children.toArray(children);
  return (
    <table className="employee-report-fields" role="presentation">
      <tbody>
        {Array.from({ length: Math.ceil(entries.length / 2) }, (_, row) => (
          <tr key={row}>
            {entries.slice(row * 2, row * 2 + 2).map((entry, column) => (
              <td key={column}>
                <dl>{entry}</dl>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
export function EmployeeProfileReport({
  file,
  onBack,
}: {
  file: EmployeeFile;
  onBack: () => void;
}) {
  const { data } = useApp();
  const [dataMode, setDataMode] = useState('');
  useEffect(() => {
    let active = true;
    void api<{ mode?: string }>('/session')
      .then((session) => {
        if (active) setDataMode(session.mode || '');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const generated = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Riyadh',
  }).format(new Date());
  const dataModeLabel = dataMode.startsWith('private-')
    ? 'بيانات خاصة'
    : dataMode.startsWith('synthetic-')
      ? 'بيانات اصطناعية'
      : 'نوع البيانات غير محدد';
  const tabs = profileTabs(file);
  return (
    <div className="employee-report-page">
      <div className="employee-report-controls">
        <button className="adm-button secondary" onClick={onBack}>
          <ArrowRight size={16} /> العودة للملف
        </button>
        <button className="adm-button" onClick={() => window.print()}>
          <Printer size={16} /> طباعة / حفظ PDF
        </button>
      </div>
      <p className="employee-report-help">
        لحفظ نسخة على جهازك، اضغط «طباعة / حفظ PDF»، ثم اختر «حفظ بصيغة PDF» من نافذة الطباعة.
      </p>
      <article className="employee-report" dir="rtl">
        <header className="employee-report-brand">
          <img src="/brand/sabq-logo.svg" alt="سبق" />
          <div>
            <h1 aria-label="الملف الوظيفي">الملـف الوظـيفي</h1>
            <p>
              {dataModeLabel} · تاريخ الإنشاء {generated}
            </p>
          </div>
        </header>
        <section className="employee-report-identity">
          <div>
            <h2>{file.employee.name}</h2>
            <p>
              {file.employee.title} · {file.employee.department}
            </p>
          </div>
          <dl>
            <div>
              <dt>الرقم الوظيفي</dt>
              <dd>{file.employee.employeeNumber}</dd>
            </div>
            <div>
              <dt>حالة الموظف</dt>
              <dd>{stateLabels[String(file.values.employmentStatus)] || 'غير محددة'}</dd>
            </div>
          </dl>
        </section>
        {tabs
          .filter((tab) => tab !== 'الإجازات')
          .map((tab) => {
            const visibleFields = fields.filter(
              (field) =>
                (groupFor[tab]?.includes(field.group || 'البيانات الأساسية') ||
                  specialKeys[tab]?.includes(field.key)) &&
                !(tab === 'البيانات' && ['relationshipType', 'bio'].includes(field.key)) &&
                !(tab === 'الراتب' && ['bankName', 'iban'].includes(field.key)) &&
                isProfileFieldVisible(file, field.key),
            );
            if (!visibleFields.length) return null;
            return (
              <section className="employee-report-section" key={tab}>
                <h3>{titleFor[tab] || tab}</h3>
                <ReportFields>
                  {visibleFields.map((field) => (
                    <div key={field.key}>
                      <dt>{labels[field.key] || field.label}</dt>
                      <dd>{format(file.values[field.key], field, data.employees)}</dd>
                    </div>
                  ))}
                </ReportFields>
              </section>
            );
          })}
        {tabs.includes('الإجازات') && (
          <section className="employee-report-section">
            <h3>الإجازات</h3>
            <ReportFields>
              {isProfileFieldVisible(file, 'annualLeaveEntitlement') && (
                <div>
                  <dt>الاستحقاق السنوي المسجل</dt>
                  <dd>
                    {file.values.annualLeaveEntitlement == null ||
                    file.values.annualLeaveEntitlement === ''
                      ? 'غير مسجل'
                      : `${format(file.values.annualLeaveEntitlement)} يوم`}
                  </dd>
                </div>
              )}
              {visibleEmployeeFields(file)
                .filter(
                  (field) =>
                    field.group === 'الإجازات' &&
                    ![
                      'annualLeaveEntitlement',
                      'annualLeaveSource',
                      'annualLeaveEffectiveDate',
                      'annualLeaveVerificationStatus',
                    ].includes(field.key),
                )
                .map((field) => (
                  <div key={field.key}>
                    <dt>{field.label}</dt>
                    <dd>{format(file.values[field.key], field, data.employees)}</dd>
                  </div>
                ))}
              <div>
                <dt>الرصيد الافتتاحي المسجل</dt>
                <dd>
                  {file.leaveSummary.openingBalance === null
                    ? 'غير محدد'
                    : `${file.leaveSummary.openingBalance} يوم`}
                </dd>
              </div>
              <div>
                <dt>إجمالي المخصصات</dt>
                <dd>
                  {file.leaveSummary.allocated === null
                    ? 'غير متاح'
                    : `${file.leaveSummary.allocated} يوم`}
                </dd>
              </div>
              <div>
                <dt>الرصيد المتاح</dt>
                <dd>
                  {file.leaveSummary.available === null
                    ? 'غير متاح'
                    : `${file.leaveSummary.available} يوم`}
                </dd>
              </div>
              <div>
                <dt>الرصيد المحجوز</dt>
                <dd>{file.leaveSummary.reserved} يوم</dd>
              </div>
              <div>
                <dt>الإجازات المسجلة</dt>
                <dd>{file.leaveSummary.taken} يوم</dd>
              </div>
              <div>
                <dt>سياسة الإجازة السنوية</dt>
                <dd>{file.leaveSummary.policyApproved ? 'معتمدة' : 'غير معتمدة'}</dd>
              </div>
            </ReportFields>
            {file.leaveMovements.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>الحركة</th>
                    <th>الأيام</th>
                    <th>تاريخ السريان</th>
                    <th>المصدر</th>
                  </tr>
                </thead>
                <tbody>
                  {file.leaveMovements.slice(0, 60).map((move) => (
                    <tr key={move.id}>
                      <td>{stateLabels[move.kind] || 'حركة مسجلة'}</td>
                      <td>{move.days}</td>
                      <td>{date(move.effectiveAt)}</td>
                      <td>{move.source.startsWith('طلب ') ? 'طلب إجازة مرتبط' : move.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {file.leaveMovements.length > 60 && <p>يعرض التقرير أحدث 60 حركة.</p>}
          </section>
        )}
        {file.periods.length > 0 && (
          <section className="employee-report-section">
            <h3>فترات العمل</h3>
            <table>
              <thead>
                <tr>
                  <th>الفترة</th>
                  <th>نوع العلاقة</th>
                  <th>المصدر</th>
                </tr>
              </thead>
              <tbody>
                {file.periods.map((period) => (
                  <tr key={period.id}>
                    <td>
                      {date(period.startDate)} — {date(period.endDate)}
                    </td>
                    <td>{stateLabels[period.relationshipType] || 'علاقة عمل'}</td>
                    <td>
                      {/synthetic|fictional/i.test(period.source)
                        ? 'بيانات اصطناعية'
                        : period.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {file.documents.length > 0 && (
          <section className="employee-report-section">
            <h3>الوثائق</h3>
            <table>
              <thead>
                <tr>
                  <th>الوثيقة</th>
                  <th>الصنف</th>
                  <th>تاريخ الرفع</th>
                  <th>الانتهاء</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {file.documents.slice(0, 40).map((doc) => (
                  <tr key={doc.id}>
                    <td>{doc.filename}</td>
                    <td>
                      {documentCategories.find((category) => category.key === doc.category)
                        ?.label || 'وثيقة وظيفية'}
                    </td>
                    <td>{date(doc.uploadedAt)}</td>
                    <td>{date(doc.expiresAt)}</td>
                    <td>{stateLabels[doc.state] || doc.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {file.documents.length > 40 && <p>يعرض التقرير أحدث 40 وثيقة.</p>}
          </section>
        )}
        {file.requests.length > 0 && (
          <section className="employee-report-section">
            <h3>الطلبات</h3>
            <table>
              <thead>
                <tr>
                  <th>الرقم</th>
                  <th>الخدمة</th>
                  <th>الحالة</th>
                  <th>آخر تحديث</th>
                </tr>
              </thead>
              <tbody>
                {file.requests.slice(0, 40).map((request) => (
                  <tr key={request.id}>
                    <td>{request.number}</td>
                    <td>{formByKind[request.kind]?.title || 'طلب إداري'}</td>
                    <td>{stateLabels[request.state] || 'مسجل'}</td>
                    <td>{date(request.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {file.requests.length > 40 && <p>يعرض التقرير أحدث 40 طلبًا.</p>}
          </section>
        )}
        {file.fieldHistory.filter((entry) => isProfileFieldVisible(file, entry.fieldKey)).length >
          0 && (
          <section className="employee-report-section">
            <h3>سجل التغييرات</h3>
            <table>
              <thead>
                <tr>
                  <th>الحقل</th>
                  <th>القيمة السابقة</th>
                  <th>القيمة الجديدة</th>
                  <th>تاريخ السريان</th>
                  <th>السبب</th>
                </tr>
              </thead>
              <tbody>
                {file.fieldHistory
                  .filter((entry) => isProfileFieldVisible(file, entry.fieldKey))
                  .slice(0, 40)
                  .map((entry) => {
                    const field = fields.find((item) => item.key === entry.fieldKey);
                    return (
                      <tr key={entry.id}>
                        <td>{field?.label || labels[entry.fieldKey] || 'حقل وظيفي'}</td>
                        <td>{format(entry.oldValue, field, data.employees)}</td>
                        <td>{format(entry.newValue, field, data.employees)}</td>
                        <td>{date(entry.effectiveAt)}</td>
                        <td>{entry.reason || '—'}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {file.fieldHistory.length > 40 && (
              <p>يعرض التقرير أحدث 40 تغييرًا للحقول المسموح بعرضها.</p>
            )}
          </section>
        )}
        <section className="employee-report-signature">
          <div>
            <span>مراجعة الشؤون الإدارية</span>
            <i />
          </div>
          <div>
            <span>التوقيع</span>
            <i />
          </div>
          <div>
            <span>التاريخ</span>
            <i />
          </div>
        </section>
        <footer>
          سبق · {dataModeLabel} · نسخة عرض وفق صلاحيات الحساب الحالي، ولا تمثل اعتمادًا أو مستندًا
          رسميًا
        </footer>
      </article>
    </div>
  );
}
