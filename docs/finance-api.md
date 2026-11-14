# واجهة المالية لبوت المحاسب

مفتاح خدمة يتيح لبرنامج موثوق (بوت «محاسب سبق») تشغيل قسم المالية عبر HTTP دون جلسة متصفح. كل الأمثلة هنا ببيانات وهمية.

## الأمان

- المفتاح بصيغة `sabqfin_` يليها 43 حرفًا عشوائيًا، ويُرسل في الترويسة `Authorization: Bearer …`.
- الخادم لا يحفظ المفتاح نفسه، بل بصمة SHA-256 في المتغير `HR_FINANCE_API_KEY_HASHES`، وتُقارن البصمات بزمن ثابت. يمكن وضع أكثر من بصمة مفصولة بفواصل لتدوير المفتاح.
- النطاق `/api/finance*` و`/api/health` فقط. ما عداه، ومعه `/api/finance/settings/api-key` و`/api/finance/settings/test`، يُرفض بـ `403 API_KEY_SCOPE`. لا وصول لإدارة الموظفين ولا الرواتب ولا الوثائق ولا السجل ولا الجلسات.
- المفتاح يعمل بصفة الحساب `HR_FINANCE_EMPLOYEE_ID` بدور موظف، فيرى بيانات ذلك الحساب المالية فقط. إذا عُلّق الحساب أو أُنهيت خدمته يتوقف المفتاح.
- يتعطل المفتاح (`401 API_KEY_DISABLED`) في المعاينة العامة، أو عند غياب `HR_FINANCE_EMPLOYEE_ID`، أو عند غياب البصمات. ويرفض الخادم الإقلاع إذا ضُبطت البصمات خارج الأوضاع الخاصة.
- 20 محاولة فاشلة خلال 15 دقيقة من العنوان نفسه تعطي `429 API_KEY_LOCKED`.
- طلبات المفتاح تتجاهل ملفات تعريف الارتباط ولا تحتاج ترويسة Origin، لكنها تشترط `Content-Type: application/json` لما فيه جسم، و`Idempotency-Key` لكل تعديل.

## إنشاء مفتاح

```bash
npm run finance:key -- --out /secure/path/finance.key --env-out /secure/path/finance.env --url https://HOST
```

يرفض الأمر الكتابة داخل المستودع، ويكتب الملفات بصلاحية 600 داخل مجلد 700، ويطبع البصمة فقط. ضع البصمة في `HR_FINANCE_API_KEY_HASHES` في بيئة الخادم.

## بيئة تجريبية محلية

```bash
HR_FINANCE_API_KEY_HASHES="sha256:…" npm run finance:sandbox
```

تعمل على `127.0.0.1:4320` بقاعدة SQLite في `.data/finance-sandbox.sqlite` ومزود وافق وهمي لا يتصل بالشبكة، وتزرع منشأة وعميلين وصنفين وهميين. ترفض العمل في الإنتاج أو مع `HR_MODE`.

## المسارات

| العملية                                 | المسار                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| قراءة العملاء والبنود والعروض والفواتير | `GET /api/finance`                                                                               |
| العملاء                                 | `POST /api/finance/customers`، `PATCH /api/finance/customers/:id`                                |
| بنود الأسعار                            | `POST /api/finance/catalog`، `PATCH /api/finance/catalog/:id`                                    |
| عرض السعر                               | `POST /api/finance/quotes`، `PATCH /api/finance/quotes/:id`                                      |
| PDF عرض السعر                           | `GET /api/finance/quotes/:id/document.pdf`                                                       |
| الفاتورة                                | `POST /api/finance/quotes/:id/convert`                                                           |
| PDF نسخة الفاتورة                       | `GET /api/finance/invoices/:id/document.pdf` (نسخة داخلية، ليست فاتورة ضريبية)                   |
| PDF كشف حساب العميل                     | `GET /api/finance/customers/:id/statement.pdf?from=YYYY-MM-DD&to=YYYY-MM-DD` (أفقي)              |
| PDF الرسمي                              | `GET /api/finance/invoices/:id/pdf` (من المزود بعد القبول فقط)                                   |
| تهيئة الدفاتر                           | `POST /api/finance/ledger/setup` (مرة واحدة)                                                     |
| ترحيل الفاتورة وتسجيل الدفع             | `POST /api/finance/ledger/invoices/:id/post`، `POST /api/finance/ledger/invoices/:id/receipts`   |
| إيراد ومصروف                            | `POST /api/finance/ledger/revenues`، `POST /api/finance/ledger/expenses`                         |
| القيد اليومي والأستاذ                   | `GET/POST /api/finance/ledger/entries`، `GET /api/finance/ledger/reports/account/:code`          |
| ميزان المراجعة والميزانية               | `GET /api/finance/ledger/reports/trial-balance`، `GET /api/finance/ledger/reports/balance-sheet` |
| الموازنة                                | `GET /api/finance/ledger/reports/budget?year=`، `PATCH /api/finance/ledger/budgets/:year`        |
| ضريبة القيمة المضافة الربعية            | `GET /api/finance/ledger/vat?start=YYYY-MM-DD`                                                   |

المبالغ في الردود بالهللة. الاختبارات في `tests/domain/finance-service-api.test.ts` و`tests/domain/finance-document-pdf.test.ts`.

## ملفات PDF

ثلاثة مسارات تطبع المستند نفسه الذي تعرضه معاينة الطباعة في الواجهة، بالمكونات نفسها (`src/finance/paper.tsx` و`src/finance/statement-paper.tsx`) وأوراق الأنماط نفسها، عبر Chromium دون واجهة:

| المستند         | المسار                                                   | الورق    | سجل التدقيق                 |
| --------------- | -------------------------------------------------------- | -------- | --------------------------- |
| عرض السعر       | `GET /api/finance/quotes/:id/document.pdf`               | A4 عمودي | `quote_pdf_exported`        |
| نسخة الفاتورة   | `GET /api/finance/invoices/:id/document.pdf`             | A4 عمودي | `invoice_copy_pdf_exported` |
| كشف حساب العميل | `GET /api/finance/customers/:id/statement.pdf?from=&to=` | A4 أفقي  | `statement_pdf_exported`    |

- بيانات المنشأة والحساب البنكي من المصدر الذي تستخدمه المعاينة: بيانات البائع المحفوظة في المستند، وما نقص منها يُكمَّل من إعدادات المالية الحالية. الشعار `public/brand/sabq-logo.svg`.
- كشف الحساب يقبل معاملات الواجهة نفسها: `from` اختياري، و`to` افتراضيًا تاريخ اليوم بتوقيت الرياض. بداية بعد النهاية تعطي `400 INVALID_DATE_RANGE`. وهي معاملات مسار JSON `GET /api/finance/customers/:id/statement` نفسها.
- كل طلب PDF ناجح يضيف سطرًا في سجل التدقيق.
- الترويسة `x-pdf-renderer` تبيّن المحرك: `chromium`، أو `pdfkit` إذا لم يتوفر Chromium، فيرجع عرض السعر والفاتورة بالتخطيط القديم، ويرجع كشف الحساب `503 PDF_RENDERER_UNAVAILABLE`.
- يبحث الخادم عن Chromium في `HR_PDF_CHROMIUM_PATH`، ثم `/usr/bin/chromium` و`/usr/bin/chromium-browser`، ثم نسخة Playwright المثبتة. على Railway يثبّته `railpack.json` (حزمة `chromium` في صورة التشغيل).
- الصفحة المطبوعة لا تصل إلى الشبكة: تُخدم الخطوط والشعار من الملفات المحلية ويُحجب أي طلب آخر. متصفح واحد يعمل عند الطلب، والطلبات بالتتابع، ويُغلق بعد دقيقة من الخمول.
- نسخة الفاتورة داخلية وليست فاتورة ضريبية، ولا تحمل رمز QR. الملف الرسمي على `GET /api/finance/invoices/:id/pdf` من المزود بعد القبول فقط.

```bash
curl -fsS -H "Authorization: Bearer $KEY" -o quote.pdf "$HOST/api/finance/quotes/$QUOTE_ID/document.pdf"
curl -fsS -H "Authorization: Bearer $KEY" -o invoice.pdf "$HOST/api/finance/invoices/$INVOICE_ID/document.pdf"
curl -fsS -H "Authorization: Bearer $KEY" -o statement.pdf "$HOST/api/finance/customers/$CUSTOMER_ID/statement.pdf?from=2026-01-01&to=2026-11-14"
```
