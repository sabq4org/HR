import { randomUUID } from 'node:crypto';
import type { Employee, Role } from '../../shared/contracts.js';
import type { EmployeeFile, FormField, FormValues } from '../../shared/administration.js';
import { employeeFields, formByKind, documentCategories } from '../../shared/catalog.js';
import { todayInRiyadh, type AsyncDb } from '../database.js';
import { decryptSensitive, encryptSensitive } from './security.js';
import { fault, roleFromState, validateValues } from './validation.js';

export type Actor = { id: string; role: Role };
export type EmployeeRow = {
  id: string;
  employee_number: string;
  name: string;
  initials: string;
  title: string;
  department: string;
  email: string;
  location: string;
  manager_id: string | null;
  join_date: string;
  role: Role;
  color: string;
  status: Employee['status'];
  access_role: Role | null;
  record_version: number;
};
const byKey = new Map(employeeFields.map((field) => [field.key, field]));

export async function readEmployee(db: AsyncDb, id: string): Promise<EmployeeRow | undefined> {
  return (await db.read<EmployeeRow>('SELECT * FROM employee_access WHERE id=?', [id]))[0];
}

export function mayReadEmployee(actor: Actor, employee: EmployeeRow): boolean {
  if (actor.id === employee.id || actor.role === 'hr' || actor.role === 'auditor') return true;
  return actor.role === 'manager' && employee.manager_id === actor.id;
}

export function mayManageEmployee(actor: Actor, employee: EmployeeRow): boolean {
  return actor.role === 'hr' && actor.id !== employee.id;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => [...word][0])
      .join(' ') || '؟'
  );
}
function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validateEffectiveAt(value: string): void {
  const futureMessage = 'لا تدعم المعاينة جدولة التغيير؛ اعتمده في تاريخ السريان.';
  const invalid = () => fault(400, 'INVALID_EFFECTIVE_DATE', 'تاريخ السريان غير صالح.');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!validIsoDate(value)) throw invalid();
    if (value > todayInRiyadh()) throw fault(409, 'FUTURE_EFFECTIVE_DATE', futureMessage);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !validIsoDate(value.slice(0, 10))) throw invalid();
  if (timestamp > Date.now() + 30_000) throw fault(409, 'FUTURE_EFFECTIVE_DATE', futureMessage);
}

function splitBySensitivity(values: FormValues): {
  publicValues: FormValues;
  sensitiveValues: FormValues;
} {
  const publicValues: FormValues = Object.create(null) as FormValues;
  const sensitiveValues: FormValues = Object.create(null) as FormValues;
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (field?.sensitive) sensitiveValues[key] = value;
    else publicValues[key] = value;
  }
  return { publicValues, sensitiveValues };
}

export function protectFormValues(
  values: FormValues,
  fields: FormField[],
  context: string,
): string {
  const parts = splitValuesByFields(values, fields);
  const stored: Record<string, unknown> = { ...parts.publicValues };
  if (Object.keys(parts.sensitiveValues).length) {
    stored.__encryptedSensitive = encryptSensitive(JSON.stringify(parts.sensitiveValues), context);
  }
  return JSON.stringify(stored);
}

function splitValuesByFields(
  values: FormValues,
  fields: FormField[],
): { publicValues: FormValues; sensitiveValues: FormValues } {
  const publicValues: FormValues = Object.create(null) as FormValues;
  const sensitiveValues: FormValues = Object.create(null) as FormValues;
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(values)) {
    if (fieldsByKey.get(key)?.sensitive) sensitiveValues[key] = value;
    else publicValues[key] = value;
  }
  return { publicValues, sensitiveValues };
}

export function readProtectedFormValues(raw: string, context: string): FormValues {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const encrypted = value.__encryptedSensitive;
    delete value.__encryptedSensitive;
    if (typeof encrypted !== 'string') return value as FormValues;
    return {
      ...(value as FormValues),
      ...(JSON.parse(decryptSensitive(encrypted, context)) as FormValues),
    };
  } catch (error) {
    if ((error as { status?: number }).status) throw error;
    throw fault(500, 'REQUEST_DATA_INVALID', 'تعذر قراءة البيانات المحمية للطلب.');
  }
}

export async function getApprovedPayrollSource(
  db: AsyncDb,
  requestId: string,
): Promise<{
  id: string;
  kind: string;
  employeeId: string;
  version: number;
  values: FormValues;
}> {
  const row = (
    await db.read<{
      id: string;
      kind: string;
      employee_id: string;
      version: number;
      state: string;
      values_json: string;
    }>(
      'SELECT id,kind,employee_id,version,state,values_json FROM administrative_requests WHERE id=?',
      [requestId],
    )
  )[0];
  if (
    !row ||
    row.state !== 'approved' ||
    !['advance', 'overtime', 'reward', 'settlement'].includes(row.kind)
  ) {
    throw fault(409, 'INVALID_PAYROLL_SOURCE', 'يجب أن يكون مصدر المسير طلبًا ماليًا معتمدًا.');
  }
  return {
    id: row.id,
    kind: row.kind,
    employeeId: row.employee_id,
    version: row.version,
    values: readProtectedFormValues(row.values_json, `admin-request:${row.id}:values`),
  };
}

export async function getProfileValues(db: AsyncDb, employeeId: string): Promise<FormValues> {
  const row = (
    await db.read<{ public_values_json: string; encrypted_values_json: string }>(
      'SELECT public_values_json,encrypted_values_json FROM employee_profile_data WHERE employee_id=?',
      [employeeId],
    )
  )[0];
  if (!row) return Object.create(null) as FormValues;
  let publicValues: FormValues;
  let sensitiveValues: FormValues;
  try {
    publicValues = JSON.parse(row.public_values_json) as FormValues;
    const ciphertext = row.encrypted_values_json;
    sensitiveValues =
      ciphertext === '{}'
        ? (Object.create(null) as FormValues)
        : (JSON.parse(
            decryptSensitive(ciphertext, `employee-profile:${employeeId}`),
          ) as FormValues);
  } catch (error) {
    if ((error as { status?: number }).status) throw error;
    throw fault(500, 'PROFILE_DATA_INVALID', 'تعذر قراءة بيانات الملف المحمية.');
  }
  return { ...publicValues, ...sensitiveValues };
}

export function filterProfileValues(actor: Actor, ownerId: string, values: FormValues): FormValues {
  if (actor.id === ownerId || actor.role === 'hr') return values;
  const output: FormValues = Object.create(null) as FormValues;
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field?.sensitive && actor.role !== 'finance') output[key] = value;
    if (field?.sensitive === 'financial' && actor.role === 'finance') output[key] = value;
  }
  return output;
}

function mergeValues(base: FormValues, patch: FormValues): FormValues {
  const result = { ...base } as FormValues;
  for (const [key, value] of Object.entries(patch)) result[key] = value;
  return result;
}

const baseColumnByField: Record<string, string> = {
  name: 'name',
  employeeNumber: 'employee_number',
  title: 'title',
  department: 'department',
  email: 'email',
  location: 'location',
  managerId: 'manager_id',
  joinDate: 'join_date',
};

export async function saveProfileValues(
  tx: AsyncDb,
  actor: Actor,
  employeeId: string,
  values: FormValues,
  reason: string,
  effectiveAt: string,
  expectedVersion?: number,
  approvedWorkflow = false,
): Promise<number> {
  validateEffectiveAt(effectiveAt);
  const employee = await readEmployee(tx, employeeId);
  if (!employee) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
  if (!mayManageEmployee(actor, employee) && !approvedWorkflow)
    throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية تعديل هذا الملف.');
  if (expectedVersion !== undefined && employee.record_version !== expectedVersion)
    throw fault(409, 'STALE_VERSION', 'تغير الملف؛ حدّث البيانات ثم أعد المحاولة.');
  if (!reason.trim() || reason.length > 1000)
    throw fault(400, 'REASON_REQUIRED', 'أدخل سببًا للتعديل.');
  const validated = validateValues(employeeFields, values, { partial: true });
  if ('employmentStatus' in validated && typeof validated.employmentStatus !== 'string')
    throw fault(400, 'INVALID_STATUS', 'اختر حالة وظيفية صالحة.');
  if ('managerId' in validated && validated.managerId) {
    const manager =
      typeof validated.managerId === 'string'
        ? await readEmployee(tx, validated.managerId)
        : undefined;
    if (
      !manager ||
      manager.id === employeeId ||
      manager.role !== 'manager' ||
      !['active', 'on_leave'].includes(manager.status)
    ) {
      throw fault(400, 'INVALID_MANAGER', 'المدير المحدد غير موجود.');
    }
  }
  const before = await getProfileValues(tx, employeeId);
  const after = mergeValues(before, validated);
  const now = new Date().toISOString();
  const assignments: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(baseColumnByField)) {
    if (key in validated) {
      assignments.push(`${column}=?`);
      params.push(validated[key] ?? null);
    }
  }
  if ('employmentStatus' in validated) {
    assignments.push('employment_status=?');
    params.push(validated.employmentStatus);
  }
  assignments.push('record_version=record_version+1');
  const changed = await tx.execute(
    `UPDATE employees SET ${assignments.join(',')} WHERE id=? AND record_version=?`,
    [...params, employeeId, employee.record_version],
  );
  if (changed.rowCount !== 1)
    throw fault(409, 'STALE_VERSION', 'تغير الملف؛ حدّث البيانات ثم أعد المحاولة.');
  const parts = splitBySensitivity(after);
  const encrypted = Object.keys(parts.sensitiveValues).length
    ? encryptSensitive(JSON.stringify(parts.sensitiveValues), `employee-profile:${employeeId}`)
    : '{}';
  await tx.execute(
    `INSERT INTO employee_profile_data(employee_id,public_values_json,encrypted_values_json,version,updated_at,updated_by)
    VALUES(?,?,?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET public_values_json=excluded.public_values_json,
    encrypted_values_json=excluded.encrypted_values_json,version=employee_profile_data.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    [
      employeeId,
      JSON.stringify(parts.publicValues),
      encrypted,
      employee.record_version + 1,
      now,
      actor.id,
    ],
  );

  for (const key of Object.keys(validated)) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    const field = byKey.get(key);
    const historyId = randomUUID();
    await tx.execute(
      `INSERT INTO employee_profile_history(id,employee_id,field_key,old_value_ciphertext,new_value_ciphertext,effective_at,reason_ciphertext,actor_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        historyId,
        employeeId,
        key,
        before[key] === undefined
          ? null
          : encryptSensitive(JSON.stringify(before[key]), `employee-history:${historyId}:old`),
        after[key] === undefined
          ? null
          : encryptSensitive(JSON.stringify(after[key]), `employee-history:${historyId}:new`),
        effectiveAt,
        encryptSensitive(reason, `employee-history:${historyId}:reason`),
        actor.id,
        now,
      ],
    );
    await appendEvent(
      tx,
      actor,
      'employee',
      employeeId,
      'field_updated',
      reason,
      { field: key, sensitive: !!field?.sensitive },
      employee.record_version + 1,
      now,
    );
  }
  return employee.record_version + 1;
}

export async function appendEvent(
  tx: AsyncDb,
  actor: Actor,
  resourceType: string,
  resourceId: string,
  action: string,
  reason: string | null,
  details: Record<string, unknown> = {},
  resourceVersion: number | null = null,
  createdAt = new Date().toISOString(),
): Promise<string> {
  const id = randomUUID();
  const encryptedReason = reason
    ? encryptSensitive(reason, `administration-event:${id}:reason`)
    : null;
  await tx.execute(
    `INSERT INTO administration_events(id,resource_type,resource_id,actor_id,actor_role,action,reason,details_json,resource_version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      resourceType,
      resourceId,
      actor.id,
      actor.role,
      action,
      encryptedReason,
      JSON.stringify(details),
      resourceVersion,
      createdAt,
    ],
  );
  return id;
}

export async function createEmployee(
  tx: AsyncDb,
  actor: Actor,
  input: unknown,
): Promise<EmployeeFile> {
  if (actor.role !== 'hr')
    throw fault(403, 'FORBIDDEN', 'تتطلب إضافة ملف جديد صلاحية الشؤون الإدارية.');
  const count = Number(
    (await tx.read<{ count: number | string }>('SELECT COUNT(*) AS count FROM employees'))[0]
      ?.count ?? 0,
  );
  if (count >= 200)
    throw fault(
      429,
      'WORKSPACE_EMPLOYEE_CAP',
      'وصلت مساحة المعاينة إلى الحد الأقصى البالغ 200 ملف موظف.',
    );
  const values = validateValues(employeeFields, input);
  const id = `emp-${randomUUID()}`;
  const duplicate = (
    await tx.read<{ id: string }>('SELECT id FROM employees WHERE employee_number=? LIMIT 1', [
      values.employeeNumber,
    ])
  )[0];
  if (duplicate) throw fault(409, 'EMPLOYEE_NUMBER_EXISTS', 'الرقم الوظيفي مستخدم في ملف آخر.');
  const managerId = typeof values.managerId === 'string' ? values.managerId : null;
  if (managerId) {
    const manager = await readEmployee(tx, managerId);
    if (!manager || manager.role !== 'manager' || !['active', 'on_leave'].includes(manager.status))
      throw fault(400, 'INVALID_MANAGER', 'المدير المحدد غير موجود.');
  }
  if (typeof values.joinDate !== 'string' || !validIsoDate(values.joinDate))
    throw fault(400, 'INVALID_DATE', 'تاريخ المباشرة غير صالح.');
  if (
    typeof values.contractStart === 'string' &&
    typeof values.contractEnd === 'string' &&
    values.contractEnd < values.contractStart
  )
    throw fault(400, 'INVALID_CONTRACT_DATES', 'نهاية العقد تسبق بدايته.');
  const status = typeof values.employmentStatus === 'string' ? values.employmentStatus : 'active';
  const role: Role = 'employee';
  const now = new Date().toISOString();
  await tx.execute(
    `INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color,access_role,employment_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      values.employeeNumber,
      values.name,
      initials(String(values.name)),
      values.title,
      values.department,
      values.email,
      values.location,
      managerId,
      values.joinDate,
      'employee',
      '#D8E8F3',
      role,
      status,
    ],
  );
  const parts = splitBySensitivity(values);
  const encrypted = Object.keys(parts.sensitiveValues).length
    ? encryptSensitive(JSON.stringify(parts.sensitiveValues), `employee-profile:${id}`)
    : '{}';
  await tx.execute(
    `INSERT INTO employee_profile_data(employee_id,public_values_json,encrypted_values_json,version,updated_at,updated_by)
    VALUES(?,?,?,?,?,?)`,
    [id, JSON.stringify(parts.publicValues), encrypted, 1, now, actor.id],
  );
  await tx.execute(
    `INSERT INTO employment_periods(id,employee_id,start_date,relationship_type,source,status,created_at)
    VALUES(?,?,?,'fictional-demo-record','Synthetic demo fixture; user-created synthetic record.','synthetic-demo-only',?)`,
    [`period-${randomUUID()}`, id, values.joinDate, now],
  );
  if (status === 'active') {
    await tx.execute(
      `INSERT INTO work_schedules(id,employee_id,version,timezone,working_days_json,source,created_at)
      VALUES(?,?,'demo-1','Asia/Riyadh','[0,1,2,3,4]','Synthetic demo schedule; confirm before use.',?) ON CONFLICT(employee_id,version) DO NOTHING`,
      [`schedule-${id}`, id, now],
    );
    await tx.execute(
      `INSERT INTO leave_ledger(employee_id,kind,days,created_at,actor_id)
      SELECT ?,'allocation',allocated_days,?,? FROM policy_versions WHERE id='policy-demo-annual-v1'
      AND NOT EXISTS(SELECT 1 FROM leave_ledger WHERE employee_id=? AND kind='allocation')`,
      [id, now, actor.id, id],
    );
  }
  await appendEvent(
    tx,
    actor,
    'employee',
    id,
    'employee_created',
    null,
    { fields: Object.keys(values) },
    1,
    now,
  );
  return getEmployeeFile(tx, actor, id);
}

export async function getEmployeeFile(
  db: AsyncDb,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeFile> {
  const employee = await readEmployee(db, employeeId);
  if (!employee) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
  if (!mayReadEmployee(actor, employee))
    throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية الاطلاع على هذا الملف.');
  const baseValues: FormValues = {
    name: employee.name,
    employeeNumber: employee.employee_number,
    title: employee.title,
    department: employee.department,
    email: employee.email,
    location: employee.location,
    managerId: employee.manager_id,
    joinDate: employee.join_date,
    employmentStatus: employee.status,
  };
  const allValues = { ...baseValues, ...(await getProfileValues(db, employeeId)) } as FormValues;
  const values = filterProfileValues(actor, employeeId, allValues);
  const periods = await db.read<{
    id: string;
    start_date: string;
    end_date: string | null;
    relationship_type: string;
    source: string;
  }>(
    'SELECT id,start_date,end_date,relationship_type,source FROM employment_periods WHERE employee_id=? ORDER BY start_date DESC',
    [employeeId],
  );
  const events = await db.read<{
    id: string;
    actor_id: string;
    actor_role: string;
    action: string;
    reason: string | null;
    resource_version: number | null;
    created_at: string;
  }>(
    "SELECT id,actor_id,actor_role,action,reason,resource_version,created_at FROM administration_events WHERE resource_type='employee' AND resource_id=? ORDER BY created_at DESC LIMIT 100",
    [employeeId],
  );
  const history = await Promise.all(
    events.map(async (event) => {
      const actorRow = await readEmployee(db, event.actor_id);
      const mayReadReason = actor.id === employeeId || actor.role === 'hr';
      let reason: string | null = null;
      if (event.reason && mayReadReason) {
        try {
          reason = decryptSensitive(event.reason, `administration-event:${event.id}:reason`);
        } catch {
          reason = '[معلومة محمية]';
        }
      }
      return {
        id: event.id,
        actorId: event.actor_id,
        actorName: actorRow?.name ?? 'مستخدم',
        role: event.actor_role as Role,
        action: event.action,
        reason,
        createdAt: event.created_at,
        version: event.resource_version ?? 1,
      };
    }),
  );
  const requestRows = await db.read<any>(
    'SELECT * FROM administrative_requests WHERE employee_id=? ORDER BY created_at DESC LIMIT 100',
    [employeeId],
  );
  const requests = requestRows
    .filter((row) => {
      const stage = roleFromState(row.state);
      return (
        actor.id === employeeId ||
        actor.role === 'hr' ||
        actor.role === 'auditor' ||
        (actor.role === 'manager' && employee.manager_id === actor.id) ||
        (actor.role === 'finance' &&
          ['advance', 'overtime', 'reward', 'settlement', 'salary_letter'].includes(row.kind)) ||
        (stage === actor.role && actor.role !== 'manager')
      );
    })
    .map((row) => {
      const form = formByKind[row.kind as keyof typeof formByKind];
      if (!form) return null;
      const allValues = readProtectedFormValues(row.values_json, `admin-request:${row.id}:values`);
      const values: FormValues = Object.create(null) as FormValues;
      for (const [key, value] of Object.entries(allValues)) {
        const field = form.fields.find((f) => f.key === key);
        if (actor.id === employeeId || actor.role === 'hr') values[key] = value;
        else if (!field?.sensitive && actor.role !== 'finance') values[key] = value;
        else if (field?.sensitive === 'financial' && actor.role === 'finance') values[key] = value;
      }
      const steps = JSON.parse(row.steps_json) as Role[];
      return {
        id: row.id,
        number: row.request_number,
        kind: row.kind,
        employeeId,
        employeeName: actor.role === 'auditor' ? 'موظف' : employee.name,
        createdBy: row.created_by,
        state: row.state,
        version: Number(row.version),
        values,
        steps,
        stepIndex: Number(row.step_index),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canAct:
          roleFromState(row.state) === actor.role &&
          row.created_by !== actor.id &&
          employeeId !== actor.id &&
          (actor.role !== 'manager' || employee.manager_id === actor.id),
        canEdit: row.created_by === actor.id && ['draft', 'returned'].includes(row.state),
        timeline: [],
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
  const documentRows = await db.read<any>(
    'SELECT * FROM employee_documents WHERE employee_id=? ORDER BY uploaded_at DESC LIMIT 200',
    [employeeId],
  );
  const documents = documentRows
    .filter((doc) => {
      const sensitivity = documentCategories.find(
        (category) => category.key === doc.category,
      )?.sensitive;
      if (actor.role === 'hr' || actor.role === 'auditor' || actor.id === employeeId) return true;
      if (actor.role === 'manager') return employee.manager_id === actor.id && !sensitivity;
      if (actor.role === 'finance') return sensitivity === 'financial';
      return false;
    })
    .map((doc) => ({
      id: doc.id,
      employeeId: actor.role === 'auditor' ? '' : employeeId,
      employeeName: actor.role === 'auditor' ? 'موظف' : employee.name,
      category: doc.category,
      filename: actor.role === 'auditor' ? 'مستند وظيفي' : doc.filename,
      mimeType: doc.mime_type,
      size: Number(doc.size_bytes),
      expiresAt: doc.expires_at,
      uploadedAt: doc.uploaded_at,
      uploadedBy: actor.role === 'auditor' ? '' : doc.uploaded_by,
      checksum: actor.role === 'auditor' ? '' : doc.checksum,
      version: Number(doc.version),
      state: doc.state,
    }));
  const employeeValue: Employee = {
    id: employee.id,
    employeeNumber: employee.employee_number,
    name: employee.name,
    initials: employee.initials,
    title: employee.title,
    department: employee.department,
    email: employee.email,
    location: employee.location,
    managerId: employee.manager_id,
    joinDate: employee.join_date,
    role: employee.role,
    color: employee.color,
    status: employee.status,
  };
  const required = employeeFields.filter((field) => field.required);
  const missing = required
    .filter(
      (field) =>
        values[field.key] === undefined || values[field.key] === null || values[field.key] === '',
    )
    .map((field) => field.key);
  return {
    employee: employeeValue,
    version: employee.record_version,
    values,
    editable: mayManageEmployee(actor, employee),
    periods: periods.map((period) => ({
      id: period.id,
      startDate: period.start_date,
      endDate: period.end_date,
      relationshipType: period.relationship_type,
      source: period.source,
    })),
    requests,
    documents,
    completeness: { completed: required.length - missing.length, total: required.length, missing },
    history,
  };
}
