import { NavLink } from 'react-router-dom';

/**
 * One sidebar entry can cover several related pages. The pages keep their own
 * addresses (bookmarks, notifications and tests still work); this strip lets the
 * person move between them. Decision 020.
 */
export interface SectionTab {
  to: string;
  label: string;
}

export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  if (tabs.length < 2) return null;
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }) => `section-tab ${isActive ? 'active' : ''}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** The pages each grouped sidebar entry covers, for the given person. */
export function sectionGroups(role: string, accountMode: boolean) {
  const requests: SectionTab[] = [
    { to: '/services', label: 'طلب جديد' },
    { to: '/requests', label: 'طلباتي ومتابعاتي' },
  ];
  const entitlements: SectionTab[] = ['hr', 'finance', 'approver'].includes(role)
    ? [
        { to: '/leave-entitlement', label: 'استحقاق الإجازات والتصفية' },
        { to: '/end-of-service', label: 'مكافأة نهاية الخدمة' },
      ]
    : [];
  const settings: SectionTab[] = [
    ...(['hr', 'approver', 'auditor'].includes(role)
      ? [
          ...(!accountMode ? [{ to: '/settings/policies', label: 'القواعد والسياسات' }] : []),
          { to: '/settings/leave', label: 'سياسات الإجازات' },
        ]
      : []),
    ...(accountMode ? [{ to: '/settings/accounts', label: 'الحسابات والوصول' }] : []),
    ...(accountMode && ['hr', 'auditor'].includes(role)
      ? [{ to: '/settings/operations', label: 'حالة التشغيل' }]
      : []),
  ];
  return { requests, entitlements, settings };
}
