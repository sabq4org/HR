// Which profile fields and tabs a file shows. Pure (no React, router or CSS), so the server PDF
// of the employee report applies exactly the same rules as the in-app report.
//
// The catalog keeps every field the system can store. The profile, the edit form and the report
// show a short essential set per section; the rest stay stored and editable under «حقول إضافية».
import type { EmployeeFile, FormField, FormValues } from '../../shared/administration';
import { employeeFields } from '../../shared/catalog';
const fields = employeeFields as FormField[];
export function allowedFieldKeys(file: EmployeeFile) {
  return new Set(file.visibleFieldKeys);
}

type ProfileSection = { title: string; groups: string[]; essential: string[] };
export const profileGroups: Record<string, ProfileSection> = {
  البيانات: {
    title: 'البيانات الأساسية',
    groups: ['البيانات الأساسية', 'التواصل', 'المؤهلات'],
    essential: [
      'name',
      'englishName',
      'employeeNumber',
      'nationality',
      'nationalId',
      'nationalIdExpiry',
      'birthDate',
      'gender',
      'email',
      'mobile',
      'qualification',
    ],
  },
  العمل: {
    title: 'العمل والعقد',
    groups: ['العمل', 'العقد', 'انتهاء العلاقة'],
    essential: [
      'department',
      'title',
      'managerId',
      'joinDate',
      'location',
      'relationshipType',
      'employmentStatus',
      'contractType',
      'contractStart',
      'contractEnd',
      'probationEnd',
    ],
  },
  الراتب: {
    title: 'الراتب والبنك',
    groups: ['المالية', 'البنك'],
    essential: [
      'basicSalary',
      'housingAllowance',
      'transportAllowance',
      'otherAllowance',
      'payrollEmploymentType',
      'payrollPaymentMethod',
      'bankName',
      'iban',
    ],
  },
  التأمينات: {
    title: 'التأمينات والتغطية الطبية',
    groups: ['التأمينات', 'التأمين الطبي'],
    essential: [
      'insuranceNumber',
      'insuranceNationalityGroup',
      'insuranceCategory',
      'insuranceRegistrationStatus',
      'medicalCoverageStatus',
    ],
  },
  الإجازات: {
    title: 'الإجازات',
    groups: ['الإجازات'],
    essential: ['annualLeaveEntitlement'],
  },
};
export const profileSectionOrder = ['البيانات', 'العمل', 'الراتب', 'التأمينات', 'الإجازات'];

/** The section (tab) a catalog field belongs to. */
export function sectionOfField(field: FormField) {
  const group = field.group || 'البيانات الأساسية';
  return profileSectionOrder.find((tab) => profileGroups[tab].groups.includes(group)) || 'البيانات';
}

/** Essential fields of a section, plus the ones that become essential from the employee's state. */
export function isEssentialField(key: string, values: FormValues) {
  if (['separationDate', 'separationReason'].includes(key))
    return values.employmentStatus === 'terminated';
  if (key === 'contractorMonthlyAmount')
    return (
      values.payrollEmploymentType === 'contractor' ||
      (!values.payrollEmploymentType && values.relationshipType === 'collaborator')
    );
  return profileSectionOrder.some((tab) => profileGroups[tab].essential.includes(key));
}

export function hasFieldValue(values: FormValues, key: string) {
  const value = values[key];
  return value !== null && value !== undefined && value !== '';
}

/** Splits a section's fields into the short essential list and the optional extras. */
export function splitFields(list: FormField[], values: FormValues) {
  return {
    essential: list.filter((field) => isEssentialField(field.key, values)),
    extra: list.filter((field) => !isEssentialField(field.key, values)),
  };
}

export function authorizedFields(file: EmployeeFile, tab: string) {
  const config = profileGroups[tab];
  if (!config) return [];
  const allowed = allowedFieldKeys(file);
  return fields.filter((field) => sectionOfField(field) === tab && allowed.has(field.key));
}
export function visibleEmployeeFields(file: EmployeeFile) {
  const allowed = allowedFieldKeys(file);
  return fields.filter((field) => allowed.has(field.key));
}
export function isProfileFieldVisible(file: EmployeeFile, key: string) {
  return allowedFieldKeys(file).has(key);
}

export function profileTabs(file: EmployeeFile) {
  return profileSectionOrder.filter((tab) =>
    tab === 'الإجازات'
      ? allowedFieldKeys(file).has('annualLeaveEntitlement') ||
        !!file.leaveMovements.length ||
        file.leaveSummary.balanceKnown
      : authorizedFields(file, tab).length > 0,
  );
}

const identityKeys = ['name', 'employeeNumber', 'department', 'title'];
export const REPORT_DOCUMENT_LIMIT = 15;
/**
 * What the PDF report shows. The template renders from this, and the service export audits it,
 * so the audit event names exactly the sections, fields and documents disclosed.
 */
export function reportSelection(file: EmployeeFile, includeLeave: boolean) {
  const tabs = profileTabs(file).filter((tab) => includeLeave || tab !== 'الإجازات');
  const fieldSections = tabs
    .filter((tab) => tab !== 'الإجازات')
    .map((tab) => ({
      tab,
      fields: splitFields(authorizedFields(file, tab), file.values).essential.filter(
        (field) => !identityKeys.includes(field.key),
      ),
    }))
    .filter((section) => section.fields.length > 0);
  const leave = tabs.includes('الإجازات');
  const documents = file.documents
    .filter((doc) => doc.state === 'active')
    .slice(0, REPORT_DOCUMENT_LIMIT);
  const activeDocuments = file.documents.filter((doc) => doc.state === 'active').length;
  const fieldKeys = [
    ...identityKeys.filter((key) => isProfileFieldVisible(file, key)),
    ...fieldSections.flatMap((section) => section.fields.map((field) => field.key)),
    ...(leave && isProfileFieldVisible(file, 'annualLeaveEntitlement')
      ? ['annualLeaveEntitlement']
      : []),
  ];
  const sections = [
    'الهوية الوظيفية',
    ...fieldSections.map((section) => section.tab),
    ...(leave ? ['الإجازات'] : []),
    ...(documents.length ? ['الوثائق السارية'] : []),
  ];
  return { fieldSections, leave, documents, activeDocuments, fieldKeys, sections };
}
