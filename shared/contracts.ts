export type Role = 'employee' | 'manager' | 'hr' | 'finance' | 'approver' | 'auditor';
export type LeaveStatus = 'pending_manager' | 'pending_hr' | 'approved' | 'rejected' | 'cancelled';
export interface Employee {
  id: string;
  employeeNumber: string;
  name: string;
  initials: string;
  title: string;
  department: string;
  email: string;
  location: string;
  managerId: string | null;
  joinDate: string;
  role: Role;
  color: string;
  status: 'active' | 'on_leave' | 'suspended' | 'terminated';
  /** Id of the active profile photo document, or null. Bytes come from /api/employees/:id/photo. */
  photoId?: string | null;
}
export interface Balance {
  allocated: number;
  available: number;
  reserved: number;
  used: number;
}
export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeTitle: string;
  department: string;
  initials: string;
  color: string;
  type: 'annual';
  startDate: string;
  endDate: string;
  days: number;
  note: string;
  status: LeaveStatus;
  version: number;
  createdAt: string;
  managerDecisionAt: string | null;
  hrDecisionAt: string | null;
  decisionReason: string | null;
}
export interface Notification {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  leaveId: string | null;
  requestId?: string | null;
}
export interface DemoPersona {
  id: string;
  name: string;
  role: Role;
  title: string;
}
export interface DemoPolicy {
  name: string;
  version: string;
  description: string;
  workingDays: number[];
}
export interface Bootstrap {
  me: Employee;
  employees: Employee[];
  leaves: LeaveRequest[];
  balance: Balance;
  notifications: Notification[];
  personas: DemoPersona[];
  policy: DemoPolicy;
  today: string;
}
export interface CreateLeaveInput {
  startDate: string;
  endDate: string;
  note: string;
}
export interface DecisionInput {
  decision: 'approve' | 'reject';
  version: number;
  reason?: string;
}
export interface ApiError {
  error: { code: string; message: string };
}

// GET /api/session -> { me: Employee | null, personas: DemoPersona[] }
// POST /api/demo/session { employeeId } -> { me: Employee }; HTTP-only SameSite=Strict cookie.
// DELETE /api/session -> 204
// GET /api/bootstrap -> Bootstrap; requires session.
// GET /api/employees/:id -> { employee: Employee }; resource scoped.
// POST /api/leaves + Idempotency-Key -> { leave: LeaveRequest }; CreateLeaveInput.
// POST /api/leaves/:id/decision + Idempotency-Key -> { leave: LeaveRequest }; DecisionInput.
// POST /api/leaves/:id/cancel + Idempotency-Key -> { leave: LeaveRequest }; {version:number}.
// POST /api/notifications/read -> 204. Only current user's notifications.
// GET /api/health -> {status:'ok', mode:'synthetic-local' | 'synthetic-hosted'}.
// All unsafe requests: require same-origin Origin header. No CORS. Bind loopback only.
