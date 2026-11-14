/** HTTP surface of the accounting ledger. Every route re-checks the granted finance account. */
import type { Express, Request } from 'express';
import type { FinanceInvoice } from '../../shared/finance.js';
import type {
  JournalTax,
  LedgerOverview,
  LedgerVendorInput,
  TaxCode,
  VoucherKind,
} from '../../shared/ledger.js';
import { todayInRiyadh, type AsyncDb } from '../database.js';
import { encryptSensitive } from '../administration/security.js';
import type { Actor } from '../administration/service.js';
import {
  newId,
  registerRoute,
  requireRecord,
  versionValue,
  type RequireActor,
} from '../administration/common.js';
import { fault } from '../administration/validation.js';
import {
  audited,
  dateValue,
  idempotent,
  now,
  optionalText,
  readInvoice,
  requireFinance,
  routeId,
  safeJson,
  text,
  validateVat,
  type FinanceAccessOptions,
  type InvoiceRow,
} from './routes.js';
import * as ledger from './ledger.js';
import { halalas, n, vatOf, type PostLine } from './ledger.js';

type Options = { db: AsyncDb; requireActor: RequireActor; access: FinanceAccessOptions };
const invoiceFromRow = (row: InvoiceRow) =>
  safeJson<FinanceInvoice>(row.invoice_ciphertext, `finance:invoice:${row.id}`);
const query = (req: Request, name: string): string | undefined => {
  const value = req.query[name];
  return typeof value === 'string' && value ? value : undefined;
};
const queryDate = (req: Request, name: string, fallback: string) => {
  const value = query(req, name);
  return value === undefined ? fallback : dateValue(value);
};
function taxValue(value: unknown): JournalTax | null {
  if (value === undefined || value === null) return null;
  const x = requireRecord(value);
  const side = x.side === 'sales' || x.side === 'purchases' ? x.side : null;
  const role = x.role === 'base' || x.role === 'output' || x.role === 'input' ? x.role : null;
  const valid =
    side === 'sales' ? ledger.isSalesCode(x.code) : side ? ledger.isPurchaseCode(x.code) : false;
  if (!side || !role || !valid)
    throw fault(400, 'INVALID_TAX_TAG', 'الرمز الضريبي للسطر غير صالح.');
  return { side, code: x.code as TaxCode, role };
}

export function registerLedger(app: Express, { db, requireActor, access }: Options) {
  const auth = async (req: Request): Promise<Actor> => {
    const actor = await requireActor(req);
    requireFinance(actor, access);
    return actor;
  };
  const ready = async (req: Request): Promise<Actor> => {
    const actor = await auth(req);
    if (!(await ledger.isInitialized(db, actor.id)))
      throw fault(409, 'LEDGER_NOT_INITIALIZED', 'هيّئ دليل الحسابات أولًا.');
    return actor;
  };
  const mutation = async (
    req: Request,
    actor: Actor,
    action: string,
    payload: unknown,
    work: (tx: AsyncDb) => Promise<string>,
  ): Promise<string> =>
    (
      await idempotent<{ id: string }>(
        db,
        actor,
        action,
        req.get('idempotency-key'),
        payload,
        async (tx) => {
          const id = await work(tx);
          return { marker: { type: action, id }, result: { id } };
        },
        async (_tx, marker) => ({ id: marker.id }),
      )
    ).id;
  const overview = async (actor: Actor): Promise<LedgerOverview> => {
    const initialized = await ledger.isInitialized(db, actor.id);
    const unposted = initialized
      ? (await ledger.invoiceStates(db, actor.id, invoiceFromRow)).filter(
          (item) => !item.voucher && item.status !== 'rejected',
        ).length
      : 0;
    return {
      initialized,
      settings: await ledger.ledgerSettings(db, actor.id),
      accounts: await ledger.listAccounts(db, actor.id),
      vendors: await ledger.listVendors(db, actor.id),
      locks: await ledger.locks(db, actor.id),
      dashboard: initialized ? await ledger.dashboard(db, actor.id, unposted) : null,
    };
  };
  const cashAccount = async (tx: AsyncDb, ownerId: string, value: unknown) => {
    const code = text(value, 20),
      row = (await ledger.accountRows(tx, ownerId)).get(code);
    if (!row || Number(row.is_cash) !== 1)
      throw fault(400, 'INVALID_CASH_ACCOUNT', 'اختر حساب صندوق أو بنك صالحًا.');
    return code;
  };

  registerRoute(app, 'get', '/api/finance/ledger', async (req, res) => {
    res.json(await overview(await auth(req)));
  });
  registerRoute(app, 'post', '/api/finance/ledger/setup', async (req, res) => {
    const actor = await auth(req);
    await mutation(req, actor, 'finance.ledger.setup', {}, async (tx) => {
      await ledger.setupLedger(tx, actor);
      return actor.id;
    });
    res.status(201).json(await overview(actor));
  });
  registerRoute(app, 'patch', '/api/finance/ledger/settings', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      version = versionValue(b.version);
    if (b.filingFrequency !== 'quarterly' && b.filingFrequency !== 'monthly')
      throw fault(400, 'INVALID_FILING_FREQUENCY', 'اختر دورية الإقرار: ربعي أو شهري.');
    const payload = {
      version,
      filingFrequency: b.filingFrequency,
      defaultRevenueAccount: text(b.defaultRevenueAccount, 20),
      defaultCashAccount: text(b.defaultCashAccount, 20),
      limit: halalas(b.vatCorrectionLimit),
    };
    await mutation(req, actor, 'finance.ledger.settings', payload, async (tx) => {
      const accounts = await ledger.accountRows(tx, actor.id);
      if (accounts.get(payload.defaultRevenueAccount)?.type !== 'revenue')
        throw fault(400, 'INVALID_REVENUE_ACCOUNT', 'اختر حساب إيراد صالحًا.');
      await cashAccount(tx, actor.id, payload.defaultCashAccount);
      const changed = await tx.execute(
        'UPDATE finance_ledger_settings SET version=version+1,filing_frequency=?,default_revenue_account=?,default_cash_account=?,vat_correction_limit=?,updated_at=? WHERE owner_id=? AND version=?',
        [
          payload.filingFrequency,
          payload.defaultRevenueAccount,
          payload.defaultCashAccount,
          payload.limit,
          now(),
          actor.id,
          version,
        ],
      );
      if (changed.rowCount !== 1)
        throw fault(409, 'VERSION_CONFLICT', 'تغيرت الإعدادات؛ حدّث الصفحة ثم أعد المحاولة.');
      await audited(tx, actor, 'finance_ledger', actor.id, 'settings_updated', version + 1);
      return actor.id;
    });
    res.json({ settings: await ledger.ledgerSettings(db, actor.id) });
  });

  // ------------------------------------------------------------ accounts
  registerRoute(app, 'post', '/api/finance/ledger/accounts', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body);
    const code = text(b.code, 10),
      name = text(b.name, 120),
      parentCode = text(b.parentCode, 10);
    if (!/^\d{3,8}$/.test(code))
      throw fault(400, 'INVALID_ACCOUNT_CODE', 'رمز الحساب أرقام فقط، من 3 إلى 8 خانات.');
    const defaultTaxCode = b.defaultTaxCode ?? null;
    if (defaultTaxCode !== null && !ledger.isPurchaseCode(defaultTaxCode))
      throw fault(400, 'INVALID_TAX_CODE', 'الرمز الضريبي الافتراضي غير صالح.');
    const payload = { code, name, parentCode, isCash: b.isCash === true, defaultTaxCode };
    await mutation(req, actor, 'finance.ledger.account.create', payload, async (tx) => {
      const accounts = await ledger.accountRows(tx, actor.id),
        parent = accounts.get(parentCode);
      if (accounts.has(code)) throw fault(409, 'ACCOUNT_EXISTS', 'رمز الحساب مستخدم من قبل.');
      if (!parent || Number(parent.postable) === 1)
        throw fault(400, 'INVALID_PARENT_ACCOUNT', 'اختر مجموعة رئيسية للحساب.');
      if (!code.startsWith(parent.code))
        throw fault(400, 'INVALID_ACCOUNT_CODE', `رمز الحساب يبدأ برمز مجموعته ${parent.code}.`);
      if (payload.isCash && parent.type !== 'asset')
        throw fault(400, 'INVALID_CASH_ACCOUNT', 'حساب النقد أو البنك يكون ضمن الأصول.');
      await tx.execute(
        'INSERT INTO finance_accounts(owner_id,code,name,type,normal_side,parent_code,postable,is_cash,default_tax_code,active,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,1,1,?,?)',
        [
          actor.id,
          code,
          name,
          parent.type,
          parent.normal_side,
          parent.code,
          payload.isCash ? 1 : 0,
          defaultTaxCode,
          now(),
          now(),
        ],
      );
      await audited(tx, actor, 'finance_account', code, 'created', 1);
      return code;
    });
    res.status(201).json({ accounts: await ledger.listAccounts(db, actor.id) });
  });
  registerRoute(app, 'patch', '/api/finance/ledger/accounts/:code', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      code = routeId(req.params.code);
    const payload = {
      version: versionValue(b.version),
      name: text(b.name, 120),
      active: b.active !== false,
    };
    await mutation(req, actor, `finance.ledger.account.update:${code}`, payload, async (tx) => {
      const row = (await ledger.accountRows(tx, actor.id)).get(code);
      if (!row) throw fault(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود.');
      if (!payload.active && row.system_key)
        throw fault(409, 'SYSTEM_ACCOUNT', 'حساب نظامي تعتمد عليه القيود الآلية؛ لا يُوقف.');
      const changed = await tx.execute(
        'UPDATE finance_accounts SET name=?,active=?,version=version+1,updated_at=? WHERE owner_id=? AND code=? AND version=?',
        [payload.name, payload.active ? 1 : 0, now(), actor.id, code, payload.version],
      );
      if (changed.rowCount !== 1)
        throw fault(409, 'VERSION_CONFLICT', 'تغير الحساب؛ حدّث الصفحة ثم أعد المحاولة.');
      await audited(tx, actor, 'finance_account', code, 'updated', payload.version + 1);
      return code;
    });
    res.json({ accounts: await ledger.listAccounts(db, actor.id) });
  });

  // ------------------------------------------------------------ vendors
  const vendorInput = (value: unknown): LedgerVendorInput => {
    const x = requireRecord(value),
      resident = x.resident !== false;
    return {
      name: text(x.name, 200),
      vatNumber: resident ? validateVat(x.vatNumber) : optionalText(x.vatNumber, 30),
      country: optionalText(x.country, 60) || (resident ? 'السعودية' : ''),
      resident,
      notes: optionalText(x.notes, 500),
    };
  };
  registerRoute(app, 'post', '/api/finance/ledger/vendors', async (req, res) => {
    const actor = await ready(req),
      input = vendorInput(req.body);
    const id = await mutation(req, actor, 'finance.ledger.vendor.create', input, async (tx) => {
      const vendorId = newId();
      await tx.execute(
        'INSERT INTO finance_vendors(id,owner_id,version,vendor_ciphertext,resident,active,created_at,updated_at) VALUES(?,?,1,?,?,1,?,?)',
        [
          vendorId,
          actor.id,
          encryptSensitive(JSON.stringify(input), `finance:vendor:${vendorId}`),
          input.resident ? 1 : 0,
          now(),
          now(),
        ],
      );
      await audited(tx, actor, 'finance_vendor', vendorId, 'created', 1);
      return vendorId;
    });
    res.status(201).json({ vendor: await ledger.readVendor(db, actor.id, id) });
  });
  registerRoute(app, 'patch', '/api/finance/ledger/vendors/:id', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      id = routeId(req.params.id);
    const payload = {
      version: versionValue(b.version),
      input: vendorInput(b),
      active: b.active !== false,
    };
    await mutation(req, actor, `finance.ledger.vendor.update:${id}`, payload, async (tx) => {
      const changed = await tx.execute(
        'UPDATE finance_vendors SET version=version+1,vendor_ciphertext=?,resident=?,active=?,updated_at=? WHERE owner_id=? AND id=? AND version=?',
        [
          encryptSensitive(JSON.stringify(payload.input), `finance:vendor:${id}`),
          payload.input.resident ? 1 : 0,
          payload.active ? 1 : 0,
          now(),
          actor.id,
          id,
          payload.version,
        ],
      );
      if (changed.rowCount !== 1)
        throw fault(409, 'VERSION_CONFLICT', 'تغير المورد أو لم يعد موجودًا؛ حدّث الصفحة.');
      await audited(tx, actor, 'finance_vendor', id, 'updated', payload.version + 1);
      return id;
    });
    res.json({ vendor: await ledger.readVendor(db, actor.id, id) });
  });

  // ------------------------------------------------------------ journal
  registerRoute(app, 'get', '/api/finance/ledger/entries', async (req, res) => {
    const actor = await ready(req);
    const from = query(req, 'from'),
      to = query(req, 'to');
    res.json({
      entries: await ledger.listEntries(db, actor.id, {
        from: from && dateValue(from),
        to: to && dateValue(to),
        account: query(req, 'account'),
      }),
    });
  });
  registerRoute(app, 'post', '/api/finance/ledger/entries', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body);
    if (!Array.isArray(b.lines) || b.lines.length < 2 || b.lines.length > 200)
      throw fault(400, 'ENTRY_LINES_REQUIRED', 'القيد يحتاج طرفين على الأقل.');
    const kind = b.kind === 'opening' ? ('opening' as const) : ('manual' as const);
    const payload = {
      date: dateValue(b.date),
      description: text(b.description, 500),
      kind,
      lines: b.lines.map((raw): PostLine => {
        const x = requireRecord(raw);
        return {
          accountCode: text(x.accountCode, 20),
          debit: halalas(x.debit === '' || x.debit === undefined ? '0' : x.debit),
          credit: halalas(x.credit === '' || x.credit === undefined ? '0' : x.credit),
          memo: optionalText(x.memo, 300),
          tax: taxValue(x.tax),
        };
      }),
    };
    const id = await mutation(req, actor, 'finance.ledger.entry.create', payload, async (tx) => {
      const accounts = await ledger.accountRows(tx, actor.id);
      for (const line of payload.lines) {
        const key = accounts.get(line.accountCode)?.system_key;
        // Untagged VAT movements would silently break the return; force an explicit tag.
        if ((key === 'vat_input' || key === 'vat_output') && !line.tax)
          throw fault(
            400,
            'VAT_LINE_TAX_REQUIRED',
            'السطر على حساب ضريبة القيمة المضافة يحتاج رمزًا ضريبيًا حتى يظهر في الإقرار.',
          );
        if (key === 'vat_settlement')
          throw fault(400, 'SYSTEM_ACCOUNT', 'حساب تسوية الضريبة يتحرك بإقفال الإقرار وسداده فقط.');
      }
      return (await ledger.postEntry(tx, actor, { ...payload, kind: payload.kind })).id;
    });
    res.status(201).json({ entry: await ledger.readEntry(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/entries/:id/reverse', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      id = routeId(req.params.id);
    const payload = { date: dateValue(b.date), reason: text(b.reason, 300) };
    const reversal = await mutation(
      req,
      actor,
      `finance.ledger.entry.reverse:${id}`,
      payload,
      async (tx) => {
        const entry = await ledger.readEntry(tx, actor.id, id);
        if (entry.kind !== 'manual' && entry.kind !== 'opening')
          throw fault(
            409,
            'ENTRY_NOT_REVERSIBLE',
            'هذا قيد آلي؛ اعكس مستنده الأصلي من صفحته حتى تبقى الأرصدة متطابقة.',
          );
        return (await ledger.reverseEntry(tx, actor, id, payload.date, payload.reason)).id;
      },
    );
    res.status(201).json({ entry: await ledger.readEntry(db, actor.id, reversal) });
  });

  // ------------------------------------------------------------ documents
  registerRoute(app, 'get', '/api/finance/ledger/vouchers', async (req, res) => {
    const actor = await ready(req),
      kind = query(req, 'kind');
    const kinds = kind
      ? (kind
          .split(',')
          .filter((item) =>
            ['invoice', 'credit_note', 'receipt', 'revenue', 'expense', 'payment'].includes(item),
          ) as VoucherKind[])
      : undefined;
    res.json({ vouchers: await ledger.listVouchers(db, actor.id, kinds) });
  });
  registerRoute(app, 'get', '/api/finance/ledger/invoices', async (req, res) => {
    const actor = await ready(req);
    res.json({ invoices: await ledger.invoiceStates(db, actor.id, invoiceFromRow) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/invoices/:id/post', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      invoiceId = routeId(req.params.id);
    const payload = {
      revenueAccountCode: text(b.revenueAccountCode, 20),
      zeroLinesTaxCode: b.zeroLinesTaxCode ?? null,
    };
    if (payload.zeroLinesTaxCode !== null && !ledger.isSalesCode(payload.zeroLinesTaxCode))
      throw fault(400, 'INVALID_TAX_CODE', 'الرمز الضريبي غير صالح.');
    const id = await mutation(
      req,
      actor,
      `finance.ledger.invoice.post:${invoiceId}`,
      payload,
      async (tx) =>
        ledger.postInvoice(
          tx,
          actor,
          await readInvoice(tx, actor.id, invoiceId),
          payload.revenueAccountCode,
          (payload.zeroLinesTaxCode as TaxCode | null) ?? undefined,
        ),
    );
    res.status(201).json({ voucher: await ledger.readVoucher(db, actor.id, id) });
  });
  /** The posted ledger document of an invoice; receipts and credit notes attach to it. */
  const postedInvoice = async (tx: AsyncDb, ownerId: string, invoiceId: string) => {
    const row = (
      await tx.read<{ id: string }>(
        "SELECT id FROM finance_vouchers WHERE owner_id=? AND kind='invoice' AND related_id=? AND status='posted'",
        [ownerId, invoiceId],
      )
    )[0];
    if (!row) throw fault(409, 'INVOICE_NOT_POSTED', 'رحّل الفاتورة إلى الدفاتر أولًا.');
    return row.id;
  };
  registerRoute(app, 'post', '/api/finance/ledger/invoices/:id/receipts', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      invoiceId = routeId(req.params.id);
    const payload = {
      date: dateValue(b.date),
      amount: halalas(b.amount),
      cash: text(b.cashAccountCode, 20),
      reference: optionalText(b.reference, 120),
    };
    const id = await mutation(
      req,
      actor,
      `finance.ledger.invoice.receipt:${invoiceId}`,
      payload,
      async (tx) => {
        const source = await ledger.readVoucher(
          tx,
          actor.id,
          await postedInvoice(tx, actor.id, invoiceId),
        );
        if (payload.amount <= 0 || payload.amount > source.outstandingHalalas)
          throw fault(400, 'RECEIPT_EXCEEDS_BALANCE', 'المبلغ يتجاوز المتبقي على الفاتورة.');
        if (payload.date < source.date)
          throw fault(400, 'INVALID_DATE_RANGE', 'تاريخ التحصيل لا يسبق تاريخ الفاتورة.');
        const cash = await cashAccount(tx, actor.id, payload.cash);
        return ledger.createVoucher(tx, actor, {
          kind: 'receipt',
          date: payload.date,
          cashAccountCode: cash,
          relatedId: source.id,
          net: payload.amount,
          vat: 0,
          total: payload.amount,
          details: {
            description: `تحصيل من ${source.partyName} عن ${source.reference}`,
            reference: payload.reference,
            partyName: source.partyName,
          },
          lines: [
            { accountCode: cash, debit: payload.amount, credit: 0 },
            {
              accountCode: await ledger.systemAccount(tx, actor.id, 'receivable'),
              debit: 0,
              credit: payload.amount,
            },
          ],
        });
      },
    );
    res.status(201).json({ voucher: await ledger.readVoucher(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/invoices/:id/credit-notes', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      invoiceId = routeId(req.params.id);
    const payload = {
      date: dateValue(b.date),
      net: halalas(b.net),
      portion: b.portion === 'zero' ? ('zero' as const) : ('taxable' as const),
      reason: text(b.reason, 300),
    };
    const id = await mutation(
      req,
      actor,
      `finance.ledger.invoice.credit:${invoiceId}`,
      payload,
      async (tx) => {
        const sourceId = await postedInvoice(tx, actor.id, invoiceId),
          sourceRow = await ledger.voucherRow(tx, actor.id, sourceId),
          details = ledger.voucherDetails(sourceRow);
        const portion =
          payload.portion === 'taxable' && !(details.taxableNet ?? 0) ? 'zero' : payload.portion;
        const original = portion === 'taxable' ? (details.taxableNet ?? 0) : (details.zeroNet ?? 0);
        if (payload.date < sourceRow.doc_date)
          throw fault(400, 'INVALID_DATE_RANGE', 'تاريخ الإشعار لا يسبق تاريخ الفاتورة.');
        const earlier = await tx.read<{
          id: string;
          details_ciphertext: string;
          net: unknown;
          vat: unknown;
        }>(
          "SELECT id,details_ciphertext,net,vat FROM finance_vouchers WHERE owner_id=? AND kind='credit_note' AND related_id=? AND status='posted'",
          [actor.id, sourceId],
        );
        let creditedNet = 0,
          creditedVat = 0;
        for (const row of earlier)
          if ((ledger.voucherDetails(row).portion ?? 'taxable') === portion) {
            creditedNet += n(row.net);
            creditedVat += n(row.vat);
          }
        if (payload.net <= 0 || payload.net > original - creditedNet)
          throw fault(
            400,
            'CREDIT_EXCEEDS_INVOICE',
            'مبلغ الإشعار الدائن يتجاوز المتبقي من قيمة الفاتورة قبل الضريبة.',
          );
        const code: TaxCode = portion === 'taxable' ? 'S' : (details.zeroCode ?? 'O');
        const fullVat = n(sourceRow.vat);
        // The last credit note takes whatever VAT is left so the invoice's VAT is never exceeded.
        const vat =
          portion !== 'taxable'
            ? 0
            : payload.net === original - creditedNet
              ? fullVat - creditedVat
              : Math.min(vatOf(payload.net), fullVat - creditedVat);
        const lines: PostLine[] = [
          {
            accountCode: await ledger.systemAccount(tx, actor.id, 'sales_returns'),
            debit: payload.net,
            credit: 0,
            tax: { side: 'sales', code, role: 'base' },
          },
          {
            accountCode: await ledger.systemAccount(tx, actor.id, 'vat_output'),
            debit: vat,
            credit: 0,
            tax: { side: 'sales', code: 'S', role: 'output' },
          },
          {
            accountCode: await ledger.systemAccount(tx, actor.id, 'receivable'),
            debit: 0,
            credit: payload.net + vat,
          },
        ];
        return ledger.createVoucher(tx, actor, {
          kind: 'credit_note',
          date: payload.date,
          relatedId: sourceId,
          taxCode: code,
          net: payload.net,
          vat,
          total: payload.net + vat,
          details: {
            description: `إشعار دائن على ${details.reference}: ${payload.reason}`,
            reference: details.reference,
            partyName: details.partyName,
            portion,
          },
          lines,
        });
      },
    );
    res.status(201).json({ voucher: await ledger.readVoucher(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/revenues', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body);
    if (!ledger.isSalesCode(b.taxCode))
      throw fault(400, 'INVALID_TAX_CODE', 'اختر المعالجة الضريبية للإيراد.');
    const payload = {
      date: dateValue(b.date),
      description: text(b.description, 300),
      accountCode: text(b.accountCode, 20),
      taxCode: b.taxCode,
      net: halalas(b.net),
      cash: text(b.cashAccountCode, 20),
      customerName: optionalText(b.customerName, 200),
      reference: optionalText(b.reference, 120),
    };
    if (payload.taxCode === 'S' && !payload.reference)
      throw fault(
        400,
        'TAX_INVOICE_REFERENCE_REQUIRED',
        'الإيراد الخاضع للضريبة يحتاج رقم الفاتورة الضريبية الصادرة عنه.',
      );
    const id = await mutation(req, actor, 'finance.ledger.revenue.create', payload, async (tx) => {
      const row = (await ledger.accountRows(tx, actor.id)).get(payload.accountCode);
      if (!row || row.type !== 'revenue' || row.system_key)
        throw fault(400, 'INVALID_REVENUE_ACCOUNT', 'اختر حساب إيراد صالحًا.');
      const cash = await cashAccount(tx, actor.id, payload.cash),
        vat = payload.taxCode === 'S' ? vatOf(payload.net) : 0;
      return ledger.createVoucher(tx, actor, {
        kind: 'revenue',
        date: payload.date,
        accountCode: payload.accountCode,
        cashAccountCode: cash,
        taxCode: payload.taxCode,
        net: payload.net,
        vat,
        total: payload.net + vat,
        details: {
          description: payload.description,
          reference: payload.reference,
          partyName: payload.customerName,
        },
        lines: [
          { accountCode: cash, debit: payload.net + vat, credit: 0 },
          {
            accountCode: payload.accountCode,
            debit: 0,
            credit: payload.net,
            tax: { side: 'sales', code: payload.taxCode, role: 'base' },
          },
          {
            accountCode: await ledger.systemAccount(tx, actor.id, 'vat_output'),
            debit: 0,
            credit: vat,
            tax: { side: 'sales', code: 'S', role: 'output' },
          },
        ],
      });
    });
    res.status(201).json({ voucher: await ledger.readVoucher(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/expenses', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body);
    if (!ledger.isPurchaseCode(b.taxCode))
      throw fault(400, 'INVALID_TAX_CODE', 'اختر المعالجة الضريبية للمصروف.');
    const code: TaxCode = b.taxCode;
    const payload = {
      date: dateValue(b.date),
      description: text(b.description, 300),
      accountCode: text(b.accountCode, 20),
      taxCode: code,
      net: halalas(b.net),
      vat: b.vat === undefined || b.vat === '' ? null : halalas(b.vat),
      cash: optionalText(b.cashAccountCode, 20),
      vendorId: optionalText(b.vendorId, 80),
      reference: optionalText(b.reference, 120),
      dueDate: b.dueDate ? dateValue(b.dueDate) : '',
    };
    const id = await mutation(req, actor, 'finance.ledger.expense.create', payload, async (tx) => {
      const row = (await ledger.accountRows(tx, actor.id)).get(payload.accountCode);
      if (
        !row ||
        (row.type !== 'expense' && row.type !== 'asset') ||
        Number(row.is_cash) === 1 ||
        (row.system_key && row.system_key !== 'vat_adjustments')
      )
        throw fault(400, 'INVALID_EXPENSE_ACCOUNT', 'اختر حساب مصروف أو أصل صالحًا.');
      const party = payload.vendorId
        ? await ledger.readVendor(tx, actor.id, payload.vendorId)
        : null;
      if (payload.net <= 0) throw fault(400, 'INVALID_AMOUNT', 'المبلغ يجب أن يكون أكبر من صفر.');
      const computed = vatOf(payload.net);
      let vat = 0;
      if (code === 'S' || code === 'ND') {
        vat = payload.vat ?? computed;
        // Supplier invoices round per line; accept a small difference, reject a different rate.
        if (Math.abs(vat - computed) > 50)
          throw fault(
            400,
            'VAT_AMOUNT_MISMATCH',
            'مبلغ الضريبة لا يساوي 15٪ من الصافي؛ قسّم الفاتورة إن كان فيها بنود بمعالجات مختلفة.',
          );
        if (code === 'S' && !payload.reference)
          throw fault(
            400,
            'TAX_INVOICE_REFERENCE_REQUIRED',
            'خصم ضريبة المدخلات يحتاج رقم الفاتورة الضريبية للمورد.',
          );
      } else if (code === 'RC') vat = computed;
      else if (code === 'IMP') {
        if (!payload.vat)
          throw fault(400, 'IMPORT_VAT_REQUIRED', 'أدخل مبلغ الضريبة المسدد في البيان الجمركي.');
        vat = payload.vat;
      }
      const cash = payload.cash ? await cashAccount(tx, actor.id, payload.cash) : null;
      const credit = cash ?? (await ledger.systemAccount(tx, actor.id, 'payable'));
      const input = await ledger.systemAccount(tx, actor.id, 'vat_input'),
        output = await ledger.systemAccount(tx, actor.id, 'vat_output');
      // Non-deductible VAT is part of the cost; reverse charge VAT is never paid to the supplier.
      const cost = code === 'ND' ? payload.net + vat : payload.net,
        owed = code === 'RC' ? payload.net : payload.net + vat,
        deductible = code === 'S' || code === 'RC' || code === 'IMP' ? vat : 0;
      return ledger.createVoucher(tx, actor, {
        kind: 'expense',
        date: payload.date,
        accountCode: payload.accountCode,
        cashAccountCode: cash,
        partyId: party?.id ?? null,
        taxCode: code,
        net: payload.net,
        vat,
        total: owed,
        details: {
          description: payload.description,
          reference: payload.reference,
          partyName: party?.name ?? '',
          dueDate: payload.dueDate,
        },
        lines: [
          {
            accountCode: payload.accountCode,
            debit: cost,
            credit: 0,
            tax: { side: 'purchases', code, role: 'base' },
          },
          {
            accountCode: input,
            debit: deductible,
            credit: 0,
            tax: { side: 'purchases', code, role: 'input' },
          },
          {
            accountCode: output,
            debit: 0,
            credit: code === 'RC' ? vat : 0,
            tax: { side: 'purchases', code, role: 'output' },
          },
          { accountCode: credit, debit: 0, credit: owed },
        ],
      });
    });
    res.status(201).json({ voucher: await ledger.readVoucher(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/expenses/:id/payments', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      expenseId = routeId(req.params.id);
    const payload = {
      date: dateValue(b.date),
      amount: halalas(b.amount),
      cash: text(b.cashAccountCode, 20),
      reference: optionalText(b.reference, 120),
    };
    const id = await mutation(
      req,
      actor,
      `finance.ledger.expense.payment:${expenseId}`,
      payload,
      async (tx) => {
        const source = await ledger.readVoucher(tx, actor.id, expenseId);
        if (source.kind !== 'expense' || source.status !== 'posted' || source.cashAccountCode)
          throw fault(409, 'EXPENSE_NOT_PAYABLE', 'هذا المصروف ليس مستحقًا لمورد.');
        if (payload.amount <= 0 || payload.amount > source.outstandingHalalas)
          throw fault(400, 'PAYMENT_EXCEEDS_BALANCE', 'المبلغ يتجاوز المستحق للمورد.');
        if (payload.date < source.date)
          throw fault(400, 'INVALID_DATE_RANGE', 'تاريخ السداد لا يسبق تاريخ المصروف.');
        const cash = await cashAccount(tx, actor.id, payload.cash);
        return ledger.createVoucher(tx, actor, {
          kind: 'payment',
          date: payload.date,
          cashAccountCode: cash,
          partyId: source.partyId,
          relatedId: source.id,
          net: payload.amount,
          vat: 0,
          total: payload.amount,
          details: {
            description: `سداد ${source.number}${source.partyName ? ` · ${source.partyName}` : ''}`,
            reference: payload.reference,
            partyName: source.partyName,
          },
          lines: [
            {
              accountCode: await ledger.systemAccount(tx, actor.id, 'payable'),
              debit: payload.amount,
              credit: 0,
            },
            { accountCode: cash, debit: 0, credit: payload.amount },
          ],
        });
      },
    );
    res.status(201).json({ voucher: await ledger.readVoucher(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/vouchers/:id/reverse', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      id = routeId(req.params.id);
    const payload = {
      version: versionValue(b.version),
      date: dateValue(b.date),
      reason: text(b.reason, 300),
    };
    await mutation(req, actor, `finance.ledger.voucher.reverse:${id}`, payload, async (tx) => {
      await ledger.reverseVoucher(tx, actor, id, payload.version, payload.date, payload.reason);
      return id;
    });
    res.json({ voucher: await ledger.readVoucher(db, actor.id, id) });
  });

  // ------------------------------------------------------------ reports
  const yearStart = () => `${todayInRiyadh().slice(0, 4)}-01-01`;
  registerRoute(app, 'get', '/api/finance/ledger/reports/trial-balance', async (req, res) => {
    const actor = await ready(req);
    const from = queryDate(req, 'from', yearStart()),
      to = queryDate(req, 'to', todayInRiyadh());
    res.json({ from, to, rows: await ledger.trialBalance(db, actor.id, from, to) });
  });
  registerRoute(app, 'get', '/api/finance/ledger/reports/income-statement', async (req, res) => {
    const actor = await ready(req);
    res.json(
      await ledger.incomeStatement(
        db,
        actor.id,
        queryDate(req, 'from', yearStart()),
        queryDate(req, 'to', todayInRiyadh()),
      ),
    );
  });
  registerRoute(app, 'get', '/api/finance/ledger/reports/balance-sheet', async (req, res) => {
    const actor = await ready(req);
    res.json(await ledger.balanceSheet(db, actor.id, queryDate(req, 'asOf', todayInRiyadh())));
  });
  registerRoute(app, 'get', '/api/finance/ledger/reports/account/:code', async (req, res) => {
    const actor = await ready(req);
    res.json(
      await ledger.accountStatement(
        db,
        actor.id,
        routeId(req.params.code),
        queryDate(req, 'from', yearStart()),
        queryDate(req, 'to', todayInRiyadh()),
      ),
    );
  });
  registerRoute(app, 'get', '/api/finance/ledger/reports/aging', async (req, res) => {
    const actor = await ready(req),
      side = query(req, 'side') === 'payable' ? 'payable' : 'receivable';
    res.json({
      side,
      rows: await ledger.aging(db, actor.id, side, queryDate(req, 'asOf', todayInRiyadh())),
    });
  });
  const yearValue = (value: unknown) => {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      throw fault(400, 'INVALID_YEAR', 'السنة غير صالحة.');
    return year;
  };
  registerRoute(app, 'get', '/api/finance/ledger/reports/budget', async (req, res) => {
    const actor = await ready(req);
    res.json(
      await ledger.budgetReport(
        db,
        actor.id,
        yearValue(query(req, 'year') ?? todayInRiyadh().slice(0, 4)),
      ),
    );
  });
  registerRoute(app, 'patch', '/api/finance/ledger/budgets/:year', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      year = yearValue(routeId(req.params.year));
    if (!Array.isArray(b.lines) || b.lines.length > 300)
      throw fault(400, 'INVALID_INPUT', 'صيغة الموازنة غير صالحة.');
    const payload = {
      version: versionValue(b.version),
      lines: b.lines.map((raw) => {
        const x = requireRecord(raw);
        if (!Array.isArray(x.months) || x.months.length !== 12)
          throw fault(400, 'INVALID_INPUT', 'كل حساب يحتاج 12 مبلغًا شهريًا.');
        return {
          accountCode: text(x.accountCode, 20),
          months: x.months.map((value) => halalas(value === '' ? '0' : value)),
        };
      }),
    };
    await mutation(req, actor, `finance.ledger.budget:${year}`, payload, async (tx) => {
      const current = (
        await tx.read<{ version: number }>(
          'SELECT version FROM finance_budget_years WHERE owner_id=? AND year=?',
          [actor.id, year],
        )
      )[0];
      if (n(current?.version ?? 1) !== payload.version)
        throw fault(409, 'VERSION_CONFLICT', 'تغيرت الموازنة؛ حدّث الصفحة ثم أعد المحاولة.');
      const accounts = await ledger.accountRows(tx, actor.id);
      // A budget is a plan, not a ledger record: the year is rewritten and the change audited.
      await tx.execute('DELETE FROM finance_budgets WHERE owner_id=? AND year=?', [actor.id, year]);
      for (const line of payload.lines) {
        const row = accounts.get(line.accountCode);
        if (
          !row ||
          Number(row.postable) !== 1 ||
          (row.type !== 'revenue' && row.type !== 'expense')
        )
          throw fault(400, 'INVALID_BUDGET_ACCOUNT', 'الموازنة لحسابات الإيرادات والمصروفات فقط.');
        for (let month = 1; month <= 12; month += 1)
          if (line.months[month - 1] > 0)
            await tx.execute(
              'INSERT INTO finance_budgets(owner_id,year,account_code,month,amount) VALUES(?,?,?,?,?)',
              [actor.id, year, line.accountCode, month, line.months[month - 1]],
            );
      }
      await tx.execute(
        'INSERT INTO finance_budget_years(owner_id,year,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,year) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at',
        [actor.id, year, payload.version + 1, now()],
      );
      await audited(tx, actor, 'finance_budget', String(year), 'saved', payload.version + 1);
      return String(year);
    });
    res.json(await ledger.budgetReport(db, actor.id, year));
  });
  registerRoute(app, 'post', '/api/finance/ledger/periods', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body);
    const payload = {
      year: yearValue(b.year),
      month: Number(b.month),
      locked: b.locked === true,
    };
    if (!Number.isInteger(payload.month) || payload.month < 1 || payload.month > 12)
      throw fault(400, 'INVALID_MONTH', 'الشهر غير صالح.');
    await mutation(
      req,
      actor,
      `finance.ledger.period:${payload.year}-${payload.month}`,
      payload,
      async (tx) => {
        const start = `${payload.year}-${String(payload.month).padStart(2, '0')}-01`;
        const covered = await tx.read<{ id: string }>(
          'SELECT id FROM finance_vat_returns WHERE owner_id=? AND period_start<=? AND period_end>=?',
          [actor.id, start, start],
        );
        if (!payload.locked && covered.length)
          throw fault(409, 'PERIOD_IN_VAT_RETURN', 'الشهر ضمن إقرار ضريبي مقفل ولا يُعاد فتحه.');
        await ledger.setLock(tx, actor, payload.year, payload.month, payload.locked, 'manual');
        await audited(
          tx,
          actor,
          'finance_period',
          start.slice(0, 7),
          payload.locked ? 'locked' : 'reopened',
          1,
        );
        return start;
      },
    );
    res.json({ locks: await ledger.locks(db, actor.id) });
  });

  // ------------------------------------------------------------ VAT
  registerRoute(app, 'get', '/api/finance/ledger/vat', async (req, res) => {
    const actor = await ready(req),
      settings = await ledger.ledgerSettings(db, actor.id);
    const periods = await ledger.vatPeriods(db, actor.id, settings.filingFrequency),
      returns = await ledger.listVatReturns(db, actor.id);
    const start = query(req, 'start');
    const selected =
      (start && periods.find((item) => item.periodStart === dateValue(start))) ||
      periods.find((item) => item.status === 'open' && item.periodEnd < todayInRiyadh()) ||
      periods[0];
    const closed = returns.find((item) => item.periodStart === selected.periodStart);
    res.json({
      periods,
      selected,
      computation: closed ?? (await ledger.computeVat(db, actor.id, selected)),
      return: closed ?? null,
    });
  });
  registerRoute(app, 'post', '/api/finance/ledger/vat/close', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body);
    const raw = typeof b.correction === 'string' && b.correction ? b.correction.trim() : '0';
    const payload = {
      periodStart: dateValue(b.periodStart),
      correction: raw.startsWith('-') ? -halalas(raw.slice(1)) : halalas(raw),
      note: optionalText(b.correctionNote, 500),
    };
    const id = await mutation(
      req,
      actor,
      `finance.ledger.vat.close:${payload.periodStart}`,
      payload,
      (tx) => ledger.closeVat(tx, actor, payload.periodStart, payload.correction, payload.note),
    );
    res.status(201).json({ return: await ledger.readVatReturn(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/vat/:id/file', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      id = routeId(req.params.id);
    const payload = {
      version: versionValue(b.version),
      filedAt: dateValue(b.filedAt),
      reference: text(b.reference, 120),
    };
    await mutation(req, actor, `finance.ledger.vat.file:${id}`, payload, async (tx) => {
      const changed = await tx.execute(
        "UPDATE finance_vat_returns SET status='filed',filed_at=?,filing_reference_ciphertext=?,version=version+1 WHERE owner_id=? AND id=? AND version=? AND status='closed'",
        [
          payload.filedAt,
          encryptSensitive(payload.reference, `finance:vat-reference:${id}`),
          actor.id,
          id,
          payload.version,
        ],
      );
      if (changed.rowCount !== 1)
        throw fault(409, 'VERSION_CONFLICT', 'تغيرت حالة الإقرار؛ حدّث الصفحة ثم أعد المحاولة.');
      await audited(tx, actor, 'finance_vat_return', id, 'filed', payload.version + 1);
      return id;
    });
    res.json({ return: await ledger.readVatReturn(db, actor.id, id) });
  });
  registerRoute(app, 'post', '/api/finance/ledger/vat/:id/pay', async (req, res) => {
    const actor = await ready(req),
      b = requireRecord(req.body),
      id = routeId(req.params.id);
    const payload = {
      version: versionValue(b.version),
      date: dateValue(b.date),
      cash: text(b.cashAccountCode, 20),
    };
    await mutation(req, actor, `finance.ledger.vat.pay:${id}`, payload, async (tx) => {
      const current = await ledger.readVatReturn(tx, actor.id, id);
      if (current.status !== 'filed')
        throw fault(409, 'VAT_RETURN_NOT_FILED', 'سجّل تقديم الإقرار للهيئة قبل تسجيل السداد.');
      if (current.netDueHalalas <= 0)
        throw fault(409, 'VAT_NOTHING_DUE', 'لا يوجد مبلغ مستحق للسداد في هذا الإقرار.');
      const cash = await cashAccount(tx, actor.id, payload.cash);
      const entry = await ledger.postEntry(tx, actor, {
        date: payload.date,
        kind: 'vat_payment',
        sourceId: id,
        description: `سداد ضريبة القيمة المضافة · ${current.periodStart} إلى ${current.periodEnd}`,
        lines: [
          {
            accountCode: await ledger.systemAccount(tx, actor.id, 'vat_settlement'),
            debit: current.netDueHalalas,
            credit: 0,
          },
          { accountCode: cash, debit: 0, credit: current.netDueHalalas },
        ],
      });
      const changed = await tx.execute(
        "UPDATE finance_vat_returns SET status='paid',payment_entry_id=?,version=version+1 WHERE owner_id=? AND id=? AND version=? AND status='filed'",
        [entry.id, actor.id, id, payload.version],
      );
      if (changed.rowCount !== 1)
        throw fault(409, 'VERSION_CONFLICT', 'تغيرت حالة الإقرار؛ حدّث الصفحة ثم أعد المحاولة.');
      await audited(tx, actor, 'finance_vat_return', id, 'paid', payload.version + 1);
      return id;
    });
    res.json({ return: await ledger.readVatReturn(db, actor.id, id) });
  });
}
