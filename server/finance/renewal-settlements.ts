import type {
  RenewalSettlementCorrectionInput,
  RenewalSettlementDetails,
  RenewalSettlementInput,
  RenewalSettlementLink,
  RenewalSettlementState,
  RenewalSettlementSummary,
  RenewalSettlementVoucher,
  RenewalSettlementVoucherOption,
} from '../../shared/renewal-settlements.js';
import type { LedgerVoucher } from '../../shared/ledger.js';
import type { AsyncDb } from '../database.js';
import type { Actor } from '../administration/service.js';
import { newId } from '../administration/common.js';
import { fault } from '../administration/validation.js';
import { audited, now } from './routes.js';
import { listVouchers, n, readVoucher } from './ledger.js';

type RenewalRow = {
  id: string;
  status: 'open' | 'renewed' | 'cancelled';
  payment: 'none' | 'owner' | null;
  version?: unknown;
  [key: string]: unknown;
};
type SettlementRow = {
  id: string;
  owner_id: string;
  renewal_id: string;
  voucher_id: string;
  state: 'active' | 'corrected';
  reason: string;
  version: number;
  created_by: string;
  created_at: string;
  corrected_at: string | null;
};

const renewal = async (db: AsyncDb, renewalId: string): Promise<RenewalRow> => {
  const row = (
    await db.read<RenewalRow>('SELECT * FROM document_renewals WHERE id=?', [renewalId])
  )[0];
  if (!row) throw fault(404, 'RENEWAL_NOT_FOUND', 'حالة التجديد غير موجودة.');
  if (row.status !== 'open' && row.status !== 'renewed' && row.status !== 'cancelled')
    throw fault(409, 'RENEWAL_STATE_INVALID', 'حالة التجديد غير صالحة للمطابقة المالية.');
  if (row.payment !== 'none' && row.payment !== 'owner' && row.payment !== null)
    throw fault(409, 'RENEWAL_PAYMENT_INVALID', 'طريقة دفع التجديد غير صالحة.');
  return row;
};

const expectedFee = (row: RenewalRow): number | null => {
  const value = row.fee_halalas;
  return value !== null &&
    value !== undefined &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 0
    ? Number(value)
    : null;
};

const activeSettlement = async (db: AsyncDb, ownerId: string, renewalId: string) =>
  (
    await db.read<SettlementRow>(
      "SELECT * FROM finance_renewal_settlements WHERE owner_id=? AND renewal_id=? AND state='active'",
      [ownerId, renewalId],
    )
  )[0] ?? null;

const activeSettlementAnyOwner = async (db: AsyncDb, renewalId: string) =>
  (
    await db.read<{ owner_id: string; id: string }>(
      "SELECT owner_id,id FROM finance_renewal_settlements WHERE renewal_id=? AND state='active'",
      [renewalId],
    )
  )[0] ?? null;

const latestRevision = async (db: AsyncDb, renewalId: string): Promise<number> => {
  const row = (
    await db.read<{ revision: unknown }>(
      'SELECT MAX(version) AS revision FROM finance_renewal_settlements WHERE renewal_id=?',
      [renewalId],
    )
  )[0];
  const value = Number(row?.revision ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const voucherView = (
  voucher: Awaited<ReturnType<typeof readVoucher>>,
): RenewalSettlementVoucher => ({
  id: voucher.id,
  number: voucher.number,
  date: voucher.date,
  description: voucher.description,
  reference: voucher.reference,
  status: voucher.status,
  totalHalalas: voucher.totalHalalas,
  refundedHalalas: Math.max(0, voucher.ownerRefundedHalalas),
  // Reversing a voucher removes its claim; refunds remain derived from the live refund vouchers.
  remainingHalalas: voucher.status === 'posted' ? Math.max(0, voucher.ownerOutstandingHalalas) : 0,
});

const claimVouchers = async (
  db: AsyncDb,
  ownerId: string,
  postedOnly: boolean,
): Promise<LedgerVoucher[]> => {
  const vouchers = await listVouchers(db, ownerId, ['expense', 'payment'], null);
  const expenseIds = new Set(
    vouchers
      .filter((item) => item.kind === 'expense' && item.status === 'posted')
      .map((item) => item.id),
  );
  return vouchers.filter(
    (item) =>
      (!postedOnly || item.status === 'posted') &&
      item.paidByOwner &&
      (item.kind === 'expense' ||
        (item.kind === 'payment' && item.relatedId !== null && expenseIds.has(item.relatedId))),
  );
};

const ownerPaidClaimVouchers = (db: AsyncDb, ownerId: string) => claimVouchers(db, ownerId, true);

const settlementLink = async (
  db: AsyncDb,
  ownerId: string,
  row: SettlementRow,
): Promise<RenewalSettlementLink> => ({
  id: row.id,
  renewalId: row.renewal_id,
  voucherId: row.voucher_id,
  version: Number(row.version),
  state: row.state,
  reason: row.reason,
  createdAt: row.created_at,
  correctedAt: row.corrected_at,
  voucher: voucherView(await readVoucher(db, ownerId, row.voucher_id)),
});

const ensureEligible = (row: RenewalRow) => {
  if (row.status !== 'renewed')
    throw fault(409, 'RENEWAL_NOT_RENEWED', 'لا يمكن مطابقة رسوم حالة لم تُجدّد بعد.');
  if (row.payment !== 'owner')
    throw fault(409, 'RENEWAL_NOT_OWNER_PAID', 'حالة التجديد ليست مسددة من المالك.');
};

const ensureVoucher = async (db: AsyncDb, ownerId: string, voucherId: string) => {
  const voucher = await readVoucher(db, ownerId, voucherId);
  const indirectSource =
    voucher.kind === 'payment' && voucher.relatedId
      ? await readVoucher(db, ownerId, voucher.relatedId)
      : null;
  const legitimate =
    voucher.status === 'posted' &&
    voucher.paidByOwner &&
    ((voucher.kind === 'expense' && voucher.relatedId === null) ||
      (voucher.kind === 'payment' &&
        indirectSource?.kind === 'expense' &&
        indirectSource.status === 'posted'));
  if (!legitimate) throw fault(409, 'VOUCHER_NOT_OWNER_PAID', 'اختر سند مصروف منشورًا سدده المالك.');
  return voucher;
};

const settlementConstraint = (error: unknown): never => {
  const value = error as { code?: string; message?: string };
  if (value.code === '23505' || value.message?.includes('UNIQUE constraint failed'))
    throw fault(409, 'RENEWAL_SETTLEMENT_CONFLICT', 'تغيرت المطابقة؛ حدّث الصفحة ثم أعد المحاولة.');
  throw error;
};

export async function linkRenewalSettlement(
  tx: AsyncDb,
  actor: Actor,
  renewalId: string,
  input: RenewalSettlementInput,
): Promise<string> {
  const row = await renewal(tx, renewalId);
  ensureEligible(row);
  const revision = await latestRevision(tx, renewalId);
  if (input.version !== revision)
    throw fault(409, 'VERSION_CONFLICT', 'تغيرت المطابقة؛ حدّث الصفحة ثم أعد المحاولة.');
  if (await activeSettlementAnyOwner(tx, renewalId))
    throw fault(409, 'RENEWAL_ALREADY_LINKED', 'حالة التجديد مرتبطة بسند قائم؛ استخدم التصحيح.');
  const voucher = await ensureVoucher(tx, actor.id, input.voucherId);
  const used = (
    await tx.read<{ renewal_id: string }>(
      "SELECT renewal_id FROM finance_renewal_settlements WHERE owner_id=? AND voucher_id=? AND state='active'",
      [actor.id, voucher.id],
    )
  )[0];
  if (used) throw fault(409, 'VOUCHER_ALREADY_LINKED', 'لا يمكن ربط السند بأكثر من حالة تجديد.');
  const id = newId();
  try {
    await tx.execute(
      'INSERT INTO finance_renewal_settlements(id,owner_id,renewal_id,voucher_id,state,reason,version,created_by,created_at,corrected_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)',
      [
        id,
        actor.id,
        renewalId,
        voucher.id,
        'active',
        input.reason ?? '',
        revision + 1,
        actor.id,
        now(),
      ],
    );
  } catch (error) {
    settlementConstraint(error);
  }
  await audited(tx, actor, 'finance_renewal_settlement', renewalId, 'linked', revision + 1, {
    voucherId: voucher.id,
  });
  return id;
}

export async function correctRenewalSettlement(
  tx: AsyncDb,
  actor: Actor,
  renewalId: string,
  input: RenewalSettlementCorrectionInput,
): Promise<string | null> {
  const current = await activeSettlement(tx, actor.id, renewalId);
  if (!current) throw fault(409, 'RENEWAL_NOT_LINKED', 'لا توجد مطابقة قائمة لتصحيحها.');
  if (Number(current.version) !== input.version)
    throw fault(409, 'VERSION_CONFLICT', 'تغيرت المطابقة؛ حدّث الصفحة ثم أعد المحاولة.');
  if (input.voucherId === current.voucher_id)
    throw fault(400, 'SAME_VOUCHER', 'اختر سندًا مختلفًا أو أزل المطابقة.');
  let voucherId: string | null = null;
  if (input.voucherId) {
    const voucher = await ensureVoucher(tx, actor.id, input.voucherId);
    const used = (
      await tx.read<{ renewal_id: string }>(
        "SELECT renewal_id FROM finance_renewal_settlements WHERE owner_id=? AND voucher_id=? AND state='active' AND renewal_id<>?",
        [actor.id, voucher.id, renewalId],
      )
    )[0];
    if (used) throw fault(409, 'VOUCHER_ALREADY_LINKED', 'لا يمكن ربط السند بأكثر من حالة تجديد.');
    voucherId = voucher.id;
  }
  const revision = await latestRevision(tx, renewalId);
  if (revision !== Number(current.version))
    throw fault(409, 'VERSION_CONFLICT', 'تغيرت المطابقة؛ حدّث الصفحة ثم أعد المحاولة.');
  const nextVersion = revision + 1;
  const changed = await tx.execute(
    "UPDATE finance_renewal_settlements SET state='corrected',version=version+1,corrected_at=? WHERE owner_id=? AND renewal_id=? AND state='active' AND version=?",
    [now(), actor.id, renewalId, input.version],
  );
  if (changed.rowCount !== 1)
    throw fault(409, 'VERSION_CONFLICT', 'تغيرت المطابقة؛ حدّث الصفحة ثم أعد المحاولة.');
  if (voucherId) {
    try {
      await tx.execute(
        'INSERT INTO finance_renewal_settlements(id,owner_id,renewal_id,voucher_id,state,reason,version,created_by,created_at,corrected_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)',
        [
          newId(),
          actor.id,
          renewalId,
          voucherId,
          'active',
          input.reason,
          nextVersion,
          actor.id,
          now(),
        ],
      );
    } catch (error) {
      settlementConstraint(error);
    }
  }
  await audited(tx, actor, 'finance_renewal_settlement', renewalId, 'corrected', nextVersion, {
    priorVoucherId: current.voucher_id,
    voucherId: voucherId ?? '',
    reason: input.reason,
  });
  return voucherId ? (await activeSettlement(tx, actor.id, renewalId))!.id : null;
}

const stateFor = (
  link: SettlementRow | null,
  voucher: RenewalSettlementVoucher | null,
): RenewalSettlementState => {
  if (!link || !voucher) return 'unlinked';
  if (voucher.status === 'reversed') return 'reversed';
  if (voucher.refundedHalalas <= 0) return 'outstanding';
  return voucher.remainingHalalas <= 0 ? 'settled' : 'partial';
};

export async function renewalSettlementDetails(
  db: AsyncDb,
  ownerId: string,
  renewalId: string,
): Promise<RenewalSettlementDetails> {
  const row = await renewal(db, renewalId);
  const current = await activeSettlement(db, ownerId, renewalId);
  const link = current ? await settlementLink(db, ownerId, current) : null;
  const fee = expectedFee(row);
  const options: RenewalSettlementVoucherOption[] = [];
  if (row.status === 'renewed' && row.payment === 'owner') {
    const used = new Set(
      (
        await db.read<{ voucher_id: string }>(
          "SELECT voucher_id FROM finance_renewal_settlements WHERE owner_id=? AND state='active'",
          [ownerId],
        )
      ).map((item) => item.voucher_id),
    );
    for (const voucher of await ownerPaidClaimVouchers(db, ownerId)) {
      if (used.has(voucher.id) && voucher.id !== current?.voucher_id) continue;
      const view = voucherView(voucher);
      options.push({
        ...view,
        ...(fee !== null && fee !== view.totalHalalas ? { warning: 'amount_mismatch' } : {}),
      });
    }
  }
  return {
    renewalId,
    renewalStatus: row.status,
    payment: row.payment,
    eligible: row.status === 'renewed' && row.payment === 'owner',
    expectedFeeHalalas: fee,
    version: await latestRevision(db, renewalId),
    settlement: link,
    options,
  };
}

export async function renewalSettlementSummary(
  db: AsyncDb,
  ownerId: string,
): Promise<RenewalSettlementSummary[]> {
  const rows = await db.read<RenewalRow>(
    "SELECT * FROM document_renewals WHERE payment='owner' ORDER BY id",
  );
  if (!rows.length) return [];
  const links = await db.read<SettlementRow>(
    "SELECT * FROM finance_renewal_settlements WHERE owner_id=? AND state='active'",
    [ownerId],
  );
  const byRenewal = new Map(links.map((item) => [item.renewal_id, item]));
  const vouchers = await claimVouchers(db, ownerId, false);
  const byVoucher = new Map(vouchers.map((voucher) => [voucher.id, voucherView(voucher)]));
  return rows.map((row) => {
    const link = byRenewal.get(row.id) ?? null;
    const voucher = link ? (byVoucher.get(link.voucher_id) ?? null) : null;
    return {
      renewalId: row.id,
      renewalStatus: row.status,
      payment: row.payment,
      state: stateFor(link, voucher),
      voucherId: voucher?.id ?? null,
      voucherNumber: voucher?.number ?? null,
      amountHalalas: voucher?.totalHalalas ?? 0,
      refundedHalalas: voucher?.refundedHalalas ?? 0,
      remainingHalalas: voucher?.remainingHalalas ?? 0,
    };
  });
}
