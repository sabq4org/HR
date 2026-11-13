import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { X, Check, Clock3, Ban, ChevronLeft } from 'lucide-react';
import type { Bootstrap, Employee, LeaveRequest, LeaveStatus, Role } from '../shared/contracts';

export const roleLabel: Record<Role, string> = {
  employee: 'موظف',
  manager: 'مدير فريق',
  hr: 'الموارد البشرية',
};
export const statusLabel: Record<LeaveStatus, string> = {
  pending_manager: 'لدى المدير',
  pending_hr: 'لدى الموارد البشرية',
  approved: 'معتمدة',
  rejected: 'مرفوضة',
  cancelled: 'ملغاة',
};
export const statusClass: Record<LeaveStatus, string> = {
  pending_manager: 'pending',
  pending_hr: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'neutral',
};
export function dateLabel(
  value: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' },
) {
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    ...options,
    timeZone: 'Asia/Riyadh',
  }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function countDays(start: string, end: string, workingDays: number[]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start)
    return 0;
  let count = 0;
  let cursor = start;
  for (let i = 0; cursor <= end && i < 367; i++, cursor = addDays(cursor, 1))
    if (workingDays.includes(new Date(`${cursor}T12:00:00Z`).getUTCDay())) count++;
  return count;
}
export const isPending = (leave: LeaveRequest) =>
  leave.status === 'pending_manager' || leave.status === 'pending_hr';
export function canDecide(me: Employee, leave: LeaveRequest, employees: Employee[]) {
  if (me.id === leave.employeeId) return false;
  if (me.role === 'manager' && leave.status === 'pending_manager')
    return employees.find((e) => e.id === leave.employeeId)?.managerId === me.id;
  return me.role === 'hr' && leave.status === 'pending_hr';
}
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || 'تعذّر إكمال العملية. حاول مرة أخرى.');
  }
  if (response.status === 204) return undefined as T;
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('خدمة البيانات غير متاحة الآن. أعد المحاولة بعد قليل.');
  }
  return response.json();
}
interface AppContextValue {
  data: Bootstrap;
  refresh: () => Promise<void>;
  newLeave: () => void;
  showLeave: (leave: LeaveRequest) => void;
  notify: (message: string) => void;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('App context unavailable');
  return value;
}
export function Avatar({
  person,
  size = 'md',
}: {
  person: { initials: string; color: string };
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ backgroundColor: person.color }}
      aria-hidden="true"
    >
      {person.initials}
    </span>
  );
}
export function Status({ value }: { value: LeaveStatus }) {
  const Icon =
    value === 'approved' ? Check : value === 'rejected' || value === 'cancelled' ? Ban : Clock3;
  return (
    <span className={`status status-${statusClass[value]}`}>
      <Icon size={13} />
      {statusLabel[value]}
    </span>
  );
}
export function Modal({
  title,
  children,
  close,
  wide = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const before = document.activeElement as HTMLElement;
    d.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      d.close();
      document.body.style.overflow = old;
      before?.focus();
    };
  }, []);
  return (
    <dialog
      className={`dialog ${wide ? 'dialog-wide' : ''} ${className}`}
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const b = ref.current.getBoundingClientRect();
          if (
            e.clientX < b.left ||
            e.clientX > b.right ||
            e.clientY < b.top ||
            e.clientY > b.bottom
          )
            close();
        }
      }}
    >
      <header className="dialog-header">
        <h2>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="إغلاق">
          <X size={21} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">
        <Check size={26} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}
export function SectionTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
const displayTitles: Record<string, string> = {
  'لوحة العمل': 'لوحـة العمـل',
  'الإجازات والطلبات': 'الإجـازات والطلبـات',
  'صندوق الموافقات': 'صنـدوق الموافقـات',
  الموافقات: 'الموافقـات',
  'دليل الفريق': 'دليـل الفريـق',
  'ملفي الوظيفي': 'ملفّـي الوظيفـي',
  'الملف الوظيفي': 'الملـف الوظيفـي',
  'تقويم الفريق': 'تقويـم الفريـق',
};
export function PageHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1 aria-label={title}>{displayTitles[title] || title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
export function LeaveRows({
  leaves,
  compact = false,
}: {
  leaves: LeaveRequest[];
  compact?: boolean;
}) {
  const { showLeave } = useApp();
  if (!leaves.length)
    return <Empty title="لا توجد طلبات هنا" detail="ستظهر الطلبات وحالة كل خطوة في هذه المساحة." />;
  return (
    <div className={`leave-table ${compact ? 'compact' : ''}`}>
      <div className="leave-table-head">
        <span>الموظف / الطلب</span>
        <span>الفترة</span>
        <span>المدة</span>
        <span>الحالة</span>
        <span />
      </div>
      {leaves.map((leave) => (
        <button
          key={leave.id}
          className="leave-row"
          onClick={() => showLeave(leave)}
          aria-label={`تفاصيل طلب ${leave.employeeName} من ${dateLabel(leave.startDate)}`}
        >
          <span className="person-cell">
            <Avatar person={leave} />
            <span>
              <strong>{leave.employeeName}</strong>
              <small>إجازة سنوية</small>
            </span>
          </span>
          <span className="date-cell">
            {dateLabel(leave.startDate)}
            <small>إلى {dateLabel(leave.endDate)}</small>
          </span>
          <span className="days-cell">
            <b>{leave.days}</b> {leave.days === 1 ? 'يوم' : 'أيام'}
          </span>
          <Status value={leave.status} />
          <ChevronLeft size={17} className="row-chevron" />
        </button>
      ))}
    </div>
  );
}
