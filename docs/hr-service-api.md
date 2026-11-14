# واجهة الموارد البشرية لبوت «محاسب سبق» (قراءة، وكتابة محددة في المرحلة الثانية)

مفتاح خدمة مستقل يتيح لبوت «محاسب سبق» قراءة ملفات الموظفين والرواتب والإجازات والمسيرات عبر HTTP دون جلسة متصفح، وفي المرحلة الثانية: تعديل الملف بتوجيه علي، وإعداد مسودة المسير وإرسالها للمراجعة. كل الأمثلة هنا ببيانات وهمية، والمفتاح فيها `$SABQ_HR_SERVICE_TOKEN` (لا تكتب المفتاح الحقيقي في أي أمر يُحفظ في السجل).

## الأمان

- المفتاح بصيغة `sabqhr_` يليها 43 حرفًا عشوائيًا، ويُرسل في `Authorization: Bearer …`.
- **منفصل عن مفتاح المالية** (`sabqfin_`، المتغير `HR_FINANCE_API_KEY_HASHES`) الذي بقي كما هو. مفتاح المالية لا يصل لهذه الواجهة، وهذا المفتاح لا يصل إلى `/api/finance`. كلاهما يُرفض بـ `403 API_KEY_SCOPE`.
- الخادم يحفظ بصمة SHA-256 فقط في `HR_SERVICE_API_KEY_HASHES` (أكثر من بصمة مفصولة بفواصل للتدوير)، وتُقارن بزمن ثابت.
- النطاقات في `HR_SERVICE_API_KEY_SCOPES`. بدونها يتعطل المفتاح (`401 API_KEY_DISABLED`)، ويرفض الخادم الإقلاع إذا وُجدت البصمات بلا نطاقات أو خارج الأوضاع الخاصة.
- المفتاح يعمل بصفة **حساب خدمة ثابت** اسمه «محاسب سبق» (`svc-sabq-accountant`، الدور `service`)، لا بصفة موظف. لا يقبله أي مسار من مسارات المتصفح (`/api/bootstrap` و`/api/admin/*` و`/api/session` …)، كلها `403 API_KEY_SCOPE`.
- `GET` و`HEAD` على `/api/health` و`/api/service/hr/*`، وثلاثة مسارات كتابة فقط: `PATCH /api/service/hr/employees/:id` و`POST /api/service/hr/payroll` و`POST /api/service/hr/payroll/:id/actions`. أي طريقة أو مسار غيرها يُرفض بـ `403 API_KEY_SCOPE`.
- الكتابة بصيغة JSON (`Content-Type: application/json`، وإلا `415 JSON_REQUIRED`) ومعها `Idempotency-Key` إلزاميًا. لا تحتاج `Origin` لأنها ليست طلب متصفح.
- 20 محاولة مفتاح خاطئة خلال 15 دقيقة (مشتركة مع مفتاح المالية) تعطي `429 API_KEY_LOCKED`.

## النطاقات

| النطاق                 | يفتح                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `hr.employees.read`    | البحث بالاسم، والملف بالحقول غير الحساسة                                                           |
| `hr.sensitive.read`    | الحقول الشخصية والطبية في الملف (الهوية، الجواز، الميلاد، التأمين الطبي…)، واستحقاق الإجازة المسجَّل |
| `hr.compensation.read` | الراتب والبدلات والآيبان والحساب والتأمينات، ومبالغ أسطر المسير ومجاميعه                           |
| `hr.leave.read`        | رصيد الإجازة وحركاته وطلبات الإجازة                                                                |
| `hr.payroll.read`      | قائمة المسيرات وتفاصيلها (بدون مبالغ إلا مع `hr.compensation.read`)                                |

| `hr.employees.write` | تعديل حقول الملف (ومنها مكونات الراتب) بسبب وتاريخ سريان ورقم نسخة — المرحلة الثانية |
| `hr.payroll.write` | إنشاء مسودة المسير الأساسي لشهر — المرحلة الثانية |
| `hr.payroll.submit` | إرسال مسودة أعدّها المفتاح نفسه للمراجعة (`draft` ← `pending_finance`) — المرحلة الثانية |

`hr.leave.write` معرّف ولم يُفعّل بعد؛ يرفض الخادم الإقلاع إن ضُبط.

**لا يُمنح أبدًا لمفتاح:** `hr.payroll.approve` و`hr.payroll.close`. اعتماد المسير وإغلاقه يبقى لعلي (المعتمد البشري)، والخادم يرفض الإقلاع إن ضُبط أحدهما. مسار الإجراءات يرد `403 PAYROLL_ACTION_FORBIDDEN` على `approve` و`close` و`review` و`reject` مهما كانت النطاقات، وطبقة المسير نفسها ترفض أي إجراء غير `submit` للدور `service`.

## التدقيق

كل رد يحمل حقولًا حساسة يكتب حدثًا في `administration_events` (`resource_type = service_access`) بالممثل `svc-sabq-accountant`، ويظهر في سجل التدقيق باسم «محاسب سبق». التفاصيل: أسماء الحقول ومعرّف المفتاح (أول 12 خانة من البصمة)، **بلا قيم**. الأحداث:

- `service_read_sensitive_profile` — قراءة حقول شخصية أو طبية من الملف
- `service_read_compensation` — قراءة الراتب أو الحساب
- `service_read_sensitive_leave` — قراءة استحقاق الإجازة
- `service_read_payroll_list` — قراءة إجماليات قائمة المسيرات (الشهر وعدد المسيرات وأسماء حقول المبالغ فقط، بلا قيم)
- `service_read_payroll_amounts` — قراءة مبالغ أسطر مسير

القراءات غير الحساسة (البحث، الملف العام، الرصيد، المسير بلا مبالغ، وقائمة المسيرات بلا نطاق التعويض) لا تكتب حدثًا.

كل كتابة تُسجَّل في المعاملة نفسها، بالممثل `svc-sabq-accountant` والدور `service`:

- تعديل الملف: حدث `field_updated` لكل حقل تغيّر (اسم الحقل وهل هو حساس، بلا قيمة)، وحدث `profile_updated` فيه `actorName` و`actorKind` و`keyId` وأسماء الحقول وتاريخ السريان، والسبب مشفّرًا. وسجل الحقل في `employee_profile_history` (القيمة القديمة والجديدة والسبب مشفّرة) باسم «محاسب سبق».
- المسير: `service_payroll_draft_created` و`service_payroll_submitted` (`resource_type = payroll_run`)، إضافة إلى `payroll_events` (`created` و`submit`) الذي يظهر في الخط الزمني للمسير باسم «محاسب سبق».

## المسارات

```bash
BASE="$SABQ_HR_SERVICE_URL"
AUTH="Authorization: Bearer $SABQ_HR_SERVICE_TOKEN"
```

### البحث عن موظف — `hr.employees.read`

```bash
curl -s -H "$AUTH" "$BASE/api/service/hr/employees?q=$(printf 'ساره القحطاني' | jq -sRr @uri)"
```

يتجاهل التشكيل والتطويل، ويساوي أ/إ/آ/ا وى/ي وة/ه وؤ/و وئ/ي والأرقام العربية. يبحث في الاسم والرقم الوظيفي، وكل كلمات البحث يجب أن تطابق. حرفان على الأقل وإلا `400 QUERY_REQUIRED`. حتى 20 نتيجة:

```json
{
  "employees": [
    {
      "id": "emp-example",
      "employeeNumber": "S-000",
      "name": "موظف وهمي",
      "title": "…",
      "department": "…",
      "status": "active"
    }
  ],
  "total": 1
}
```

### ملف موظف — `hr.employees.read` (+ `hr.sensitive.read`)

```bash
curl -s -H "$AUTH" "$BASE/api/service/hr/employees/emp-example"
```

يعيد `employee` و`values` (الحقول غير الحساسة، والشخصية والطبية فقط مع `hr.sensitive.read`) و`included`. حقول الراتب والبنك لا تظهر هنا أبدًا.

### الراتب والحساب — `hr.compensation.read`

```bash
curl -s -H "$AUTH" "$BASE/api/service/hr/employees/emp-example/compensation"
```

يعيد `compensation` بالحقول المالية فقط (`basicSalary` و`housingAllowance` و`iban` …).

### الإجازة — `hr.leave.read`

```bash
curl -s -H "$AUTH" "$BASE/api/service/hr/employees/emp-example/leave"
```

يعيد `summary` (`allocated` و`available` و`taken` و`reserved` و`balanceKnown` و`policyApproved`)، و`movements` (النوع والأيام والتاريخ)، و`requests` (طلبات الإجازة السنوية وحالاتها). مع `hr.sensitive.read` يضاف `annualLeaveEntitlement`.

### المسيرات — `hr.payroll.read` (+ `hr.compensation.read` للمبالغ)

```bash
curl -s -H "$AUTH" "$BASE/api/service/hr/payroll?month=2026-07"
curl -s -H "$AUTH" "$BASE/api/service/hr/payroll/RUN_ID"
```

القائمة اختياريًا لشهر `YYYY-MM` (وإلا `400 INVALID_MONTH`). كل مسير: `id` و`period` و`state` و`version` و`employeeCount`، و`totals` بالهللة مع نطاق التعويض. التفصيل يضيف `lines` (الموظف والبند والنوع، و`amountMinor` مع نطاق التعويض).

### تعديل ملف موظف — `hr.employees.write`

```bash
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  "$BASE/api/service/hr/employees/emp-example" \
  -d '{"version":7,"reason":"بتوجيه علي في 2026-11-14: تسجيل الراتب","effectiveAt":"2026-11-01",
       "values":{"basicSalary":10000,"housingAllowance":2500,"transportAllowance":1000,"otherAllowance":0}}'
```

- `version` هو `record_version` الحالي للملف (يرجع في رد التعديل السابق). إن تغيّر الملف منذ قراءته: `409 STALE_VERSION` ولا يتغير شيء.
- `reason` إلزامي (من 3 أحرف): اكتب من وجّه بالتعديل ومتى. يُحفظ مشفّرًا.
- `effectiveAt` إلزامي بصيغة `YYYY-MM-DD`، ولا يقبل تاريخًا مستقبليًا (`409 FUTURE_EFFECTIVE_DATE`) كما في واجهة الموارد البشرية؛ سجّل التعديل في يوم سريانه.
- عند تغيير أي مكون راتب (`basicSalary` و`housingAllowance` و`transportAllowance` و`otherAllowance`) يُضبط `salaryEffectiveDate` على `effectiveAt` و`salarySource` على «محاسب سبق (مفتاح خدمة) بتوجيه مسجل في سبب التعديل» ما لم يُرسلا. لا يُترك تاريخ السريان فارغًا.
- التحقق نفسه الذي في الواجهة (`saveProfileValues`): أنواع الحقول، الحقول غير المعروفة (`400 UNKNOWN_FIELDS`)، إعادة حالة التحقق البنكي والتأميني وإجازة الاستحقاق إلى «غير متحقق» عند تغيير قيمها، وسجل الحقل.
- حقول لا يعدّلها المفتاح ولو بالنطاق (`403 FIELD_NOT_ALLOWED_FOR_SERVICE`): `employeeNumber` و`managerId` و`employmentStatus` و`separationDate` و`separationReason`، وحالات التحقق `bankVerificationStatus` و`bankVerificationSource` و`bankVerifiedAt` و`insuranceVerificationStatus` و`annualLeaveVerificationStatus`. هذه لها مسار بشري (الحالة الوظيفية وإنهاء الخدمة، خط الاعتماد، شهادة تحقق).
- الرد بلا قيم: `{ "employee": {…}, "version": 8, "fields": [...], "replayed": false }`. إعادة الطلب بالمفتاح نفسه ونفس المحتوى ترد `replayed: true` دون أثر جديد؛ بمحتوى مختلف `409 IDEMPOTENCY_CONFLICT`.

### مسودة المسير — `hr.payroll.write`

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  "$BASE/api/service/hr/payroll" -d '{"period":"2026-11","reason":"مسودة نوفمبر بتوجيه علي"}'
```

ينفّذ أمر الإنشاء نفسه الذي تستخدمه الموارد البشرية (`createPayrollCommands`): السياسة المعتمدة للفترة، مسير أساسي واحد لكل شهر (`409 period_already_exists`)، أسطر من مكونات الملف للموظفين النشطين، واستبعاد الملفات الناقصة (`excludedCount`). المسير المعدّ باسم `svc-sabq-accountant`. مسير التصحيح لا يُعد بالمفتاح (`400 SERVICE_CORRECTION_UNSUPPORTED`). الرد `201` بملخص المسير (`id` و`period` و`state` و`version` و`preparedBy` و`employeeCount`، و`totals` مع `hr.compensation.read`) دون أسطر؛ الأسطر من `GET /payroll/:id`.

إذا لم تكن في القاعدة سياسة رواتب معتمدة للفترة يرد `400 policy_unavailable` — هذا هو الحال في البيانات الخاصة حاليًا، والمفتاح لا يتجاوزه.

### إرسال المسودة للمراجعة — `hr.payroll.submit`

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  "$BASE/api/service/hr/payroll/RUN_ID/actions" -d '{"action":"submit","version":1}'
```

`draft` ← `pending_finance`، لمسودة أعدّها المفتاح نفسه فقط (`403 transition_forbidden` لمسودة أعدّها شخص). `version` غير مطابق: `409 version_conflict`. بعدها المراجعة للمالية والاعتماد (الذي يغلق المسير) للمعتمد، من الواجهة. `approve` و`close` و`review` و`reject` بالمفتاح: `403 PAYROLL_ACTION_FORBIDDEN` دائمًا.

## التصدير (PDF وCSV وXLSX والتنزيل)

كل تصدير في التطبيق له مسار للمفتاح، بنفس المولّد أو قالب الطباعة الذي تستخدمه الواجهة (لا قوالب مستقلة). ملفات PDF يرسمها Chromium في الخادم من مكوّن React نفسه وورقة الأنماط نفسها التي تطبعها الواجهة بـ`window.print`، والرد يحمل `x-pdf-renderer: chromium`، وبلا Chromium يرد `503 PDF_RENDERER_UNAVAILABLE`. كل تصدير يكتب حدثًا في `administration_events` (`resource_type = service_access`) باسم «محاسب سبق» بأسماء الأقسام والحقول وعدد الصفوف فقط، بلا قيم. كل الردود `cache-control: private, no-store`.

| التصدير في التطبيق                                                                                       | مسار المفتاح                                                                          | النطاق                                                                                                                                      | حدث التدقيق                                                                  | الحالة                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| تقرير الملف الوظيفي («طباعة / حفظ PDF»)                                                                  | `GET /employees/:id/report.pdf`                                                       | `hr.employees.read`؛ الراتب والبنك والتأمينات بـ`hr.compensation.read`؛ الهوية والطبي بـ`hr.sensitive.read`؛ قسم الإجازات بـ`hr.leave.read` | `service_export_profile_report` (الأقسام، أسماء الحقول الحساسة، عدد الوثائق) | متاح                                                                                            |
| تنزيل وثيقة موظف                                                                                         | `GET /employees/:id/documents` ثم `GET /employees/:id/documents/:documentId/download` | `hr.employees.read`؛ وثائق الصنف المالي بـ`hr.compensation.read`، والشخصي والطبي بـ`hr.sensitive.read`                                      | `service_document_downloaded` (الصنف)                                        | متاح                                                                                            |
| طباعة النسخة المعتمدة لطلب قابل للطباعة (تعريف بالراتب، تعريف، شهادة خبرة، عقد، ملحق، إخلاء طرف، مخالصة) | `GET /employees/:id/letters` ثم `GET /employees/:id/letters/:requestId/letter.pdf`    | `hr.employees.read` + `hr.compensation.read` + `hr.sensitive.read` (النسخة مجمّدة ولا تُحجب حقلًا حقلًا)                                        | `service_export_issued_letter` (النوع والمرجع)                               | متاح، قراءة فقط                                                                                 |
| تصدير CSV للمسير                                                                                         | `GET /payroll/:id/export.csv`                                                         | `hr.payroll.read` + `hr.compensation.read`                                                                                                  | `service_export_payroll_csv` (الفترة والحالة وعدد السطور)                    | متاح                                                                                            |
| طباعة كشف الراتب (مسير مغلق)                                                                             | `GET /payroll/:id/payslips/:employeeId/payslip.pdf`                                   | `hr.payroll.read` + `hr.compensation.read`                                                                                                  | `service_export_payslip`                                                     | متاح، للمسيرات المغلقة فقط كما في الواجهة (`409 PAYROLL_NOT_CLOSED`)                            |
| تقارير CSV: الموظفون، الطلبات، الحضور                                                                    | `GET /reports/export.csv?type=employees\|requests\|attendance`                        | `hr.employees.read` (الطلبات والحضور أعداد وحالات بلا هوية موظف)                                                                            | `service_export_report_csv` (النوع وعدد الصفوف)                              | متاح                                                                                            |
| نموذج استيراد الموظفين XLSX (فارغ)                                                                       | `GET /imports/employees/template.xlsx`                                                | `hr.employees.read`                                                                                                                         | `service_export_import_template`                                             | متاح                                                                                            |
| مستندات المالية (عرض السعر، الفاتورة، كشف الحساب، تقارير الدفتر)                                         | `/api/finance/...`                                                                    | مفتاح المالية `sabqfin_`                                                                                                                    | كما هي                                                                       | تبقى على مفتاح المالية                                                                          |
| طباعة صفحة الطلب كاملة (قيم النموذج والمسار الزمني)                                                      | —                                                                                     | —                                                                                                                                           | —                                                                            | غير متاح: المفتاح لا يملك وصولًا للطلبات الإدارية. يحتاج قرارًا بنطاق جديد مثل `hr.requests.read` |

قواعد الحجب في التقرير هي قواعد مسارات JSON نفسها. يُترك من التقرير المطبوع بالمفتاح: الطلبات الإدارية، وأسباب تغييرات الحقول (نص حر)، والمسار الزمني للملف؛ لأنها خارج صلاحيات المفتاح.

**ما يغيّر الحالة ولا يُعرض كتصدير:** إصدار النسخة المعتمدة لخطاب أو عقد يحدث عند اعتماد الطلب (رقم مرجع ونسخة مجمّدة)، وهو اعتماد بشري. المفتاح يقرأ النسخ الصادرة فقط، وإصدارها بالمفتاح يحتاج قرار كتابة مستقلًا. ورفع الوثائق وأرشفتها واستيراد الموظفين كتابات خارج نطاق المفتاح.

## الأخطاء

| الرمز                                                               | المعنى                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `401 API_KEY_DISABLED`                                              | المفتاح غير مفعّل في هذه النسخة (لا بصمات أو لا نطاقات أو وضع غير خاص) |
| `401 INVALID_API_KEY`                                               | مفتاح خاطئ                                                            |
| `403 API_KEY_SCOPE`                                                 | المسار أو الطريقة خارج نطاق المفتاح، أو النطاق المطلوب غير ممنوح      |
| `404 EMPLOYEE_NOT_FOUND` / `PAYROLL_NOT_FOUND`                      | المعرّف غير موجود                                                      |
| `404 DOCUMENT_NOT_FOUND` / `LETTER_NOT_FOUND` / `PAYSLIP_NOT_FOUND` | غير موجود أو خارج نطاق المفتاح                                        |
| `409 PAYROLL_NOT_CLOSED`                                            | كشف الراتب لمسير غير مغلق                                             |
| `503 PDF_RENDERER_UNAVAILABLE`                                      | Chromium غير متاح على الخادم                                          |
| `400 IDEMPOTENCY_KEY_REQUIRED` / `idempotency_key_required`         | كتابة بلا `Idempotency-Key`                                           |
| `403 FIELD_NOT_ALLOWED_FOR_SERVICE`                                 | حقل له مسار بشري فقط                                                  |
| `403 PAYROLL_ACTION_FORBIDDEN`                                      | اعتماد أو إغلاق أو مراجعة أو رفض مسير بالمفتاح                        |
| `409 STALE_VERSION` / `version_conflict`                            | الملف أو المسير تغيّر منذ قراءته                                       |
| `429 API_KEY_LOCKED`                                                | محاولات خاطئة كثيرة                                                   |

## حدود معروفة

- السياسة السنوية والمسير في البيانات الخاصة ما زالا على محرك المعاينة (`payroll-policy-demo-v2`). الرصيد والمسير المقروءان ليسا نظاميين حتى تُعتمد سياسة حقيقية.
- لا يوجد في البيانات الخاصة حتى الآن سياسة رواتب معتمدة، فمسودة المسير بالمفتاح ترد `400 policy_unavailable` إلى أن تُعتمد سياسة.
- المسير يستبعد أصحاب الدور `finance` و`approver` (كما في واجهة الموارد البشرية).
- `hr.leave.write` لم يُفعّل.

## حساب الخدمة في قاعدة البيانات (المرحلة الثانية)

سجل الحقل (`employee_profile_history.actor_id`) وبيانات الملف (`updated_by`) ومُعدّ المسير (`payroll_runs.prepared_by`) مرتبطة بجدول `employees`. اخترنا الأقل خطرًا: صف واحد ثابت للمفتاح بدل حذف القيود أو إعادة بناء الجداول.

- المعرّف `svc-sabq-accountant` والرقم `SVC-SABQ-ACCOUNTANT` والاسم «محاسب سبق»، الحالة `suspended`، بلا `access_role`، وبلا حساب دخول في `employee_accounts`.
- يُنشأ **عند أول كتابة** بالمفتاح، داخل معاملة تلك الكتابة (`server/service-api/service-account.ts`)، لا في الترحيل. قاعدة لم يكتب فيها المفتاح لا يتغير فيها شيء.
- الترحيل `016_service_account_view` يعيد تعريف العرض `employee_access` بالأعمدة نفسها وبترتيبها مع استثناء هذا المعرّف. كل الدليل والبحث والمسير والإجازات وإدارة الحسابات والتصدير تقرأ من هذا العرض، فلا يظهر فيها ولا يُضاف لمسير ولا يُسند له عمل. ولا يستطيع المفتاح تعديل صفه (`404`).
- التراجع: إعادة تعريف العرض بلا شرط (ترحيل جديد)؛ الصف إن وُجد يبقى معطّلًا ولا يضر.

## إنشاء المفتاح وتفعيله (بعد الدمج)

```bash
npm run hr:key -- --out /secure/path/hr-service.key --env-out /secure/path/hr-service.env --url https://HOST
```

يكتب المفتاح في ملف بصلاحية 600 خارج المستودع ويطبع البصمة فقط. في بيئة الخادم:

```
HR_SERVICE_API_KEY_HASHES=sha256:<البصمة المطبوعة>
HR_SERVICE_API_KEY_SCOPES=hr.employees.read,hr.compensation.read,hr.sensitive.read,hr.leave.read,hr.payroll.read
```

لتفعيل المرحلة الثانية (بعد الدمج وبموافقة علي) أضف نطاقات الكتابة إلى القيمة نفسها، دون تغيير البصمة أو المفتاح:

```
HR_SERVICE_API_KEY_SCOPES=hr.employees.read,hr.compensation.read,hr.sensitive.read,hr.leave.read,hr.payroll.read,hr.employees.write,hr.payroll.write,hr.payroll.submit
```

لسحب الكتابة فقط: أعد القيمة إلى نطاقات القراءة وأعد النشر.

للتدوير: أضف البصمة الجديدة بفاصلة، وسلّم المفتاح الجديد، ثم احذف القديمة. للإيقاف الفوري: احذف المتغيرين وأعد النشر.
