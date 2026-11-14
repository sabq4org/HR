import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { RiyalSign } from './RiyalSign';
import {
  ArrowRight,
  Check,
  CircleAlert,
  ClipboardList,
  FileText,
  LoaderCircle,
  Plus,
  Printer,
  RefreshCw,
  Settings2,
  Users,
  WalletCards,
  X,
} from 'lucide-react';
import type {
  FinanceAddress,
  FinanceCatalogItem,
  FinanceCatalogItemInput,
  FinanceDocumentType,
  FinanceLineInput,
  FinanceCustomer,
  FinanceCustomerInput,
  FinanceLine,
  FinanceInvoice,
  FinanceOverview,
  FinanceQuote,
  FinanceQuoteInput,
  FinanceSeller,
  FinanceSettings,
} from '../../shared/finance';
import { useSearchParams } from 'react-router-dom';
import { api, Modal, PageHeading, useApp } from '../lib';
import './finance.css';

type Tab = 'customers' | 'catalog' | 'quotes' | 'invoices' | 'settings';
const documentTypeText: Record<FinanceDocumentType, { label: string; hint: string }> = {
  standard: {
    label: 'فاتورة ضريبية (B2B) · 15٪',
    hint: 'لمنشأة لها رقم ضريبي. البنود بضريبة 15٪، ويمكن جعل بند بعينه بدون ضريبة مع ذكر السبب.',
  },
  simplified: {
    label: 'فاتورة ضريبية مبسطة (B2C) · 15٪',
    hint: 'لعميل فرد أو جهة بلا رقم ضريبي. البنود بضريبة 15٪.',
  },
  zero_rated: {
    label: 'فاتورة ضريبية بنسبة صفرية (تصدير) · 0٪',
    hint: 'خدمة لعميل خارج المملكة. تبقى فاتورة ضريبية تُرسل للهيئة، وكل البنود 0٪ مع سبب الإعفاء.',
  },
  out_of_scope: {
    label: 'فاتورة غير ضريبية (خارج النطاق)',
    hint: 'لمبلغ ليس مقابل خدمة أو بيع، مثل تعويض أو منحة. بلا ضريبة ولا QR، ولا تُرسل للهيئة.',
  },
};
const documentTypeShort: Record<FinanceDocumentType, string> = {
  standard: 'ضريبية B2B',
  simplified: 'مبسطة B2C',
  zero_rated: 'نسبة صفرية',
  out_of_scope: 'غير ضريبية',
};
const zeroLines = (type: FinanceDocumentType) => type === 'zero_rated' || type === 'out_of_scope';
// Default wording only; the user can change it per line before saving.
const defaultZeroReason = (type: FinanceDocumentType) =>
  type === 'out_of_scope' ? 'خارج نطاق ضريبة القيمة المضافة' : 'تصدير خدمات لعميل غير مقيم';
const blankLine = (type: FinanceDocumentType = 'standard'): FinanceLineInput => ({
  description: '',
  quantity: '1',
  unitPrice: '0.00',
  taxRateBps: zeroLines(type) ? 0 : 1500,
  taxReason: zeroLines(type) ? defaultZeroReason(type) : '',
});
const invoiceTitle = (type: FinanceDocumentType | undefined, invoiceType?: string) =>
  type === 'out_of_scope'
    ? { ar: 'فاتورة', en: 'Invoice' }
    : invoiceType === 'simplified'
      ? { ar: 'فاتورة ضريبية مبسطة', en: 'Simplified Tax Invoice' }
      : type === 'zero_rated'
        ? { ar: 'فاتورة ضريبية', en: 'Tax Invoice · Zero-rated' }
        : { ar: 'فاتورة ضريبية', en: 'Tax Invoice' };
const blankCatalogItem = (): FinanceCatalogItemInput => ({
  description: '',
  unitPrice: '0.00',
  taxRateBps: 1500,
  taxReason: '',
});
// A B2B tax invoice needs a business customer; individuals go through the simplified type.
const blockedConversion = (quote: FinanceQuote) =>
  quote.customer.type === 'individual' && (quote.documentType ?? 'standard') === 'standard';
const isBlankLine = (line: FinanceLineInput) =>
  !line.description.trim() && (Number(line.unitPrice) || 0) === 0;
const blankAddress = (): FinanceAddress => ({ line: '', city: '', postalCode: '', country: 'SA' });
const blankCustomer = (): FinanceCustomerInput => ({
  name: '',
  email: '',
  vatNumber: '',
  address: blankAddress(),
  nameEnglish: '',
  type: 'business',
  commercialRegistration: '',
  phone: '',
  mobile: '',
  notes: '',
});
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
const money = (halalas: number) =>
  new Intl.NumberFormat('en-SA', {
    style: 'currency',
    currency: 'SAR',
    maximumFractionDigits: 2,
  }).format(halalas / 100);
const statusText: Record<FinanceInvoice['status'], string> = {
  draft: 'مسودة فاتورة',
  syncing: 'جارٍ الإرسال',
  pending: 'بانتظار نتيجة التحقق',
  cleared: 'معتمدة',
  reported: 'تم الإبلاغ عنها',
  rejected: 'مرفوضة',
  reconciliation_required: 'تحتاج إلى مطابقة الحالة',
};
function mutationKey(path: string, ref: MutableRefObject<Record<string, string>>) {
  return ref.current[path] ?? (ref.current[path] = crypto.randomUUID());
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'تعذّر إكمال العملية. أعد المحاولة.';
}
function Alert({ children }: { children: string }) {
  return (
    <p className="fin-alert" role="alert">
      <CircleAlert size={17} />
      {children}
    </p>
  );
}
function FormPage({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <section className="fin-form-page" aria-labelledby="fin-form-title">
      <header className="fin-form-page-head">
        <button type="button" className="button secondary small" onClick={close}>
          <ArrowRight size={16} />
          رجوع
        </button>
        <h2 id="fin-form-title">{title}</h2>
      </header>
      {children}
    </section>
  );
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="fin-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Status({
  text,
  kind = 'neutral',
}: {
  text: string;
  kind?: 'neutral' | 'good' | 'bad' | 'waiting';
}) {
  return (
    <span className={`fin-status ${kind}`}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

export function FinancePage() {
  const { data, notify } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const access = (data as typeof data & { financeAccess?: boolean }).financeAccess === true;
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [tab, setTab] = useState<Tab>(() =>
    searchParams.get('tab') === 'settings' ? 'settings' : 'customers',
  );
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState<'customer' | 'catalog' | 'quote' | 'convert' | null>(null);
  const openForm = (kind: 'customer' | 'catalog' | 'quote' | 'convert') => {
    setDialog(kind);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set('form', kind);
      return next;
    });
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (!searchParams.get('form')) setDialog(null);
  }, [searchParams]);
  const [selectedItem, setSelectedItem] = useState<FinanceCatalogItem | null>(null);
  const [catalogForm, setCatalogForm] = useState<FinanceCatalogItemInput>(blankCatalogItem());
  const [catalogPick, setCatalogPick] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<FinanceCustomer | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<FinanceQuote | null>(null);
  const [preview, setPreview] = useState<FinanceQuote | null>(null);
  const [customerForm, setCustomerForm] = useState<FinanceCustomerInput>(blankCustomer());
  const [quoteForm, setQuoteForm] = useState<FinanceQuoteInput>(() => ({
    customerId: '',
    documentType: 'standard',
    title: '',
    issueDate: today(),
    validUntil: '',
    notes: '',
    lines: [blankLine()],
  }));
  const [settingsForm, setSettingsForm] = useState<FinanceSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [convertDates, setConvertDates] = useState({ issueDate: today(), dueDate: '' });
  const [purchaseOrder, setPurchaseOrder] = useState('');
  const [finalInvoice, setFinalInvoice] = useState<FinanceInvoice | null>(null);
  const keys = useRef<Record<string, string>>({});
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const result = await api<FinanceOverview>('/finance');
      setOverview(result);
      setSettingsForm(result.settings);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);
  useEffect(() => {
    if (access) void load();
  }, [access, load]);
  const update = <K extends keyof FinanceSettings>(key: K, value: FinanceSettings[K]) =>
    setSettingsForm((old) => (old ? { ...old, [key]: value } : old));
  const updateBank = (key: keyof NonNullable<FinanceSeller['bankAccount']>, value: string) => {
    if (!settingsForm) return;
    const current = settingsForm.seller.bankAccount ?? {
      beneficiaryName: '',
      bankName: '',
      accountNumber: '',
      iban: '',
    };
    update('seller', { ...settingsForm.seller, bankAccount: { ...current, [key]: value } });
  };
  const mutate = async <T,>(path: string, method: 'POST' | 'PATCH', body: unknown) => {
    const result = await api<T>(path, {
      method,
      headers: { 'Idempotency-Key': mutationKey(path, keys) },
      body: JSON.stringify(body),
    });
    delete keys.current[path];
    return result;
  };
  const beginCustomer = (customer?: FinanceCustomer) => {
    setSelectedCustomer(customer ?? null);
    setCustomerForm(
      customer
        ? { ...blankCustomer(), ...customer, address: { ...blankAddress(), ...customer.address } }
        : blankCustomer(),
    );
    openForm('customer');
  };
  const beginQuote = (quote?: FinanceQuote) => {
    setSelectedQuote(quote ?? null);
    setQuoteForm(
      quote
        ? {
            customerId: quote.customerId,
            documentType: quote.documentType ?? 'standard',
            title: quote.title,
            issueDate: quote.issueDate,
            validUntil: quote.validUntil,
            notes: quote.notes,
            lines: quote.lines.map(
              ({ description, quantity, unitPrice, taxRateBps, taxReason }) => ({
                description,
                quantity,
                unitPrice,
                taxRateBps,
                taxReason,
              }),
            ),
          }
        : {
            customerId: overview?.customers[0]?.id ?? '',
            documentType: 'standard',
            title: '',
            issueDate: today(),
            validUntil: '',
            notes: '',
            lines: [blankLine()],
          },
    );
    setCatalogPick('');
    openForm('quote');
  };
  const quoteType = quoteForm.documentType ?? 'standard';
  // Switching the document type re-applies its tax rule to every line.
  const changeDocumentType = (type: FinanceDocumentType) =>
    setQuoteForm((form) => ({
      ...form,
      documentType: type,
      lines: form.lines.map((line) =>
        zeroLines(type)
          ? { ...line, taxRateBps: 0, taxReason: defaultZeroReason(type) }
          : zeroLines(form.documentType ?? 'standard')
            ? { ...line, taxRateBps: 1500, taxReason: '' }
            : line,
      ),
    }));
  const insertCatalogItem = () => {
    const item = overview?.catalog.find((x) => x.id === catalogPick);
    if (!item) return;
    const line: FinanceLineInput = zeroLines(quoteType)
      ? {
          description: item.description,
          quantity: '1',
          unitPrice: item.unitPrice,
          taxRateBps: 0,
          taxReason: defaultZeroReason(quoteType),
        }
      : {
          description: item.description,
          quantity: '1',
          unitPrice: item.unitPrice,
          taxRateBps: item.taxRateBps,
          taxReason: item.taxReason,
        };
    setQuoteForm((form) => {
      const lines = form.lines.filter((x, n) => !(n === form.lines.length - 1 && isBlankLine(x)));
      return { ...form, lines: [...lines, line] };
    });
    setCatalogPick('');
  };
  const beginCatalogItem = (item?: FinanceCatalogItem) => {
    setSelectedItem(item ?? null);
    setCatalogForm(
      item
        ? {
            description: item.description,
            unitPrice: item.unitPrice,
            taxRateBps: item.taxRateBps,
            taxReason: item.taxReason,
          }
        : blankCatalogItem(),
    );
    openForm('catalog');
  };
  const saveCatalogItem = async (item: FinanceCatalogItem | null, active: boolean) => {
    const path = item ? `/finance/catalog/${item.id}` : '/finance/catalog';
    const body = item
      ? { ...(dialog === 'catalog' ? catalogForm : item), version: item.version, active }
      : catalogForm;
    setBusy(item ? `catalog:${item.id}` : 'catalog');
    setLoadError('');
    try {
      const result = await mutate<{ item: FinanceCatalogItem }>(
        path,
        item ? 'PATCH' : 'POST',
        body,
      );
      setOverview((o) =>
        o
          ? {
              ...o,
              catalog: item
                ? o.catalog.map((x) => (x.id === item.id ? result.item : x))
                : [result.item, ...o.catalog],
            }
          : o,
      );
      if (dialog === 'catalog') closeDialog();
      notify(active ? 'تم حفظ البند.' : 'أُخفي البند من قائمة الإدراج.');
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  // Entry forms open as their own page (?form=...) so browser back returns to the list.
  const closeDialog = () => {
    setDialog(null);
    if (searchParams.get('form'))
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.delete('form');
        return next;
      });
  };
  const onCustomerSave = async (event: FormEvent) => {
    event.preventDefault();
    const path = selectedCustomer
      ? `/finance/customers/${selectedCustomer.id}`
      : '/finance/customers';
    setBusy('customer');
    setLoadError('');
    try {
      const result = await mutate<{ customer: FinanceCustomer }>(
        path,
        selectedCustomer ? 'PATCH' : 'POST',
        { ...customerForm, ...(selectedCustomer ? { version: selectedCustomer.version } : {}) },
      );
      setOverview((o) =>
        o
          ? {
              ...o,
              customers: [
                result.customer,
                ...o.customers.filter((x) => x.id !== result.customer.id),
              ],
            }
          : o,
      );
      closeDialog();
      notify(selectedCustomer ? 'تم حفظ بيانات العميل.' : 'تم إضافة العميل.');
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const onQuoteSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!quoteForm.customerId) return;
    const path = selectedQuote ? `/finance/quotes/${selectedQuote.id}` : '/finance/quotes';
    setBusy('quote');
    setLoadError('');
    try {
      const result = await mutate<{ quote: FinanceQuote }>(path, selectedQuote ? 'PATCH' : 'POST', {
        ...quoteForm,
        ...(selectedQuote ? { version: selectedQuote.version } : {}),
      });
      setOverview((o) =>
        o
          ? { ...o, quotes: [result.quote, ...o.quotes.filter((x) => x.id !== result.quote.id)] }
          : o,
      );
      closeDialog();
      notify('تم حفظ عرض السعر.');
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const syncCustomer = async (customer: FinanceCustomer) => {
    const path = `/finance/customers/${customer.id}/sync`;
    setBusy(`customer:${customer.id}`);
    setLoadError('');
    try {
      const result = await mutate<{ customer: FinanceCustomer }>(path, 'POST', {
        version: customer.version,
      });
      setOverview((o) =>
        o
          ? {
              ...o,
              customers: o.customers.map((x) => (x.id === customer.id ? result.customer : x)),
            }
          : o,
      );
    } catch (e) {
      setLoadError(errorText(e));
      await load();
    } finally {
      setBusy('');
    }
  };
  const beginConvert = (quote: FinanceQuote) => {
    setSelectedQuote(quote);
    setConvertDates({ issueDate: today(), dueDate: quote.validUntil || '' });
    openForm('convert');
  };
  const convertQuote = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedQuote) return;
    const path = `/finance/quotes/${selectedQuote.id}/convert`;
    setBusy('convert');
    try {
      const result = await mutate<{ invoice: FinanceInvoice }>(path, 'POST', {
        version: selectedQuote.version,
        ...convertDates,
        purchaseOrder,
      });
      setOverview((o) =>
        o
          ? {
              ...o,
              invoices: [result.invoice, ...o.invoices],
              quotes: o.quotes.map((q) =>
                q.id === selectedQuote.id
                  ? { ...q, status: 'converted', invoiceId: result.invoice.id }
                  : q,
              ),
            }
          : o,
      );
      closeDialog();
      setTab('invoices');
      notify('تم إنشاء مسودة الفاتورة المرتبطة بعرض السعر.');
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!settingsForm) return;
    setBusy('settings');
    setLoadError('');
    try {
      const result = await mutate<{ settings: FinanceSettings }>('/finance/settings', 'PATCH', {
        version: settingsForm.version,
        seller: settingsForm.seller,
        revenueAccountId: settingsForm.revenueAccountId,
        standardTaxRateId: settingsForm.standardTaxRateId,
        zeroTaxRateId: settingsForm.zeroTaxRateId,
      });
      setOverview((o) => (o ? { ...o, settings: result.settings } : o));
      setSettingsForm(result.settings);
      notify('تم حفظ إعدادات الفوترة.');
    } catch (e) {
      setLoadError(errorText(e));
      await load();
    } finally {
      setBusy('');
    }
  };
  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('key');
    try {
      const result = await mutate<{ settings: FinanceSettings }>(
        '/finance/settings/api-key',
        'POST',
        { apiKey },
      );
      setApiKey('');
      setOverview((o) => (o ? { ...o, settings: result.settings } : o));
      setSettingsForm(result.settings);
      notify('تم حفظ مفتاح وافق دون عرضه مجددًا.');
    } catch (e) {
      setApiKey('');
      setLoadError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const testConnection = async () => {
    setBusy('test');
    try {
      const result = await mutate<{ settings: FinanceSettings }>(
        '/finance/settings/test',
        'POST',
        {},
      );
      setOverview((o) => (o ? { ...o, settings: result.settings } : o));
      setSettingsForm(result.settings);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const invoiceSync = async (invoice: FinanceInvoice, action: 'sync' | 'refresh') => {
    const path = `/finance/invoices/${invoice.id}/${action}`;
    setBusy(`invoice:${invoice.id}`);
    try {
      const result = await mutate<{ invoice: FinanceInvoice }>(
        path,
        'POST',
        action === 'sync' ? { version: invoice.version } : {},
      );
      setOverview((o) =>
        o
          ? { ...o, invoices: o.invoices.map((x) => (x.id === invoice.id ? result.invoice : x)) }
          : o,
      );
    } catch (e) {
      setLoadError(errorText(e));
      await load();
    } finally {
      setBusy('');
    }
  };
  const download = async (invoice: FinanceInvoice) => {
    setBusy(`pdf:${invoice.id}`);
    try {
      const response = await fetch(`/api/finance/invoices/${encodeURIComponent(invoice.id)}/pdf`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'تعذّر تنزيل نسخة الفاتورة.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.number}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const totals = useMemo(
    () =>
      quoteForm.lines.reduce(
        (sum, line) => {
          const sub = Math.round(
            (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0) * 100,
          );
          const tax = Math.round((sub * line.taxRateBps) / 10000);
          return { sub: sum.sub + sub, tax: sum.tax + tax };
        },
        { sub: 0, tax: 0 },
      ),
    [quoteForm.lines],
  );

  if (!access)
    return (
      <section className="finance-page">
        <PageHeading title="المالية" subtitle="لا تتوفر لك صلاحية دخول هذا القسم." />
      </section>
    );
  return (
    <section className="finance-page" dir="rtl">
      <PageHeading
        title="المالية"
        subtitle="العملاء وعروض الأسعار والفواتير المرتبطة بوافق."
        action={
          <button className="button secondary" onClick={() => void load()} disabled={!!busy}>
            <RefreshCw size={16} />
            تحديث البيانات
          </button>
        }
      />
      <div className="fin-banner">
        <div>
          <b>مساحة مالية خاصة</b>
          <span>
            لا يُرسل عرض السعر إلى العميل من هذه الصفحة. إصدار الفاتورة ومزامنتها إجراء منفصل.
          </span>
        </div>
        <div className="fin-connection">
          <span className={`fin-connection-dot ${overview?.settings.canSync ? 'ready' : ''}`} />
          {overview?.settings.connectionMessage || 'جارٍ قراءة حالة الربط'}
        </div>
      </div>
      {loadError && <Alert>{loadError}</Alert>}
      {!overview ? (
        <section className="fin-loading" aria-live="polite">
          {loadError ? (
            <button className="button secondary" onClick={() => void load()}>
              إعادة المحاولة
            </button>
          ) : (
            <>
              <LoaderCircle className="spin" size={20} /> جارٍ تحميل مساحة المالية…
            </>
          )}
        </section>
      ) : dialog ? null : (
        <>
          <nav className="fin-tabs" aria-label="أقسام المالية">
            {(
              [
                ['customers', 'العملاء', Users],
                ['catalog', 'البنود المحفوظة', ClipboardList],
                ['quotes', 'عروض الأسعار', FileText],
                ['invoices', 'الفواتير', WalletCards],
                ['settings', 'إعدادات وافق', Settings2],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                className={tab === id ? 'active' : ''}
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => setTab(id)}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
          {tab === 'customers' && (
            <section className="fin-section">
              <div className="fin-section-head">
                <div>
                  <h2>العملاء</h2>
                  <p>بيانات العميل المستخدمة في عروض الأسعار والفواتير.</p>
                </div>
                <button className="button primary" onClick={() => beginCustomer()}>
                  <Plus size={17} />
                  إضافة عميل
                </button>
              </div>
              {overview.customers.length ? (
                <div className="fin-table-wrap">
                  <table className="fin-table">
                    <thead>
                      <tr>
                        <th>اسم العميل</th>
                        <th>الرقم الضريبي</th>
                        <th>الحالة في وافق</th>
                        <th>إجراءات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.customers.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <b>{c.name}</b>
                            <small>{c.email || 'لا يوجد بريد'}</small>
                          </td>
                          <td>{c.vatNumber || '—'}</td>
                          <td>
                            <Status
                              text={
                                c.syncStatus === 'synced'
                                  ? 'متزامن'
                                  : c.syncStatus === 'error'
                                    ? c.syncMessage || 'تعذرت المزامنة'
                                    : 'غير متزامن'
                              }
                              kind={
                                c.syncStatus === 'synced'
                                  ? 'good'
                                  : c.syncStatus === 'error'
                                    ? 'bad'
                                    : 'neutral'
                              }
                            />
                          </td>
                          <td className="fin-actions">
                            <button className="text-button" onClick={() => beginCustomer(c)}>
                              تعديل
                            </button>
                            <button
                              className="text-button"
                              disabled={
                                !overview.settings.canSync ||
                                c.type === 'individual' ||
                                busy === `customer:${c.id}`
                              }
                              onClick={() => void syncCustomer(c)}
                            >
                              {busy === `customer:${c.id}`
                                ? 'جارٍ المزامنة…'
                                : c.type === 'individual'
                                  ? 'مزامنة غير مدعومة'
                                  : 'مزامنة وافق'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="لا يوجد عملاء بعد" detail="أضف بيانات العميل لتبدأ إعداد عرض سعر." />
              )}
            </section>
          )}
          {tab === 'catalog' && (
            <section className="fin-section">
              <div className="fin-section-head">
                <div>
                  <h2>البنود المحفوظة</h2>
                  <p>احفظ الخدمات المتكررة بسعرها وضريبتها، ثم أدرجها في عرض السعر بضغطة.</p>
                </div>
                <button className="button primary" onClick={() => beginCatalogItem()}>
                  <Plus size={17} />
                  إضافة بند محفوظ
                </button>
              </div>
              {overview.catalog.length ? (
                <div className="fin-table-wrap">
                  <table className="fin-table">
                    <thead>
                      <tr>
                        <th>الوصف</th>
                        <th>سعر الوحدة</th>
                        <th>الضريبة</th>
                        <th>الحالة</th>
                        <th>إجراءات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.catalog.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <b>{item.description}</b>
                            {item.taxRateBps === 0 && <small>{item.taxReason}</small>}
                          </td>
                          <td className="num">{money(Math.round(Number(item.unitPrice) * 100))}</td>
                          <td>{item.taxRateBps === 0 ? 'بدون ضريبة' : '15٪'}</td>
                          <td>
                            <Status
                              text={item.active ? 'متاح للإدراج' : 'مخفي'}
                              kind={item.active ? 'good' : 'neutral'}
                            />
                          </td>
                          <td className="fin-actions">
                            <button className="text-button" onClick={() => beginCatalogItem(item)}>
                              تعديل
                            </button>
                            <button
                              className="text-button"
                              disabled={busy === `catalog:${item.id}`}
                              onClick={() => void saveCatalogItem(item, !item.active)}
                            >
                              {item.active ? 'إخفاء' : 'إظهار'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="لا توجد بنود محفوظة بعد"
                  detail="أضف الخدمات التي تتكرر في عروضك لتدرجها مباشرة."
                />
              )}
            </section>
          )}
          {tab === 'quotes' && (
            <section className="fin-section">
              <div className="fin-section-head">
                <div>
                  <h2>عروض الأسعار</h2>
                  <p>العروض محفوظة كمسودات قابلة للتعديل قبل تحويلها إلى فاتورة.</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => beginQuote()}
                  disabled={!overview.customers.length}
                >
                  <Plus size={17} />
                  عرض سعر جديد
                </button>
              </div>
              {overview.quotes.length ? (
                <div className="fin-table-wrap">
                  <table className="fin-table">
                    <thead>
                      <tr>
                        <th>رقم العرض</th>
                        <th>العميل</th>
                        <th>النوع</th>
                        <th>العنوان</th>
                        <th>الإجمالي</th>
                        <th>الحالة</th>
                        <th>إجراءات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.quotes.map((q) => (
                        <tr key={q.id}>
                          <td>
                            <b>{q.number}</b>
                          </td>
                          <td>{q.customer.name}</td>
                          <td>{documentTypeShort[q.documentType ?? 'standard']}</td>
                          <td>{q.title}</td>
                          <td className="num">{money(q.totalHalalas)}</td>
                          <td>
                            <Status
                              text={
                                q.status === 'draft' ? 'مسودة عرض سعر' : 'تم التحويل إلى فاتورة'
                              }
                              kind={q.status === 'draft' ? 'waiting' : 'good'}
                            />
                          </td>
                          <td className="fin-actions">
                            <button className="text-button" onClick={() => setPreview(q)}>
                              معاينة
                            </button>
                            {q.status === 'draft' && (
                              <>
                                <button className="text-button" onClick={() => beginQuote(q)}>
                                  تعديل
                                </button>
                                <button className="text-button" onClick={() => beginConvert(q)}>
                                  تحويل إلى مسودة فاتورة
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="ابدأ بعرض السعر الأول"
                  detail="اختر عميلًا، أضف البنود، ثم راجع النسخة قبل الطباعة."
                />
              )}
            </section>
          )}
          {tab === 'invoices' && (
            <section className="fin-section">
              <div className="fin-section-head">
                <div>
                  <h2>الفواتير</h2>
                  <p>الإصدار والمزامنة إلى وافق ومنصة فاتورة في الهيئة يتمان صراحةً.</p>
                </div>
              </div>
              {overview.invoices.length ? (
                <div className="fin-table-wrap">
                  <table className="fin-table">
                    <thead>
                      <tr>
                        <th>رقم الفاتورة</th>
                        <th>العميل</th>
                        <th>عرض السعر</th>
                        <th>الإجمالي</th>
                        <th>الحالة</th>
                        <th>إجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.invoices.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <b>{i.number}</b>
                          </td>
                          <td>{i.customer.name}</td>
                          <td>{i.quoteNumber}</td>
                          <td className="num">{money(i.totalHalalas)}</td>
                          <td>
                            <Status
                              text={statusText[i.status]}
                              kind={
                                ['cleared', 'reported'].includes(i.status)
                                  ? 'good'
                                  : ['rejected', 'reconciliation_required'].includes(i.status)
                                    ? 'bad'
                                    : i.status === 'draft'
                                      ? 'waiting'
                                      : 'neutral'
                              }
                            />
                            {i.syncMessage && (
                              <small className="fin-message">{i.syncMessage}</small>
                            )}
                            {['cleared', 'reported'].includes(i.status) && !i.qrCode && (
                              <small className="fin-message">
                                بانتظار مستند الاعتماد ورمز التحقق
                              </small>
                            )}
                          </td>
                          <td className="fin-actions">
                            {i.status === 'draft' ? (
                              <>
                                <button className="text-button" onClick={() => setFinalInvoice(i)}>
                                  معاينة المسودة
                                </button>
                                <button
                                  className="button primary small"
                                  disabled={
                                    !overview.settings.canSync ||
                                    i.customer.type === 'individual' ||
                                    i.lines.some((line) => line.taxRateBps === 0) ||
                                    busy === `invoice:${i.id}`
                                  }
                                  onClick={() => void invoiceSync(i, 'sync')}
                                >
                                  {busy === `invoice:${i.id}`
                                    ? 'جارٍ الإرسال…'
                                    : i.documentType === 'out_of_scope'
                                      ? 'غير ضريبية · لا تُرسل للهيئة'
                                      : i.lines.some((line) => line.taxRateBps === 0)
                                        ? 'تحتاج ربط ضريبة صفرية'
                                        : i.customer.type === 'individual'
                                          ? 'العميل الفردي غير مدعوم'
                                          : 'إصدار ومزامنة مع وافق'}
                                </button>
                                {i.documentType !== 'out_of_scope' &&
                                  i.lines.some((line) => line.taxRateBps === 0) && (
                                    <small className="fin-message">
                                      تحتاج البنود ذات الضريبة الصفرية إلى رمز سبب معتمد في وافق؛
                                      وصف السبب الحر لا يكفي.
                                    </small>
                                  )}
                              </>
                            ) : (
                              <>
                                {/* Retrying /sync reuses the stored provider operation keys. */}
                                {['reconciliation_required', 'syncing'].includes(i.status) && (
                                  <button
                                    className="text-button"
                                    disabled={busy === `invoice:${i.id}`}
                                    onClick={() => void invoiceSync(i, 'sync')}
                                  >
                                    إعادة محاولة المزامنة
                                  </button>
                                )}
                                {i.wafeqId && (
                                  <button
                                    className="text-button"
                                    disabled={busy === `invoice:${i.id}`}
                                    onClick={() => void invoiceSync(i, 'refresh')}
                                  >
                                    تحديث حالة التحقق
                                  </button>
                                )}
                              </>
                            )}
                            {['cleared', 'reported'].includes(i.status) && i.qrCode && (
                              <button className="text-button" onClick={() => setFinalInvoice(i)}>
                                طباعة فاتورة سبق
                              </button>
                            )}
                            {i.canDownloadXml && (
                              <button
                                className="text-button"
                                onClick={() => {
                                  const a = document.createElement('a');
                                  a.href = `/api/finance/invoices/${encodeURIComponent(i.id)}/xml`;
                                  a.download = `${i.number}.xml`;
                                  a.click();
                                }}
                              >
                                تنزيل XML
                              </button>
                            )}
                            {i.canDownload && ['cleared', 'reported'].includes(i.status) && (
                              <button
                                className="text-button"
                                disabled={busy === `pdf:${i.id}`}
                                onClick={() => void download(i)}
                              >
                                النسخة الأصلية من وافق
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="لا توجد فواتير"
                  detail="حوّل عرض سعر إلى مسودة فاتورة عندما يوافق العميل على العرض."
                />
              )}
            </section>
          )}
          {tab === 'settings' && settingsForm && (
            <section className="fin-section">
              <div className="fin-section-head">
                <div>
                  <h2>إعدادات وافق والفوترة</h2>
                  <p>بيانات البائع وحساب الإيراد والضريبة المستخدمة عند تجهيز الفواتير.</p>
                </div>
              </div>
              <section className="fin-provider">
                <h3>الاتصال بوافق</h3>
                <p>
                  {settingsForm.organization
                    ? `المنشأة المرتبطة: ${settingsForm.organization.name}`
                    : 'لم يتم التحقق من منشأة وافق بعد.'}
                </p>
                <Status
                  text={settingsForm.apiKeyConfigured ? 'مفتاح محفوظ' : 'لا يوجد مفتاح محفوظ'}
                  kind={settingsForm.apiKeyConfigured ? 'good' : 'neutral'}
                />
                <form className="fin-key-form" onSubmit={saveKey}>
                  <Field
                    label="مفتاح واجهة وافق"
                    hint="لن يظهر المفتاح بعد الحفظ. لا تحفظه في المتصفح."
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="أدخل المفتاح مرة واحدة"
                      disabled={!settingsForm.canStoreApiKey}
                    />
                  </Field>
                  <button
                    className="button secondary"
                    disabled={!settingsForm.canStoreApiKey || !apiKey || busy === 'key'}
                  >
                    حفظ المفتاح
                  </button>
                </form>
                <button
                  className="text-button"
                  onClick={() => void testConnection()}
                  disabled={busy === 'test'}
                >
                  {busy === 'test' ? 'جارٍ فحص الاتصال…' : 'اختبار الاتصال بوافق'}
                </button>
                {settingsForm.connectionMessage && (
                  <p className="fin-message">{settingsForm.connectionMessage}</p>
                )}
              </section>
              <form className="fin-settings" onSubmit={saveSettings}>
                <fieldset>
                  <legend>بيانات البائع</legend>
                  <div className="fin-grid">
                    <Field label="اسم المنشأة">
                      <input
                        required
                        value={settingsForm.seller.name}
                        onChange={(e) =>
                          update('seller', { ...settingsForm.seller, name: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="الرقم الضريبي">
                      <input
                        value={settingsForm.seller.vatNumber}
                        onChange={(e) =>
                          update('seller', { ...settingsForm.seller, vatNumber: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="السجل التجاري">
                      <input
                        value={settingsForm.seller.commercialRegistration}
                        onChange={(e) =>
                          update('seller', {
                            ...settingsForm.seller,
                            commercialRegistration: e.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="العنوان الوطني">
                      <input
                        value={settingsForm.seller.address.line}
                        onChange={(e) =>
                          update('seller', {
                            ...settingsForm.seller,
                            address: { ...settingsForm.seller.address, line: e.target.value },
                          })
                        }
                      />
                    </Field>
                    <Field label="المدينة">
                      <input
                        value={settingsForm.seller.address.city}
                        onChange={(e) =>
                          update('seller', {
                            ...settingsForm.seller,
                            address: { ...settingsForm.seller.address, city: e.target.value },
                          })
                        }
                      />
                    </Field>
                    <Field label="الرمز البريدي">
                      <input
                        value={settingsForm.seller.address.postalCode}
                        onChange={(e) =>
                          update('seller', {
                            ...settingsForm.seller,
                            address: { ...settingsForm.seller.address, postalCode: e.target.value },
                          })
                        }
                      />
                    </Field>
                  </div>
                </fieldset>
                <fieldset>
                  <legend>بيانات الحساب البنكي (اختياري)</legend>
                  <div className="fin-grid">
                    <Field label="اسم المستفيد">
                      <input
                        value={settingsForm.seller.bankAccount?.beneficiaryName ?? ''}
                        onChange={(e) => updateBank('beneficiaryName', e.target.value)}
                      />
                    </Field>
                    <Field label="البنك">
                      <input
                        value={settingsForm.seller.bankAccount?.bankName ?? ''}
                        onChange={(e) => updateBank('bankName', e.target.value)}
                      />
                    </Field>
                    <Field label="رقم الحساب">
                      <input
                        inputMode="numeric"
                        value={settingsForm.seller.bankAccount?.accountNumber ?? ''}
                        onChange={(e) => updateBank('accountNumber', e.target.value)}
                      />
                    </Field>
                    <Field label="رقم الآيبان">
                      <input
                        dir="ltr"
                        autoComplete="off"
                        value={settingsForm.seller.bankAccount?.iban ?? ''}
                        onChange={(e) => updateBank('iban', e.target.value)}
                      />
                    </Field>
                  </div>
                </fieldset>
                <fieldset>
                  <legend>حسابات الضرائب والإيرادات في وافق</legend>
                  <div className="fin-grid">
                    <Field label="حساب الإيراد">
                      <input
                        value={settingsForm.revenueAccountId}
                        onChange={(e) => update('revenueAccountId', e.target.value)}
                      />
                    </Field>
                    <Field label="رمز ضريبة 15٪">
                      <input
                        value={settingsForm.standardTaxRateId}
                        onChange={(e) => update('standardTaxRateId', e.target.value)}
                      />
                    </Field>
                    <Field label="رمز الضريبة الصفرية">
                      <input
                        value={settingsForm.zeroTaxRateId}
                        onChange={(e) => update('zeroTaxRateId', e.target.value)}
                      />
                    </Field>
                  </div>
                </fieldset>
                <div className="fin-form-actions">
                  <button className="button primary" disabled={busy === 'settings'}>
                    {busy === 'settings' ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
                  </button>
                </div>
              </form>
            </section>
          )}
        </>
      )}
      {dialog === 'customer' && (
        <FormPage
          title={selectedCustomer ? 'تعديل بيانات العميل' : 'إضافة عميل'}
          close={closeDialog}
        >
          <form className="fin-dialog-form" onSubmit={onCustomerSave}>
            <div className="fin-grid">
              <Field label="اسم العميل بالعربية">
                <input
                  required
                  autoFocus
                  value={customerForm.name}
                  onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })}
                />
              </Field>
              <Field label="الاسم بالإنجليزية (اختياري)">
                <input
                  value={customerForm.nameEnglish || ''}
                  onChange={(e) =>
                    setCustomerForm({ ...customerForm, nameEnglish: e.target.value })
                  }
                />
              </Field>
              <Field label="نوع العميل">
                <select
                  value={customerForm.type || 'business'}
                  onChange={(e) =>
                    setCustomerForm({
                      ...customerForm,
                      type: e.target.value as 'business' | 'individual',
                    })
                  }
                >
                  <option value="business">شركة (B2B)</option>
                  <option value="individual">فرد (B2C)</option>
                </select>
              </Field>
              <Field label="الرقم الضريبي">
                <input
                  value={customerForm.vatNumber}
                  onChange={(e) => setCustomerForm({ ...customerForm, vatNumber: e.target.value })}
                />
              </Field>
              <Field label="السجل التجاري">
                <input
                  value={customerForm.commercialRegistration || ''}
                  onChange={(e) =>
                    setCustomerForm({ ...customerForm, commercialRegistration: e.target.value })
                  }
                />
              </Field>
              <Field label="البريد الإلكتروني">
                <input
                  type="email"
                  value={customerForm.email}
                  onChange={(e) => setCustomerForm({ ...customerForm, email: e.target.value })}
                />
              </Field>
              <Field label="الهاتف">
                <input
                  type="tel"
                  value={customerForm.phone || ''}
                  onChange={(e) => setCustomerForm({ ...customerForm, phone: e.target.value })}
                />
              </Field>
              <Field label="الجوال">
                <input
                  type="tel"
                  value={customerForm.mobile || ''}
                  onChange={(e) => setCustomerForm({ ...customerForm, mobile: e.target.value })}
                />
              </Field>
              <Field label="الدولة">
                <input value="المملكة العربية السعودية" readOnly />
              </Field>
              <Field label="المدينة">
                <input
                  value={customerForm.address.city}
                  onChange={(e) =>
                    setCustomerForm({
                      ...customerForm,
                      address: { ...customerForm.address, city: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="الحي">
                <input
                  value={customerForm.address.district || ''}
                  onChange={(e) =>
                    setCustomerForm({
                      ...customerForm,
                      address: { ...customerForm.address, district: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="الشارع">
                <input
                  value={customerForm.address.line}
                  onChange={(e) =>
                    setCustomerForm({
                      ...customerForm,
                      address: { ...customerForm.address, line: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="رقم المبنى">
                <input
                  value={customerForm.address.buildingNumber || ''}
                  onChange={(e) =>
                    setCustomerForm({
                      ...customerForm,
                      address: { ...customerForm.address, buildingNumber: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="الرمز البريدي">
                <input
                  value={customerForm.address.postalCode}
                  onChange={(e) =>
                    setCustomerForm({
                      ...customerForm,
                      address: { ...customerForm.address, postalCode: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="ملاحظات">
                <textarea
                  value={customerForm.notes || ''}
                  onChange={(e) => setCustomerForm({ ...customerForm, notes: e.target.value })}
                />
              </Field>
            </div>
            {loadError && <Alert>{loadError}</Alert>}
            <div className="fin-form-actions">
              <button type="button" className="button secondary" onClick={closeDialog}>
                إلغاء
              </button>
              <button className="button primary" disabled={busy === 'customer'}>
                {busy === 'customer' ? 'جارٍ الحفظ…' : 'حفظ العميل'}
              </button>
            </div>
          </form>
        </FormPage>
      )}
      {dialog === 'catalog' && (
        <FormPage title={selectedItem ? 'تعديل بند محفوظ' : 'بند محفوظ جديد'} close={closeDialog}>
          <form
            className="fin-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCatalogItem(selectedItem, selectedItem?.active ?? true);
            }}
          >
            <div className="fin-grid">
              <Field label="وصف البند">
                <input
                  required
                  value={catalogForm.description}
                  onChange={(e) => setCatalogForm({ ...catalogForm, description: e.target.value })}
                />
              </Field>
              <Field label="سعر الوحدة (ر.س)">
                <input
                  required
                  inputMode="decimal"
                  value={catalogForm.unitPrice}
                  onChange={(e) => setCatalogForm({ ...catalogForm, unitPrice: e.target.value })}
                />
              </Field>
              <Field label="الضريبة">
                <select
                  value={catalogForm.taxRateBps}
                  onChange={(e) =>
                    setCatalogForm({
                      ...catalogForm,
                      taxRateBps: Number(e.target.value),
                      taxReason: Number(e.target.value) === 0 ? catalogForm.taxReason : '',
                    })
                  }
                >
                  <option value={1500}>15٪</option>
                  <option value={0}>بدون ضريبة</option>
                </select>
              </Field>
              {catalogForm.taxRateBps === 0 && (
                <Field label="سبب عدم احتساب الضريبة">
                  <input
                    required
                    value={catalogForm.taxReason}
                    onChange={(e) => setCatalogForm({ ...catalogForm, taxReason: e.target.value })}
                  />
                </Field>
              )}
            </div>
            {loadError && <Alert>{loadError}</Alert>}
            <div className="fin-form-actions">
              <button type="button" className="button secondary" onClick={closeDialog}>
                إلغاء
              </button>
              <button
                className="button primary"
                disabled={busy === 'catalog' || busy === `catalog:${selectedItem?.id}`}
              >
                حفظ البند
              </button>
            </div>
          </form>
        </FormPage>
      )}
      {dialog === 'quote' && (
        <FormPage title={selectedQuote ? 'تعديل عرض السعر' : 'عرض سعر جديد'} close={closeDialog}>
          <form className="fin-dialog-form" onSubmit={onQuoteSave}>
            <div className="fin-grid">
              <Field label="نوع الفاتورة">
                <select
                  value={quoteType}
                  onChange={(e) => changeDocumentType(e.target.value as FinanceDocumentType)}
                >
                  {(Object.keys(documentTypeText) as FinanceDocumentType[]).map((type) => (
                    <option key={type} value={type}>
                      {documentTypeText[type].label}
                    </option>
                  ))}
                </select>
                <small>{documentTypeText[quoteType].hint}</small>
              </Field>
              <Field label="العميل">
                <select
                  required
                  value={quoteForm.customerId}
                  onChange={(e) => setQuoteForm({ ...quoteForm, customerId: e.target.value })}
                >
                  <option value="">اختر عميلًا</option>
                  {(overview?.customers ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="عنوان العرض">
                <input
                  required
                  value={quoteForm.title}
                  onChange={(e) => setQuoteForm({ ...quoteForm, title: e.target.value })}
                />
              </Field>
              <Field label="تاريخ العرض">
                <input
                  type="date"
                  required
                  value={quoteForm.issueDate}
                  onChange={(e) => setQuoteForm({ ...quoteForm, issueDate: e.target.value })}
                />
              </Field>
              <Field label="صالح حتى">
                <input
                  type="date"
                  required
                  value={quoteForm.validUntil}
                  onChange={(e) => setQuoteForm({ ...quoteForm, validUntil: e.target.value })}
                />
              </Field>
            </div>
            <h3 className="fin-subheading">بنود العرض</h3>
            {(overview?.catalog ?? []).some((item) => item.active) && (
              <div className="fin-catalog-insert">
                <Field label="إدراج بند محفوظ">
                  <select value={catalogPick} onChange={(e) => setCatalogPick(e.target.value)}>
                    <option value="">اختر بندًا</option>
                    {(overview?.catalog ?? [])
                      .filter((item) => item.active)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.description} · {money(Math.round(Number(item.unitPrice) * 100))}
                        </option>
                      ))}
                  </select>
                </Field>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!catalogPick}
                  onClick={insertCatalogItem}
                >
                  <Plus size={16} />
                  إدراج
                </button>
              </div>
            )}
            {quoteForm.lines.map((line, index) => (
              <div className="fin-line" key={index}>
                <Field label="وصف البند">
                  <input
                    required
                    value={line.description}
                    onChange={(e) =>
                      setQuoteForm({
                        ...quoteForm,
                        lines: quoteForm.lines.map((x, n) =>
                          n === index ? { ...x, description: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field label="الكمية">
                  <input
                    required
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) =>
                      setQuoteForm({
                        ...quoteForm,
                        lines: quoteForm.lines.map((x, n) =>
                          n === index ? { ...x, quantity: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field label="سعر الوحدة (ر.س)">
                  <input
                    required
                    inputMode="decimal"
                    value={line.unitPrice}
                    onChange={(e) =>
                      setQuoteForm({
                        ...quoteForm,
                        lines: quoteForm.lines.map((x, n) =>
                          n === index ? { ...x, unitPrice: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field label="الضريبة">
                  <select
                    value={line.taxRateBps}
                    disabled={zeroLines(quoteType)}
                    onChange={(e) =>
                      setQuoteForm({
                        ...quoteForm,
                        lines: quoteForm.lines.map((x, n) =>
                          n === index
                            ? {
                                ...x,
                                taxRateBps: Number(e.target.value),
                                taxReason: Number(e.target.value) === 0 ? x.taxReason : '',
                              }
                            : x,
                        ),
                      })
                    }
                  >
                    <option value={1500}>15٪</option>
                    <option value={0}>بدون ضريبة</option>
                  </select>
                </Field>
                {line.taxRateBps === 0 && (
                  <Field label="سبب عدم احتساب الضريبة">
                    <input
                      required
                      value={line.taxReason}
                      onChange={(e) =>
                        setQuoteForm({
                          ...quoteForm,
                          lines: quoteForm.lines.map((x, n) =>
                            n === index ? { ...x, taxReason: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                )}
                <button
                  type="button"
                  className="icon-button fin-remove"
                  aria-label="حذف البند"
                  disabled={quoteForm.lines.length === 1}
                  onClick={() =>
                    setQuoteForm({
                      ...quoteForm,
                      lines: quoteForm.lines.filter((_, n) => n !== index),
                    })
                  }
                >
                  <X size={17} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setQuoteForm({
                  ...quoteForm,
                  lines: [...quoteForm.lines, blankLine(quoteType)],
                })
              }
            >
              <Plus size={16} />
              إضافة بند
            </button>
            <div className="fin-quote-totals">
              <span>
                الإجمالي قبل الضريبة <b>{money(totals.sub)}</b>
              </span>
              <span>
                الضريبة <b>{money(totals.tax)}</b>
              </span>
              <strong>
                الإجمالي <b>{money(totals.sub + totals.tax)}</b>
              </strong>
            </div>
            <Field label="ملاحظات">
              <textarea
                rows={3}
                value={quoteForm.notes}
                onChange={(e) => setQuoteForm({ ...quoteForm, notes: e.target.value })}
              />
            </Field>
            {loadError && <Alert>{loadError}</Alert>}
            <div className="fin-form-actions">
              <button type="button" className="button secondary" onClick={closeDialog}>
                إلغاء
              </button>
              <button className="button primary" disabled={busy === 'quote'}>
                {busy === 'quote' ? 'جارٍ الحفظ…' : 'حفظ عرض السعر'}
              </button>
            </div>
          </form>
        </FormPage>
      )}
      {dialog === 'convert' && selectedQuote && (
        <FormPage title="تحويل عرض السعر إلى مسودة فاتورة" close={closeDialog}>
          <form className="fin-dialog-form" onSubmit={convertQuote}>
            <p className="fin-convert-note">
              سيُنشأ سجل فاتورة بحالة <b>مسودة</b> مرتبط بالعرض {selectedQuote.number}. لن تُصدر
              الفاتورة أو تُرسل إلى وافق في هذه الخطوة.{' '}
              {blockedConversion(selectedQuote)
                ? 'هذا العميل فرد؛ اختر «فاتورة ضريبية مبسطة (B2C)» في عرض السعر قبل تحويله.'
                : (selectedQuote.documentType ?? 'standard') !== 'standard'
                  ? 'يمكن تجهيز المسودة، لكن إرسال هذا النوع إلى وافق غير مدعوم في الربط الحالي.'
                  : ''}
            </p>
            <div className="fin-grid">
              <Field label="نوع الفاتورة">
                <input
                  readOnly
                  value={documentTypeText[selectedQuote.documentType ?? 'standard'].label}
                />
                <small>يُحدد النوع في عرض السعر؛ عدّل العرض لتغييره.</small>
              </Field>
              <Field label="رقم أمر الشراء (اختياري)">
                <input value={purchaseOrder} onChange={(e) => setPurchaseOrder(e.target.value)} />
              </Field>
              <Field label="تاريخ الإصدار">
                <input
                  type="date"
                  required
                  value={convertDates.issueDate}
                  onChange={(e) => setConvertDates({ ...convertDates, issueDate: e.target.value })}
                />
              </Field>
              <Field label="تاريخ الاستحقاق">
                <input
                  type="date"
                  required
                  value={convertDates.dueDate}
                  onChange={(e) => setConvertDates({ ...convertDates, dueDate: e.target.value })}
                />
              </Field>
            </div>
            {loadError && <Alert>{loadError}</Alert>}
            <div className="fin-form-actions">
              <button type="button" className="button secondary" onClick={closeDialog}>
                رجوع
              </button>
              <button
                className="button primary"
                disabled={busy === 'convert' || blockedConversion(selectedQuote)}
              >
                {busy === 'convert'
                  ? 'جارٍ التحويل…'
                  : blockedConversion(selectedQuote)
                    ? 'التحويل غير متاح لهذا العميل'
                    : 'إنشاء مسودة الفاتورة'}
              </button>
            </div>
          </form>
        </FormPage>
      )}
      {preview && (
        <Modal title={`معاينة عرض السعر · ${preview.number}`} close={() => setPreview(null)} wide>
          <div className="fin-preview-actions">
            <button className="button secondary" onClick={() => window.print()}>
              <Printer size={16} />
              طباعة أو حفظ PDF
            </button>
          </div>
          <article className="fin-document-paper fin-quote-paper" dir="rtl" lang="ar">
            <DocumentHeader
              seller={preview.seller}
              kind="quote"
              title="عرض سعر"
              number={preview.number}
              status="مسودة عرض سعر"
            />
            <div className="fin-document-rule" />
            <div className="fin-document-cards">
              <CustomerDetails customer={preview.customer} />
              <DocumentDetails
                kind="quote"
                number={preview.number}
                issueDate={preview.issueDate}
                validUntil={preview.validUntil}
                status="مسودة عرض سعر"
                documentType={preview.documentType ?? 'standard'}
              />
            </div>
            <LineItemsTable lines={preview.lines} noVat={preview.documentType === 'out_of_scope'} />
            <div className="fin-document-ending">
              <PaperTotals
                subtotal={preview.subtotalHalalas}
                tax={preview.taxHalalas}
                total={preview.totalHalalas}
                totalLabel="الإجمالي / Total"
                noVat={preview.documentType === 'out_of_scope'}
              />
              <BankAccountDetails seller={preview.seller} />
              {preview.notes && <NotesBox notes={preview.notes} />}
              <PaperFooter>
                عرض سعر محفوظ كمسودة. لم يُرسل إلى العميل، ولا يمثل فاتورة ضريبية.
              </PaperFooter>
            </div>
          </article>
        </Modal>
      )}
      {finalInvoice && (
        <Modal
          title={`${['cleared', 'reported'].includes(finalInvoice.status) && finalInvoice.qrCode ? 'فاتورة سبق' : 'معاينة مسودة فاتورة'} · ${finalInvoice.number}`}
          close={() => setFinalInvoice(null)}
          wide
        >
          <div className="fin-preview-actions">
            {['cleared', 'reported'].includes(finalInvoice.status) && finalInvoice.qrCode ? (
              <button className="button primary" onClick={() => window.print()}>
                <Printer size={16} />
                طباعة فاتورة سبق
              </button>
            ) : (
              <Status text="معاينة داخلية غير صالحة للإصدار أو الطباعة" kind="waiting" />
            )}
            {finalInvoice.canDownloadXml && (
              <a
                className="button secondary"
                href={`/api/finance/invoices/${encodeURIComponent(finalInvoice.id)}/xml`}
                download={`${finalInvoice.number}.xml`}
              >
                تنزيل XML
              </a>
            )}
            {finalInvoice.canDownload && (
              <button className="button secondary" onClick={() => void download(finalInvoice)}>
                النسخة الأصلية من وافق
              </button>
            )}
          </div>
          <article className="fin-document-paper fin-invoice-paper" dir="rtl" lang="ar">
            <DocumentHeader
              seller={finalInvoice.seller}
              kind="invoice"
              title={invoiceTitle(finalInvoice.documentType, finalInvoice.invoiceType).ar}
              subtitle={invoiceTitle(finalInvoice.documentType, finalInvoice.invoiceType).en}
              number={finalInvoice.number}
              status={statusText[finalInvoice.status]}
            />
            <div className="fin-document-rule" />
            {['cleared', 'reported'].includes(finalInvoice.status) ? (
              <div className="fin-final-banner">
                <Check size={17} />
                {statusText[finalInvoice.status]} · حالة مصدرها وافق والهيئة
              </div>
            ) : (
              <div className="fin-draft-watermark">مسودة فاتورة · للمعاينة الداخلية فقط</div>
            )}
            <div className="fin-document-cards">
              <CustomerDetails customer={finalInvoice.customer} />
              <DocumentDetails
                kind="invoice"
                number={finalInvoice.number}
                issueDate={finalInvoice.issueDate}
                validUntil={finalInvoice.dueDate}
                validUntilLabel="تاريخ الاستحقاق / Due Date"
                status={statusText[finalInvoice.status]}
                purchaseOrder={finalInvoice.purchaseOrder}
                documentType={finalInvoice.documentType}
              />
            </div>
            <h2 className="fin-document-title">{finalInvoice.title}</h2>
            <LineItemsTable
              lines={finalInvoice.lines}
              noVat={finalInvoice.documentType === 'out_of_scope'}
            />
            <div className="fin-document-ending">
              <PaperTotals
                subtotal={finalInvoice.subtotalHalalas}
                tax={finalInvoice.taxHalalas}
                total={finalInvoice.totalHalalas}
                totalLabel="الإجمالي المستحق / Total Due"
                noVat={finalInvoice.documentType === 'out_of_scope'}
                aside={
                  ['cleared', 'reported'].includes(finalInvoice.status) && finalInvoice.qrCode ? (
                    <div className="fin-qr-wrap" dir="rtl">
                      <img
                        className="fin-qr"
                        src={`/api/finance/invoices/${encodeURIComponent(finalInvoice.id)}/qr`}
                        alt="رمز التحقق من الفاتورة"
                      />
                      <b>فاتورة ضريبية / Tax Invoice</b>
                      <small>رمز التحقق صادر من وافق بعد قبول الفاتورة.</small>
                    </div>
                  ) : null
                }
              />
              <BankAccountDetails seller={finalInvoice.seller} />
              {finalInvoice.notes && <NotesBox notes={finalInvoice.notes} />}
              <PaperFooter>
                {finalInvoice.documentType === 'out_of_scope'
                  ? 'مستند غير ضريبي: المبلغ خارج نطاق ضريبة القيمة المضافة.'
                  : ['cleared', 'reported'].includes(finalInvoice.status) && finalInvoice.qrCode
                    ? 'فاتورة سبق متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك.'
                    : 'هذه معاينة داخلية للمسودة وليست فاتورة صادرة أو مستندًا ضريبيًا.'}
              </PaperFooter>
            </div>
          </article>
        </Modal>
      )}
    </section>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="fin-empty">
      <span>
        <FileText size={20} />
      </span>
      <b>{title}</b>
      <p>{detail}</p>
    </div>
  );
}

function DocumentHeader({
  seller,
  kind,
  title,
  number,
  status,
  subtitle,
}: {
  seller: FinanceSeller;
  kind: 'quote' | 'invoice';
  title: string;
  number: string;
  status: string;
  subtitle?: string;
}) {
  return (
    <header className="fin-doc-head">
      <div className="fin-doc-brand">
        <img src="/brand/sabq-logo.svg" alt="سبق" />
        <div>
          <b>{seller.name || 'سبق'}</b>
          {seller.address.line || seller.address.city ? (
            <span>{[seller.address.line, seller.address.city].filter(Boolean).join('، ')}</span>
          ) : null}
          {seller.vatNumber && <span>الرقم الضريبي / VAT No: {seller.vatNumber}</span>}
          {seller.commercialRegistration && (
            <span>السجل التجاري / CR: {seller.commercialRegistration}</span>
          )}
        </div>
      </div>
      <aside className="fin-doc-heading">
        <h1>{title}</h1>
        <span>{subtitle ?? (kind === 'quote' ? 'Price Quotation' : 'Tax Invoice')}</span>
        <Status
          text={status}
          kind={kind === 'quote' || status.includes('مسودة') ? 'waiting' : 'good'}
        />
        <b className="fin-doc-number" dir="ltr">
          {number}
        </b>
      </aside>
    </header>
  );
}

function CustomerDetails({ customer }: { customer: FinanceCustomerInput }) {
  return (
    <section className="fin-detail-card">
      <header>
        <b>بيانات العميل</b>
        <span lang="en">Customer Details</span>
      </header>
      <dl>
        <div>
          <dt>الاسم / Name</dt>
          <dd>{customer.name || '—'}</dd>
        </div>
        {customer.nameEnglish && (
          <div>
            <dt>الاسم بالإنجليزية / English Name</dt>
            <dd dir="ltr">{customer.nameEnglish}</dd>
          </div>
        )}
        <div>
          <dt>العنوان / Address</dt>
          <dd>
            {[
              customer.address.line,
              customer.address.district,
              customer.address.city,
              customer.address.postalCode,
            ]
              .filter(Boolean)
              .join('، ') || '—'}
          </dd>
        </div>
        {customer.vatNumber && (
          <div>
            <dt>الرقم الضريبي / VAT No</dt>
            <dd dir="ltr">{customer.vatNumber}</dd>
          </div>
        )}
        {customer.commercialRegistration && (
          <div>
            <dt>السجل التجاري / CR</dt>
            <dd dir="ltr">{customer.commercialRegistration}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function DocumentDetails({
  kind,
  number,
  issueDate,
  validUntil,
  validUntilLabel,
  status,
  purchaseOrder,
  documentType,
}: {
  kind: 'quote' | 'invoice';
  number: string;
  issueDate: string;
  validUntil?: string;
  validUntilLabel?: string;
  status: string;
  purchaseOrder?: string;
  documentType?: FinanceDocumentType;
}) {
  return (
    <section className="fin-detail-card fin-detail-rows">
      <header>
        <b>{kind === 'quote' ? 'بيانات عرض السعر' : 'بيانات الفاتورة'}</b>
        <span lang="en">{kind === 'quote' ? 'Quotation Details' : 'Invoice Details'}</span>
      </header>
      <dl>
        <div>
          <dt>{kind === 'quote' ? 'رقم العرض / Quotation No' : 'رقم الفاتورة / Invoice No'}</dt>
          <dd dir="ltr">{number}</dd>
        </div>
        <div>
          <dt>تاريخ الإصدار / Issue Date</dt>
          <dd dir="ltr">{issueDate}</dd>
        </div>
        {validUntil && (
          <div>
            <dt>{validUntilLabel ?? 'صالح حتى / Valid Until'}</dt>
            <dd dir="ltr">{validUntil}</dd>
          </div>
        )}
        {documentType && (
          <div>
            <dt>نوع الفاتورة / Invoice Type</dt>
            <dd>{documentTypeShort[documentType]}</dd>
          </div>
        )}
        {purchaseOrder && (
          <div>
            <dt>أمر الشراء / Purchase Order</dt>
            <dd dir="ltr">{purchaseOrder}</dd>
          </div>
        )}
        <div>
          <dt>الحالة / Status</dt>
          <dd>
            <Status text={status} kind={status.includes('مسودة') ? 'waiting' : 'good'} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

function LineItemsTable({ lines, noVat = false }: { lines: FinanceLine[]; noVat?: boolean }) {
  const percent = (bps: number) =>
    new Intl.NumberFormat('en-SA', { maximumFractionDigits: 2 }).format(bps / 100);
  // Table cells show plain amounts like the legacy layout; currency appears in the totals.
  const amount = (halalas: number) =>
    new Intl.NumberFormat('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      halalas / 100,
    );
  return (
    <div className="fin-paper-table-wrap">
      <table className="fin-paper-table">
        <thead>
          <tr>
            <th scope="col" className="fin-paper-number">
              #
            </th>
            <th scope="col" className="fin-paper-description">
              الوصف / Description
            </th>
            <th scope="col">الكمية / Qty</th>
            <th scope="col">السعر / Unit Price</th>
            {!noVat && <th scope="col">الضريبة / VAT</th>}
            {!noVat && <th scope="col">مبلغ الضريبة / VAT Amt</th>}
            <th scope="col">الإجمالي / Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.description}-${index}`}>
              <td className="fin-paper-number" dir="ltr">
                {index + 1}
              </td>
              <td className="fin-paper-description">
                {line.description}
                {!noVat && line.taxRateBps === 0 && line.taxReason && (
                  <small className="fin-paper-reason">
                    سبب عدم احتساب الضريبة / VAT exemption reason: {line.taxReason}
                  </small>
                )}
              </td>
              <td dir="ltr">{line.quantity}</td>
              <td dir="ltr">{amount(Math.round(Number(line.unitPrice) * 100))}</td>
              {!noVat && <td dir="ltr">{percent(line.taxRateBps)}%</td>}
              {!noVat && <td dir="ltr">{amount(line.taxHalalas)}</td>}
              <td dir="ltr">{amount(line.totalHalalas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaperAmount({ halalas }: { halalas: number }) {
  const value = new Intl.NumberFormat('en-SA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(halalas / 100);
  return (
    <b dir="ltr" className="fin-paper-amount">
      <RiyalSign />
      {value}
    </b>
  );
}

function PaperTotals({
  subtotal,
  tax,
  total,
  totalLabel,
  aside,
  noVat = false,
}: {
  subtotal: number;
  tax: number;
  total: number;
  totalLabel: string;
  aside?: ReactNode;
  noVat?: boolean;
}) {
  return (
    <div className="fin-paper-summary" dir="ltr">
      <div className="fin-paper-summary-rows" dir="rtl">
        {!noVat && (
          <div>
            <span>المجموع الفرعي / Subtotal</span>
            <PaperAmount halalas={subtotal} />
          </div>
        )}
        {!noVat && (
          <div>
            <span>ضريبة القيمة المضافة / VAT</span>
            <PaperAmount halalas={tax} />
          </div>
        )}
        <div className="fin-paper-grand-total">
          <span>{totalLabel}</span>
          <PaperAmount halalas={total} />
        </div>
      </div>
      {aside}
    </div>
  );
}

function BankAccountDetails({ seller }: { seller: FinanceSeller }) {
  const bank = seller.bankAccount;
  if (!bank || !Object.values(bank).some((value) => value.trim())) return null;
  return (
    <section className="fin-bank-card">
      <header>
        <b>بيانات الحساب البنكي</b>
        <span lang="en">Bank Account Details</span>
      </header>
      <dl>
        {bank.beneficiaryName && (
          <div>
            <dt>اسم المستفيد / Beneficiary Name</dt>
            <dd>{bank.beneficiaryName}</dd>
          </div>
        )}
        {bank.bankName && (
          <div>
            <dt>البنك / Bank</dt>
            <dd>{bank.bankName}</dd>
          </div>
        )}
        {bank.accountNumber && (
          <div>
            <dt>رقم الحساب / Account No</dt>
            <dd dir="ltr">{bank.accountNumber}</dd>
          </div>
        )}
        {bank.iban && (
          <div>
            <dt>الآيبان / IBAN</dt>
            <dd dir="ltr">{bank.iban}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function NotesBox({ notes }: { notes: string }) {
  return (
    <section className="fin-notes-box">
      <b>ملاحظات / Notes</b>
      <p>{notes}</p>
    </section>
  );
}

function PaperFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="fin-paper-footer">
      <span>{children}</span>
      <span>
        أُنشئ هذا المستند إلكترونيًا |{' '}
        <span lang="en">This document was generated electronically</span>
      </span>
    </footer>
  );
}
