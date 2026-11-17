/**
 * Renewal follow-up contracts. These objects deliberately contain no file names,
 * numbers or contents: a renewal case is an operational pointer, not a document
 * download surface.
 */

export type RenewalStatus = 'open' | 'renewed' | 'cancelled';
export type RenewalPayment = 'none' | 'owner';

export interface DocumentRenewalCase {
  id: string;
  documentId: string;
  employeeId: string;
  employeeName: string;
  category: string;
  originalExpiry: string;
  assignedTo: string;
  assigneeName: string;
  status: RenewalStatus;
  newExpiry: string | null;
  proofDocumentId: string | null;
  payment: RenewalPayment | null;
  version: number;
  /** Current source-document version, useful for optimistic UI refreshes. */
  documentVersion: number;
  feeHalalas: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RenewalAssignee {
  id: string;
  name: string;
}

export interface RenewalsResponse {
  cases: DocumentRenewalCase[];
  assignees: RenewalAssignee[];
}
