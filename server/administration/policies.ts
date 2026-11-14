import type { AsyncDb } from '../database.js';
import type { FormValues, PolicyRecord } from '../../shared/administration.js';
import { parseGosiRule } from '../../shared/gosi.js';
import { approvesPayroll } from '../system-owner.js';
import { idempotent, newId, requiredString, requireRecord, versionValue } from './common.js';
import { appendEvent, validIsoDate, type Actor } from './service.js';
import { fault } from './validation.js';

export type { PolicyRecord };

const at = () => new Date().toISOString();

type PolicyRow = {
  id: string;
  policy_key: string;
  version: number | string;
  name: string;
  effective_from: string;
  effective_to: string | null;
  source: string;
  state: string;
  values_json: string;
  created_by: string;
  approved_by: string | null;
};

export function toPolicyRecord(row: PolicyRow): PolicyRecord {
  return {
    id: row.id,
    key: row.policy_key,
    name: row.name,
    version: Number(row.version),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    source: row.source,
    state: row.state as PolicyRecord['state'],
    values: JSON.parse(row.values_json) as FormValues,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
  };
}

function assertPayrollValues(key: string, values: Record<string, unknown>) {
  if (key !== 'payroll') return;
  if (values.currency !== 'SAR' || values.calculation !== 'profile-components')
    throw fault(
      400,
      'unsupported_calculator',
      'إصدار قواعد الرواتب يجب أن يستخدم حاسبة مكونات الملف الوظيفي بالريال.',
    );
  try {
    if (!parseGosiRule(values))
      throw fault(
        400,
        'gosi_rule_invalid',
        'قسم التأمينات في إصدار القواعد غير مكتمل أو غير صالح.',
      );
  } catch (error) {
    if ((error as { status?: number }).status === 400) throw error;
    throw fault(400, 'gosi_rule_invalid', 'قسم التأمينات في إصدار القواعد غير مكتمل أو غير صالح.');
  }
}

export async function getPolicy(db: AsyncDb, id: string): Promise<PolicyRecord> {
  const row = (
    await db.read<PolicyRow>('SELECT * FROM administrative_policies WHERE id=?', [id])
  )[0];
  if (!row) throw fault(404, 'POLICY_NOT_FOUND', 'القاعدة غير موجودة.');
  return toPolicyRecord(row);
}

export async function listPolicies(db: AsyncDb, keys?: readonly string[]): Promise<PolicyRecord[]> {
  const rows = keys?.length
    ? await db.read<PolicyRow>(
        `SELECT * FROM administrative_policies WHERE policy_key IN (${keys.map(() => '?').join(',')}) ORDER BY policy_key,version DESC`,
        [...keys],
      )
    : await db.read<PolicyRow>(
        'SELECT * FROM administrative_policies ORDER BY policy_key,version DESC',
      );
  return rows.map(toPolicyRecord);
}

export async function createPolicyDraft(
  db: AsyncDb,
  actor: Actor,
  input: {
    key: string;
    name: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    source: string;
    values: Record<string, unknown>;
  },
  options: {
    privateMode?: boolean;
    idempotencyKey?: string;
    auditAction?: string;
    auditDetails?: Record<string, unknown>;
  } = {},
): Promise<PolicyRecord> {
  const key = requiredString(input.key, 'INVALID_POLICY', 'المعرف مطلوب.', 80);
  const name = requiredString(input.name, 'INVALID_POLICY', 'الاسم مطلوب.', 200);
  const effectiveFrom = requiredString(
    input.effectiveFrom,
    'INVALID_DATE',
    'تاريخ السريان مطلوب.',
    10,
  );
  const effectiveTo = input.effectiveTo ? String(input.effectiveTo) : null;
  const source = requiredString(input.source, 'SOURCE_REQUIRED', 'اذكر مصدر القاعدة وحالتها.', 500);
  const values = requireRecord(input.values);
  if (
    !validIsoDate(effectiveFrom) ||
    (effectiveTo && !validIsoDate(effectiveTo)) ||
    (effectiveTo && effectiveTo < effectiveFrom)
  )
    throw fault(400, 'INVALID_DATE', 'فترة السريان غير صالحة.');
  assertPayrollValues(key, values);
  const id = newId();
  return idempotent(
    db,
    actor,
    'policy:create',
    options.idempotencyKey,
    { key, name, effectiveFrom, effectiveTo, source, values },
    async (tx, marker) => getPolicy(tx, marker.id),
    async (tx) => {
      const max = (
        await tx.read<{ v: number | string | null }>(
          'SELECT MAX(version) AS v FROM administrative_policies WHERE policy_key=?',
          [key],
        )
      )[0]?.v;
      const version = Number(max ?? 0) + 1;
      const now = at();
      await tx.execute(
        "INSERT INTO administrative_policies(id,policy_key,version,name,effective_from,effective_to,source,state,values_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,'draft',?,?,?)",
        [
          id,
          key,
          version,
          name,
          effectiveFrom,
          effectiveTo,
          options.privateMode ? source : `Synthetic: ${source}`,
          JSON.stringify(values),
          actor.id,
          now,
        ],
      );
      await appendEvent(
        tx,
        actor,
        'policy',
        id,
        options.auditAction ?? 'policy_created',
        source,
        options.auditDetails ?? { version },
        version,
        now,
      );
      return { marker: { type: 'policy', id }, result: await getPolicy(tx, id) };
    },
  );
}

export async function actOnPolicy(
  db: AsyncDb,
  actor: Actor,
  id: string,
  input: { action: string; version: unknown; reason: string; idempotencyKey?: string },
): Promise<PolicyRecord> {
  const version = versionValue(input.version);
  const action = requiredString(input.action, 'INVALID_ACTION', 'الإجراء مطلوب.', 20);
  const reason = requiredString(input.reason, 'REASON_REQUIRED', 'أدخل سبب الإجراء.', 1000);
  if (!['approve', 'retire'].includes(action))
    throw fault(400, 'INVALID_ACTION', 'الإجراء غير صالح.');
  return idempotent(
    db,
    actor,
    `policy:action:${id}`,
    input.idempotencyKey,
    { version, action, reason },
    async (tx, marker) => getPolicy(tx, marker.id),
    async (tx) => {
      const row = (
        await tx.read<PolicyRow>('SELECT * FROM administrative_policies WHERE id=?', [id])
      )[0];
      if (!row) throw fault(404, 'POLICY_NOT_FOUND', 'القاعدة غير موجودة.');
      if (Number(row.version) !== version) throw fault(409, 'STALE_VERSION', 'تغيرت القاعدة.');
      if (action === 'approve' && row.created_by === actor.id)
        throw fault(403, 'SELF_APPROVAL', 'لا تعتمد القاعدة التي أنشأتها.');
      if (
        action === 'approve'
          ? !approvesPayroll(actor) || row.state !== 'draft'
          : actor.role !== 'hr' || row.state !== 'synthetic_approved'
      )
        throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية الإجراء في هذه المرحلة.');
      const state = action === 'approve' ? 'synthetic_approved' : 'retired';
      const changed = await tx.execute(
        'UPDATE administrative_policies SET state=?,approved_by=? WHERE id=? AND version=? AND state=?',
        [state, action === 'approve' ? actor.id : row.approved_by, row.id, version, row.state],
      );
      if (changed.rowCount !== 1) throw fault(409, 'STALE_VERSION', 'تغيرت القاعدة.');
      await appendEvent(
        tx,
        actor,
        'policy',
        row.id,
        `policy_${action}`,
        reason,
        {},
        Number(row.version),
      );
      return { marker: { type: 'policy', id: row.id }, result: await getPolicy(tx, row.id) };
    },
  );
}

export const PAYROLL_POLICY_KEYS = ['payroll', 'payroll-demo'] as const;
