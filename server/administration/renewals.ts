import type { Express, Request } from 'express';
import type { AsyncDb } from '../database.js';
import {
  actorOrThrow,
  idempotent,
  newId,
  requiredString,
  requireRecord,
  route,
  versionValue,
  type RequireActor,
} from './common.js';
import {
  appendEvent,
  mayEditFile,
  readEmployee,
  validIsoDate,
  type Actor,
  type EmployeeRow,
} from './service.js';
import { fault } from './validation.js';
import type {
  DocumentRenewalCase,
  RenewalAssignee,
  RenewalPayment,
  RenewalsResponse,
} from '../../shared/renewals.js';

type RenewalRow = {
  id: string;
  document_id: string;
  employee_id: string;
  category: string;
  original_expiry: string;
  assigned_to: string;
  status: 'open' | 'renewed' | 'cancelled';
  new_expiry: string | null;
  proof_document_id: string | null;
  payment: RenewalPayment | null;
  version: number | string;
  fee_halalas: number | string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  employee_name: string;
  assignee_name: string | null;
  document_version: number | string;
  document_state: 'active' | 'archived';
  document_expiry: string | null;
};

type DocumentRow = {
  id: string;
  employee_id: string;
  category: string;
  expires_at: string | null;
  state: 'active' | 'archived';
  version: number | string;
  renewal_fee_halalas: number | string | null;
};

const at = () => new Date().toISOString();

function requireIsoDate(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || !validIsoDate(value)) throw fault(400, code, message);
  return value;
}

function rowLockSuffix(db: AsyncDb): string {
  return db.dialect === 'postgres' ? ' FOR UPDATE' : '';
}

function caseLockSuffix(db: AsyncDb): string {
  // The case query has a nullable assignee join. Lock only the case row; PostgreSQL
  // rejects an unqualified FOR UPDATE when an outer-joined relation is present.
  return db.dialect === 'postgres' ? ' FOR UPDATE OF r' : '';
}

function requireHr(actor: Actor): void {
  if (actor.role !== 'hr')
    throw fault(403, 'FORBIDDEN', 'متابعة تجديد الوثائق متاحة للشؤون الإدارية.');
}

function feeOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function caseView(row: RenewalRow): DocumentRenewalCase {
  return {
    id: row.id,
    documentId: row.document_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    category: row.category,
    originalExpiry: row.original_expiry,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name ?? 'مستخدم غير متاح',
    status: row.status,
    newExpiry: row.new_expiry,
    proofDocumentId: row.proof_document_id,
    payment: row.payment,
    version: Number(row.version),
    documentVersion: Number(row.document_version),
    feeHalalas: feeOf(row.fee_halalas),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getCaseRow(db: AsyncDb, id: string, lock = false): Promise<RenewalRow | undefined> {
  const suffix = lock ? caseLockSuffix(db) : '';
  return (
    await db.read<RenewalRow>(
      `SELECT r.*,e.name AS employee_name,a.name AS assignee_name,
              d.version AS document_version,d.state AS document_state,d.expires_at AS document_expiry
         FROM document_renewals r
         JOIN employees e ON e.id=r.employee_id AND e.id<>'svc-sabq-accountant'
         JOIN employee_documents d ON d.id=r.document_id
         LEFT JOIN employees a ON a.id=r.assigned_to
        WHERE r.id=?${suffix}`,
      [id],
    )
  )[0];
}

async function replayAuthorizedCase(
  tx: AsyncDb,
  actor: Actor,
  id: string,
  activeOnly: boolean,
): Promise<DocumentRenewalCase> {
  const row = await getCaseRow(tx, id);
  if (!row) throw fault(404, 'RENEWAL_NOT_FOUND', 'حالة التجديد غير موجودة.');
  await editableOwner(tx, actor, row.employee_id, activeOnly);
  return caseView(row);
}

async function editableOwner(
  db: AsyncDb,
  actor: Actor,
  employeeId: string,
  activeOnly = true,
): Promise<EmployeeRow> {
  const employee = await readEmployee(db, employeeId);
  if (!employee || (activeOnly && !['active', 'on_leave'].includes(employee.status)))
    throw fault(404, 'RENEWAL_NOT_FOUND', 'حالة التجديد غير موجودة.');
  if (!mayEditFile(actor, employee))
    throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية تعديل مستندات هذا الموظف.');
  return employee;
}

function param(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !id) throw fault(400, 'INVALID_ID', 'معرف الحالة غير صالح.');
  return id;
}

async function createCase(
  db: AsyncDb,
  actor: Actor,
  req: Request,
  documentId: string,
  documentVersion: number,
  assignedTo: string,
): Promise<DocumentRenewalCase> {
  const body = { documentId, documentVersion, assignedTo };
  return idempotent(
    db,
    actor,
    'document-renewal:create',
    req.get('Idempotency-Key') ?? undefined,
    body,
    async (tx, marker) => replayAuthorizedCase(tx, actor, marker.id, true),
    async (tx) => {
      const document = (
        await tx.read<DocumentRow>(
          `SELECT id,employee_id,category,expires_at,state,version,renewal_fee_halalas
             FROM employee_documents WHERE id=?${rowLockSuffix(tx)}`,
          [documentId],
        )
      )[0];
      if (!document) throw fault(404, 'DOCUMENT_NOT_FOUND', 'المستند غير موجود.');
      if (document.state !== 'active')
        throw fault(409, 'DOCUMENT_ARCHIVED', 'لا يمكن فتح حالة لمستند مؤرشف.');
      if (document.category === 'renewal_proof')
        throw fault(400, 'INVALID_SOURCE_DOCUMENT', 'لا يمكن فتح تجديد لإثبات تجديد آخر.');
      if (Number(document.version) !== documentVersion)
        throw fault(409, 'STALE_VERSION', 'تغير المستند؛ حدّث البيانات ثم أعد المحاولة.');
      if (!document.expires_at)
        throw fault(400, 'EXPIRY_REQUIRED', 'لا يمكن فتح حالة دون تاريخ انتهاء للمستند.');
      if (!validIsoDate(document.expires_at))
        throw fault(409, 'INVALID_DOCUMENT_EXPIRY', 'تاريخ انتهاء المستند غير صالح.');

      await editableOwner(tx, actor, document.employee_id);
      const assignee = (
        await tx.read<{ id: string; name: string }>(
          "SELECT id,name FROM employee_access WHERE id=? AND role='hr' AND status='active' AND id<>'svc-sabq-accountant'",
          [assignedTo],
        )
      )[0];
      if (!assignee)
        throw fault(400, 'INVALID_ASSIGNEE', 'المسند إليه يجب أن يكون حساب موارد بشرية نشطًا.');
      if (assignee.id === document.employee_id) {
        const owner = (
          await tx.read<{ employee_id: string }>(
            'SELECT employee_id FROM system_owners WHERE employee_id=?',
            [assignee.id],
          )
        )[0];
        if (!owner)
          throw fault(
            400,
            'INVALID_ASSIGNEE',
            'لا يمكن إسناد مستند HR إلى صاحبه إلا إذا كان مالك النظام.',
          );
      }

      const existing = (
        await tx.read<{ id: string }>(
          "SELECT id FROM document_renewals WHERE document_id=? AND original_expiry=? AND status<>'cancelled' LIMIT 1",
          [document.id, document.expires_at],
        )
      )[0];
      if (existing) throw fault(409, 'RENEWAL_EXISTS', 'توجد حالة تجديد مفتوحة لهذه الدورة.');

      const id = newId();
      const now = at();
      try {
        await tx.execute(
          `INSERT INTO document_renewals
             (id,document_id,employee_id,category,original_expiry,assigned_to,status,new_expiry,
              proof_document_id,payment,version,fee_halalas,created_at,updated_at,completed_at)
           VALUES(?,?,?,?,?,?, 'open',NULL,NULL,NULL,1,?,?,?,NULL)`,
          [
            id,
            document.id,
            document.employee_id,
            document.category,
            document.expires_at,
            assignee.id,
            feeOf(document.renewal_fee_halalas),
            now,
            now,
          ],
        );
      } catch (error) {
        // Keep the database unique index as the final race-safe guard. Translate its
        // expected collision into the same domain error as the pre-check.
        const message = String((error as { message?: string }).message ?? error);
        if (/unique|constraint/i.test(message))
          throw fault(409, 'RENEWAL_EXISTS', 'توجد حالة تجديد لهذه الدورة.');
        throw error;
      }
      await appendEvent(
        tx,
        actor,
        'document_renewal',
        id,
        'renewal_opened',
        null,
        {
          documentId: document.id,
          employeeId: document.employee_id,
          category: document.category,
          originalExpiry: document.expires_at,
          assignedTo: assignee.id,
        },
        1,
        now,
      );
      const row = await getCaseRow(tx, id);
      if (!row) throw fault(500, 'RENEWAL_DATA_INVALID', 'تعذر قراءة حالة التجديد الجديدة.');
      return { marker: { type: 'document_renewal', id }, result: caseView(row) };
    },
  );
}

async function completeCase(
  db: AsyncDb,
  actor: Actor,
  req: Request,
  id: string,
  version: number,
  documentVersion: number,
  proofDocumentId: string,
  newExpiry: string,
  payment: RenewalPayment,
  reason: string,
): Promise<DocumentRenewalCase> {
  const body = { version, documentVersion, proofDocumentId, newExpiry, payment, reason };
  return idempotent(
    db,
    actor,
    `document-renewal:complete:${id}`,
    req.get('Idempotency-Key') ?? undefined,
    body,
    async (tx, marker) => replayAuthorizedCase(tx, actor, marker.id, true),
    async (tx) => {
      const row = await getCaseRow(tx, id, true);
      if (!row) throw fault(404, 'RENEWAL_NOT_FOUND', 'حالة التجديد غير موجودة.');
      await editableOwner(tx, actor, row.employee_id, true);
      if (row.status !== 'open')
        throw fault(409, 'RENEWAL_NOT_OPEN', 'حالة التجديد أُغلقت ولا تقبل إكمالًا جديدًا.');
      if (Number(row.version) !== version || Number(row.document_version) !== documentVersion)
        throw fault(409, 'STALE_VERSION', 'تغيرت الحالة أو المستند؛ حدّث البيانات ثم أعد المحاولة.');
      if (row.document_state !== 'active' || row.document_expiry !== row.original_expiry)
        throw fault(409, 'STALE_VERSION', 'تغير تاريخ المستند أو أُرشف قبل الإكمال.');
      if (newExpiry <= row.original_expiry)
        throw fault(400, 'INVALID_NEW_EXPIRY', 'يجب أن يلي تاريخ التجديد تاريخ الانتهاء الأصلي.');

      // Lock the source separately. The case lock above intentionally locks only
      // document_renewals because the listing joins a nullable assignee.
      const source = (
        await tx.read<DocumentRow>(
          `SELECT id,employee_id,category,expires_at,state,version,renewal_fee_halalas
             FROM employee_documents WHERE id=?${rowLockSuffix(tx)}`,
          [row.document_id],
        )
      )[0];
      if (
        !source ||
        source.state !== 'active' ||
        source.employee_id !== row.employee_id ||
        Number(source.version) !== documentVersion ||
        source.expires_at !== row.original_expiry
      )
        throw fault(409, 'STALE_VERSION', 'تغير المستند؛ حدّث البيانات ثم أعد المحاولة.');

      const proof = (
        await tx.read<{
          id: string;
          employee_id: string;
          category: string;
          state: 'active' | 'archived';
        }>(
          `SELECT id,employee_id,category,state FROM employee_documents WHERE id=?${rowLockSuffix(tx)}`,
          [proofDocumentId],
        )
      )[0];
      if (
        !proof ||
        proof.employee_id !== row.employee_id ||
        proof.id === row.document_id ||
        proof.category !== 'renewal_proof' ||
        proof.state !== 'active'
      )
        throw fault(
          400,
          'INVALID_PROOF_DOCUMENT',
          'أرفق مستند إثبات تجديد نشطًا من ملف الموظف نفسه.',
        );
      const used = (
        await tx.read<{ id: string }>(
          'SELECT id FROM document_renewals WHERE proof_document_id=? LIMIT 1',
          [proof.id],
        )
      )[0];
      if (used && used.id !== row.id)
        throw fault(409, 'PROOF_ALREADY_USED', 'استُخدم مستند الإثبات في حالة تجديد أخرى.');

      const now = at();
      const changedDocument = await tx.execute(
        `UPDATE employee_documents
            SET expires_at=?,version=version+1
          WHERE id=? AND state='active' AND version=? AND expires_at=?`,
        [newExpiry, row.document_id, documentVersion, row.original_expiry],
      );
      if (changedDocument.rowCount !== 1)
        throw fault(409, 'STALE_VERSION', 'تغير المستند؛ حدّث البيانات ثم أعد المحاولة.');
      const changedCase = await tx.execute(
        `UPDATE document_renewals
            SET status='renewed',new_expiry=?,proof_document_id=?,payment=?,version=version+1,
                updated_at=?,completed_at=?
          WHERE id=? AND status='open' AND version=?`,
        [newExpiry, proof.id, payment, now, now, row.id, version],
      );
      if (changedCase.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغيرت حالة التجديد.');
      await appendEvent(
        tx,
        actor,
        'document',
        row.document_id,
        'document_renewal_completed',
        reason,
        { originalExpiry: row.original_expiry, newExpiry, renewalId: row.id },
        documentVersion + 1,
        now,
      );
      await appendEvent(
        tx,
        actor,
        'document_renewal',
        row.id,
        'renewal_completed',
        reason,
        { documentId: row.document_id, newExpiry, proofDocumentId: proof.id, payment },
        version + 1,
        now,
      );
      const updated = await getCaseRow(tx, row.id);
      if (!updated)
        throw fault(500, 'RENEWAL_DATA_INVALID', 'تعذر قراءة حالة التجديد بعد الإكمال.');
      return { marker: { type: 'document_renewal', id: row.id }, result: caseView(updated) };
    },
  );
}

async function cancelCase(
  db: AsyncDb,
  actor: Actor,
  req: Request,
  id: string,
  version: number,
  reason: string,
): Promise<DocumentRenewalCase> {
  return idempotent(
    db,
    actor,
    `document-renewal:cancel:${id}`,
    req.get('Idempotency-Key') ?? undefined,
    { version, reason },
    async (tx, marker) => replayAuthorizedCase(tx, actor, marker.id, false),
    async (tx) => {
      const row = await getCaseRow(tx, id, true);
      if (!row) throw fault(404, 'RENEWAL_NOT_FOUND', 'حالة التجديد غير موجودة.');
      await editableOwner(tx, actor, row.employee_id, false);
      if (row.status !== 'open') throw fault(409, 'RENEWAL_NOT_OPEN', 'لا يمكن إلغاء حالة مغلقة.');
      if (Number(row.version) !== version) throw fault(409, 'STALE_VERSION', 'تغيرت حالة التجديد.');
      const now = at();
      const changed = await tx.execute(
        `UPDATE document_renewals SET status='cancelled',version=version+1,updated_at=?
          WHERE id=? AND status='open' AND version=?`,
        [now, row.id, version],
      );
      if (changed.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغيرت حالة التجديد.');
      await appendEvent(
        tx,
        actor,
        'document_renewal',
        row.id,
        'renewal_cancelled',
        reason,
        { documentId: row.document_id, originalExpiry: row.original_expiry },
        version + 1,
        now,
      );
      const updated = await getCaseRow(tx, row.id);
      if (!updated)
        throw fault(500, 'RENEWAL_DATA_INVALID', 'تعذر قراءة حالة التجديد بعد الإلغاء.');
      return { marker: { type: 'document_renewal', id: row.id }, result: caseView(updated) };
    },
  );
}

export function registerRenewals(
  app: Express,
  ctx: { db: AsyncDb; requireActor: RequireActor },
): void {
  const { db, requireActor } = ctx;
  app.get(
    '/api/admin/renewals',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      requireHr(actor);
      const rows = await db.read<RenewalRow>(
        `SELECT r.*,e.name AS employee_name,a.name AS assignee_name,
                d.version AS document_version,d.state AS document_state,d.expires_at AS document_expiry
           FROM document_renewals r
           JOIN employees e ON e.id=r.employee_id AND e.id<>'svc-sabq-accountant'
           JOIN employee_documents d ON d.id=r.document_id
           LEFT JOIN employees a ON a.id=r.assigned_to
          ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'renewed' THEN 1 ELSE 2 END,
                   r.original_expiry,r.created_at,r.id
          `,
      );
      const assignees = await db.read<RenewalAssignee>(
        "SELECT id,name FROM employee_access WHERE role='hr' AND status='active' AND id<>'svc-sabq-accountant' ORDER BY name,id",
      );
      const response: RenewalsResponse = {
        cases: rows.map(caseView),
        assignees,
      };
      res.json(response);
    }),
  );

  app.post(
    '/api/admin/renewals',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      requireHr(actor);
      const body = requireRecord(req.body);
      const documentId = requiredString(body.documentId, 'DOCUMENT_REQUIRED', 'حدد المستند.', 120);
      const documentVersion = versionValue(body.documentVersion);
      const assignedTo = requiredString(body.assignedTo, 'ASSIGNEE_REQUIRED', 'حدد المسؤول.', 120);
      const renewal = await createCase(db, actor, req, documentId, documentVersion, assignedTo);
      res.status(201).json({ case: renewal });
    }),
  );

  app.post(
    '/api/admin/renewals/:id/complete',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      requireHr(actor);
      const body = requireRecord(req.body);
      const version = versionValue(body.version);
      const documentVersion = versionValue(body.documentVersion);
      const proofDocumentId = requiredString(
        body.proofDocumentId,
        'PROOF_REQUIRED',
        'حدد مستند إثبات التجديد.',
        120,
      );
      const newExpiry = requireIsoDate(
        body.newExpiry,
        'INVALID_NEW_EXPIRY',
        'تاريخ التجديد غير صالح.',
      );
      const payment = body.payment;
      if (payment !== 'none' && payment !== 'owner')
        throw fault(400, 'INVALID_PAYMENT', 'حدد جهة دفع الرسوم.');
      const reason = requiredString(body.reason, 'REASON_REQUIRED', 'أدخل سبب الإكمال.', 1000);
      const renewal = await completeCase(
        db,
        actor,
        req,
        param(req),
        version,
        documentVersion,
        proofDocumentId,
        newExpiry,
        payment,
        reason,
      );
      res.json({ case: renewal });
    }),
  );

  app.post(
    '/api/admin/renewals/:id/cancel',
    route(async (req, res) => {
      const actor = actorOrThrow(await requireActor(req));
      requireHr(actor);
      const body = requireRecord(req.body);
      const version = versionValue(body.version);
      const reason = requiredString(body.reason, 'REASON_REQUIRED', 'أدخل سبب الإلغاء.', 1000);
      const renewal = await cancelCase(db, actor, req, param(req), version, reason);
      res.json({ case: renewal });
    }),
  );
}
