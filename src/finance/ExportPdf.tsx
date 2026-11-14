import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';

/**
 * Downloads the server-rendered PDF of a document straight to the device, without the browser's
 * print dialog. The file is the same paper as the preview.
 */
export function ExportPdfButton({
  path,
  filename,
  disabled,
  label = 'تصدير PDF',
}: {
  /** Path under /api/finance, including any query. */
  path: string;
  filename: string;
  disabled?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/finance${path}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'تعذّر تصدير الملف. أعد المحاولة.');
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename.replace(/[^\p{L}\p{N}_-]+/gu, '-')}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذّر تصدير الملف. أعد المحاولة.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="button primary" disabled={disabled || busy} onClick={() => void run()}>
        {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
        {busy ? 'جارٍ التصدير…' : label}
      </button>
      {error && (
        <small className="fin-export-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}
