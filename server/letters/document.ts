import type { AsyncDb } from '../database.js';
import type { FormValues, IssuedDocument, RequestKind } from '../../shared/administration.js';
import { formByKind } from '../../shared/catalog.js';
import { getProfileValues, readEmployee, type Actor } from '../administration/service.js';

export async function createIssuedDocument(
  db: AsyncDb,
  request: {
    id: string;
    number: string;
    kind: RequestKind;
    employeeId: string;
    values: FormValues;
  },
  actor: Actor,
): Promise<IssuedDocument> {
  const employee = await readEmployee(db, request.employeeId);
  if (!employee)
    throw Object.assign(new Error('الملف الوظيفي غير موجود.'), {
      status: 404,
      code: 'EMPLOYEE_NOT_FOUND',
    });
  const profile = await getProfileValues(db, request.employeeId);
  const approver = await readEmployee(db, actor.id);
  const en = request.kind === 'salary_letter' && request.values.language === 'en';
  const fact = (ar: string, english: string, value: unknown) => ({
    label: en ? english : ar,
    value:
      value === undefined || value === null || value === ''
        ? en
          ? 'Not recorded'
          : 'غير مسجل'
        : String(value),
  });
  const currency = (v: unknown) =>
    new Intl.NumberFormat(en ? 'en-GB' : 'ar-SA-u-nu-latn', {
      style: 'currency',
      currency: 'SAR',
    }).format(Number(v));
  const facts = [
    fact('الموظف', 'Employee', en ? profile.englishName || employee.name : employee.name),
    fact('الرقم الوظيفي', 'Employee number', employee.employee_number),
    fact('المسمى الوظيفي', 'Job title', employee.title),
    fact('الإدارة', 'Department', employee.department),
    fact('تاريخ المباشرة', 'Employment start', employee.join_date),
  ];
  let paragraphs: string[];
  if (request.kind === 'salary_letter') {
    const salaryFields = [
      ['basicSalary', 'الأساسي', 'Basic salary'],
      ['housingAllowance', 'بدل السكن', 'Housing allowance'],
      ['transportAllowance', 'بدل النقل', 'Transport allowance'],
      ['otherAllowance', 'بدلات ثابتة أخرى', 'Other fixed allowances'],
    ];
    let total = 0;
    let recorded = false;
    for (const [key, ar, eng] of salaryFields) {
      if (typeof profile[key] === 'number') {
        total += Math.round(Number(profile[key]) * 100);
        recorded = true;
        facts.push(fact(ar, eng, currency(profile[key])));
      }
    }
    facts.push(
      fact(
        'إجمالي العناصر المسجلة',
        'Total recorded components',
        recorded ? currency(total / 100) : undefined,
      ),
    );
    paragraphs = en
      ? [
          'This internal preview records the employment and salary information available in the synthetic employee file at the time of approval.',
          'Issued upon the employee’s request for the recipient below. All identities and amounts are fictional; this is not an official or signed salary certificate.',
        ]
      : [
          'نورد أدناه بيانات العمل وعناصر الأجر المسجلة في الملف الوظيفي الاصطناعي وقت اعتماد الطلب.',
          'أُعد هذا التعريف بناءً على طلب الموظف للجهة المحددة. الأسماء والمبالغ تجريبية، ولا تمثل هذه المعاينة خطابًا رسميًا أو موقعًا.',
        ];
  } else if (request.kind === 'employment_letter') {
    facts.push(
      fact(
        'الحالة الوظيفية',
        'Employment status',
        (
          {
            active: 'على رأس العمل',
            on_leave: 'في إجازة',
            suspended: 'موقوف',
            terminated: 'منتهية الخدمة',
          } as Record<string, string>
        )[employee.status],
      ),
    );
    paragraphs = [
      'يفيد هذا التعريف الداخلي بأن بيانات الموظف وعلاقته الوظيفية مسجلة كما هو موضح أدناه وقت اعتماد الطلب.',
      'أُعد للغرض الذي حدده صاحب الطلب، اعتمادًا على بيانات المعاينة الاصطناعية.',
    ];
  } else if (request.kind === 'experience_letter') {
    const periods = await db.read<{ start_date: string; end_date: string | null }>(
      'SELECT start_date,end_date FROM employment_periods WHERE employee_id=? ORDER BY start_date',
      [employee.id],
    );
    periods.forEach((p, i) =>
      facts.push(
        fact(
          `فترة العمل ${i + 1}`,
          'Employment period',
          `${p.start_date} — ${p.end_date || 'مستمرة بحسب السجل'}`,
        ),
      ),
    );
    paragraphs = [
      'توضح هذه الشهادة الداخلية فترات العمل المسجلة والمهام التي روجعت ضمن هذا الطلب.',
      String(request.values.duties || ''),
    ];
  } else {
    paragraphs = [
      `نسخة داخلية من ${formByKind[request.kind].title}، تحفظ البيانات التي راجعها المعتمد وقت اتخاذ القرار. لا تمثل هذه النسخة توقيعًا قانونيًا أو إثبات صرف.`,
    ];
  }
  for (const field of formByKind[request.kind].fields) {
    const value = request.values[field.key];
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      ['recipient', 'language', 'duties'].includes(field.key)
    )
      continue;
    facts.push(
      fact(
        field.label,
        field.key,
        field.type === 'money'
          ? currency(value)
          : field.type === 'select'
            ? (field.options?.find((o) => o.value === value)?.label ?? value)
            : field.type === 'checkbox'
              ? value
                ? 'نعم'
                : 'لا'
              : value,
      ),
    );
  }
  return {
    title: en ? 'Salary certificate — synthetic preview' : formByKind[request.kind].title,
    language: en ? 'en' : 'ar',
    reference: request.number,
    issuedAt: new Date().toISOString(),
    recipient: String(
      request.values.recipient || (en ? 'To whom it may concern' : 'لمن يهمه الأمر'),
    ),
    paragraphs,
    facts,
    approvedByName: approver?.name ?? 'معتمد تجريبي',
    version: 1,
  };
}
