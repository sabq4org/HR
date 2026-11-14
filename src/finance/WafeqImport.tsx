import { useEffect, useRef, useState } from 'react';
import { DownloadCloud, LoaderCircle } from 'lucide-react';
import type { WafeqImportCandidate } from '../../shared/finance';
import { api, Modal } from '../lib';
import { Status } from './paper';

/**
 * Review-then-import of the customers already saved in Wafeq. Reading the list changes nothing;
 * importing only adds local customers linked to their Wafeq contact, and never writes to Wafeq.
 */
export function WafeqImportModal({
  close,
  onDone,
}: {
  close: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const [contacts, setContacts] = useState<WafeqImportCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    let live = true;
    api<{ contacts: WafeqImportCandidate[] }>('/finance/wafeq/customers')
      .then((result) => {
        if (!live) return;
        setContacts(result.contacts);
        setPicked(new Set(result.contacts.filter((c) => c.status === 'new').map((c) => c.id)));
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : 'تعذّرت قراءة العملاء.');
      });
    return () => {
      live = false;
    };
  }, []);
  const fresh = contacts?.filter((c) => c.status === 'new') ?? [];
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
    key.current = crypto.randomUUID();
  };
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ imported: number; skipped: number }>(
        '/finance/wafeq/customers/import',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key.current },
          body: JSON.stringify({ ids: [...picked] }),
        },
      );
      await onDone(
        result.imported === 0
          ? 'لم يُضف أي عميل جديد.'
          : result.imported === 1
            ? 'أُضيف عميل واحد من وافق.'
            : `أُضيف ${result.imported} من العملاء من وافق.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذّر الاستيراد. أعد المحاولة.');
      setBusy(false);
    }
  };
  return (
    <Modal title="استيراد العملاء من وافق" close={close} wide className="fin-import-dialog">
      <div className="fin-import">
        <p className="fin-import-intro">
          راجع القائمة ثم اختر من تريد إضافته. الاستيراد قراءة فقط، ولا يغيّر شيئًا في حسابك في وافق.
        </p>
        {error && (
          <p className="fin-alert" role="alert">
            {error}
          </p>
        )}
        {!contacts && !error && (
          <p className="fin-import-loading">
            <LoaderCircle className="spin" size={18} /> جارٍ قراءة العملاء من وافق…
          </p>
        )}
        {contacts && contacts.length === 0 && <p>لا يوجد عملاء في حساب وافق.</p>}
        {contacts && contacts.length > 0 && (
          <>
            <div className="fin-import-bar">
              <span>
                {contacts.length} في وافق · {fresh.length} جديد · {contacts.length - fresh.length}{' '}
                موجود عندك
              </span>
              {fresh.length > 0 && (
                <button
                  className="text-button"
                  onClick={() => {
                    setPicked(
                      picked.size === fresh.length ? new Set() : new Set(fresh.map((c) => c.id)),
                    );
                    key.current = crypto.randomUUID();
                  }}
                >
                  {picked.size === fresh.length ? 'إلغاء تحديد الكل' : 'تحديد الكل'}
                </button>
              )}
            </div>
            <div className="fin-table-wrap fin-import-list">
              <table className="fin-table">
                <thead>
                  <tr>
                    <th>
                      <span aria-label="اختيار" />
                    </th>
                    <th>اسم العميل</th>
                    <th>الرقم الضريبي</th>
                    <th>المدينة</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id} className={c.status === 'new' ? '' : 'fin-import-exists'}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`اختيار ${c.name}`}
                          disabled={c.status !== 'new' || busy}
                          checked={picked.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                      </td>
                      <td>
                        <b>{c.name}</b>
                        <small>{c.email || 'لا يوجد بريد'}</small>
                      </td>
                      <td>{c.vatNumber || '—'}</td>
                      <td>{c.city || '—'}</td>
                      <td>
                        <Status
                          text={
                            c.status === 'exists'
                              ? 'موجود عندك'
                              : c.status === 'unsupported'
                                ? 'خارج السعودية'
                                : 'جديد'
                          }
                          kind={c.status === 'new' ? 'good' : 'neutral'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <footer>
          <button className="button secondary" onClick={close} disabled={busy}>
            إلغاء
          </button>
          <button
            className="button primary"
            disabled={busy || picked.size === 0}
            onClick={() => void run()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <DownloadCloud size={16} />}
            {busy ? 'جارٍ الاستيراد…' : `استيراد المحدد (${picked.size})`}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
