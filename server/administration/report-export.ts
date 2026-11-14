import type { AsyncDb } from '../database.js';
import { csvCell } from './validation.js';

export type ReportExportType = 'employees' | 'requests' | 'attendance';
/**
 * CSV body of the reports page exports (no BOM). Shared by GET /api/admin/reports/export and the
 * HR service key's GET /api/service/hr/reports/export.csv. `masked` is the auditor view.
 */
export async function reportCsv(db: AsyncDb, type: ReportExportType, masked: boolean) {
  let csv = '';
  if (type === 'employees') {
    const rows = await db.read<any>(
      'SELECT employee_number,name,title,department,status FROM employee_access ORDER BY employee_number',
    );
    csv = [
      'employee_number,name,title,department,status',
      ...rows.map((r) =>
        [
          r.employee_number,
          masked ? 'موظف' : r.name,
          r.title,
          masked ? 'محجوب' : r.department,
          r.status,
        ]
          .map(csvCell)
          .join(','),
      ),
    ].join('\r\n');
  } else if (type === 'requests') {
    const rows = await db.read<any>(
      'SELECT request_number,kind,state,created_at,updated_at FROM administrative_requests ORDER BY created_at',
    );
    csv = [
      'number,kind,state,created_at,updated_at',
      ...rows.map((r) =>
        [r.request_number, r.kind, r.state, r.created_at, r.updated_at].map(csvCell).join(','),
      ),
    ].join('\r\n');
  } else {
    const rows = await db.read<any>(
      'SELECT work_date,state,COUNT(*) AS count FROM attendance_records GROUP BY work_date,state ORDER BY work_date',
    );
    csv = [
      'date,state,count',
      ...rows.map((r) => [r.work_date, r.state, r.count].map(csvCell).join(',')),
    ].join('\r\n');
  }
  return csv;
}
