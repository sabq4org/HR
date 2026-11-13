import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowUpLeft,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileCheck2,
  Mail,
  MapPin,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  WalletCards,
} from 'lucide-react';
import {
  addDays,
  Avatar,
  canDecide,
  dateLabel,
  Empty,
  isPending,
  LeaveRows,
  Modal,
  PageHeading,
  roleLabel,
  SectionTitle,
  useApp,
} from './lib';
import type { Employee } from '../shared/contracts';
import { EmployeeCreateDialog } from './administration';

export function WorkspaceArt() {
  return (
    <svg className="workspace-art" viewBox="0 0 340 250" fill="none" aria-hidden="true">
      <circle cx="172" cy="132" r="105" fill="#D5E8F5" />
      <path d="M56 213C74 153 33 130 53 98C87 122 103 159 91 213" fill="#82B5D4" />
      <path d="M79 212C81 163 116 151 108 128C79 142 66 173 70 211" fill="#4F91BB" />
      <path d="M54 211H96L89 240H62Z" fill="#BED7E9" />
      <path d="M111 194L145 59L269 91L235 225Z" fill="#629AC1" />
      <path d="M108 184L137 46L261 73L233 212Z" fill="white" />
      <path d="M137 46L261 73L253 109L129 82Z" fill="#1264A3" />
      <path
        d="M157 44L153 62M237 61L233 79"
        stroke="#9CC5DF"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        d="M150 117L164 120M178 123L192 126M206 129L220 132M143 145L157 148M171 151L185 154M199 157L213 160M137 172L151 175M165 178L179 181"
        stroke="#D8E4EE"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle cx="209" cy="158" r="17" fill="#E4F3EC" />
      <path
        d="M201 157L206 164L218 153"
        stroke="#23806A"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="278" cy="56" r="23" fill="#E8BD66" />
      <path
        d="M276 22V15M305 33L310 28M313 57H321M304 81L310 87M257 30L251 24"
        stroke="#E8BD66"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="M252 204C274 171 294 172 307 161C305 193 277 212 253 214" fill="#70A9B9" />
      <path d="M251 219C271 205 300 211 315 203C304 227 277 232 251 228" fill="#A2C7CE" />
      <path d="M261 205L246 237" stroke="#3D8194" strokeWidth="3" strokeLinecap="round" />
      <path d="M110 238H237" stroke="#BDD5E6" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function BalanceCard() {
  const { data, newLeave } = useApp();
  const { available, allocated, reserved, used } = data.balance;
  const percentage = allocated ? Math.max(0, Math.min(100, (available / allocated) * 100)) : 0;
  return (
    <section className="balance-card">
      <div className="balance-title">
        <span className="icon-tile">
          <Sun size={20} />
        </span>
        <h2>مساحة لاستراحة</h2>
      </div>
      <div className="balance-body">
        <div
          className="balance-ring"
          style={{ '--progress': `${percentage}%` } as React.CSSProperties}
        >
          <div>
            <strong>{available}</strong>
            <span>يوم متاح</span>
          </div>
        </div>
        <div className="balance-legend">
          <span>
            <i className="dot blue" />
            رصيد التجربة <b>{allocated}</b>
          </span>
          <span>
            <i className="dot pale" />
            مستخدم <b>{used}</b>
          </span>
          <span>
            <i className="dot gold" />
            محجوز <b>{reserved}</b>
          </span>
        </div>
      </div>
      <button className="text-button" onClick={newLeave}>
        خطّط لإجازتك القادمة <ArrowUpLeft size={17} />
      </button>
    </section>
  );
}
export function Dashboard() {
  const { data, newLeave, showLeave } = useApp();
  const { me, employees, leaves, today } = data;
  const pending = leaves.filter(isPending);
  const actionable = pending.filter((l) => canDecide(me, l, employees));
  const upcoming = leaves
    .filter((l) => l.status === 'approved' && l.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const month = dateLabel(today, { month: 'long' });
  return (
    <>
      <PageHeading
        title="لوحة العمل"
        subtitle="صورة أوضح ليومك، ومساحة لكل ما يهمك."
        action={
          <span className="today-label">
            <CalendarDays size={17} />
            {dateLabel(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </span>
        }
      />
      <div className="welcome-grid">
        <section className="welcome-panel">
          <div className="welcome-copy">
            <span className="greeting">
              <span className="greeting-dot" />
              معًا، نصنع يومًا أفضل
            </span>
            <h2>
              أهـلًا {me.name.split(' ')[0]}،<br />
              كلّ ما يخصّـك، أقـرب.
            </h2>
            <p>
              {actionable.length
                ? `${actionable.length === 1 ? 'لديك طلب بانتظار قرارك' : `لديك ${actionable.length} طلبات بانتظار قرارك`}. خطوة صغيرة منك تساعد فريقك على التخطيط.`
                : 'من تفاصيل عملك إلى إجازتك القادمة، رتّب يومك وخلّ تركيزك على ما تصنعه.'}
            </p>
            <div className="hero-actions">
              <button className="button primary" onClick={newLeave}>
                <Plus size={18} />
                طلب إجازة
              </button>
              <Link className="text-button" to={actionable.length ? '/approvals' : '/profile'}>
                {actionable.length ? 'مراجعة الموافقات' : 'ملفي الوظيفي'}
                <ArrowUpLeft size={17} />
              </Link>
            </div>
          </div>
          <WorkspaceArt />
        </section>
        <BalanceCard />
      </div>
      <div className="stat-strip">
        <div>
          <span className="stat-icon">
            <Users size={21} />
          </span>
          <div>
            <small>{me.role === 'employee' ? 'ملفك الوظيفي' : 'أفراد الفريق'}</small>
            <strong>
              {me.role === 'employee' ? 'نشط' : employees.length}
              <em>{me.role === 'employee' ? 'في سبق' : 'موظفين في نطاقك'}</em>
            </strong>
          </div>
        </div>
        <div>
          <span className="stat-icon amber">
            <Clock3 size={21} />
          </span>
          <div>
            <small>طلبات قيد المراجعة</small>
            <strong>
              {pending.length}
              <em>طلب إجازة</em>
            </strong>
          </div>
        </div>
        <div>
          <span className="stat-icon green">
            <CalendarDays size={21} />
          </span>
          <div>
            <small>إجازات قادمة</small>
            <strong>
              {upcoming.length}
              <em>إجازات معتمدة</em>
            </strong>
          </div>
        </div>
        <div>
          <span className="stat-icon violet">
            <FileCheck2 size={21} />
          </span>
          <div>
            <small>{me.role === 'employee' ? 'طلباتك المعتمدة' : 'بانتظار قرارك'}</small>
            <strong>
              {me.role === 'employee'
                ? leaves.filter((l) => l.status === 'approved').length
                : actionable.length}
              <em>{me.role === 'employee' ? 'طلب معتمد' : 'طلبات قابلة للمراجعة'}</em>
            </strong>
          </div>
        </div>
      </div>
      <div className="dashboard-bottom">
        <section className="panel requests-panel">
          <SectionTitle
            title={me.role === 'employee' ? 'آخر طلباتك' : 'طلبات الفريق'}
            subtitle="كل طلب، وخطوته التالية."
            action={
              <Link className="text-button small" to="/leaves">
                عرض الكل <ChevronLeft size={16} />
              </Link>
            }
          />
          <LeaveRows
            leaves={[...pending, ...leaves.filter((l) => !isPending(l))].slice(0, 4)}
            compact
          />
        </section>
        <section className="panel team-panel">
          <SectionTitle
            title="الفريق هذا الأسبوع"
            action={
              <Link to="/calendar" className="icon-button" aria-label="فتح تقويم الفريق">
                <ArrowUpLeft size={19} />
              </Link>
            }
          />
          <div className="week-heading">
            <span>
              {month} {dateLabel(today, { year: 'numeric' })}
            </span>
            <span className="subtle">بتوقيت الرياض</span>
          </div>
          <div className="week-strip">
            {Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((day) => (
              <Link
                to="/calendar"
                key={day}
                className={day === today ? 'week-day current' : 'week-day'}
              >
                <span>{dateLabel(day, { weekday: 'short' })}</span>
                <b>{dateLabel(day, { day: 'numeric' })}</b>
                <i
                  className={
                    upcoming.some((l) => l.startDate <= day && l.endDate >= day) ? 'has-event' : ''
                  }
                />
              </Link>
            ))}
          </div>
          <div className="upcoming-list">
            {upcoming.length ? (
              upcoming.slice(0, 2).map((l) => (
                <button className="upcoming-person" key={l.id} onClick={() => showLeave(l)}>
                  <Avatar person={l} size="sm" />
                  <span>
                    <strong>{l.employeeName}</strong>
                    <small>
                      {dateLabel(l.startDate)} — {dateLabel(l.endDate)}
                    </small>
                  </span>
                  <span className="tiny-badge">إجازة</span>
                </button>
              ))
            ) : (
              <p className="quiet-empty">لا توجد إجازات قادمة معتمدة.</p>
            )}
          </div>
          <Link to="/calendar" className="calendar-link">
            افتح التقويم وخطّط مع فريقك <ChevronLeft size={16} />
          </Link>
        </section>
      </div>
      <div className="workspace-note">
        <ShieldCheck size={17} />
        <span>مساحتك تخصّك. تظهر لك البيانات بحسب دورك وصلاحياتك.</span>
        <span className="note-brand">فريق واحد. أثر أكبر.</span>
      </div>
    </>
  );
}

export function LeavesPage() {
  const { data, newLeave } = useApp();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState(false);
  const leaves = data.leaves.filter(
    (l) =>
      (!mine || l.employeeId === data.me.id) &&
      (filter === 'all' || (filter === 'pending' ? isPending(l) : l.status === filter)) &&
      `${l.employeeName} ${l.id}`.includes(query),
  );
  return (
    <>
      <PageHeading
        title="الإجازات والطلبات"
        subtitle="خطّط لاستراحتك، وتابع طلبك خطوة بخطوة."
        action={
          <button className="button primary" onClick={newLeave}>
            <Plus size={18} />
            طلب إجازة
          </button>
        }
      />
      <div className="leave-summary">
        <div className="leave-summary-icon">
          <Sun size={29} />
        </div>
        <div>
          <span>رصيد إجازتك المتاح</span>
          <strong>
            {data.balance.available}
            <small>يوم</small>
          </strong>
        </div>
        <div className="summary-divider" />
        <p>
          من أصل {data.balance.allocated} يومًا في السياسة التجريبية.
          <br />
          <span>
            {data.balance.reserved} محجوزة للطلبات · {data.balance.used} مستخدمة
          </span>
        </p>
        <span className="demo-pill">سياسة تجريبية</span>
      </div>
      <section className="panel">
        <div className="filter-toolbar">
          <div className="tabs" role="group" aria-label="تصفية حالة الطلبات">
            {[
              ['all', 'كل الطلبات'],
              ['pending', 'قيد المراجعة'],
              ['approved', 'المعتمدة'],
              ['rejected', 'المرفوضة'],
              ['cancelled', 'الملغاة'],
            ].map(([v, l]) => (
              <button
                className={filter === v ? 'tab active' : 'tab'}
                aria-pressed={filter === v}
                key={v}
                onClick={() => setFilter(v)}
              >
                {l}
              </button>
            ))}
          </div>
          <label className="search-field">
            <Search size={17} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ابحث في الطلبات"
              aria-label="ابحث في الطلبات"
            />
          </label>
        </div>
        {data.me.role !== 'employee' && (
          <label className="checkbox-filter">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            عرض طلباتي فقط
          </label>
        )}
        <LeaveRows leaves={leaves} />
        <div className="table-footer">
          {leaves.length} طلبات<span>يمكنك فتح أي طلب للاطلاع على تفاصيله.</span>
        </div>
      </section>
    </>
  );
}
export function ApprovalsPage() {
  const { data } = useApp();
  const [filter, setFilter] = useState('actionable');
  if (data.me.role === 'employee')
    return (
      <>
        <PageHeading title="الموافقات" subtitle="هذه المساحة مخصصة لأصحاب صلاحية الاعتماد." />
        <Empty
          title="لا تملك صلاحية هذه المساحة"
          detail="يمكنك متابعة حالة طلباتك من صفحة الإجازات."
          action={
            <Link className="button primary" to="/leaves">
              عرض طلباتي
            </Link>
          }
        />
      </>
    );
  const pending = data.leaves.filter(isPending);
  const actionable = pending.filter((l) => canDecide(data.me, l, data.employees));
  return (
    <>
      <PageHeading title="صندوق الموافقات" subtitle="قرار واضح، وفريق يستطيع التخطيط." />
      <div className="approval-intro">
        <span className="approval-mark">
          <FileCheck2 size={30} />
        </span>
        <div>
          <h2>
            {actionable.length
              ? actionable.length === 1
                ? 'طلب بانتظارك'
                : `${actionable.length} طلبات بانتظارك`
              : 'أنت على اطّلاع بكل شيء'}
          </h2>
          <p>
            {actionable.length
              ? 'راجع الفترة والتغطية، ثم اتخذ قرارك من تفاصيل الطلب.'
              : 'ستظهر هنا الطلبات عندما تصل إلى خطوتك في مسار الموافقة.'}
          </p>
        </div>
        <span className="role-badge">{roleLabel[data.me.role]}</span>
      </div>
      <section className="panel">
        <div className="filter-toolbar">
          <div className="tabs" role="group" aria-label="نطاق الموافقات">
            <button
              className={filter === 'actionable' ? 'tab active' : 'tab'}
              aria-pressed={filter === 'actionable'}
              onClick={() => setFilter('actionable')}
            >
              تحتاج قراري <span>{actionable.length}</span>
            </button>
            <button
              className={filter === 'all' ? 'tab active' : 'tab'}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              كل الطلبات المعلّقة <span>{pending.length}</span>
            </button>
          </div>
        </div>
        <LeaveRows leaves={filter === 'actionable' ? actionable : pending} />
      </section>
      <div className="inline-note">
        <ShieldCheck size={18} />
        كل قرار مرتبط بصاحب الصلاحية ونسخة الطلب. لا يمكن اعتماد طلبك الشخصي.
      </div>
    </>
  );
}
export function PeoplePage() {
  const { data, refresh } = useApp();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('all');
  const departments = [...new Set(data.employees.map((e) => e.department))];
  const people = data.employees.filter(
    (e) =>
      (department === 'all' || department === e.department) &&
      `${e.name} ${e.title} ${e.employeeNumber}`.includes(query),
  );
  return (
    <>
      <PageHeading
        title="دليل الفريق"
        subtitle="وجوه تعرفها، وتفاصيل تجمعنا في مكان واحد."
        action={
          <span className="count-label">
            <Users size={18} />
            {data.employees.length} في نطاق صلاحيتك
          </span>
        }
      />
      <section className="people-toolbar">
        <label className="search-field wide-search">
          <Search size={19} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالاسم أو المسمّى الوظيفي"
            aria-label="البحث في دليل الفريق"
          />
        </label>
        <label className="select-field">
          <span>القسم</span>
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            aria-label="تصفية القسم"
          >
            <option value="all">كل الأقسام</option>
            {departments.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <span className="subtle">{people.length} نتائج</span>
        {data.me.role === 'hr' && (
          <div className="employee-actions">
            <Link className="button secondary" to="/employees/import">
              استيراد Excel
            </Link>
            <button className="button primary" onClick={() => setCreating(true)}>
              <Plus size={17} />
              إضافة موظف
            </button>
          </div>
        )}
      </section>
      {people.length ? (
        <div className="people-grid">
          {people.map((e) => (
            <Link to={`/employees/${e.id}`} className="person-card" key={e.id}>
              <div className="person-card-top">
                <Avatar person={e} size="lg" />
                <span className={e.status === 'active' ? 'active-dot' : 'subtle'}>
                  {
                    {
                      active: 'على رأس العمل',
                      on_leave: 'في إجازة',
                      suspended: 'موقوف',
                      terminated: 'منتهية الخدمة',
                    }[e.status]
                  }
                </span>
              </div>
              <h2>{e.name}</h2>
              <p>{e.title}</p>
              <span className="department-tag">{e.department}</span>
              <div className="person-card-footer">
                <span>
                  <MapPin size={14} />
                  {e.location}
                </span>
                <ArrowUpLeft size={18} />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="لم نجد اسمًا مطابقًا" detail="جرّب اسمًا آخر أو اختر جميع الأقسام." />
      )}
      {creating && (
        <EmployeeCreateDialog
          close={() => setCreating(false)}
          onCreated={(id) => {
            void refresh();
            navigate(`/employees/${id}/file`);
          }}
        />
      )}
    </>
  );
}
export function ProfilePage({ self = false }: { self?: boolean }) {
  const { data, newLeave } = useApp();
  const { id } = useParams();
  const [tab, setTab] = useState('overview');
  const employee = self ? data.me : data.employees.find((e) => e.id === id);
  if (!employee)
    return (
      <>
        <PageHeading title="الملف الوظيفي" subtitle="بيانات الموظف بحسب صلاحيتك." />
        <Empty
          title="الملف غير متاح"
          detail="قد لا تملك صلاحية عرض هذا الملف أو أنه غير موجود."
          action={
            <Link to="/" className="button primary">
              العودة للوحة العمل
            </Link>
          }
        />
      </>
    );
  const manager = data.employees.find((e) => e.id === employee.managerId);
  const mine = employee.id === data.me.id;
  return (
    <>
      <PageHeading
        title={mine ? 'ملفي الوظيفي' : 'الملف الوظيفي'}
        subtitle="كل التفاصيل التي تصنع رحلتك في سبق."
        action={
          mine ? (
            <button className="button primary" onClick={newLeave}>
              <Plus size={18} />
              طلب إجازة
            </button>
          ) : (
            <Link to="/employees" className="text-button">
              العودة للفريق
              <ChevronLeft size={17} />
            </Link>
          )
        }
      />
      <section className="profile-hero">
        <div className="profile-cover">
          <span>مكانك بيننا، وأثرك معنا.</span>
          <div className="cover-lines" aria-hidden="true" />
        </div>
        <div className="profile-identity">
          <Avatar person={employee} size="xl" />
          <div>
            <h2>{employee.name}</h2>
            <p>
              {employee.title} <span>·</span> {employee.department}
            </p>
          </div>
          <span className="status status-approved">
            <Check size={14} />
            على رأس العمل
          </span>
        </div>
        <div className="profile-meta">
          <span>
            <MapPin size={16} />
            {employee.location}
          </span>
          <span>
            <Mail size={16} />
            <bdi>{employee.email}</bdi>
          </span>
          <span>
            <CalendarDays size={16} />
            انضم في{' '}
            {dateLabel(employee.joinDate, { day: 'numeric', month: 'long', year: 'numeric' })}
          </span>
        </div>
        <div className="tabs profile-tabs" role="group" aria-label="أقسام الملف">
          <button
            className={tab === 'overview' ? 'tab active' : 'tab'}
            aria-pressed={tab === 'overview'}
            onClick={() => setTab('overview')}
          >
            نظرة عامة
          </button>
          <button
            className={tab === 'leaves' ? 'tab active' : 'tab'}
            aria-pressed={tab === 'leaves'}
            onClick={() => setTab('leaves')}
          >
            سجل الإجازات
          </button>
          <Link className="tab" to={mine ? '/profile/file' : `/employees/${employee.id}/file`}>
            الملف الكامل والوثائق <ChevronLeft size={14} />
          </Link>
        </div>
      </section>
      {tab === 'overview' ? (
        <div className="profile-grid">
          <section className="panel details-panel">
            <SectionTitle title="معلومات العمل" subtitle="تفاصيل العلاقة الوظيفية الحالية." />
            <dl className="details-grid">
              <div>
                <dt>الرقم الوظيفي</dt>
                <dd>
                  <bdi>{employee.employeeNumber}</bdi>
                </dd>
              </div>
              <div>
                <dt>القسم</dt>
                <dd>{employee.department}</dd>
              </div>
              <div>
                <dt>المسمّى الوظيفي</dt>
                <dd>{employee.title}</dd>
              </div>
              <div>
                <dt>المدير المباشر</dt>
                <dd>
                  {manager?.name || (employee.managerId ? 'مدير الفريق' : 'غير محدد في التجربة')}
                </dd>
              </div>
              <div>
                <dt>موقع العمل</dt>
                <dd>{employee.location}</dd>
              </div>
              <div>
                <dt>تاريخ المباشرة</dt>
                <dd>
                  {dateLabel(employee.joinDate, { day: 'numeric', month: 'long', year: 'numeric' })}
                </dd>
              </div>
              <div>
                <dt>نطاق الوصول</dt>
                <dd>{roleLabel[employee.role]}</dd>
              </div>
              <div>
                <dt>الحالة الوظيفية</dt>
                <dd>نشط</dd>
              </div>
            </dl>
          </section>
          <section className="panel journey-panel">
            <SectionTitle title="رحلتك في سبق" />
            <div className="journey-step">
              <span>
                <Sparkles size={17} />
              </span>
              <div>
                <small>{dateLabel(employee.joinDate, { month: 'long', year: 'numeric' })}</small>
                <h3>بداية الحكاية</h3>
                <p>
                  انضمام {employee.name.split(' ')[0]} إلى فريق {employee.department}.
                </p>
              </div>
            </div>
            <div className="journey-step">
              <span>
                <Check size={17} />
              </span>
              <div>
                <small>اليوم</small>
                <h3>والأثر مستمر</h3>
                <p>{employee.title} في فريق سبق.</p>
              </div>
            </div>
            <div className="profile-privacy">
              <ShieldCheck size={20} />
              <p>تُعرض معلومات العمل اللازمة فقط، بحسب صلاحية حسابك.</p>
            </div>
          </section>
        </div>
      ) : (
        <section className="panel">
          <SectionTitle title="طلبات الإجازة" />
          <LeaveRows leaves={data.leaves.filter((l) => l.employeeId === employee.id)} />
        </section>
      )}
    </>
  );
}

export function CalendarPage() {
  const { data, showLeave } = useApp();
  const [month, setMonth] = useState(data.today.slice(0, 7));
  const [mine, setMine] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const first = `${month}-01`;
  const date = new Date(`${first}T12:00:00Z`);
  const offset = date.getUTCDay();
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const cellCount = Math.ceil((offset + last) / 7) * 7;
  const leaves = data.leaves.filter(
    (l) => l.status === 'approved' && (!mine || l.employeeId === data.me.id),
  );
  const onDay = (day: string) =>
    leaves.filter(
      (l) =>
        l.startDate <= day &&
        l.endDate >= day &&
        data.policy.workingDays.includes(new Date(`${day}T12:00:00Z`).getUTCDay()),
    );
  const move = (n: number) => {
    const d = new Date(`${first}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  return (
    <>
      <PageHeading
        title="تقويم الفريق"
        subtitle="خطّطوا معًا. تعرف على الإجازات المعتمدة قبل ترتيب أيامك."
      />
      <section className="panel calendar-panel">
        <div className="calendar-toolbar">
          <div className="calendar-month">
            <h2>{dateLabel(first, { month: 'long', year: 'numeric' })}</h2>
            <button className="icon-button" onClick={() => move(-1)} aria-label="الشهر السابق">
              <ChevronRight size={19} />
            </button>
            <button className="icon-button" onClick={() => move(1)} aria-label="الشهر التالي">
              <ChevronLeft size={19} />
            </button>
            <button className="button quiet small" onClick={() => setMonth(data.today.slice(0, 7))}>
              اليوم
            </button>
          </div>
          <div className="segmented">
            <button
              className={!mine ? 'selected' : ''}
              aria-pressed={!mine}
              onClick={() => setMine(false)}
            >
              الفريق
            </button>
            <button
              className={mine ? 'selected' : ''}
              aria-pressed={mine}
              onClick={() => setMine(true)}
            >
              إجازاتي
            </button>
          </div>
        </div>
        <div className="calendar-weeknames">
          {['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {Array.from({ length: cellCount }, (_, i) => {
            const day = addDays(first, i - offset);
            const events = onDay(day);
            const other = day.slice(0, 7) !== month;
            const weekend = [5, 6].includes(i % 7);
            return (
              <button
                key={day}
                className={`calendar-day ${other ? 'other-month' : ''} ${weekend ? 'weekend' : ''} ${day === data.today ? 'is-today' : ''}`}
                onClick={() => setSelected(day)}
                aria-label={`${dateLabel(day, { weekday: 'long', day: 'numeric', month: 'long' })}، ${events.length} إجازات`}
              >
                <span className="day-number">{Number(day.slice(-2))}</span>
                <div className="day-events">
                  {events.slice(0, 2).map((l) => (
                    <span className="calendar-event" key={l.id}>
                      <i />
                      {l.employeeName.split(' ')[0]}
                    </span>
                  ))}
                  {events.length > 2 && <small>+{events.length - 2} آخرون</small>}
                </div>
                {events.length > 0 && <span className="mobile-event-count">{events.length}</span>}
              </button>
            );
          })}
        </div>
        <div className="calendar-legend">
          <span>
            <i className="dot blue" />
            إجازة معتمدة
          </span>
          <span>
            <i className="dot pale" />
            راحة أسبوعية حسب سياسة التجربة
          </span>
        </div>
      </section>
      {selected && (
        <Modal
          title={dateLabel(selected, { weekday: 'long', day: 'numeric', month: 'long' })}
          close={() => setSelected(null)}
        >
          <div className="dialog-body">
            {onDay(selected).length ? (
              onDay(selected).map((l) => (
                <button
                  key={l.id}
                  className="upcoming-person"
                  onClick={() => {
                    setSelected(null);
                    showLeave(l);
                  }}
                >
                  <Avatar person={l} />
                  <span>
                    <strong>{l.employeeName}</strong>
                    <small>إجازة سنوية · {l.days} أيام</small>
                  </span>
                  <ChevronLeft size={18} />
                </button>
              ))
            ) : (
              <Empty
                title="لا توجد إجازات في هذا اليوم"
                detail="يظهر هنا أعضاء الفريق الذين لديهم إجازة معتمدة في يوم عمل."
              />
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
