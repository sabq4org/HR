# واجهة الموارد البشرية لبوت «محاسب سبق» (المرحلة الأولى: قراءة فقط)

مفتاح خدمة مستقل يتيح لبوت «محاسب سبق» قراءة ملفات الموظفين والرواتب والإجازات والمسيرات عبر HTTP دون جلسة متصفح. كل الأمثلة هنا ببيانات وهمية، والمفتاح فيها `$SABQ_HR_SERVICE_TOKEN` (لا تكتب المفتاح الحقيقي في أي أمر يُحفظ في السجل).

## الأمان

- المفتاح بصيغة `sabqhr_` يليها 43 حرفًا عشوائيًا، ويُرسل في `Authorization: Bearer …`.
- **منفصل عن مفتاح المالية** (`sabqfin_`، المتغير `HR_FINANCE_API_KEY_HASHES`) الذي بقي كما هو. مفتاح المالية لا يصل لهذه الواجهة، وهذا المفتاح لا يصل إلى `/api/finance`. كلاهما يُرفض بـ `403 API_KEY_SCOPE`.
- الخادم يحفظ بصمة SHA-256 فقط في `HR_SERVICE_API_KEY_HASHES` (أكثر من بصمة مفصولة بفواصل للتدوير)، وتُقارن بزمن ثابت.
- النطاقات في `HR_SERVICE_API_KEY_SCOPES`. بدونها يتعطل المفتاح (`401 API_KEY_DISABLED`)، ويرفض الخادم الإقلاع إذا وُجدت البصمات بلا نطاقات أو خارج الأوضاع الخاصة.
- المفتاح يعمل بصفة **حساب خدمة ثابت** اسمه «محاسب سبق» (`svc-sabq-accountant`، الدور `service`)، لا بصفة موظف. لا يقبله أي مسار من مسارات المتصفح (`/api/bootstrap` و`/api/admin/*` و`/api/session` …)، كلها `403 API_KEY_SCOPE`.
- المرحلة الأولى `GET` و`HEAD` فقط على `/api/health` و`/api/service/hr/*`. أي `POST/PATCH/PUT/DELETE` يُرفض بـ `403 API_KEY_SCOPE`.
- 20 محاولة مفتاح خاطئة خلال 15 دقيقة (مشتركة مع مفتاح المالية) تعطي `429 API_KEY_LOCKED`.

## النطاقات

| النطاق | يفتح |
| --- | --- |
| `hr.employees.read` | البحث بالاسم، والملف بالحقول غير الحساسة |
| `hr.sensitive.read` | الحقول الشخصية والطبية في الملف (الهوية، الجواز، الميلاد، التأمين الطبي…)، واستحقاق الإجازة المسجَّل |
| `hr.compensation.read` | الراتب والبدلات والآيبان والحساب والتأمينات، ومبالغ أسطر المسير ومجاميعه |
| `hr.leave.read` | رصيد الإجازة وحركاته وطلبات الإجازة |
| `hr.payroll.read` | قائمة المسيرات وتفاصيلها (بدون مبالغ إلا مع `hr.compensation.read`) |

نطاقات الكتابة معرّفة للمرحلة الثانية ولا تعمل الآن، ويرفض الخادم الإقلاع إن ضُبطت: `hr.employees.write`، `hr.leave.write`، `hr.payroll.write`، `hr.payroll.submit`.

**لا يُمنح أبدًا لمفتاح:** `hr.payroll.approve` و`hr.payroll.close`. اعتماد المسير وإغلاقه يبقى لعلي (المعتمد البشري)، والخادم يرفض الإقلاع إن ضُبط أحدهما، والدالة `serviceMayRunPayrollAction` ترفض `approve` و`close` مهما كانت النطاقات.

## التدقيق

كل رد يحمل حقولًا حساسة يكتب حدثًا في `administration_events` (`resource_type = service_access`) بالممثل `svc-sabq-accountant`، ويظهر في سجل التدقيق باسم «محاسب سبق». التفاصيل: أسماء الحقول ومعرّف المفتاح (أول 12 خانة من البصمة)، **بلا قيم**. الأحداث:

- `service_read_sensitive_profile` — قراءة حقول شخصية أو طبية من الملف
- `service_read_compensation` — قراءة الراتب أو الحساب
- `service_read_sensitive_leave` — قراءة استحقاق الإجازة
- `service_read_payroll_amounts` — قراءة مبالغ أسطر مسير

القراءات غير الحساسة (البحث، الملف العام، الرصيد، المسير بلا مبالغ) لا تكتب حدثًا.

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
{ "employees": [{ "id": "emp-example", "employeeNumber": "S-000", "name": "موظف وهمي", "title": "…", "department": "…", "status": "active" }], "total": 1 }
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

## الأخطاء

| الرمز | المعنى |
| --- | --- |
| `401 API_KEY_DISABLED` | المفتاح غير مفعّل في هذه النسخة (لا بصمات أو لا نطاقات أو وضع غير خاص) |
| `401 INVALID_API_KEY` | مفتاح خاطئ |
| `403 API_KEY_SCOPE` | المسار أو الطريقة خارج نطاق المفتاح، أو النطاق المطلوب غير ممنوح |
| `404 EMPLOYEE_NOT_FOUND` / `PAYROLL_NOT_FOUND` | المعرّف غير موجود |
| `429 API_KEY_LOCKED` | محاولات خاطئة كثيرة |

## حدود معروفة

- السياسة السنوية والمسير في البيانات الخاصة ما زالا على محرك المعاينة (`payroll-policy-demo-v2`). الرصيد والمسير المقروءان ليسا نظاميين حتى تُعتمد سياسة حقيقية.
- لا كتابة في هذه المرحلة. المرحلة الثانية (بقرار علي): تعديل الملف مباشرة مع تسجيله باسم «محاسب سبق»، وإنشاء مسودة المسير وإرسالها للمراجعة. الاعتماد والإغلاق لعلي فقط. ملاحظة للمرحلة الثانية: `payroll_runs.prepared_by` مرتبط بجدول الموظفين، فيلزم صف حساب خدمة أو تعديل المخطط.

## إنشاء المفتاح وتفعيله (بعد الدمج)

```bash
npm run hr:key -- --out /secure/path/hr-service.key --env-out /secure/path/hr-service.env --url https://HOST
```

يكتب المفتاح في ملف بصلاحية 600 خارج المستودع ويطبع البصمة فقط. في بيئة الخادم:

```
HR_SERVICE_API_KEY_HASHES=sha256:<البصمة المطبوعة>
HR_SERVICE_API_KEY_SCOPES=hr.employees.read,hr.compensation.read,hr.sensitive.read,hr.leave.read,hr.payroll.read
```

للتدوير: أضف البصمة الجديدة بفاصلة، وسلّم المفتاح الجديد، ثم احذف القديمة. للإيقاف الفوري: احذف المتغيرين وأعد النشر.
