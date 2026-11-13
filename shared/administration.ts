import type { Employee, Role } from './contracts';

export type Scalar = string | number | boolean | null;
export type FormValues = Record<string, Scalar>;
export type FieldType =
  'text' | 'textarea' | 'date' | 'number' | 'money' | 'email' | 'select' | 'checkbox' | 'employee';
export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  group?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  sensitive?: 'personal' | 'financial' | 'medical';
  min?: number;
  max?: number;
}
export type RequestKind =
  | 'contract'
  | 'contract_amendment'
  | 'probation'
  | 'salary_letter'
  | 'employment_letter'
  | 'experience_letter'
  | 'clearance'
  | 'advance'
  | 'data_change'
  | 'bank_change'
  | 'transfer'
  | 'special_leave'
  | 'leave_adjustment'
  | 'overtime'
  | 'reward'
  | 'separation'
  | 'settlement'
  | 'discipline'
  | 'grievance';
export type RequestState =
  | 'draft'
  | 'pending_manager'
  | 'pending_hr'
  | 'pending_finance'
  | 'pending_approver'
  | 'returned'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'closed';
export interface FormDefinition {
  kind: RequestKind;
  title: string;
  description: string;
  category: 'employment' | 'services' | 'time' | 'financial' | 'separation' | 'compliance';
  initiators: Role[];
  steps: Role[];
  stepsByInitiator?: Partial<Record<Role, Role[]>>;
  fields: FormField[];
  confidential?: boolean;
  printable?: boolean;
}
export interface AdministrativeRequest {
  id: string;
  number: string;
  kind: RequestKind;
  employeeId: string;
  employeeName: string;
  createdBy: string;
  state: RequestState;
  version: number;
  values: FormValues;
  steps: Role[];
  stepIndex: number;
  createdAt: string;
  updatedAt: string;
  canAct: boolean;
  canEdit: boolean;
  timeline: WorkflowEvent[];
  issuedDocument?: IssuedDocument;
}
export interface IssuedDocument {
  title: string;
  language: 'ar' | 'en';
  reference: string;
  issuedAt: string;
  recipient: string;
  paragraphs: string[];
  facts: { label: string; value: string }[];
  approvedByName: string;
  version: 1;
}
export interface WorkflowEvent {
  id: string;
  actorId: string;
  actorName: string;
  role: Role;
  action: string;
  reason: string | null;
  createdAt: string;
  version: number;
}
export interface EmploymentPeriod {
  id: string;
  startDate: string;
  endDate: string | null;
  relationshipType: string;
  source: string;
}
export interface EmployeeFile {
  employee: Employee;
  version: number;
  values: FormValues;
  editable: boolean;
  periods: EmploymentPeriod[];
  requests: AdministrativeRequest[];
  documents: EmployeeDocument[];
  completeness: { completed: number; total: number; missing: string[] };
  history: WorkflowEvent[];
}
export interface EmployeeDocument {
  id: string;
  employeeId: string;
  employeeName: string;
  category: string;
  filename: string;
  mimeType: string;
  size: number;
  expiresAt: string | null;
  uploadedAt: string;
  uploadedBy: string;
  checksum: string;
  version: number;
  state: 'active' | 'archived';
}
export interface DocumentCategory {
  key: string;
  label: string;
  sensitive?: 'financial' | 'medical' | 'personal';
  hasExpiry?: boolean;
}
export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  checkIn: string;
  checkOut: string;
  minutes: number;
  workMode: 'office' | 'remote' | 'field';
  note: string;
  state: 'submitted' | 'approved' | 'rejected';
  version: number;
  reviewedBy: string | null;
  reason: string | null;
  canReview: boolean;
}
export interface PolicyRecord {
  id: string;
  key: string;
  name: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  state: 'draft' | 'synthetic_approved' | 'retired';
  values: FormValues;
  createdBy: string;
  approvedBy: string | null;
}
export interface PayrollLine {
  id: string;
  employeeId: string;
  employeeName: string;
  component: string;
  kind: 'earning' | 'deduction';
  amountMinor: number;
  source: string;
  sourceRequestId?: string | null;
}
export interface PayrollPayment {
  employeeId: string;
  state: 'pending' | 'paid' | 'failed' | 'partial';
  paidMinor: number;
  reference: string;
  recordedAt: string;
}
export interface PayrollRun {
  id: string;
  period: string;
  version: number;
  state: 'draft' | 'pending_finance' | 'pending_approver' | 'closed' | 'rejected';
  preparedBy: string;
  reviewedBy: string | null;
  approvedBy: string | null;
  policyId: string;
  correctionOf: string | null;
  reason: string;
  lines: PayrollLine[];
  payments: PayrollPayment[];
  totals: { earningsMinor: number; deductionsMinor: number; netMinor: number };
  createdAt: string;
  closedAt: string | null;
  canEdit: boolean;
  canReview: boolean;
  timeline: WorkflowEvent[];
}
export interface AuditRecord {
  id: string;
  actorName: string;
  actorRole: string;
  action: string;
  resourceId: string;
  reason: string | null;
  createdAt: string;
}
export interface AdministrativeOverview {
  counts: {
    employees: number;
    pendingRequests: number;
    expiringDocuments: number;
    expiringContracts: number;
    attendancePending: number;
    payrollDrafts: number;
  };
  requests: AdministrativeRequest[];
  expiries: {
    id: string;
    employeeName: string;
    title: string;
    date: string;
    type: 'document' | 'contract';
  }[];
  capabilities: {
    manageEmployees: boolean;
    payroll: boolean;
    reports: boolean;
    policies: boolean;
    audit: boolean;
  };
}
