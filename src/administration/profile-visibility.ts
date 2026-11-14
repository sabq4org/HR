// Which profile fields and tabs a file shows. Pure (no React, router or CSS), so the server PDF
// of the employee report applies exactly the same rules as the in-app report.
import type { EmployeeFile, FormField } from '../../shared/administration';
import { employeeFields } from '../../shared/catalog';
const fields = employeeFields as FormField[];
export function allowedFieldKeys(file: EmployeeFile) {
  return new Set(file.visibleFieldKeys);
}
export const profileGroups: Record<string, { title: string; groups: string[]; keys?: string[] }> = {
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

export function authorizedFields(file: EmployeeFile, tab: string) {
  const config = profileGroups[tab];
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
