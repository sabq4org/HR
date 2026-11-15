import { Children, type ReactNode } from 'react';
import type { EmployeeFile, FormField } from '../../shared/administration';
import { documentCategories } from '../../shared/catalog';
import {
  hasFieldValue,
  isProfileFieldVisible,
  profileGroups,
  REPORT_DOCUMENT_LIMIT,
  reportSelection,
} from './profile-visibility';
const date = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
        dateStyle: 'medium',
        timeZone: 'Asia/Riyadh',
      }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value))
    : '—';
const stateLabels: Record<string, string> = {
  active: 'على رأس العمل',
  on_leave: 'في إجازة',
  suspended: 'موقوف',
  terminated: 'منتهية الخدمة',
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
  return String(value);
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

/**
 * The employee report: one or two A4 pages. It carries the essential fields of each section the
 * reader may see, a leave summary and the active documents. History, requests and movements stay
 * in the app, where they are complete.
 */
export function EmployeeProfilePaper({
  file,
  employees = [],
  dataModeLabel,
  generated = new Date(),
  includeLeave = true,
}: {
  file: EmployeeFile;
  employees?: { id: string; name: string }[];
  dataModeLabel: string;
  generated?: Date;
  includeLeave?: boolean;
}) {
  const selection = reportSelection(file, includeLeave);
  const people = file.managerName
    ? [{ id: String(file.values.managerId ?? ''), name: file.managerName }, ...employees]
    : employees;
  const generatedLabel = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Riyadh',
  }).format(generated);
  const salaryKeys = ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'];
  const recordedSalary = salaryKeys.filter(
    (key) => isProfileFieldVisible(file, key) && hasFieldValue(file.values, key),
  );
  const salaryTotal = recordedSalary.includes('basicSalary')
    ? recordedSalary.reduce((sum, key) => sum + Number(file.values[key]), 0)
    : null;
  return (
    <article className="employee-report" dir="rtl">
      <header className="employee-report-brand">
        <img src="/brand/sabq-logo.svg" alt="سبق" />
        <div>
          <h1 aria-label="الملف الوظيفي">الملـف الوظـيفي</h1>
          <p>
            {dataModeLabel} · تاريخ الإنشاء {generatedLabel}
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
            <dt>الحالة</dt>
            <dd>{stateLabels[String(file.values.employmentStatus)] || 'غير محددة'}</dd>
          </div>
        </dl>
      </section>
      {selection.fieldSections.map(({ tab, fields: shown }) => {
        return (
          <section className="employee-report-section" key={tab}>
            <h3>{profileGroups[tab].title}</h3>
            <ReportFields>
              {shown.map((field) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{format(file.values[field.key], field, people)}</dd>
                </div>
              ))}
              {tab === 'الراتب' && recordedSalary.length > 0 && (
                <div>
                  <dt>إجمالي العناصر الثابتة المسجلة</dt>
                  <dd>
                    {salaryTotal === null
                      ? 'غير متاح'
                      : format(salaryTotal, { key: 'total', label: '', type: 'money' })}
                  </dd>
                </div>
              )}
            </ReportFields>
          </section>
        );
      })}
      {selection.leave && (
        <section className="employee-report-section">
          <h3>الإجازات</h3>
          <ReportFields>
            {isProfileFieldVisible(file, 'annualLeaveEntitlement') && (
              <div>
                <dt>الاستحقاق السنوي</dt>
                <dd>
                  {hasFieldValue(file.values, 'annualLeaveEntitlement')
                    ? `${format(file.values.annualLeaveEntitlement)} يوم`
                    : 'غير مسجل'}
                </dd>
              </div>
            )}
            <div>
              <dt>الرصيد المتاح</dt>
              <dd>
                {file.leaveSummary.available === null
                  ? 'غير متاح'
                  : `${file.leaveSummary.available} يوم`}
              </dd>
            </div>
            <div>
              <dt>المحجوز</dt>
              <dd>{file.leaveSummary.reserved} يوم</dd>
            </div>
            <div>
              <dt>المستهلك</dt>
              <dd>{file.leaveSummary.taken} يوم</dd>
            </div>
          </ReportFields>
        </section>
      )}
      {selection.documents.length > 0 && (
        <section className="employee-report-section">
          <h3>الوثائق السارية</h3>
          <table>
            <thead>
              <tr>
                <th>الوثيقة</th>
                <th>الصنف</th>
                <th>الانتهاء</th>
              </tr>
            </thead>
            <tbody>
              {selection.documents.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.filename}</td>
                  <td>
                    {documentCategories.find((category) => category.key === doc.category)?.label ||
                      'وثيقة وظيفية'}
                  </td>
                  <td>{date(doc.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {selection.activeDocuments > REPORT_DOCUMENT_LIMIT && (
            <p>يعرض التقرير أحدث {REPORT_DOCUMENT_LIMIT} وثيقة سارية.</p>
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
        سبق · {dataModeLabel} · نسخة عرض وفق صلاحيات الحساب الحالي، ولا تمثل اعتمادًا أو مستندًا رسميًا
      </footer>
    </article>
  );
}
