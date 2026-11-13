import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react';
import { api, PageHeading, useApp } from '../lib';
import type { EmployeeImportPreview } from '../../shared/imports';
import './imports.css';

export function EmployeeImportPage() {
  const { data, refresh } = useApp();
  const [preview, setPreview] = useState<EmployeeImportPreview | null>(null);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const command = useRef(crypto.randomUUID());
  async function review(file?: File) {
    if (!file) return;
    setError('');
    setPreview(null);
    setComplete(null);
    setFilename(file.name);
    if (!/\.xlsx$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
      setError('اختر ملف XLSX لا يتجاوز 2 ميجابايت.');
      return;
    }
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('تعذر قراءة الملف من جهازك.'));
        reader.readAsDataURL(file);
      });
      const result = await api<{ preview: EmployeeImportPreview }>(
        '/admin/imports/employees/preview',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ filename: file.name, contentBase64: base64 }),
        },
      );
      setPreview(result.preview);
      command.current = crypto.randomUUID();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview?.valid) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ count: number }>('/admin/imports/employees/commit', {
        method: 'POST',
        headers: { 'Idempotency-Key': command.current },
        body: JSON.stringify({ rows: preview.rows.map((r) => r.values) }),
      });
      setComplete(result.count);
      setPreview(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (data.me.role !== 'hr')
    return (
      <>
        <PageHeading title="استيـراد الموظفيـن" subtitle="إضافة ملفات موظفين من Excel." />
        <p role="alert">الاستيراد متاح للموارد البشرية فقط.</p>
      </>
    );
  return (
    <section className="employee-import">
      <PageHeading
        title="استيـراد الموظفيـن"
        subtitle="راجع الملف مرة واحدة، وأضف الفريق بخطوة واضحة."
        action={
          <Link to="/employees" className="text-button">
            العودة لدليل الفريق
          </Link>
        }
      />
      <ol className="import-steps" aria-label="خطوات الاستيراد">
        <li className={!preview && complete === null ? 'current' : ''}>
          <b>1</b>جهّز الملف
        </li>
        <li className={preview ? 'current' : ''}>
          <b>2</b>راجع الصفوف
        </li>
        <li className={complete !== null ? 'current' : ''}>
          <b>3</b>احفظ الدفعة
        </li>
      </ol>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {complete !== null ? (
        <div className="import-success">
          <CheckCircle2 size={42} />
          <h2>أُضيفت الملفات بنجاح</h2>
          <p>حُفظ {complete} ملفًا وظيفيًا، ويمكنك الآن استكمال الوثائق والعقود.</p>
          <Link to="/employees" className="button primary">
            عرض دليل الفريق
          </Link>
          <button
            className="text-button"
            onClick={() => {
              setComplete(null);
              setFilename('');
            }}
          >
            استيراد دفعة أخرى
          </button>
        </div>
      ) : (
        <>
          <div className="import-intro">
            <div>
              <h2>ابدأ بالقالب المعتمد للاستيراد</h2>
              <p>
                القالب يجمع بيانات الملف الوظيفي ويشرح الحقول المطلوبة. استخدم بيانات وهمية، وبحد
                أقصى 100 موظف في الدفعة.
              </p>
              <a className="button secondary" href="/api/admin/imports/employees/template" download>
                <Download size={17} />
                تنزيل قالب Excel
              </a>
            </div>
            <div className="import-upload">
              <FileSpreadsheet size={33} />
              <strong>{filename || 'اختر ملف الموظفين'}</strong>
              <span>XLSX · حتى 2 ميجابايت · قيم بدون صيغ</span>
              <input
                ref={input}
                type="file"
                accept=".xlsx"
                aria-label="ملف الموظفين Excel"
                disabled={busy}
                onChange={(e) => void review(e.target.files?.[0])}
              />
              <button
                className="button primary"
                onClick={() => input.current?.click()}
                disabled={busy}
              >
                <Upload size={17} />
                {busy ? 'جارٍ المعالجة…' : preview ? 'اختيار ملف آخر' : 'اختيار الملف ومراجعته'}
              </button>
            </div>
          </div>
          {preview && (
            <section className="import-preview">
              <header>
                <h2>معاينة {preview.total} صفًا</h2>
                <span
                  className={preview.valid ? 'status status-approved' : 'status status-rejected'}
                >
                  {preview.valid ? 'الدفعة جاهزة للحفظ' : 'توجد أخطاء تحتاج تصحيحًا'}
                </span>
              </header>
              <div className="import-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>الصف</th>
                      <th>الموظف</th>
                      <th>الرقم الوظيفي</th>
                      <th>الإدارة</th>
                      <th>المراجعة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td>{row.rowNumber}</td>
                        <td>{String(row.values.name || '—')}</td>
                        <td>{String(row.values.employeeNumber || '—')}</td>
                        <td>{String(row.values.department || '—')}</td>
                        <td>
                          {row.errors.length ? (
                            <ul>
                              {row.errors.map((error, i) => (
                                <li key={i}>{error}</li>
                              ))}
                            </ul>
                          ) : (
                            <span className="import-valid">
                              <CheckCircle2 size={15} />
                              جاهز
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <footer>
                <p>
                  {preview.valid
                    ? 'ستُحفظ جميع الصفوف في عملية واحدة. إذا تعذر حفظ أي صف فلن يُحفظ أي منها.'
                    : 'صحح الأخطاء في ملف Excel، ثم ارفع النسخة المعدلة للمراجعة.'}
                </p>
                <button
                  className="button primary"
                  disabled={!preview.valid || busy}
                  onClick={() => void commit()}
                >
                  {busy ? 'جارٍ الحفظ…' : `حفظ ${preview.total} ملفًا`}
                </button>
              </footer>
            </section>
          )}
        </>
      )}
    </section>
  );
}
