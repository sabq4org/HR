import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocumentExpiryItem, EmployeeDocument } from '../../shared/administration';
import type { DocumentRenewalCase, RenewalAssignee, RenewalPayment } from '../../shared/renewals';
import { addDays, api, ConfirmDialog, useApp } from '../lib';
import { useLoadRaw } from './useLoadRaw';

function post(body: unknown, key: string = crypto.randomUUID()): RequestInit {
  return { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) };
}

export function StartRenewal({
  document,
  assignees,
  changed,
}: {
  document: DocumentExpiryItem;
  assignees: RenewalAssignee[];
  changed: () => void;
}) {
  const { data } = useApp();
  const navigate = useNavigate();
  const [assignee, setAssignee] = useState(
    assignees.some((a) => a.id === data.me.id) ? data.me.id : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ case: DocumentRenewalCase }>(
        '/admin/renewals',
        post({
          documentId: document.documentId,
          documentVersion: document.version,
          assignedTo: assignee,
        }),
      );
      navigate('/renewals?case=' + encodeURIComponent(result.case.id), { replace: true });
      changed();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="renewal-form" onSubmit={submit}>
      <label className="adm-field">
        المسؤول عن التجديد
        <select required value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">اختر المسؤول</option>
          {assignees.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="adm-button" disabled={busy || !assignee}>
        فتح معاملة التجديد
      </button>
    </form>
  );
}

async function uploadDocument(
  employeeId: string,
  file: File,
  requestKey: string,
  details: {
    category: string;
    expiresAt?: string;
    documentNumber?: string;
    renewalFee?: string;
  },
) {
  if (file.size > 2 * 1024 * 1024) throw new Error('الحد الأقصى للملف 2 ميغابايت.');
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('تعذّرت قراءة الملف.'));
    reader.readAsDataURL(file);
  });
  const { document } = await api<{ document: EmployeeDocument }>(
    '/admin/employees/' + encodeURIComponent(employeeId) + '/documents',
    post({ ...details, filename: file.name, mimeType: file.type, contentBase64 }, requestKey),
  );
  return document;
}

export function AttachSourceDocument({
  item,
  changed,
}: {
  item: DocumentExpiryItem;
  changed: () => void;
}) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [fee, setFee] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function attach(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const doc = await uploadDocument(item.employeeId, file, key, {
        category: item.category,
        expiresAt: item.expiresAt,
        documentNumber: item.documentNumber || undefined,
        renewalFee: fee.trim() || undefined,
      });
      navigate('/renewals?document=' + encodeURIComponent(doc.id), { replace: true });
      changed();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="renewal-form" onSubmit={attach}>
      <p>تاريخ الانتهاء مسجّل في الملف الوظيفي. أرفق نسخة الوثيقة الحالية لفتح معاملتها.</p>
      <label className="adm-field">
        الوثيقة الحالية
        <input
          type="file"
          required
          accept="application/pdf,image/png,image/jpeg"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setKey(crypto.randomUUID());
          }}
        />
      </label>
      <label className="adm-field">
        رسوم التجديد المتوقعة بالريال (اختياري)
        <input
          inputMode="decimal"
          value={fee}
          onChange={(e) => {
            setFee(e.target.value);
            setKey(crypto.randomUUID());
          }}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="adm-button" disabled={busy || !file}>
        إرفاق الوثيقة ومتابعة التجديد
      </button>
    </form>
  );
}

export function CompleteRenewal({
  item,
  cases,
  changed,
}: {
  item: DocumentRenewalCase;
  cases: DocumentRenewalCase[];
  changed: () => void;
}) {
  const { notify } = useApp();
  const documents = useLoadRaw<{ documents: EmployeeDocument[] }>(
    '/admin/documents?employeeId=' + encodeURIComponent(item.employeeId),
  );
  const used = new Set(cases.map((c) => c.proofDocumentId));
  const proofs =
    documents.value?.documents.filter(
      (d) => d.category === 'renewal_proof' && d.state === 'active' && !used.has(d.id),
    ) ?? [];
  const [selected, setSelected] = useState('');
  const [upload, setUpload] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<EmployeeDocument | null>(null);
  const uploadKey = useRef(crypto.randomUUID());
  const [expiry, setExpiry] = useState('');
  const [reason, setReason] = useState('');
  const [payment, setPayment] = useState<'' | RenewalPayment>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState('');

  async function complete(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      let proof = selected || uploaded?.id;
      if (!proof && upload) {
        const doc = await uploadDocument(item.employeeId, upload, uploadKey.current, {
          category: 'renewal_proof',
        });
        setUploaded(doc);
        proof = doc.id;
      }
      if (!proof) throw new Error('أرفق إثبات التجديد أو اختر إثباتًا محفوظًا.');
      await api(
        '/admin/renewals/' + item.id + '/complete',
        post({
          version: item.version,
          documentVersion: item.documentVersion,
          proofDocumentId: proof,
          newExpiry: expiry,
          payment,
          reason,
        }),
      );
      notify('تم تجديد الوثيقة وحفظ الإثبات');
      changed();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelCase() {
    setCancelError('');
    setBusy(true);
    try {
      await api(
        '/admin/renewals/' + item.id + '/cancel',
        post({ version: item.version, reason: cancelReason }),
      );
      setCancel(false);
      notify('أُلغيت معاملة التجديد');
      changed();
    } catch (failure) {
      setCancelError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form className="renewal-form" onSubmit={complete}>
        <div className="adm-fields">
          <label className="adm-field">
            تاريخ الانتهاء الجديد
            <input
              type="date"
              required
              value={expiry}
              min={addDays(item.originalExpiry, 1)}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <label className="adm-field">
            طريقة السداد
            <select
              required
              value={payment}
              onChange={(e) => setPayment(e.target.value as RenewalPayment)}
            >
              <option value="">اختر طريقة السداد</option>
              <option value="none">دون مطالبة للمالك</option>
              <option value="owner">سدّد المالك من ماله</option>
            </select>
          </label>
        </div>
        {proofs.length > 0 && (
          <label className="adm-field">
            إثبات محفوظ في الملف
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">رفع إثبات جديد</option>
              {proofs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filename}
                </option>
              ))}
            </select>
          </label>
        )}
        {documents.error && (
          <p className="form-error" role="alert">
            {documents.error}{' '}
            <button type="button" className="adm-link" onClick={() => void documents.reload()}>
              تحديث قائمة الإثباتات
            </button>
          </p>
        )}
        {!selected && (
          <label className="adm-field">
            رفع إثبات التجديد
            <input
              type="file"
              required={!uploaded}
              accept="application/pdf,image/jpeg,image/png"
              onChange={(e) => {
                setUpload(e.target.files?.[0] ?? null);
                setUploaded(null);
                uploadKey.current = crypto.randomUUID();
              }}
            />
            <small>
              {uploaded
                ? 'حُفظ الملف ويمكن إعادة محاولة تأكيد التجديد.'
                : 'PDF أو صورة JPG أو PNG حتى 2 ميغابايت.'}
            </small>
          </label>
        )}
        <label className="adm-field">
          مرجع التجديد أو ملاحظته
          <input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="adm-heading-actions">
          <button className="adm-button" disabled={busy || !reason.trim()}>
            تأكيد التجديد
          </button>
          <button
            type="button"
            className="adm-button secondary"
            disabled={busy}
            onClick={() => {
              setCancel(true);
              setCancelError('');
            }}
          >
            إلغاء المعاملة
          </button>
        </div>
      </form>
      {cancel && (
        <ConfirmDialog
          title="إلغاء معاملة التجديد"
          close={() => setCancel(false)}
          busy={busy}
          error={cancelError}
          danger
          confirmDisabled={!cancelReason.trim()}
          confirmLabel="تأكيد الإلغاء"
          onConfirm={cancelCase}
        >
          <label className="adm-field">
            سبب الإلغاء
            <input
              required
              maxLength={500}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}
