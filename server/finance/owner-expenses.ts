/**
 * Expenses the owner paid from his own card (decision 022): who owes him what, refunds from the
 * company bank, and the scanned supplier invoices kept with each ledger voucher.
 *
 * Accounting: an owner-paid expense credits the liability "due to the owner" instead of a bank
 * account; a vendor payment he made moves the vendor payable to him. A refund is a payment
 * voucher (Dr due to the owner / Cr bank) allocated to those documents. Nothing is edited or
 * deleted: a wrong refund is reversed with its voucher, a wrong file is marked removed.
 */
import { createHash } from 'node:crypto';
import type { FinanceSeller } from '../../shared/finance.js';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_VOUCHER,
  ATTACHMENTS_TOTAL_BYTES,
  attachmentTypes,
  type AttachmentType,
  type LedgerVoucher,
  type OwnerClaimRow,
  type OwnerRefundRow,
  type OwnerStatement,
  type VoucherAttachment,
} from '../../shared/ledger.js';
import type { AsyncDb } from '../database.js';
import { decryptSensitive, encryptSensitive } from '../administration/security.js';
import type { Actor } from '../administration/service.js';
import { newId } from '../administration/common.js';
import { fault } from '../administration/validation.js';
import { audited, now } from './routes.js';
import {
  accountRows,
  createVoucher,
  ensureOwnerAccount,
  listVouchers,
  n,
  ownerAccountCode,
  totals,
  voucherRow,
} from './ledger.js';

// ---------------------------------------------------------------- refunds
export type OwnerRefundPayload = {
  date: string;
  amount: number;
  cash: string;
  reference: string;
  claimIds: string[];
};
const byDate = (a: LedgerVoucher, b: LedgerVoucher) =>
  a.date.localeCompare(b.date) || a.number.localeCompare(b.number);

/** Owner-paid documents that still carry a balance, oldest first. */
export async function openClaims(db: AsyncDb, ownerId: string): Promise<LedgerVoucher[]> {
  return (await listVouchers(db, ownerId, ['expense', 'payment'], null))
    .filter((v) => v.paidByOwner && v.status === 'posted' && v.ownerOutstandingHalalas > 0)
    .sort(byDate);
}

export async function createOwnerRefund(
  tx: AsyncDb,
  actor: Actor,
  input: OwnerRefundPayload,
): Promise<string> {
  const ownerCode = await ensureOwnerAccount(tx, actor);
  const open = await openClaims(tx, actor.id);
  let chosen: LedgerVoucher[];
  if (input.claimIds.length) {
    if (new Set(input.claimIds).size !== input.claimIds.length)
      throw fault(400, 'DUPLICATE_CLAIM', 'اختر كل مستند مرة واحدة.');
    chosen = input.claimIds.map((id) => {
      const claim = open.find((item) => item.id === id);
      if (!claim)
        throw fault(409, 'CLAIM_NOT_OPEN', 'أحد المستندات المختارة لا يحمل مبلغًا مستحقًا للمالك.');
      return claim;
    });
  } else chosen = open;
  const owed = chosen.reduce((sum, item) => sum + item.ownerOutstandingHalalas, 0);
  if (input.amount <= 0) throw fault(400, 'INVALID_AMOUNT', 'المبلغ يجب أن يكون أكبر من صفر.');
  if (input.amount > owed)
    throw fault(
      400,
      'REFUND_EXCEEDS_BALANCE',
      `المبلغ يتجاوز المستحق للمالك على المستندات المختارة (${(owed / 100).toFixed(2)}).`,
    );
  // Allocate in order until the amount is used up.
  let left = input.amount;
  const allocations: { claim: LedgerVoucher; amount: number }[] = [];
  for (const claim of chosen) {
    if (!left) break;
    const amount = Math.min(left, claim.ownerOutstandingHalalas);
    allocations.push({ claim, amount });
    left -= amount;
  }
  const latest = allocations.reduce((max, a) => (a.claim.date > max ? a.claim.date : max), '');
  if (input.date < latest)
    throw fault(400, 'INVALID_DATE_RANGE', 'تاريخ الرد لا يسبق تاريخ المصروف الذي يسدده.');
  const cash = (await accountRows(tx, actor.id)).get(input.cash);
  if (!cash || Number(cash.is_cash) !== 1)
    throw fault(400, 'INVALID_CASH_ACCOUNT', 'اختر حساب البنك أو الصندوق الذي دُفع منه.');
  const numbers = allocations.map((a) => a.claim.number);
  const id = await createVoucher(tx, actor, {
    kind: 'payment',
    date: input.date,
    accountCode: ownerCode,
    cashAccountCode: input.cash,
    net: input.amount,
    vat: 0,
    total: input.amount,
    details: {
      description: `رد مبالغ سددها المالك عن ${numbers.join('، ')}`,
      reference: input.reference,
      partyName: 'المالك',
    },
    lines: [
      { accountCode: ownerCode, debit: input.amount, credit: 0 },
      { accountCode: input.cash, debit: 0, credit: input.amount },
    ],
  });
  const at = now();
  for (const allocation of allocations)
    await tx.execute(
      'INSERT INTO finance_owner_allocations(id,owner_id,refund_voucher_id,claim_voucher_id,amount,created_at) VALUES(?,?,?,?,?,?)',
      [newId(), actor.id, id, allocation.claim.id, allocation.amount, at],
    );
  return id;
}

// ---------------------------------------------------------------- statement
/**
 * Owner-paid documents dated up to `asOf` and the refunds against them. A refund counts when it
 * is dated up to `asOf` and has not been reversed.
 */
export async function ownerStatement(
  db: AsyncDb,
  ownerId: string,
  seller: FinanceSeller,
  asOf: string,
  all = false,
): Promise<OwnerStatement> {
  const code = await ownerAccountCode(db, ownerId);
  const accounts = await accountRows(db, ownerId);
  const vouchers = await listVouchers(db, ownerId, ['expense', 'payment'], null);
  // A document reversed after `asOf` was still in force on that date.
  const reversedOn = new Map(
    (
      await db.read<{ reversal_of: string; entry_date: string }>(
        "SELECT reversal_of, entry_date FROM finance_journal_entries WHERE owner_id=? AND kind='reversal' AND reversal_of IS NOT NULL",
        [ownerId],
      )
    ).map((row) => [row.reversal_of, row.entry_date]),
  );
  const liveOn = (v: LedgerVoucher) =>
    v.date <= asOf && (v.status === 'posted' || (reversedOn.get(v.entryId) ?? '') > asOf);
  const byId = new Map(vouchers.map((v) => [v.id, v]));
  const refunds = vouchers
    .filter((v) => v.isOwnerRefund && v.date <= asOf)
    .sort((a, b) => byDate(a, b));
  const allocationRows = code
    ? await db.read<{ refund_voucher_id: string; claim_voucher_id: string; amount: unknown }>(
        'SELECT refund_voucher_id, claim_voucher_id, amount FROM finance_owner_allocations WHERE owner_id=?',
        [ownerId],
      )
    : [];
  const counted = new Set(refunds.filter(liveOn).map((r) => r.id));
  const refunded = new Map<string, number>();
  for (const row of allocationRows)
    if (counted.has(row.refund_voucher_id))
      refunded.set(row.claim_voucher_id, (refunded.get(row.claim_voucher_id) ?? 0) + n(row.amount));
  const accountName = (v: LedgerVoucher) => {
    // A vendor payment the owner made carries the expense account of the bill it paid.
    const source = v.kind === 'payment' && v.relatedId ? byId.get(v.relatedId) : v;
    return (source?.accountCode && accounts.get(source.accountCode)?.name) || '';
  };
  const claims: OwnerClaimRow[] = vouchers
    .filter((v) => v.paidByOwner && liveOn(v))
    .sort(byDate)
    .map((v) => {
      const back = refunded.get(v.id) ?? 0;
      return {
        voucherId: v.id,
        number: v.number,
        date: v.date,
        description: v.description,
        partyName: v.partyName,
        reference: v.reference,
        accountName: accountName(v),
        totalHalalas: v.totalHalalas,
        refundedHalalas: back,
        outstandingHalalas: v.totalHalalas - back,
        attachmentCount: v.attachmentCount,
      };
    });
  const numberOf = new Map(vouchers.map((v) => [v.id, v.number]));
  const rank = new Map([...vouchers].sort(byDate).map((v, index) => [v.id, index]));
  const refundRows: OwnerRefundRow[] = refunds.map((r) => ({
    voucherId: r.id,
    number: r.number,
    date: r.date,
    cashAccountName: (r.cashAccountCode && accounts.get(r.cashAccountCode)?.name) || '',
    reference: r.reference,
    totalHalalas: r.totalHalalas,
    // As it stood on `asOf`: a refund reversed later still shows as posted.
    status: counted.has(r.id) ? 'posted' : 'reversed',
    allocations: allocationRows
      .filter((row) => row.refund_voucher_id === r.id)
      .sort((a, b) => (rank.get(a.claim_voucher_id) ?? 0) - (rank.get(b.claim_voucher_id) ?? 0))
      .map((row) => ({
        claimNumber: numberOf.get(row.claim_voucher_id) ?? '',
        amountHalalas: n(row.amount),
      })),
  }));
  const paid = claims.reduce((sum, c) => sum + c.totalHalalas, 0);
  const back = claims.reduce((sum, c) => sum + c.refundedHalalas, 0);
  const sums = code ? (await totals(db, ownerId, { to: asOf })).get(code) : undefined;
  return {
    seller,
    asOf,
    accountCode: code ?? '',
    accountName: (code && accounts.get(code)?.name) || 'مستحق للمالك',
    claims: all ? claims : claims.filter((c) => c.outstandingHalalas > 0),
    refunds: refundRows,
    paidHalalas: paid,
    refundedHalalas: back,
    outstandingHalalas: paid - back,
    ledgerBalanceHalalas: sums ? sums.credit - sums.debit : 0,
  };
}

// ---------------------------------------------------------------- attachments
type AttachmentRow = {
  id: string;
  voucher_id: string;
  file_name_ciphertext: string;
  mime_type: AttachmentType;
  size_bytes: unknown;
  checksum: string;
  content_ciphertext?: string;
  state: 'active' | 'removed';
  version: unknown;
  uploaded_at: string;
};
const columns =
  'id,voucher_id,file_name_ciphertext,mime_type,size_bytes,checksum,state,version,uploaded_at';
const attachment = (row: AttachmentRow): VoucherAttachment => ({
  id: row.id,
  voucherId: row.voucher_id,
  fileName: decryptSensitive(row.file_name_ciphertext, `finance:attachment-name:${row.id}`),
  mimeType: row.mime_type,
  sizeBytes: n(row.size_bytes),
  uploadedAt: row.uploaded_at,
  version: n(row.version),
});
export async function listAttachments(
  db: AsyncDb,
  ownerId: string,
  voucherId: string,
): Promise<VoucherAttachment[]> {
  await voucherRow(db, ownerId, voucherId);
  return (
    await db.read<AttachmentRow>(
      `SELECT ${columns} FROM finance_voucher_attachments WHERE owner_id=? AND voucher_id=? AND state='active' ORDER BY uploaded_at, id`,
      [ownerId, voucherId],
    )
  ).map(attachment);
}
async function attachmentRow(db: AsyncDb, ownerId: string, id: string, content = false) {
  const row = (
    await db.read<AttachmentRow>(
      `SELECT ${columns}${content ? ',content_ciphertext' : ''} FROM finance_voucher_attachments WHERE owner_id=? AND id=? AND state='active'`,
      [ownerId, id],
    )
  )[0];
  if (!row) throw fault(404, 'ATTACHMENT_NOT_FOUND', 'المرفق غير موجود.');
  return row;
}
export async function readAttachment(db: AsyncDb, ownerId: string, id: string) {
  return attachment(await attachmentRow(db, ownerId, id));
}

const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Validates the upload: type allow-list, size, and that the bytes really are that type. */
export function attachmentFile(value: Record<string, unknown>) {
  const name =
    typeof value.fileName === 'string'
      ? value.fileName.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim()
      : '';
  if (!name || name.length > 160) throw fault(400, 'INVALID_FILENAME', 'اسم الملف مطلوب.');
  const mime = value.mimeType;
  if (typeof mime !== 'string' || !(attachmentTypes as readonly string[]).includes(mime))
    throw fault(400, 'INVALID_MIME', 'يُقبل ملف PDF أو صورة PNG أو JPEG فقط.');
  const content = value.contentBase64;
  if (
    typeof content !== 'string' ||
    content.length > Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 ||
    !base64.test(content)
  )
    throw fault(
      413,
      'FILE_TOO_LARGE',
      `الملف غير صالح أو أكبر من ${ATTACHMENT_MAX_BYTES / 1024 / 1024} ميجابايت.`,
    );
  const bytes = Buffer.from(content, 'base64');
  if (!bytes.length || bytes.length > ATTACHMENT_MAX_BYTES)
    throw fault(
      413,
      'FILE_TOO_LARGE',
      `الحد الأقصى للملف ${ATTACHMENT_MAX_BYTES / 1024 / 1024} ميجابايت.`,
    );
  const magic =
    mime === 'application/pdf'
      ? bytes.subarray(0, 5).toString() === '%PDF-'
      : mime === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (!magic) throw fault(400, 'FILE_TYPE_MISMATCH', 'نوع الملف لا يطابق محتواه.');
  return {
    name,
    mime: mime as AttachmentType,
    bytes,
    checksum: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function addAttachment(
  tx: AsyncDb,
  actor: Actor,
  voucherId: string,
  file: ReturnType<typeof attachmentFile>,
): Promise<string> {
  await voucherRow(tx, actor.id, voucherId);
  const usage = (
    await tx.read<{ c: unknown; v: unknown; b: unknown }>(
      "SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN voucher_id=? AND state='active' THEN 1 ELSE 0 END),0) AS v, COALESCE(SUM(size_bytes),0) AS b FROM finance_voucher_attachments WHERE owner_id=?",
      [voucherId, actor.id],
    )
  )[0];
  if (n(usage?.v) >= ATTACHMENTS_PER_VOUCHER)
    throw fault(
      409,
      'ATTACHMENT_LIMIT',
      `الحد ${ATTACHMENTS_PER_VOUCHER} مرفقات للمستند الواحد؛ أزل مرفقًا غير لازم أولًا.`,
    );
  // Removed files still occupy space (they are kept for the audit trail), so they count here.
  if (n(usage?.b) + file.bytes.length > ATTACHMENTS_TOTAL_BYTES)
    throw fault(
      409,
      'ATTACHMENT_STORAGE_FULL',
      'امتلأت المساحة المخصصة للمرفقات في قاعدة البيانات؛ راجع مسؤول النظام.',
    );
  const id = newId();
  await tx.execute(
    'INSERT INTO finance_voucher_attachments(id,owner_id,voucher_id,file_name_ciphertext,mime_type,size_bytes,checksum,content_ciphertext,state,version,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)',
    [
      id,
      actor.id,
      voucherId,
      encryptSensitive(file.name, `finance:attachment-name:${id}`),
      file.mime,
      file.bytes.length,
      file.checksum,
      encryptSensitive(file.bytes.toString('base64'), `finance:attachment:${id}`),
      'active',
      actor.id,
      now(),
    ],
  );
  await audited(tx, actor, 'finance_attachment', id, 'attachment_added', 1, {
    voucherId,
    size: String(file.bytes.length),
  });
  return id;
}

export async function attachmentContent(db: AsyncDb, ownerId: string, id: string) {
  const row = await attachmentRow(db, ownerId, id, true);
  const bytes = Buffer.from(
    decryptSensitive(row.content_ciphertext ?? '', `finance:attachment:${row.id}`),
    'base64',
  );
  if (createHash('sha256').update(bytes).digest('hex') !== row.checksum)
    throw fault(500, 'ATTACHMENT_CORRUPT', 'تعذر التحقق من سلامة الملف.');
  return { attachment: attachment(row), bytes };
}

export async function removeAttachment(
  tx: AsyncDb,
  actor: Actor,
  id: string,
  version: number,
  reason: string,
): Promise<void> {
  const changed = await tx.execute(
    "UPDATE finance_voucher_attachments SET state='removed',version=version+1,removed_by=?,removed_at=? WHERE owner_id=? AND id=? AND version=? AND state='active'",
    [actor.id, now(), actor.id, id, version],
  );
  if (changed.rowCount !== 1)
    throw fault(409, 'VERSION_CONFLICT', 'تغير المرفق أو أُزيل؛ حدّث الصفحة ثم أعد المحاولة.');
  await audited(tx, actor, 'finance_attachment', id, 'attachment_removed', version + 1, {
    reason,
  });
}
