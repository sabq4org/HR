/**
 * The finance-only link between a renewed owner-paid document case and an
 * existing owner-paid expense voucher. This is a reconciliation reference,
 * not a second accounting posting.
 */

export type RenewalSettlementState =
  'unlinked' | 'outstanding' | 'partial' | 'settled' | 'reversed';

export interface RenewalSettlementVoucher {
  id: string;
  number: string;
  date: string;
  description: string;
  reference: string;
  status: 'posted' | 'reversed';
  totalHalalas: number;
  refundedHalalas: number;
  remainingHalalas: number;
}

export interface RenewalSettlementLink {
  id: string;
  renewalId: string;
  voucherId: string;
  version: number;
  state: 'active' | 'corrected';
  reason: string;
  createdAt: string;
  correctedAt?: string | null;
  voucher: RenewalSettlementVoucher;
}

export interface RenewalSettlementSummary {
  renewalId: string;
  renewalStatus: 'open' | 'renewed' | 'cancelled';
  payment: 'none' | 'owner' | null;
  state: RenewalSettlementState;
  voucherId: string | null;
  voucherNumber: string | null;
  amountHalalas: number;
  refundedHalalas: number;
  remainingHalalas: number;
}

export interface RenewalSettlementDetails {
  renewalId: string;
  renewalStatus: 'open' | 'renewed' | 'cancelled';
  payment: 'none' | 'owner' | null;
  eligible: boolean;
  expectedFeeHalalas: number | null;
  version: number;
  settlement: RenewalSettlementLink | null;
  options: RenewalSettlementVoucherOption[];
}

export interface RenewalSettlementVoucherOption extends RenewalSettlementVoucher {
  warning?: 'amount_mismatch';
}

export interface RenewalSettlementInput {
  voucherId: string;
  version?: number;
  reason?: string;
}

export interface RenewalSettlementCorrectionInput {
  /** Null removes the current reconciliation link without touching the voucher. */
  voucherId: string | null;
  version: number;
  reason: string;
}
