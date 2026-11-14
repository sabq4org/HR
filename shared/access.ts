import type { Role } from './contracts.js';

export type Actor = { id: string; role: Role; owner?: boolean };
export type AccountSummary = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  loginName: string;
  role: Role;
  status: string;
  enabled: boolean;
  activatedAt: string | null;
};
