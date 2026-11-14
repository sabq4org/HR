// The printed payslip of one employee in a closed run. Shared by the in-app print (window.print)
// and the server PDF (server/service-api/exports.ts).
import type { PayrollRun } from '../../shared/administration';
export const money = (n: number) =>
  new Intl.NumberFormat('ar-SA-u-nu-latn', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n / 100) + ' ر.س';
export function PayslipPaper({ run, employeeId }: { run: PayrollRun; employeeId: string }) {
  const printableLines = run.lines.filter((l) => l.employeeId === employeeId);
  const printableEmployee = printableLines[0]?.employeeName ?? '';
  const printableEarnings = printableLines
    .filter((l) => l.kind === 'earning')
    .reduce((n, l) => n + l.amountMinor, 0);
  const printableDeductions = printableLines
    .filter((l) => l.kind === 'deduction')
    .reduce((n, l) => n + l.amountMinor, 0);
  return (
    <section className="payroll-print-sheet" aria-label="كشف راتب الموظف">
      <header>
        <div>
          <h1>كشف راتب</h1>
          <p>{printableEmployee}</p>
          <p>الفترة {run.period}</p>
        </div>
        <strong>{run.correctionOf ? 'فرق تصحيحي مرتبط' : 'مسير مغلق'}</strong>
      </header>
      <div className="print-total">
        صافي {run.correctionOf ? 'فرق التصحيح' : 'الراتب'}:{' '}
        {money(printableEarnings - printableDeductions)}
      </div>
      <table>
        <thead>
          <tr>
            <th>المكوّن</th>
            <th>النوع</th>
            <th>المبلغ</th>
          </tr>
        </thead>
        <tbody>
          {printableLines.map((line) => (
            <tr key={line.id}>
              <td>{line.component}</td>
              <td>{line.kind === 'earning' ? 'استحقاق' : 'استقطاع'}</td>
              <td>{money(line.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer>هذا كشف داخلي لبيانات اصطناعية، ولا يمثل احتسابًا نظاميًا أو أمر تحويل مالي.</footer>
    </section>
  );
}
