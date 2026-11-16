import { useCallback, useEffect, useState } from 'react';
import { Download, Eye, Paperclip, Upload } from 'lucide-react';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentTypes,
  type AttachmentType,
  type LedgerVoucher,
  type VoucherAttachment,
} from '../../../shared/ledger';
import { Alert, Empty, Field, FormPage } from '../index';
import { errorText, read, useLoad, useMutate } from './shared';

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} ميجابايت`
    : `${Math.max(1, Math.round(bytes / 1024))} كيلوبايت`;

/** Reads a picked file as base64 after checking its type and size on the device. */
export async function fileBody(file: File) {
  if (!(attachmentTypes as readonly string[]).includes(file.type))
    throw new Error('يُقبل ملف PDF أو صورة PNG أو JPEG فقط.');
  if (file.size > ATTACHMENT_MAX_BYTES)
    throw new Error(`حجم الملف ${sizeText(file.size)}؛ الحد الأقصى 5 ميجابايت.`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('تعذّرت قراءة الملف.'));
    reader.readAsDataURL(file);
  });
  return {
    fileName: file.name,
    mimeType: file.type as AttachmentType,
    contentBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
  };
}

/** Uploads one file to a voucher with its own idempotency key. */
export function useUpload() {
  const mutate = useMutate();
  return useCallback(
    async (voucherId: string, file: File) =>
      mutate<{ attachment: VoucherAttachment }>(
        `/vouchers/${voucherId}/attachments`,
        await fileBody(file),
      ),
    [mutate],
  );
}

export const acceptAttachments = attachmentTypes.join(',');

async function fetchFile(attachment: VoucherAttachment, inline: boolean) {
  const path = `/api/finance/ledger/attachments/${attachment.id}/download`;
  if (!inline) {
    // A plain same-origin link: the server names the file and marks it private, no-store.
    const a = document.createElement('a');
    a.href = path;
    a.download = attachment.fileName;
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }
  const response = await fetch(`${path}?inline=1`);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || 'تعذّر فتح الملف.');
  }
  const url = URL.createObjectURL(await response.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Supplier invoice files kept with one ledger voucher: list, view, download, add, remove. */
export function AttachmentsPanel({
  voucher,
  close,
  changed,
}: {
  voucher: LedgerVoucher;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const load = useCallback(
    async () =>
      (await read<{ attachments: VoucherAttachment[] }>(`/vouchers/${voucher.id}/attachments`))
        .attachments,
    [voucher.id],
  );
  const { data, error, run } = useLoad(load);
  const upload = useUpload();
  const mutate = useMutate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [removing, setRemoving] = useState<VoucherAttachment | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    void run();
  }, [run]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem('');
    try {
      await work();
    } catch (reasonError) {
      setProblem(errorText(reasonError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormPage title={`مرفقات ${voucher.number}`} close={close}>
      <p className="led-note">
        {voucher.description} · تُحفظ الملفات مشفرة داخل قاعدة بيانات النظام، ولا يفتحها إلا من له
        صلاحية المالية. الحد 5 ميجابايت للملف (PDF أو صورة).
      </p>
      {(error || problem) && <Alert>{error || problem}</Alert>}
      {data?.length ? (
        <ul className="led-attachments">
          {data.map((item) => (
            <li key={item.id}>
              <Paperclip size={16} aria-hidden />
              <b>{item.fileName}</b>
              <small>
                {sizeText(item.sizeBytes)} · رُفع <bdi>{item.uploadedAt.slice(0, 10)}</bdi>
              </small>
              <span className="fin-actions">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void act(() => fetchFile(item, true))}
                >
                  <Eye size={15} /> عرض
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void act(() => fetchFile(item, false))}
                >
                  <Download size={15} /> تنزيل
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setReason('');
                    setRemoving(item);
                  }}
                >
                  إزالة
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        data && <Empty title="لا توجد مرفقات" detail="أرفق صورة الفاتورة أو ملف PDF الخاص بها." />
      )}
      {removing && (
        <form
          className="fin-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await mutate(`/attachments/${removing.id}/remove`, {
                version: removing.version,
                reason,
              });
              setRemoving(null);
              await Promise.all([run(), changed()]);
            });
          }}
        >
          <Field
            label={`سبب إزالة «${removing.fileName}»`}
            hint="لا يُحذف الملف من السجل؛ يختفي من المستند ويبقى أثره في التدقيق."
          >
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              required
            />
          </Field>
          <div className="fin-actions">
            <button className="button" type="submit" disabled={busy}>
              تأكيد الإزالة
            </button>
            <button className="text-button" type="button" onClick={() => setRemoving(null)}>
              تراجع
            </button>
          </div>
        </form>
      )}
      <label className="button primary led-upload">
        <Upload size={16} />
        {busy ? 'جارٍ الرفع…' : 'إرفاق ملف'}
        <input
          type="file"
          accept={acceptAttachments}
          hidden
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file)
              void act(async () => {
                await upload(voucher.id, file);
                await Promise.all([run(), changed()]);
              });
          }}
        />
      </label>
    </FormPage>
  );
}
