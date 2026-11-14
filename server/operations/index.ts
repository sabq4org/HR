import { createHash, randomUUID } from 'node:crypto';
import type { AsyncDb } from '../database.js';
import { decryptSensitive } from '../administration/security.js';

const JOB = 'hr_internal_reminders';
const REMINDER_THRESHOLDS = [30, 7, 0] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEDICAL_DOCUMENT_CATEGORY = 'medical_insurance';

export type MaintenanceResult = {
  runId: string;
  status: 'succeeded' | 'failed';
  remindersCreated: number;
  failureCode?: string;
};

export type OperationsOptions = {
  intervalMs?: number;
  overdueAfterDays?: number;
  documentThresholdDays?: readonly number[];
};

export type MaintenanceOptions = { now?: Date | string };

type Candidate = {
  resourceType: 'employee_document' | 'employee_contract' | 'leave_approval' | 'admin_approval';
  resourceId: string;
  version: number;
  recipientId: string;
  threshold: string;
  title: string;
  body: string;
  leaveId?: string;
  requestId?: string;
};

function validOptions(options: OperationsOptions = {}) {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const overdueAfterDays = options.overdueAfterDays ?? 3;
  const documentThresholdDays = options.documentThresholdDays ?? REMINDER_THRESHOLDS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 24 * 60 * 60 * 1000)
    throw new Error('Operations interval must be between 60 seconds and 24 hours.');
  if (!Number.isSafeInteger(overdueAfterDays) || overdueAfterDays < 1 || overdueAfterDays > 365)
    throw new Error('Overdue threshold must be between 1 and 365 days.');
  if (
    !Array.isArray(documentThresholdDays) ||
    documentThresholdDays.length < 1 ||
    documentThresholdDays.length > 10 ||
    documentThresholdDays.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > 365,
    ) ||
    new Set(documentThresholdDays).size !== documentThresholdDays.length
  )
    throw new Error('Document reminder thresholds must be unique whole days from 0 to 365.');
  return {
    intervalMs,
    overdueAfterDays,
    documentThresholdDays: [...documentThresholdDays].sort((a, b) => b - a),
  };
}

function asDate(value?: Date | string): Date {
  const date =
    value === undefined ? new Date() : value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Maintenance date is invalid.');
  return date;
}

function asDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return undefined;
  return Math.floor(ms / DAY_MS);
}

function riyadhDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return asDay(`${part('year')}-${part('month')}-${part('day')}`)!;
}

function isOverdue(value: string, now: Date, overdueAfterDays: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() - overdueAfterDays * DAY_MS;
}

function thresholdFor(daysRemaining: number, thresholds: number[]): number | undefined {
  return thresholds.find((threshold) => daysRemaining <= threshold);
}

function dedupeKey(candidate: Candidate): string {
  return createHash('sha256')
    .update(
      [
        candidate.resourceType,
        candidate.resourceId,
        String(candidate.version),
        candidate.threshold,
        candidate.recipientId,
      ].join('\u001f'),
    )
    .digest('hex');
}

async function activeRecipients(tx: AsyncDb, employeeId: string): Promise<string[]> {
  const employee = (
    await tx.read<{ id: string }>("SELECT id FROM employee_access WHERE id=? AND status='active'", [
      employeeId,
    ])
  )[0];
  const hr = await tx.read<{ id: string }>(
    "SELECT id FROM employee_access WHERE role='hr' AND status='active' ORDER BY id",
  );
  return [
    ...new Set([employee?.id, ...hr.map((row) => row.id)].filter((id): id is string => !!id)),
  ];
}

async function addCandidate(tx: AsyncDb, candidate: Candidate, now: string): Promise<number> {
  const key = dedupeKey(candidate);
  const inserted = await tx.execute(
    `INSERT INTO operations_reminder_dedupe
       (dedupe_key,job_name,resource_type,resource_id,resource_version,threshold_key,recipient_id,created_at)
     SELECT ?,?,?,?,?,?,?,?
     WHERE EXISTS(SELECT 1 FROM employee_access WHERE id=? AND status='active')
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [
      key,
      JOB,
      candidate.resourceType,
      candidate.resourceId,
      candidate.version,
      candidate.threshold,
      candidate.recipientId,
      now,
      candidate.recipientId,
    ],
  );
  if (!inserted.rowCount) return 0;
  await tx.execute(
    `INSERT INTO outbox(recipient_id,title,body,leave_id,created_at,request_id)
     VALUES(?,?,?, ?,?,?)`,
    [
      candidate.recipientId,
      candidate.title,
      candidate.body,
      candidate.leaveId ?? null,
      now,
      candidate.requestId ?? null,
    ],
  );
  return 1;
}

async function collectCandidates(
  tx: AsyncDb,
  now: Date,
  overdueAfterDays: number,
  documentThresholdDays: number[],
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const today = riyadhDay(now);
  const docs = await tx.read<{
    id: string;
    employee_id: string;
    version: number;
    expires_at: string;
  }>(
    `SELECT d.id,d.employee_id,d.version,d.expires_at
       FROM employee_documents d JOIN employee_access e ON e.id=d.employee_id
      WHERE d.state='active' AND d.expires_at IS NOT NULL AND d.category<>? AND e.status='active'`,
    [MEDICAL_DOCUMENT_CATEGORY],
  );
  for (const doc of docs) {
    const expiry = asDay(doc.expires_at);
    if (expiry === undefined) continue;
    const daysRemaining = expiry - today;
    const threshold = thresholdFor(daysRemaining, documentThresholdDays);
    if (threshold === undefined) continue;
    const recipients = await activeRecipients(tx, doc.employee_id);
    for (const recipientId of recipients) {
      candidates.push({
        resourceType: 'employee_document',
        resourceId: doc.id,
        version: doc.version,
        recipientId,
        threshold: `days-${threshold}`,
        title: 'تذكير بمتابعة ملف وظيفي',
        body: 'يوجد مستند وظيفي يحتاج إلى متابعة.',
      });
    }
  }

  const profiles = await tx.read<{
    employee_id: string;
    encrypted_values_json: string;
    version: number;
  }>(
    `SELECT p.employee_id,p.encrypted_values_json,p.version
       FROM employee_profile_data p JOIN employee_access e ON e.id=p.employee_id
      WHERE e.status='active'`,
  );
  for (const profile of profiles) {
    if (profile.encrypted_values_json === '{}') continue;
    const values = JSON.parse(
      decryptSensitive(profile.encrypted_values_json, `employee-profile:${profile.employee_id}`),
    ) as { contractEnd?: unknown };
    if (typeof values.contractEnd !== 'string') continue;
    const expiry = asDay(values.contractEnd);
    if (expiry === undefined) continue;
    const threshold = thresholdFor(expiry - today, documentThresholdDays);
    if (threshold === undefined) continue;
    const recipients = await activeRecipients(tx, profile.employee_id);
    for (const recipientId of recipients) {
      candidates.push({
        resourceType: 'employee_contract',
        resourceId: profile.employee_id,
        version: profile.version,
        recipientId,
        threshold: `days-${threshold}`,
        title: 'تذكير بمتابعة ملف وظيفي',
        body: 'يوجد ملف وظيفي يحتاج إلى متابعة.',
      });
    }
  }

  const leaves = await tx.read<{
    id: string;
    employee_id: string;
    version: number;
    status: string;
    created_at: string;
    manager_id: string | null;
  }>(
    `SELECT l.id,l.employee_id,l.version,l.status,l.created_at,e.manager_id
       FROM leave_requests l JOIN employee_access e ON e.id=l.employee_id
      WHERE l.status IN ('pending_manager','pending_hr') AND e.status='active'`,
  );
  for (const leave of leaves) {
    if (!isOverdue(leave.created_at, now, overdueAfterDays)) continue;
    const recipientId =
      leave.status === 'pending_manager'
        ? (
            await tx.read<{ id: string }>(
              "SELECT id FROM employee_access WHERE id=? AND id<>? AND role='manager' AND status='active'",
              [leave.manager_id, leave.employee_id],
            )
          )[0]?.id
        : (
            await tx.read<{ id: string }>(
              "SELECT id FROM employee_access WHERE role='hr' AND status='active' AND id<>? ORDER BY id LIMIT 1",
              [leave.employee_id],
            )
          )[0]?.id;
    if (!recipientId) continue;
    candidates.push({
      resourceType: 'leave_approval',
      resourceId: leave.id,
      version: leave.version,
      recipientId,
      threshold: `overdue-${overdueAfterDays}`,
      title: 'تذكير بمراجعة طلب',
      body: 'يوجد طلب بانتظار المراجعة.',
      leaveId: leave.id,
    });
  }

  const requests = await tx.read<{
    id: string;
    employee_id: string;
    created_by: string;
    version: number;
    state: string;
    updated_at: string;
    steps_json: string;
    step_index: number;
  }>(
    `SELECT r.id,r.employee_id,r.created_by,r.version,r.state,r.updated_at
       FROM administrative_requests r JOIN employee_access e ON e.id=r.employee_id
      WHERE r.state LIKE 'pending_%' AND e.status='active'`,
  );
  for (const request of requests) {
    if (!isOverdue(request.updated_at, now, overdueAfterDays)) continue;
    const role = request.state.slice('pending_'.length);
    let recipientId: string | undefined;
    if (role === 'manager') {
      recipientId = (
        await tx.read<{ id: string }>(
          `SELECT m.id FROM employee_access e JOIN employee_access m ON m.id=e.manager_id
            WHERE e.id=? AND m.id<>? AND m.role='manager' AND m.status='active'`,
          [request.employee_id, request.created_by],
        )
      )[0]?.id;
    } else if (['hr', 'finance', 'approver'].includes(role)) {
      recipientId = (
        await tx.read<{ id: string }>(
          "SELECT id FROM employee_access WHERE role=? AND status='active' AND id<>? AND id<>? ORDER BY id LIMIT 1",
          [role, request.employee_id, request.created_by],
        )
      )[0]?.id;
    }
    if (!recipientId) continue;
    const eligible = await tx.read<{ id: string }>(
      "SELECT id FROM employee_access WHERE id=? AND status='active'",
      [recipientId],
    );
    if (!eligible.length) continue;
    candidates.push({
      resourceType: 'admin_approval',
      resourceId: request.id,
      version: request.version,
      recipientId,
      threshold: `overdue-${overdueAfterDays}`,
      title: 'تذكير بمراجعة طلب',
      body: 'يوجد طلب بانتظار المراجعة.',
      requestId: request.id,
    });
  }
  return candidates;
}

/** Run a single idempotent pass. Only sanitized status and counts are persisted. */
export async function runMaintenance(
  db: AsyncDb,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const { overdueAfterDays, documentThresholdDays } = validOptions();
  return runMaintenancePass(db, options, overdueAfterDays, documentThresholdDays);
}

async function runMaintenancePass(
  db: AsyncDb,
  options: MaintenanceOptions,
  overdueAfterDays: number,
  documentThresholdDays: number[],
): Promise<MaintenanceResult> {
  const nowDate = asDate(options.now);
  const now = nowDate.toISOString();
  const runId = randomUUID();
  await db.execute(
    `INSERT INTO operations_job_runs(id,job_name,started_at,status) VALUES(?,?,?,'running')`,
    [runId, JOB, now],
  );
  try {
    const remindersCreated = await db.transaction(async (tx) => {
      const candidates = await collectCandidates(
        tx,
        nowDate,
        overdueAfterDays,
        documentThresholdDays,
      );
      let created = 0;
      for (const candidate of candidates) created += await addCandidate(tx, candidate, now);
      return created;
    });
    await db.execute(
      "UPDATE operations_job_runs SET finished_at=?,status='succeeded',reminders_created=? WHERE id=?",
      [new Date().toISOString(), remindersCreated, runId],
    );
    return { runId, status: 'succeeded', remindersCreated };
  } catch {
    const failureCode = 'MAINTENANCE_PASS_FAILED';
    await db.execute(
      "UPDATE operations_job_runs SET finished_at=?,status='failed',failure_code=? WHERE id=?",
      [new Date().toISOString(), failureCode, runId],
    );
    return { runId, status: 'failed', remindersCreated: 0, failureCode };
  }
}

export function startOperations(
  db: AsyncDb,
  options: OperationsOptions = {},
): { close(): Promise<void> } {
  const { intervalMs, overdueAfterDays, documentThresholdDays } = validOptions(options);
  let closed = false;
  let running: Promise<MaintenanceResult> | undefined;
  const tick = () => {
    if (closed || running) return;
    running = runMaintenancePass(db, { now: new Date() }, overdueAfterDays, documentThresholdDays)
      .catch(() => ({
        runId: '',
        status: 'failed' as const,
        remindersCreated: 0,
        failureCode: 'MAINTENANCE_PASS_FAILED',
      }))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
