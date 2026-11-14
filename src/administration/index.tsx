import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { IssuedLetter } from '../letters';
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock3,
  FileText,
  Filter,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { api, Avatar, Modal, PageHeading, useApp } from '../lib';
import { EmployeeProfileReport } from './EmployeeProfileReport';
import {
  isProfileFieldVisible,
  ProfileReadiness,
  ProfileTab,
  profileTabs,
  visibleEmployeeFields,
} from './EmployeeProfileSections';
import type {
  AdministrativeOverview,
  AdministrativeRequest,
  AttendanceRecord,
  AuditRecord,
  DocumentCategory,
  EmployeeDocument,
  EmployeeFile,
  FormField,
  FormValues,
  PolicyRecord,
  RequestKind,
  RequestState,
} from '../../shared/administration';
import {
  employeeFields,
  documentCategories,
  formDefinitions,
  formByKind,
} from '../../shared/catalog';
import './administration.css';

const key = () => crypto.randomUUID();
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Idempotency-Key': key() },
  body: JSON.stringify(body),
});
const date = (s?: string | null) =>
  s
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
        dateStyle: 'medium',
        timeZone: 'Asia/Riyadh',
      }).format(new Date(s.length === 10 ? `${s}T12:00:00Z` : s))
    : '—';
const stateNames: Record<RequestState, string> = {
  draft: 'مسودة',
  pending_manager: 'لدى المدير',
  pending_hr: 'لدى الشؤون الإدارية',
  pending_finance: 'لدى المالية',
  pending_approver: 'بانتظار الاعتماد',
  returned: 'معاد للتعديل',
  approved: 'معتمد',
  rejected: 'مرفوض',
  cancelled: 'ملغي',
  closed: 'مغلق',
};
const roleNames: Record<string, string> = {
  employee: 'الموظف',
  manager: 'المدير المباشر',
  hr: 'الشؤون الإدارية',
  finance: 'المالية',
  approver: 'المعتمد المستقل',
  auditor: 'المراجع',
};
const actionNames: Record<string, string> = {
  created: 'إنشاء',
  submit: 'إرسال للمراجعة',
  submitted: 'إرسال للمراجعة',
  approve: 'اعتماد',
  approved: 'اعتماد',
  reject: 'رفض',
  rejected: 'رفض',
  return: 'إعادة للتعديل',
  returned: 'إعادة للتعديل',
  cancel: 'إلغاء',
  cancelled: 'إلغاء',
  closed: 'إغلاق',
  retire: 'إيقاف السياسة',
  archive: 'أرشفة',
  updated: 'تعديل',
  attendance_created: 'تسجيل حضور',
};
const attendanceStates: Record<string, string> = {
  submitted: 'بانتظار المراجعة',
  approved: 'معتمد',
  rejected: 'مرفوض',
};
const docCategoryLabel = (key: string) =>
  documentCategories.find((c) => c.key === key)?.label || 'وثيقة وظيفية';
const requestTitle = (kind: RequestKind) => formByKind[kind]?.title || kind;
function fieldLabel(key: string, fields: FormField[] = []) {
  return (
    fields.find((f) => f.key === key)?.label ||
    employeeFields.find((f) => f.key === key)?.label ||
    formDefinitions.flatMap((f) => f.fields).find((f) => f.key === key)?.label ||
    (
      {
        draft: 'مسودة',
        pending_manager: 'بانتظار المدير',
        pending_hr: 'بانتظار الشؤون الإدارية',
        pending_finance: 'بانتظار المالية',
        pending_approver: 'بانتظار الاعتماد',
        returned: 'معاد للتعديل',
        approved: 'معتمد',
        rejected: 'مرفوض',
        cancelled: 'ملغي',
        closed: 'مغلق',
        office: 'في المكتب',
        remote: 'عن بُعد',
        field: 'ميداني',
        active: 'نشط',
        archived: 'مؤرشف',
        submitted: 'بانتظار المراجعة',
      } as Record<string, string>
    )[key] ||
    'بيانات إضافية'
  );
}
async function downloadPrivate(doc: EmployeeDocument, notify: (message: string) => void) {
  try {
    const response = await fetch(`/api/admin/documents/${encodeURIComponent(doc.id)}/download`);
    if (!response.ok) throw new Error('تعذر تنزيل الوثيقة');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    notify((e as Error).message);
  }
}
function displayValue(
  value: unknown,
  field?: FormField,
  employees: { id: string; name: string }[] = [],
) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (field?.type === 'select')
    return field.options?.find((o) => o.value === String(value))?.label || String(value);
  if (field?.type === 'employee')
    return employees.find((e) => e.id === String(value))?.name || 'موظف محدد';
  if (field?.type === 'date' && typeof value === 'string') return date(value);
  return String(value);
}

function useLoad<T>(url: string, field: string) {
  const { data, notify } = useApp();
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    setValue(null);
    try {
      const result = await api<Record<string, T>>(url);
      if (current === generation.current) setValue(result[field]);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [url, field, data.me.id]);
  useEffect(() => {
    void load();
  }, [load]);
  return { value, loading, error, reload: load, setValue };
}
function useLoadRaw<T>(url: string) {
  const { data } = useApp();
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    setValue(null);
    try {
      const result = await api<T>(url);
      if (current === generation.current) setValue(result);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [url, data.me.id]);
  useEffect(() => {
    void load();
  }, [load]);
  return { value, loading, error, reload: load };
}
function Shell({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="admin-page">
      <PageHeading
        title={title}
        subtitle={subtitle}
        action={action ? <div className="adm-heading-actions">{action}</div> : undefined}
      />
      {children}
    </section>
  );
}
function Notice({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="adm-error" role="alert">
      {error}
      <button onClick={retry}>إعادة المحاولة</button>
    </div>
  );
}
function Busy() {
  return (
    <div className="adm-loading" role="status">
      جارٍ تحميل البيانات…
    </div>
  );
}
function Empty({ children }: { children: string }) {
  return (
    <div className="adm-empty">
      <FileText size={24} />
      <b>{children}</b>
    </div>
  );
}
function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="adm-table-wrap" role="region" aria-label={headers.join('، ')} tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function ActionButton({
  children,
  ...props
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button className="adm-button" {...props}>
      {children}
    </button>
  );
}
function Field({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string | number | boolean) => void;
}) {
  const { data } = useApp();
  const departmentOptions: string[] =
    field.key === 'department'
      ? [
          ...new Set(data.employees.map((employee) => employee.department.trim()).filter(Boolean)),
        ].sort((a, b) => a.localeCompare(b, 'ar'))
      : [];
  const common = {
    id: field.key,
    name: field.key,
    required: field.required,
    'aria-label': field.label,
  };
  return (
    <label className="adm-field" htmlFor={field.key}>
      <span>
        {field.label}
        {field.required ? ' *' : ''}
      </span>
      {field.type === 'employee' ? (
        <select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">اختر موظفًا</option>
          {data.employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {e.employeeNumber}
            </option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          {...common}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === 'select' ? (
        <select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">اختر</option>
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === 'checkbox' ? (
        <input
          {...common}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : (
        <input
          {...common}
          list={field.key === 'department' ? 'employee-departments' : undefined}
          type={
            field.type === 'date'
              ? 'date'
              : field.type === 'number' || field.type === 'money'
                ? 'number'
                : field.type === 'email'
                  ? 'email'
                  : 'text'
          }
          min={field.min}
          max={field.max}
          step={field.type === 'money' ? '0.01' : undefined}
          value={String(value ?? '')}
          onChange={(e) =>
            onChange(
              field.type === 'number' || field.type === 'money'
                ? e.target.value === ''
                  ? ''
                  : Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
      {field.key === 'department' && (
        <datalist id="employee-departments">
          {departmentOptions.map((department) => (
            <option key={department} value={department} />
          ))}
        </datalist>
      )}
      {field.hint && <small>{field.hint}</small>}
    </label>
  );
}

function EmployeeWizard({
  fields,
  values,
  setValues,
  busy,
  error,
  onSubmit,
  reason,
  setReason,
  reasonRequired = false,
  submitLabel,
}: {
  fields: FormField[];
  values: FormValues;
  setValues: (update: (current: FormValues) => FormValues) => void;
  busy: boolean;
  error: string;
  onSubmit: (e: FormEvent) => void;
  reason?: string;
  setReason?: (value: string) => void;
  reasonRequired?: boolean;
  submitLabel: string;
}) {
  const groups = fieldsByGroup(fields);
  const names = Object.keys(groups);
  const [step, setStep] = useState(0);
  const panel = useRef<HTMLFormElement>(null);
  const [validation, setValidation] = useState('');
  const review = step === names.length;
  const validate = () => {
    const required = groups[names[step]]?.filter((f) => f.required && !values[f.key]);
    if (required?.length) {
      setValidation(`أكمل الحقول المطلوبة: ${required.map((f) => f.label).join('، ')}`);
      return false;
    }
    setValidation('');
    return true;
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const missing = fields.filter((f) => f.required && !values[f.key]);
    if (missing.length) {
      const groupIndex = names.indexOf(missing[0].group || 'البيانات الأساسية');
      setStep(Math.max(0, groupIndex));
      setValidation(
        `أكمل الحقول المطلوبة: ${missing
          .filter((f) => (f.group || 'البيانات الأساسية') === names[Math.max(0, groupIndex)])
          .map((f) => f.label)
          .join('، ')}`,
      );
      return;
    }
    if (reasonRequired && !reason?.trim()) {
      setValidation('أدخل سبب التعديل قبل الحفظ');
      return;
    }
    setValidation('');
    onSubmit(e);
  };
  return (
    <form ref={panel} className="adm-form" onSubmit={submit} noValidate>
      <nav className="adm-tabs adm-group-tabs" aria-label="خطوات بيانات الموظف">
        {[...names, 'المراجعة'].map((name, i) => (
          <button
            type="button"
            key={name}
            className={step === i ? 'active' : ''}
            onClick={() => {
              if (i <= step || validate()) setStep(i);
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {review ? (
        <section className="adm-section">
          <h3>راجع البيانات قبل الحفظ</h3>
          <dl className="adm-details">
            {fields.map((f) => (
              <div key={f.key}>
                <dt>{f.label}</dt>
                <dd>{displayValue(values[f.key], f)}</dd>
              </div>
            ))}
          </dl>
          {reasonRequired && (
            <label className="adm-field">
              <span>سبب التعديل *</span>
              <textarea
                required
                value={reason || ''}
                onChange={(e) => setReason?.(e.target.value)}
              />
            </label>
          )}
        </section>
      ) : (
        <section className="adm-section">
          <h3>{names[step]}</h3>
          <div className="adm-fields">
            {groups[names[step]].map((f) => (
              <Field
                key={f.key}
                field={f}
                value={values[f.key]}
                onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
              />
            ))}
          </div>
        </section>
      )}
      {(error || validation) && (
        <p className="adm-error" role="alert">
          {error || validation}
        </p>
      )}
      <div className="adm-actions">
        {step > 0 && (
          <button type="button" className="adm-button secondary" onClick={() => setStep(step - 1)}>
            السابق
          </button>
        )}
        {!review ? (
          <ActionButton
            key="wizard-next"
            type="button"
            onClick={() => {
              if (validate()) setStep(step + 1);
            }}
          >
            التالي
          </ActionButton>
        ) : (
          <ActionButton key="wizard-save" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : submitLabel}
          </ActionButton>
        )}
      </div>
    </form>
  );
}
function fieldsByGroup(fields: FormField[]) {
  return fields.reduce<Record<string, FormField[]>>((a, f) => {
    (a[f.group || 'البيانات الأساسية'] ??= []).push(f);
    return a;
  }, {});
}

export function EmployeeFilePage({ employeeId }: { employeeId?: string }) {
  const { data, notify, refresh } = useApp();
  const id = employeeId || data.me.id;
  const {
    value: file,
    loading,
    error,
    reload,
    setValue,
  } = useLoad<EmployeeFile>(`/admin/employees/${encodeURIComponent(id)}`, 'file');
  const [tab, setTab] = useState('البيانات');
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [editGroup, setEditGroup] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  useEffect(() => {
    if (file) setValues(file.values);
  }, [file]);
  const editable = !!file?.editable;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const r = await api<{ file: EmployeeFile }>(
        `/admin/employees/${encodeURIComponent(id)}`,
        json('PATCH', { version: file.version, values, reason }),
      );
      setValue(r.file);
      setEditing(false);
      setReason('');
      notify('تم حفظ الملف الوظيفي');
      await refresh();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (loading)
    return (
      <Shell title="الملف الوظيفي" subtitle="بيانات الموظف وسجلها">
        <Busy />
      </Shell>
    );
  if (error)
    return (
      <Shell title="الملف الوظيفي" subtitle="بيانات الموظف وسجلها">
        <Notice error={error} retry={() => void reload()} />
      </Shell>
    );
  if (!file) return null;
  if (reportOpen) return <EmployeeProfileReport file={file} onBack={() => setReportOpen(false)} />;
  const employee = file.employee;
  const editableEmployeeFields = visibleEmployeeFields(file);
  const detailsTabs = profileTabs(file);
  const tabs = [...detailsTabs, 'الوثائق', 'فترات العمل', 'الطلبات', 'سجل التغييرات'];
  return (
    <Shell
      title="الملف الوظيفي"
      subtitle="بيانات الموظف وسجلها"
      action={
        <>
          <button className="adm-button secondary" onClick={() => setReportOpen(true)}>
            <Printer size={16} /> طباعة / حفظ PDF
          </button>
          {editable && tab === 'البيانات' && (
            <ActionButton onClick={() => setEditing(!editing)}>
              {editing ? 'إلغاء' : 'تعديل الملف'}
            </ActionButton>
          )}
        </>
      }
    >
      <header className="adm-profile">
        <Avatar person={employee} />
        <div>
          <h2>{employee.name}</h2>
          <p>
            {employee.title} · {employee.department} · {employee.employeeNumber}
          </p>
        </div>
        <div className="adm-completion">
          <strong>
            {Math.round((file.completeness.completed / Math.max(1, file.completeness.total)) * 100)}
            ٪
          </strong>
          <span>اكتمال البيانات الأساسية</span>
        </div>
        <div className="adm-doc-count">
          <strong>{file.documents.filter((d) => d.state === 'active').length}</strong>
          <span>وثائق سارية من {file.documents.length}</span>
        </div>
      </header>
      <ProfileReadiness file={file} />
      {!editable && (
        <p className="adm-note">
          <ShieldCheck size={16} /> بياناتك للعرض فقط. تواصل مع الشؤون الإدارية لتصحيحها.
        </p>
      )}
      <nav className="adm-tabs" aria-label="أقسام الملف">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {detailsTabs.includes(tab) &&
        (editing ? (
          <EmployeeWizard
            fields={editableEmployeeFields}
            values={values}
            setValues={setValues}
            busy={busy}
            error=""
            onSubmit={save}
            reason={reason}
            setReason={setReason}
            reasonRequired
            submitLabel="حفظ التعديلات"
          />
        ) : (
          <ProfileTab file={file} tab={tab} />
        ))}
      {tab === 'الوثائق' && (
        <>
          <ProfileDocumentUpload
            employeeId={id}
            onUploaded={(doc) => setValue({ ...file, documents: [doc, ...file.documents] })}
          />
          <DocumentTable
            documents={file.documents}
            onDownload={(doc) => void downloadPrivate(doc, notify)}
          />
        </>
      )}
      {tab === 'فترات العمل' && (
        <Table headers={['الفترة', 'نوع العلاقة', 'المصدر']}>
          {file.periods.map((p) => (
            <tr key={p.id}>
              <td>
                {date(p.startDate)} — {date(p.endDate)}
              </td>
              <td>{p.relationshipType}</td>
              <td>{p.source}</td>
            </tr>
          ))}
        </Table>
      )}
      {tab === 'الطلبات' && <RequestRows requests={file.requests} />}
      {tab === 'سجل التغييرات' && (
        <>
          {file.fieldHistory.filter((entry) => isProfileFieldVisible(file, entry.fieldKey)).length >
            0 && (
            <section className="adm-section profile-section">
              <h3>تغييرات البيانات</h3>
              <Table
                headers={[
                  'الحقل',
                  'القيمة السابقة',
                  'القيمة الجديدة',
                  'السريان',
                  'المنفذ',
                  'السبب',
                ]}
              >
                {file.fieldHistory
                  .filter((entry) => isProfileFieldVisible(file, entry.fieldKey))
                  .map((entry) => {
                    const field = (employeeFields as FormField[]).find(
                      (item) => item.key === entry.fieldKey,
                    );
                    return (
                      <tr key={entry.id}>
                        <td>{field?.label || entry.fieldKey}</td>
                        <td>
                          {entry.oldValue === null
                            ? 'غير مسجل'
                            : displayValue(entry.oldValue, field)}
                        </td>
                        <td>
                          {entry.newValue === null
                            ? 'غير مسجل'
                            : displayValue(entry.newValue, field)}
                        </td>
                        <td>{date(entry.effectiveAt)}</td>
                        <td>{entry.actorName || '—'}</td>
                        <td>{entry.reason || '—'}</td>
                      </tr>
                    );
                  })}
              </Table>
            </section>
          )}
          <section className="adm-section profile-section">
            <h3>سجل الإجراءات</h3>
            <Table headers={['التاريخ', 'المنفذ', 'الإجراء', 'السبب']}>
              {file.history.map((h) => (
                <tr key={h.id}>
                  <td>{date(h.createdAt)}</td>
                  <td>{h.actorName}</td>
                  <td>{actionNames[h.action] || 'إجراء مسجل'}</td>
                  <td>{h.reason || '—'}</td>
                </tr>
              ))}
            </Table>
          </section>
        </>
      )}
    </Shell>
  );
}

function RequestRows({ requests }: { requests: AdministrativeRequest[] }) {
  return requests.length ? (
    <Table headers={['الرقم', 'الخدمة', 'الحالة', 'آخر تحديث']}>
      {requests.map((r) => (
        <tr key={r.id}>
          <td>
            <Link className="adm-link" to={`/requests/${encodeURIComponent(r.id)}`}>
              {r.number}
            </Link>
          </td>
          <td>{requestTitle(r.kind)}</td>
          <td>
            <span className={`adm-state ${r.state}`}>{stateNames[r.state]}</span>
          </td>
          <td>{date(r.updatedAt)}</td>
        </tr>
      ))}
    </Table>
  ) : (
    <Empty>لا توجد طلبات مسجلة</Empty>
  );
}
function DocumentTable({
  documents,
  onDownload,
}: {
  documents: EmployeeDocument[];
  onDownload?: (document: EmployeeDocument) => void;
}) {
  return documents.length ? (
    <Table headers={['الوثيقة', 'الصنف', 'تاريخ الرفع', 'الانتهاء', 'الحالة']}>
      {documents.map((d) => (
        <tr key={d.id}>
          <td>
            {onDownload ? (
              <button className="adm-link" onClick={() => onDownload(d)}>
                {d.filename}
              </button>
            ) : (
              d.filename
            )}
          </td>
          <td>{docCategoryLabel(d.category)}</td>
          <td>{date(d.uploadedAt)}</td>
          <td>{date(d.expiresAt)}</td>
          <td>{d.state === 'active' ? 'سارية' : 'مؤرشفة'}</td>
        </tr>
      ))}
    </Table>
  ) : (
    <Empty>لا توجد وثائق</Empty>
  );
}

function ProfileDocumentUpload({
  employeeId,
  onUploaded,
}: {
  employeeId: string;
  onUploaded: (doc: EmployeeDocument) => void;
}) {
  const { data, notify } = useApp();
  const [category, setCategory] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  if (data.me.role !== 'hr') return null;
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !category) return;
    setBusy(true);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('الحد الأقصى لحجم الملف 2 ميغابايت');
      if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type))
        throw new Error('الملفات المقبولة PDF وPNG وJPEG');
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('تعذر قراءة الملف'));
        reader.readAsDataURL(file);
      });
      const r = await api<{ document: EmployeeDocument }>(
        `/admin/employees/${encodeURIComponent(employeeId)}/documents`,
        json('POST', {
          category,
          filename: file.name,
          mimeType: file.type,
          contentBase64,
          expiresAt: expiresAt || undefined,
        }),
      );
      onUploaded(r.document);
      setFile(null);
      notify('تم رفع الوثيقة');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="adm-section adm-upload" onSubmit={upload}>
      <h3>
        <Upload size={16} /> إضافة وثيقة للملف
      </h3>
      <div className="adm-fields">
        <label className="adm-field">
          <span>الصنف</span>
          <select required value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">اختر</option>
            {(documentCategories as DocumentCategory[]).map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-field">
          <span>تاريخ الانتهاء</span>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>
        <label className="adm-field">
          <span>ملف حتى 2 ميغابايت</span>
          <input
            required
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
      </div>
      <ActionButton type="submit" disabled={busy}>
        {busy ? 'جارٍ الرفع…' : 'رفع الوثيقة'}
      </ActionButton>
    </form>
  );
}

export function EmployeeCreateDialog({
  close,
  onCreated,
}: {
  close: () => void;
  onCreated?: (id: string) => void;
}) {
  const { notify } = useApp();
  const [values, setValues] = useState<FormValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ file: EmployeeFile }>('/admin/employees', json('POST', { values }));
      notify('تم إنشاء ملف الموظف');
      onCreated?.(r.file.employee.id);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="إضافة موظف" close={close} wide className="admin-dialog">
      <EmployeeWizard
        fields={employeeFields as FormField[]}
        values={values}
        setValues={setValues}
        busy={busy}
        error={error}
        onSubmit={submit}
        submitLabel="إنشاء الملف"
      />
    </Modal>
  );
}

export function ServicesPage() {
  const { data, notify } = useApp();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<RequestKind | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [subjectId, setSubjectId] = useState(data.me.id);
  const [busy, setBusy] = useState(false);
  const submitIntent = useRef(true);
  const [error, setError] = useState('');
  const visible = (formDefinitions as typeof formDefinitions).filter(
    (f) => f.initiators.includes(data.me.role) && `${f.title} ${f.description}`.includes(query),
  );
  useEffect(() => {
    const requestedKind = searchParams.get('kind') as RequestKind | null;
    if (requestedKind && visible.some((form) => form.kind === requestedKind)) {
      setKind(requestedKind);
      setSubjectId(data.me.id);
      setValues({});
      setError('');
    }
  }, [searchParams, data.me.id, data.me.role]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!kind) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ request: AdministrativeRequest }>(
        '/admin/requests',
        json('POST', { kind, employeeId: subjectId, values, submit: submitIntent.current }),
      );
      notify(
        submitIntent.current
          ? `تم إرسال الطلب ${r.request.number}`
          : `تم حفظ المسودة ${r.request.number}`,
      );
      setKind(null);
      setValues({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="الخدمات الإدارية" subtitle="اختر الخدمة المناسبة وقدم طلبك">
      <div className="adm-toolbar">
        <label className="adm-search">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث عن خدمة"
          />
        </label>
        <span>{visible.length} خدمة متاحة حسب صلاحيتك</span>
      </div>
      <div className="adm-services">
        {visible.map((f) => (
          <button
            key={f.kind}
            className="adm-service"
            onClick={() => {
              setKind(f.kind);
              setSubjectId(data.me.id);
              setValues({});
              setError('');
            }}
          >
            <span>
              <FileText size={19} />
            </span>
            <b>{f.title}</b>
            <small>{f.description}</small>
            <em>تقديم طلب</em>
          </button>
        ))}
      </div>
      {!visible.length && <Empty>لا توجد خدمات مطابقة</Empty>}
      {kind && (
        <Modal title={requestTitle(kind)} close={() => setKind(null)} wide>
          <p className="adm-note">{formByKind[kind].description}</p>
          <p className="adm-note">
            مسار المراجعة:{' '}
            {(formByKind[kind].stepsByInitiator?.[data.me.role] ?? formByKind[kind].steps)
              .map((role) => roleNames[role])
              .join(' ← ') || 'لا يحتاج موافقة إضافية'}
          </p>
          <form className="adm-form" onSubmit={submit}>
            {['hr', 'manager'].includes(data.me.role) && (
              <label className="adm-field">
                <span>الموظف المعني بالطلب</span>
                <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                  <option value={data.me.id}>أنا</option>
                  {data.employees
                    .filter(
                      (e) =>
                        e.id !== data.me.id &&
                        (data.me.role === 'hr' || e.managerId === data.me.id),
                    )
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} · {e.employeeNumber}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <div className="adm-fields">
              {formByKind[kind].fields.map((f) => (
                <Field
                  key={f.key}
                  field={f}
                  value={values[f.key]}
                  onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
                />
              ))}
            </div>
            {error && <p className="adm-error">{error}</p>}
            <div className="adm-actions">
              <button
                className="adm-button secondary"
                type="submit"
                disabled={busy}
                onClick={() => {
                  submitIntent.current = false;
                }}
              >
                حفظ كمسودة
              </button>
              <ActionButton
                type="submit"
                disabled={busy}
                onClick={() => {
                  submitIntent.current = true;
                }}
              >
                {busy ? 'جارٍ الحفظ…' : 'إرسال للمراجعة'}
              </ActionButton>
            </div>
          </form>
        </Modal>
      )}
    </Shell>
  );
}

export function RequestsPage({ openRequest }: { openRequest?: (id: string) => void }) {
  const { data, notify } = useApp();
  const [filters, setFilters] = useState({ state: 'all', kind: 'all', query: '' });
  const url = '/admin/requests';
  const {
    value: requests,
    loading,
    error,
    reload,
  } = useLoad<AdministrativeRequest[]>(url, 'requests');
  const [detail, setDetail] = useState<AdministrativeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const visible = (requests || []).filter(
    (r) =>
      (filters.state === 'all' || r.state === filters.state) &&
      (filters.kind === 'all' || r.kind === filters.kind) &&
      `${r.number} ${r.employeeName} ${requestTitle(r.kind)}`
        .toLowerCase()
        .includes(filters.query.toLowerCase()),
  );
  const act = async (action: 'submit' | 'cancel') => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await api<{ request: AdministrativeRequest }>(
        `/admin/requests/${detail.id}/actions`,
        json('POST', { version: detail.version, action, reason: reason || undefined }),
      );
      notify(action === 'submit' ? 'تم إرسال الطلب للمراجعة' : 'تم إلغاء الطلب');
      setDetail(r.request);
      void reload();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="الطلبات الإدارية" subtitle="تابع الطلبات ومراحل معالجتها">
      <div className="adm-toolbar adm-filters">
        <label className="adm-search">
          <Search size={16} />
          <input
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
            placeholder="رقم الطلب أو الموظف أو الخدمة"
          />
        </label>
        <label>
          الحالة{' '}
          <select
            value={filters.state}
            onChange={(e) => setFilters({ ...filters, state: e.target.value })}
          >
            <option value="all">كل الحالات</option>
            {Object.entries(stateNames).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          الخدمة{' '}
          <select
            value={filters.kind}
            onChange={(e) => setFilters({ ...filters, kind: e.target.value })}
          >
            <option value="all">كل الخدمات</option>
            {(formDefinitions as typeof formDefinitions).map((f) => (
              <option key={f.kind} value={f.kind}>
                {f.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : visible.length ? (
        <div className="adm-request-list">
          {visible.map((r) => (
            <button
              key={r.id}
              className="adm-request-row"
              onClick={() => {
                openRequest ? openRequest(r.id) : setDetail(r);
              }}
            >
              <span className="adm-request-icon">
                <FileText size={18} />
              </span>
              <span className="adm-request-main">
                <b>{requestTitle(r.kind)}</b>
                <small>
                  {r.number} · {r.employeeName}
                </small>
              </span>
              <span className={`adm-state ${r.state}`}>{stateNames[r.state]}</span>
              <small>{date(r.updatedAt)}</small>
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
      ) : (
        <Empty>لا توجد طلبات بهذه المرشحات</Empty>
      )}
      {detail && (
        <Modal title={requestTitle(detail.kind)} close={() => setDetail(null)}>
          <p className="adm-note">
            {detail.employeeName} · {detail.number} · {stateNames[detail.state]}
          </p>
          <dl className="adm-details">
            {Object.entries(detail.values).map(([k, v]) => (
              <div key={k}>
                <dt>{formByKind[detail.kind].fields.find((f) => f.key === k)?.label || k}</dt>
                <dd>{String(v ?? '—')}</dd>
              </div>
            ))}
          </dl>
          {detail.canEdit && detail.state === 'draft' && (
            <>
              <label className="adm-field">
                <span>سبب الإرسال (اختياري)</span>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="adm-actions">
                <ActionButton onClick={() => void act('submit')} disabled={busy}>
                  إرسال للمراجعة
                </ActionButton>
                <button
                  className="adm-button danger"
                  disabled={busy}
                  onClick={() => void act('cancel')}
                >
                  إلغاء المسودة
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </Shell>
  );
}

export function RequestDetailPage({ requestId }: { requestId: string }) {
  const { data, notify } = useApp();
  const {
    value: request,
    loading,
    error,
    reload,
    setValue,
  } = useLoad<AdministrativeRequest>(`/admin/requests/${encodeURIComponent(requestId)}`, 'request');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  useEffect(() => {
    if (request) setValues(request.values);
  }, [request]);
  const act = async (action: string) => {
    if (!request) return;
    setBusy(true);
    try {
      const r = await api<{ request: AdministrativeRequest }>(
        `/admin/requests/${encodeURIComponent(request.id)}/actions`,
        json('POST', { version: request.version, action, reason: reason || undefined }),
      );
      setValue(r.request);
      setReason('');
      notify('تم تحديث مسار الطلب');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!request) return;
    setBusy(true);
    try {
      const r = await api<{ request: AdministrativeRequest }>(
        `/admin/requests/${encodeURIComponent(request.id)}`,
        json('PATCH', { version: request.version, values }),
      );
      setValue(r.request);
      notify('تم حفظ الطلب');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (loading)
    return (
      <Shell title="تفاصيل الطلب" subtitle="متابعة الإجراء">
        <Busy />
      </Shell>
    );
  if (error)
    return (
      <Shell title="تفاصيل الطلب" subtitle="متابعة الإجراء">
        <Notice error={error} retry={() => void reload()} />
      </Shell>
    );
  if (!request) return null;
  return (
    <Shell
      title={requestTitle(request.kind)}
      subtitle={`طلب ${request.number} · ${request.employeeName}`}
      action={
        <button className="adm-button secondary" onClick={() => window.print()}>
          <Printer size={16} /> طباعة
        </button>
      }
    >
      <div className="adm-request-head">
        <span className={`adm-state ${request.state}`}>{stateNames[request.state]}</span>
        {request.issuedDocument && <span>نسخة معاينة محفوظة عند الاعتماد</span>}
        <span>قُدم {date(request.createdAt)}</span>
      </div>
      {request.issuedDocument && (
        <div className="adm-issued-letter-wrap">
          <IssuedLetter document={request.issuedDocument} />
        </div>
      )}
      {formByKind[request.kind].printable && !request.issuedDocument && (
        <div className="adm-print-letter">
          <div className="adm-letter-brand">
            سبق <span>الشؤون الإدارية</span>
          </div>
          <h2>{requestTitle(request.kind)}</h2>
          <p className="adm-letter-state">
            مسودة للمراجعة الداخلية · لا تمثل مستندًا معتمدًا أو موقعًا
          </p>
          <p>التاريخ: {date(request.createdAt)}</p>
          <p>إلى: {String(request.values.recipient || 'الجهة المعنية')}</p>
          <p>
            نفيدكم بأن {request.employeeName}{' '}
            {request.kind === 'salary_letter'
              ? 'يعمل لدى صحيفة سبق. وتُراجع بيانات الأجر ضمن المسار الداخلي قبل إصدار أي نسخة رسمية.'
              : 'على رأس العمل وفق البيانات المسجلة في الملف الوظيفي، وتُراجع تفاصيل الطلب قبل إصدار أي نسخة رسمية.'}
          </p>
          <dl className="adm-details">
            {Object.entries(request.values).map(([k, v]) => (
              <div key={k}>
                <dt>{fieldLabel(k, formByKind[request.kind].fields)}</dt>
                <dd>
                  {displayValue(
                    v,
                    formByKind[request.kind].fields.find((f) => f.key === k),
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p>هذه معاينة داخلية غير موقعة.</p>
        </div>
      )}
      {request.canEdit ? (
        <form className="adm-section" onSubmit={save}>
          <h3>بيانات الطلب</h3>
          <div className="adm-fields">
            {formByKind[request.kind].fields.map((f) => (
              <Field
                key={f.key}
                field={f}
                value={values[f.key]}
                onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
              />
            ))}
          </div>
          <div className="adm-actions">
            <ActionButton type="submit" disabled={busy}>
              حفظ التعديلات
            </ActionButton>
            {['draft', 'returned'].includes(request.state) && (
              <button
                type="button"
                className="adm-button secondary"
                disabled={busy}
                onClick={() => void act('submit')}
              >
                إرسال للمراجعة
              </button>
            )}
          </div>
        </form>
      ) : (
        <dl className="adm-details">
          {Object.entries(request.values).map(([k, v]) => (
            <div key={k}>
              <dt>
                {formByKind[request.kind].fields.find((f) => f.key === k)?.label || fieldLabel(k)}
              </dt>
              <dd>
                {displayValue(
                  v,
                  formByKind[request.kind].fields.find((f) => f.key === k),
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <section className="adm-section">
        <h3>مسار الطلب</h3>
        <ol className="adm-timeline">
          {request.timeline.map((e) => (
            <li key={e.id}>
              <span className="adm-timeline-dot">
                <Check size={13} />
              </span>
              <div>
                <b>{actionNames[e.action] || 'إجراء مسجل'}</b>
                <p>
                  {e.actorName} · {roleNames[e.role] || 'دور إداري'}
                </p>
                {e.reason && <p>{e.reason}</p>}
                <small>{date(e.createdAt)}</small>
              </div>
            </li>
          ))}
          {request.state.startsWith('pending_') &&
            request.steps.map((role, i) =>
              i >= request.stepIndex ? (
                <li key={`${role}-${i}`} className={i >= request.stepIndex ? 'upcoming' : ''}>
                  <span className="adm-timeline-dot">
                    <Clock3 size={13} />
                  </span>
                  <div>
                    <b>{roleNames[role] || role}</b>
                    <p>{i === request.stepIndex ? 'الخطوة الحالية' : 'بانتظار الخطوة السابقة'}</p>
                  </div>
                </li>
              ) : null,
            )}
        </ol>
      </section>
      {request.canAct && (
        <section className="adm-actions">
          <label className="adm-field">
            <span>سبب أو ملاحظة (مطلوب للإرجاع والرفض)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <ActionButton disabled={busy} onClick={() => void act('approve')}>
            اعتماد
          </ActionButton>
          <button
            className="adm-button secondary"
            disabled={busy || !reason.trim()}
            onClick={() => void act('return')}
          >
            إعادة للتعديل
          </button>
          <button
            className="adm-button danger"
            disabled={busy || !reason.trim()}
            onClick={() => void act('reject')}
          >
            رفض مع السبب
          </button>
        </section>
      )}
    </Shell>
  );
}

export function AttendancePage() {
  const { data, notify } = useApp();
  const {
    value: records,
    loading,
    error,
    reload,
    setValue,
  } = useLoad<AttendanceRecord[]>('/admin/attendance', 'records');
  const [filter, setFilter] = useState('all');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({
    date: '',
    checkIn: '',
    checkOut: '',
    workMode: 'office',
    note: '',
  });
  const isAdmin = ['hr', 'manager'].includes(data.me.role);
  const visible = (records || []).filter(
    (r) =>
      filter === 'all' || (filter === 'pending' ? r.state === 'submitted' : r.state === filter),
  );
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ record: AttendanceRecord }>(
        '/admin/attendance',
        json('POST', { employeeId: data.me.id, ...form }),
      );
      setValue([r.record, ...(records || [])]);
      setShow(false);
      notify('تم تسجيل الحضور');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (r: AttendanceRecord, decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const out = await api<{ record: AttendanceRecord }>(
        `/admin/attendance/${r.id}/decision`,
        json('POST', { version: r.version, decision, reason: reason || undefined }),
      );
      setValue((records || []).map((x) => (x.id === r.id ? out.record : x)));
      setReason('');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title="الحضور والانصراف"
      subtitle="تسجيل ومراجعة سجلات الدوام"
      action={
        <ActionButton onClick={() => setShow(true)}>
          <Plus size={16} /> تسجيل حضور
        </ActionButton>
      }
    >
      <div className="adm-toolbar">
        <label>
          عرض{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">الكل</option>
            <option value="pending">بانتظار المراجعة</option>
            <option value="approved">معتمد</option>
            <option value="rejected">مرفوض</option>
          </select>
        </label>
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : visible.length ? (
        <Table
          headers={[
            'الموظف',
            'التاريخ',
            'الحضور',
            'الانصراف',
            'المدة',
            'نمط العمل',
            'الحالة',
            'الإجراء',
          ]}
        >
          {visible.map((r) => (
            <tr key={r.id}>
              <td>{r.employeeName}</td>
              <td>{date(r.date)}</td>
              <td>{r.checkIn}</td>
              <td>{r.checkOut}</td>
              <td>
                {Math.floor(r.minutes / 60)} س {r.minutes % 60} د
              </td>
              <td>{{ office: 'المكتب', remote: 'عن بعد', field: 'ميداني' }[r.workMode]}</td>
              <td>{attendanceStates[r.state] || '—'}</td>
              <td>
                {isAdmin && r.canReview && (
                  <div className="adm-row-actions">
                    <button
                      aria-label="اعتماد"
                      disabled={busy}
                      onClick={() => void decide(r, 'approve')}
                    >
                      <Check />
                    </button>
                    <button
                      aria-label="رفض"
                      disabled={busy || !reason}
                      onClick={() => void decide(r, 'reject')}
                    >
                      <X />
                    </button>
                    <input
                      aria-label="سبب الرفض"
                      placeholder="سبب الرفض"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>لا توجد سجلات حضور</Empty>
      )}
      {show && (
        <Modal title="تسجيل حضور" close={() => setShow(false)}>
          <form className="adm-form" onSubmit={create}>
            {[
              ['date', 'التاريخ', 'date'],
              ['checkIn', 'وقت الحضور', 'time'],
              ['checkOut', 'وقت الانصراف', 'time'],
            ].map(([k, l, t]) => (
              <label className="adm-field" key={k}>
                <span>{l}</span>
                <input
                  type={t}
                  required
                  value={form[k as keyof typeof form]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
              </label>
            ))}
            <label className="adm-field">
              <span>نمط العمل</span>
              <select
                value={form.workMode}
                onChange={(e) => setForm({ ...form, workMode: e.target.value })}
              >
                <option value="office">المكتب</option>
                <option value="remote">عن بعد</option>
                <option value="field">ميداني</option>
              </select>
            </label>
            <label className="adm-field">
              <span>ملاحظة</span>
              <textarea
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </label>
            <ActionButton type="submit" disabled={busy}>
              حفظ السجل
            </ActionButton>
          </form>
        </Modal>
      )}
    </Shell>
  );
}

export function DocumentsPage() {
  const { data, notify } = useApp();
  const {
    value: docs,
    loading,
    error,
    reload,
    setValue,
  } = useLoad<EmployeeDocument[]>('/admin/documents', 'documents');
  const [query, setQuery] = useState('');
  const [employeeId, setEmployeeId] = useState(data.me.id);
  const [category, setCategory] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveDoc, setArchiveDoc] = useState<EmployeeDocument | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const canManage = data.me.role === 'hr';
  const visible = (docs || []).filter((d) =>
    `${d.filename} ${d.employeeName} ${d.category}`.toLowerCase().includes(query.toLowerCase()),
  );
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !category) return;
    setBusy(true);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('الحد الأقصى لحجم الملف 2 ميغابايت');
      if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type))
        throw new Error('الملفات المقبولة PDF وPNG وJPEG');
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('تعذر قراءة الملف'));
        reader.readAsDataURL(file);
      });
      const r = await api<{ document: EmployeeDocument }>(
        `/admin/employees/${encodeURIComponent(employeeId)}/documents`,
        json('POST', {
          category,
          filename: file.name,
          mimeType: file.type,
          contentBase64,
          expiresAt: expiresAt || undefined,
        }),
      );
      setValue([r.document, ...(docs || [])]);
      setFile(null);
      notify('تم رفع الوثيقة');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async (d: EmployeeDocument) => {
    try {
      const response = await fetch(`/api/admin/documents/${d.id}/download`);
      if (!response.ok) throw new Error('تعذر تنزيل الوثيقة');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const archive = async () => {
    if (!archiveDoc || !archiveReason.trim()) return;
    try {
      const r = await api<{ document: EmployeeDocument }>(
        `/admin/documents/${archiveDoc.id}/archive`,
        json('POST', { version: archiveDoc.version, reason: archiveReason }),
      );
      setValue((docs || []).map((x) => (x.id === archiveDoc.id ? r.document : x)));
      setArchiveDoc(null);
      setArchiveReason('');
      notify('تمت أرشفة الوثيقة وحفظ نسختها');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <Shell title="وثائق الموظفين" subtitle="وثائق خاصة بصلاحيات وصول محددة">
      <div className="adm-toolbar">
        <label className="adm-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث باسم الموظف أو الوثيقة"
          />
        </label>
      </div>
      {canManage && (
        <form className="adm-section adm-upload" onSubmit={upload}>
          <h3>
            <Upload size={17} /> رفع وثيقة
          </h3>
          <div className="adm-fields">
            <label className="adm-field">
              <span>الموظف</span>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                {data.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="adm-field">
              <span>صنف الوثيقة</span>
              <select required value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">اختر</option>
                {(documentCategories as DocumentCategory[]).map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="adm-field">
              <span>تاريخ الانتهاء</span>
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </label>
            <label className="adm-field">
              <span>الملف (حتى 2 ميغابايت)</span>
              <input
                required
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
          </div>
          <ActionButton type="submit" disabled={busy}>
            {busy ? 'جارٍ الرفع…' : 'رفع الوثيقة'}
          </ActionButton>
        </form>
      )}
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : visible.length ? (
        <Table headers={['الموظف', 'الوثيقة', 'الصنف', 'رفعت في', 'تنتهي في', 'الحالة', 'إجراءات']}>
          {visible.map((d) => (
            <tr key={d.id}>
              <td>{d.employeeName}</td>
              <td>{d.filename}</td>
              <td>{docCategoryLabel(d.category)}</td>
              <td>{date(d.uploadedAt)}</td>
              <td>{date(d.expiresAt)}</td>
              <td>{d.state === 'active' ? 'نشطة' : 'مؤرشفة'}</td>
              <td className="adm-row-actions">
                <button aria-label="تنزيل" onClick={() => void download(d)}>
                  <ArrowDownToLine />
                </button>
                {canManage && d.state === 'active' && (
                  <button
                    aria-label="أرشفة"
                    onClick={() => {
                      setArchiveDoc(d);
                      setArchiveReason('');
                    }}
                  >
                    <Archive />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>لا توجد وثائق مطابقة</Empty>
      )}
      {archiveDoc && (
        <Modal title="أرشفة وثيقة" close={() => setArchiveDoc(null)}>
          <p className="adm-note">ستبقى النسخة محفوظة في سجل الوثائق.</p>
          <label className="adm-field">
            <span>سبب الأرشفة *</span>
            <textarea
              required
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
            />
          </label>
          <div className="adm-actions">
            <ActionButton disabled={!archiveReason.trim()} onClick={() => void archive()}>
              أرشفة الوثيقة
            </ActionButton>
            <button className="adm-button secondary" onClick={() => setArchiveDoc(null)}>
              إلغاء
            </button>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

export function PoliciesPage() {
  const { data, notify } = useApp();
  const {
    value: policies,
    loading,
    error,
    reload,
    setValue,
  } = useLoad<PolicyRecord[]>('/admin/policies', 'policies');
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState<{
    policy: PolicyRecord;
    action: 'approve' | 'retire';
  } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [form, setForm] = useState({
    key: '',
    name: '',
    effectiveFrom: '',
    effectiveTo: '',
    source: '',
    description: '',
  });
  const [busy, setBusy] = useState(false);
  const canManage = data.me.role === 'hr';
  const canApprove = data.me.role === 'approver';
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ policy: PolicyRecord }>(
        '/admin/policies',
        json('POST', {
          key: form.key,
          name: form.name,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || undefined,
          source: form.source,
          values: { description: form.description },
        }),
      );
      setValue([r.policy, ...(policies || [])]);
      setShow(false);
      notify('تمت إضافة مسودة السياسة');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const action = async () => {
    if (!confirm || !actionReason.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ policy: PolicyRecord }>(
        `/admin/policies/${confirm.policy.id}/actions`,
        json('POST', { action: confirm.action, reason: actionReason }),
      );
      setValue((policies || []).map((x) => (x.id === confirm.policy.id ? r.policy : x)));
      notify(
        confirm.action === 'approve' ? 'تم الاعتماد في المعاينة الاصطناعية' : 'تم إيقاف السياسة',
      );
      setConfirm(null);
      setActionReason('');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title="السياسات والإجراءات"
      subtitle="سجل إصدارات ومصادر القواعد المعمول بها"
      action={
        canManage && (
          <ActionButton onClick={() => setShow(true)}>
            <Plus size={16} /> إضافة سياسة
          </ActionButton>
        )
      }
    >
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : policies?.length ? (
        <Table headers={['السياسة', 'الإصدار', 'سارية من', 'حتى', 'المصدر', 'الحالة', 'الإجراءات']}>
          {policies.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.version}</td>
              <td>{date(p.effectiveFrom)}</td>
              <td>{date(p.effectiveTo)}</td>
              <td>{p.source}</td>
              <td>
                {p.state === 'draft'
                  ? 'مسودة'
                  : p.state === 'retired'
                    ? 'متوقفة'
                    : 'معتمدة للبيانات الاصطناعية'}
              </td>
              <td>
                {(canManage || canApprove) && (
                  <div className="adm-row-actions">
                    {p.state === 'draft' && canApprove && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setConfirm({ policy: p, action: 'approve' });
                          setActionReason('');
                        }}
                        aria-label="اعتماد"
                      >
                        اعتماد
                      </button>
                    )}
                    {p.state !== 'retired' && canManage && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setConfirm({ policy: p, action: 'retire' });
                          setActionReason('');
                        }}
                        aria-label="إيقاف"
                      >
                        إيقاف
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>لا توجد سياسات مسجلة</Empty>
      )}
      {show && (
        <Modal title="إضافة سياسة" close={() => setShow(false)}>
          <form className="adm-form" onSubmit={create}>
            {[
              ['key', 'مفتاح السياسة'],
              ['name', 'اسم السياسة'],
              ['effectiveFrom', 'تاريخ السريان', 'date'],
              ['effectiveTo', 'تاريخ الانتهاء', 'date'],
              ['source', 'المصدر'],
            ].map(([k, l, t]) => (
              <label key={k} className="adm-field">
                <span>{l}</span>
                <input
                  required={k !== 'effectiveTo'}
                  type={t || 'text'}
                  value={form[k as keyof typeof form]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
              </label>
            ))}
            <label className="adm-field">
              <span>وصف مختصر</span>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <p className="adm-note">
              ستسجل السياسة كمسودة اصطناعية. لا تعتمد قيمة قانونية دون مراجعة مختص.
            </p>
            <ActionButton type="submit" disabled={busy}>
              حفظ المسودة
            </ActionButton>
          </form>
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm.action === 'approve' ? 'اعتماد السياسة للمعاينة' : 'إيقاف السياسة'}
          close={() => setConfirm(null)}
        >
          <p className="adm-note">
            {confirm.action === 'approve'
              ? 'سيظهر الاعتماد على أنه اصطناعي ولا يثبت قاعدة قانونية.'
              : 'ستبقى النسخة السابقة محفوظة في السجل.'}
          </p>
          <label className="adm-field">
            <span>السبب *</span>
            <textarea
              required
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
            />
          </label>
          <div className="adm-actions">
            <ActionButton disabled={busy || !actionReason.trim()} onClick={() => void action()}>
              {busy ? 'جارٍ الحفظ…' : 'تأكيد'}
            </ActionButton>
            <button className="adm-button secondary" onClick={() => setConfirm(null)}>
              إلغاء
            </button>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

export function ReportsPage() {
  const { data, notify } = useApp();
  const {
    value: report,
    loading,
    error,
    reload,
  } = useLoadRaw<{
    overview: AdministrativeOverview;
    headcount: { department: string; count: number }[];
    requestCounts: { state: string; count: number }[];
    attendance: { date: string; approved: number; submitted: number; rejected: number }[];
  }>('/admin/reports');
  const [tab, setTab] = useState<'overview' | 'headcount' | 'requests' | 'attendance'>('overview');
  const exportCsv = async (type: string) => {
    try {
      const r = await fetch(`/api/admin/reports/export?type=${type}`);
      if (!r.ok) throw new Error('تعذر تجهيز التقرير');
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = `sabq-${type}.csv`;
      a.click();
      URL.revokeObjectURL(u);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  if (!['hr', 'finance', 'approver', 'auditor'].includes(data.me.role))
    return (
      <Shell title="التقارير" subtitle="التقارير الإدارية">
        <Empty>لا تملك صلاحية عرض التقارير</Empty>
      </Shell>
    );
  return (
    <Shell title="التقارير الإدارية" subtitle="ملخص بيانات التشغيل">
      <div className="adm-toolbar">
        <button className="adm-button secondary" onClick={() => void exportCsv('employees')}>
          تصدير الموظفين CSV
        </button>
        <button className="adm-button secondary" onClick={() => void exportCsv('requests')}>
          تصدير الطلبات CSV
        </button>
        <button className="adm-button secondary" onClick={() => void exportCsv('attendance')}>
          تصدير الحضور CSV
        </button>
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : (
        report && (
          <>
            <div className="adm-metrics">
              {Object.entries(report.overview.counts).map(([k, v]) => (
                <div key={k}>
                  <strong>{v}</strong>
                  <span>
                    {{
                      employees: 'الموظفون',
                      pendingRequests: 'الطلبات المعلقة',
                      expiringDocuments: 'وثائق قاربت الانتهاء',
                      expiringContracts: 'عقود قاربت الانتهاء',
                      attendancePending: 'سجلات حضور معلقة',
                      payrollDrafts: 'مسيرات مسودة',
                    }[k] || k}
                  </span>
                </div>
              ))}
            </div>
            <nav className="adm-tabs">
              {[
                ['overview', 'نظرة عامة'],
                ['headcount', 'الموظفون حسب القسم'],
                ['requests', 'حالات الطلبات'],
                ['attendance', 'الحضور'],
              ].map(([k, l]) => (
                <button
                  key={k}
                  className={tab === k ? 'active' : ''}
                  onClick={() => setTab(k as typeof tab)}
                >
                  {l}
                </button>
              ))}
            </nav>
            {tab === 'overview' && (
              <div className="adm-section">
                <h3>تنبيهات قريبة</h3>
                {report.overview.expiries.length ? (
                  <Table headers={['الموظف', 'البند', 'التاريخ', 'النوع']}>
                    {report.overview.expiries.map((x) => (
                      <tr key={x.id}>
                        <td>{x.employeeName}</td>
                        <td>{x.title}</td>
                        <td>{date(x.date)}</td>
                        <td>{x.type === 'document' ? 'وثيقة' : 'عقد'}</td>
                      </tr>
                    ))}
                  </Table>
                ) : (
                  <Empty>لا توجد تنبيهات قريبة</Empty>
                )}
              </div>
            )}
            {tab === 'headcount' && (
              <Table headers={['القسم', 'عدد الموظفين']}>
                {report.headcount.map((x) => (
                  <tr key={x.department}>
                    <td>{x.department}</td>
                    <td>{x.count}</td>
                  </tr>
                ))}
              </Table>
            )}
            {tab === 'requests' && (
              <Table headers={['الحالة', 'عدد الطلبات']}>
                {report.requestCounts.map((x) => (
                  <tr key={x.state}>
                    <td>{stateNames[x.state as RequestState] || x.state}</td>
                    <td>{x.count}</td>
                  </tr>
                ))}
              </Table>
            )}
            {tab === 'attendance' && (
              <Table headers={['التاريخ', 'معتمدة', 'بانتظار المراجعة', 'مرفوضة']}>
                {report.attendance.map((x) => (
                  <tr key={x.date}>
                    <td>{date(x.date)}</td>
                    <td>{x.approved}</td>
                    <td>{x.submitted}</td>
                    <td>{x.rejected}</td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )
      )}
    </Shell>
  );
}

export function AuditPage() {
  const { data } = useApp();
  const {
    value: events,
    loading,
    error,
    reload,
  } = useLoad<AuditRecord[]>('/admin/audit', 'events');
  const [query, setQuery] = useState('');
  const visible = (events || []).filter((e) =>
    `${e.actorName} ${e.action} ${e.resourceId} ${e.reason || ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  if (!['hr', 'auditor'].includes(data.me.role))
    return (
      <Shell title="سجل التدقيق" subtitle="سجل زمني للأنشطة">
        <Empty>لا تملك صلاحية عرض سجل التدقيق</Empty>
      </Shell>
    );
  return (
    <Shell title="سجل التدقيق" subtitle="سجل زمني للأنشطة ذات الأثر">
      <div className="adm-toolbar">
        <label className="adm-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالمنفذ أو الإجراء أو السجل"
          />
        </label>
        <span>
          <Filter size={15} /> {visible.length} نشاط
        </span>
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : visible.length ? (
        <Table headers={['التاريخ', 'المنفذ', 'الدور', 'الإجراء', 'السجل', 'السبب']}>
          {visible.map((e) => (
            <tr key={e.id}>
              <td>{date(e.createdAt)}</td>
              <td>{e.actorName}</td>
              <td>{roleNames[e.actorRole] || 'دور إداري'}</td>
              <td>{actionNames[e.action] || 'إجراء مسجل'}</td>
              <td>{e.resourceId}</td>
              <td>{e.reason || '—'}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>لا توجد أنشطة مطابقة</Empty>
      )}
    </Shell>
  );
}

export function AdminOverviewPanel({ openRequest }: { openRequest?: (id: string) => void }) {
  const { data } = useApp();
  const {
    value: overview,
    loading,
    error,
    reload,
  } = useLoad<AdministrativeOverview>('/admin/overview', 'overview');
  if (!['hr', 'manager', 'approver', 'finance'].includes(data.me.role)) return null;
  return (
    <section className="admin-page adm-overview">
      <div className="adm-overview-title">
        <div>
          <h2>الشؤون الإدارية</h2>
          <p>الطلبات والسجلات التي تحتاج متابعة</p>
        </div>
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : (
        overview && (
          <>
            <div className="adm-metrics">
              {[
                ['employees', 'الموظفون'],
                ['pendingRequests', 'طلبات معلقة'],
                ['expiringDocuments', 'وثائق تنتهي قريبًا'],
                ['attendancePending', 'حضور للمراجعة'],
              ].map(([k, label]) => (
                <div key={k}>
                  <strong>{overview.counts[k as keyof typeof overview.counts]}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <h3>آخر الطلبات</h3>
            {overview.requests.length ? (
              <div className="adm-request-list">
                {overview.requests.slice(0, 5).map((r) => (
                  <button
                    key={r.id}
                    className="adm-request-row"
                    onClick={() => openRequest?.(r.id)}
                  >
                    <span className="adm-request-icon">
                      <FileText size={18} />
                    </span>
                    <span className="adm-request-main">
                      <b>{requestTitle(r.kind)}</b>
                      <small>
                        {r.number} · {r.employeeName}
                      </small>
                    </span>
                    <span className={`adm-state ${r.state}`}>{stateNames[r.state]}</span>
                    <small>{date(r.updatedAt)}</small>
                  </button>
                ))}
              </div>
            ) : (
              <Empty>لا توجد طلبات حديثة</Empty>
            )}
          </>
        )
      )}
    </section>
  );
}

export function RequestsInbox({ openRequest }: { openRequest?: (id: string) => void }) {
  const { data } = useApp();
  const {
    value: requests,
    loading,
    error,
    reload,
  } = useLoad<AdministrativeRequest[]>('/admin/requests', 'requests');
  const pending = (requests || []).filter((r) => r.canAct);
  return (
    <section className="admin-page adm-inbox">
      <div className="adm-overview-title">
        <div>
          <h2>طلبات إدارية بانتظار قرارك</h2>
          <p>الطلبات التي يمكنك اتخاذ إجراء بشأنها</p>
        </div>
        <span className="adm-inbox-count">{pending.length}</span>
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <Notice error={error} retry={() => void reload()} />
      ) : pending.length ? (
        <div className="adm-request-list">
          {pending.map((r) => (
            <button key={r.id} className="adm-request-row" onClick={() => openRequest?.(r.id)}>
              <span className="adm-request-icon">
                <Clock3 size={18} />
              </span>
              <span className="adm-request-main">
                <b>{requestTitle(r.kind)}</b>
                <small>
                  {r.number} · {r.employeeName}
                </small>
              </span>
              <span className={`adm-state ${r.state}`}>{stateNames[r.state]}</span>
              <small>{date(r.updatedAt)}</small>
            </button>
          ))}
        </div>
      ) : (
        <Empty>لا توجد طلبات بانتظار قرارك</Empty>
      )}
    </section>
  );
}
