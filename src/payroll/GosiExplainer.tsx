// Plain-language explanation of how the payroll computes social insurance (GOSI). Every number
// shown comes from the approved rule version passed in; nothing here is a rate of its own.
import {
  GOSI_CATEGORIES,
  GOSI_CATEGORY_LABEL,
  gosiContribution,
  type GosiRule,
} from '../../shared/gosi';

const riyal = (minor: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** Example salary for the worked table: 10,000 basic and 2,500 housing, in halalas. */
const EXAMPLE = { basicSalary: 1_000_000, housingAllowance: 250_000, transportAllowance: 100_000 };

const CATEGORY_NOTE: Record<(typeof GOSI_CATEGORIES)[number], string> = {
  saudi_existing:
    'سعودي له اشتراك سابق في التأمينات قبل سريان نظام التأمينات الاجتماعية الجديد (3 يوليو 2024).',
  saudi_new:
    'سعودي يُسجَّل في التأمينات لأول مرة بعد سريان النظام الجديد. نسبة المعاش فيه ترتفع تدريجيًا كل يوليو، فيُدخل إصدار قواعد جديد بتاريخ سريان عند كل زيادة.',
  non_saudi: 'غير السعودي يُشترك عنه في الأخطار المهنية فقط، وهي على صاحب العمل.',
};

export function GosiExplainer({ rule }: { rule: GosiRule }) {
  const housing = rule.wageComponents.includes('housingAllowance');
  return (
    <details className="gosi-explainer">
      <summary>كيف تُحسب التأمينات الاجتماعية في المسير؟</summary>
      <ol>
        <li>
          <b>من يخضع:</b> الموظف الرسمي فقط، بحسب «نوع الارتباط في المسير» في ملفه. المتعاون يُصرف له
          المبلغ المقطوع كما هو بلا تأمينات.
        </li>
        <li>
          <b>الأجر الخاضع:</b> {housing ? 'الراتب الأساسي مع بدل السكن' : 'الراتب الأساسي'}، ولا
          يدخل فيه بدل النقل ولا البدلات الأخرى ولا المكافآت. لا يتجاوز {riyal(rule.maxWageMinor)}{' '}
          ريال
          {rule.minWageMinor > 0 ? ` ولا يقل عن ${riyal(rule.minWageMinor)} ريال` : ''}.
        </li>
        <li>
          <b>مكونات النسبة:</b> المعاشات (على الموظف وصاحب العمل)، والتأمين ضد التعطل عن العمل
          «ساند» للسعوديين (على الطرفين)، والأخطار المهنية (على صاحب العمل وحده).
        </li>
        <li>
          <b>نسبة واحدة لكل فئة:</b> تُطبق على كل موظفي الفئة بالطريقة نفسها، ولا تُعدل لموظف بعينه.
          فئة الموظف تُقرأ من ملفه.
          <ul>
            {GOSI_CATEGORIES.map((key) => (
              <li key={key}>
                <b>{GOSI_CATEGORY_LABEL[key]}</b> ({pct(rule.categories[key].employeeBps)} على
                الموظف، {pct(rule.categories[key].employerBps)} على صاحب العمل):{' '}
                {CATEGORY_NOTE[key]}
              </li>
            ))}
          </ul>
        </li>
        <li>
          <b>في المسير:</b> حصة الموظف تُخصم من راتبه في عمود «تأمين الموظف». حصة صاحب العمل تظهر في
          الملخص ولا تُخصم من الصافي، وتُسدد للتأمينات من الشركة. التقريب إلى أقرب هللة، ويُعاد الحساب
          تلقائيًا بعد كل تعديل على المسير.
        </li>
        <li>
          <b>تغيير النسب:</b> لا تُعدل نسبة في إصدار معتمد. أي تغيير يكون بإصدار جديد بتاريخ سريان
          ومصدر، يعتمده المدير العام.
        </li>
      </ol>
      <table className="gosi-example">
        <caption>
          مثال: أساسي 10,000 وسكن 2,500 ونقل 1,000 ريال. الأجر الخاضع{' '}
          {riyal(gosiContribution(rule, 'non_saudi', EXAMPLE).wageMinor)} ريال.
        </caption>
        <thead>
          <tr>
            <th>الفئة</th>
            <th>يُخصم من الموظف</th>
            <th>على صاحب العمل</th>
          </tr>
        </thead>
        <tbody>
          {GOSI_CATEGORIES.map((key) => {
            const share = gosiContribution(rule, key, EXAMPLE);
            return (
              <tr key={key}>
                <td>{GOSI_CATEGORY_LABEL[key]}</td>
                <td className="num">{riyal(share.employeeMinor)}</td>
                <td className="num">{riyal(share.employerMinor)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
