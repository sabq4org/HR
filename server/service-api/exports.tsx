/**
 * Exports for the «محاسب سبق» HR service key: every HR export the app offers, through the same
 * generators and print templates (no forked layouts), with the key's scope masking and an
 * administration event per export (section and field names only, never values).
 *
 * | In-app export                          | Service route                                         |
 * | -------------------------------------- | ----------------------------------------------------- |
 * | Employee report (print / save PDF)     | GET /employees/:id/report.pdf                         |
 * | Employee document download             | GET /employees/:id/documents, .../:documentId/download |
 * | Issued letter print (approved request) | GET /employees/:id/letters, .../:requestId/letter.pdf |
 * | Payroll run CSV                        | GET /payroll/:id/export.csv                           |
 * | Payslip print (closed run)             | GET /payroll/:id/payslips/:employeeId/payslip.pdf     |
 * | Reports page CSV (3 types)             | GET /reports/export.csv?type=                         |
 * | Employee import template XLSX          | GET /imports/employees/template.xlsx                  |
 *
 * Field rules match the JSON routes: financial fields need hr.compensation.read; personal and
 * medical fields need hr.sensitive.read; leave balances need hr.leave.read. See
 * docs/hr-service-api.md for the full inventory, including what is not exposed and why.
 */
import type { Express, Request, Response } from 'express';
import type { AsyncDb } from '../database.js';
import type { EmployeeFile, FormValues, IssuedDocument } from '../../shared/administration.js';
import { documentCategories, employeeFields, formByKind } from '../../shared/catalog.js';
import { appendEvent, getEmployeeFile, type Actor } from '../administration/service.js';
import { route } from '../administration/common.js';
import { fault } from '../administration/validation.js';
import { decryptSensitive } from '../administration/security.js';
import { reportCsv, type ReportExportType } from '../administration/report-export.js';
import { htmlToPdf } from '../finance/chromium-pdf.js';
import { hrDocumentHtml } from '../finance/document-html.js';
import { createPayrollCommands, payrollCsv } from '../payroll/index.js';
import { employeesTemplate } from '../imports/workbook.js';
import { EmployeeProfilePaper } from '../../src/administration/EmployeeProfilePaper.js';
import { profileTabs } from '../../src/administration/profile-visibility.js';
import { PayslipPaper } from '../../src/payroll/PayslipPaper.js';
import { IssuedLetter } from '../../src/letters/paper.js';
import { SERVICE_ACCOUNT, type HrScope } from './keys.js';
import { employeeOr404, param, requireScope, type HrServiceContext } from './routes.js';

type Options = {
  db: AsyncDb;
  contextFor: (req: Request) => HrServiceContext | undefined;
  privateData: boolean;
};
type Row = Record<string, any>;
type Sensitivity = 'financial' | 'personal' | 'medical' | undefined;

const fieldByKey = new Map(employeeFields.map((field) => [field.key, field]));
const serviceActor = { id: SERVICE_ACCOUNT.id, role: SERVICE_ACCOUNT.role } as unknown as Actor;
// Internal readers, never request actors. The file is read as HR would see it and then masked
// to the key's scopes below; leave figures use the same least-privilege reader as GET .../leave.
const fileReader: Actor = { id: SERVICE_ACCOUNT.id, role: 'hr' };
const leaveReader: Actor = { id: SERVICE_ACCOUNT.id, role: 'auditor' };
const payrollServiceActor = { id: SERVICE_ACCOUNT.id, role: 'service' as const };

/** Whether the key's scopes allow a value of this sensitivity (same rule as the JSON routes). */
export function scopeAllows(scopes: readonly HrScope[], sensitivity: Sensitivity): boolean {
  if (!sensitivity) return true;
  if (sensitivity === 'financial') return scopes.includes('hr.compensation.read');
  return scopes.includes('hr.sensitive.read');
}
const fieldAllowed = (scopes: readonly HrScope[], key: string) => {
  const field = fieldByKey.get(key);
  return !!field && scopeAllows(scopes, field.sensitive as Sensitivity);
};
const categorySensitivity = (category: string) =>
  documentCategories.find((c) => c.key === category)?.sensitive as Sensitivity;

/**
 * The employee file as the key may see it. Values, visible fields and field history follow the
 * field rules; document metadata follows the category sensitivity; leave figures need
 * hr.leave.read. Administrative requests, workflow history and change reasons are not part of
 * the key's access, so they are left out of the printout.
 */
export function maskEmployeeFile(
  file: EmployeeFile,
  scopes: readonly HrScope[],
  leave: Pick<EmployeeFile, 'leaveSummary' | 'leaveMovements'> | null,
): EmployeeFile {
  const values = Object.create(null) as FormValues;
  for (const [key, value] of Object.entries(file.values))
    if (fieldAllowed(scopes, key)) values[key] = value;
  return {
    ...file,
    values,
    visibleFieldKeys: file.visibleFieldKeys.filter((key) => fieldAllowed(scopes, key)),
    fieldHistory: file.fieldHistory
      .filter((entry) => fieldAllowed(scopes, entry.fieldKey))
      .map((entry) => ({ ...entry, reason: null })),
    documents: file.documents.filter((doc) =>
      scopeAllows(scopes, categorySensitivity(doc.category)),
    ),
    requests: [],
    history: [],
    closedPayslips: [],
    leaveSummary: leave?.leaveSummary ?? {
      openingBalance: null,
      allocated: null,
      available: null,
      taken: 0,
      adjustments: 0,
      reserved: 0,
      policyApproved: false,
      balanceKnown: false,
    },
    leaveMovements: leave?.leaveMovements ?? [],
  };
}

/** Section titles the printed report will contain (for the audit event; names only). */
export function reportSections(file: EmployeeFile, includeLeave: boolean): string[] {
  const sections: string[] = ['الهوية الوظيفية'];
  sections.push(...profileTabs(file).filter((tab) => includeLeave || tab !== 'الإجازات'));
  if (file.periods.length) sections.push('فترات العمل');
  if (file.documents.length) sections.push('الوثائق');
  if (file.fieldHistory.length) sections.push('سجل التغييرات');
  return sections;
}

/** The employee report HTML for the key's scopes, plus the masked file it was drawn from. */
export async function employeeReportHtml(
  db: AsyncDb,
  employeeId: string,
  scopes: readonly HrScope[],
  dataModeLabel: string,
  generated = new Date(),
) {
  const includeLeave = scopes.includes('hr.leave.read');
  const full = await getEmployeeFile(db, fileReader, employeeId);
  const leave = includeLeave ? await getEmployeeFile(db, leaveReader, employeeId) : null;
  const file = maskEmployeeFile(full, scopes, leave);
  const managerId = full.employee.managerId;
  const manager = managerId
    ? await db.read<Row>('SELECT id,name FROM employee_access WHERE id=?', [managerId])
    : [];
  const html = hrDocumentHtml(
    `الملف الوظيفي ${full.employee.employeeNumber}`,
    <div className="employee-report-page">
      <EmployeeProfilePaper
        file={file}
        employees={manager.map((m) => ({ id: String(m.id), name: String(m.name) }))}
        dataModeLabel={dataModeLabel}
        generated={generated}
        includeLeave={includeLeave}
      />
    </div>,
  );
  return { html, file, includeLeave };
}

const safeName = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
function sendFile(res: Response, type: string, name: string, body: Buffer | string) {
  res
    .status(200)
    .type(type)
    .set('content-disposition', `attachment; filename="${name}"`)
    .set('cache-control', 'private, no-store');
  res.send(body);
}
async function pdfOr503(html: string): Promise<Buffer> {
  const bytes = await htmlToPdf(html);
  if (!bytes) throw fault(503, 'PDF_RENDERER_UNAVAILABLE', 'خدمة توليد PDF غير متاحة حاليًا.');
  return bytes;
}
function sendPdf(res: Response, name: string, bytes: Buffer) {
  res.set('x-pdf-renderer', 'chromium');
  sendFile(res, 'application/pdf', `${safeName(name)}.pdf`, bytes);
}

export function registerHrServiceExports(app: Express, { db, contextFor, privateData }: Options) {
  const payroll = createPayrollCommands(db);
  const audit = (
    context: HrServiceContext,
    resourceId: string,
    action: string,
    details: Record<string, unknown>,
  ) =>
    appendEvent(db, serviceActor, 'service_access', resourceId, action, null, {
      actorName: SERVICE_ACCOUNT.name,
      actorKind: 'service_key',
      keyId: context.keyId,
      ...details,
    });
  const dataModeLabel = privateData ? 'بيانات خاصة' : 'بيانات اصطناعية';

  // 1) Employee report: the in-app «طباعة / حفظ PDF» page, printed by Chromium on the server.
  app.get(
    '/api/service/hr/employees/:id/report.pdf',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.employees.read');
      const employee = await employeeOr404(db, param(req, 'id'));
      const { html, file, includeLeave } = await employeeReportHtml(
        db,
        employee.id,
        context.scopes,
        dataModeLabel,
      );
      const bytes = await pdfOr503(html);
      await audit(context, employee.id, 'service_export_profile_report', {
        employeeId: employee.id,
        sections: reportSections(file, includeLeave),
        included: {
          compensation: context.scopes.includes('hr.compensation.read'),
          personalAndMedical: context.scopes.includes('hr.sensitive.read'),
          leave: includeLeave,
        },
        fields: file.visibleFieldKeys.filter((key) => fieldByKey.get(key)?.sensitive).sort(),
        documents: file.documents.length,
      });
      sendPdf(res, `employee-report-${employee.employee_number}`, bytes);
    }),
  );

  // 2) Employee documents: metadata list and download, by category sensitivity.
  const documentRow = async (employeeId: string, documentId: string) =>
    (
      await db.read<Row>('SELECT * FROM employee_documents WHERE id=? AND employee_id=?', [
        documentId,
        employeeId,
      ])
    )[0];
  app.get(
    '/api/service/hr/employees/:id/documents',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.employees.read');
      const employee = await employeeOr404(db, param(req, 'id'));
      const rows = await db.read<Row>(
        'SELECT id,category,filename,mime_type,size_bytes,expires_at,uploaded_at,state,version FROM employee_documents WHERE employee_id=? ORDER BY uploaded_at DESC LIMIT 200',
        [employee.id],
      );
      const documents = rows
        .filter((row) => scopeAllows(context.scopes, categorySensitivity(row.category)))
        .map((row) => ({
          id: row.id,
          category: row.category,
          filename: row.filename,
          mimeType: row.mime_type,
          size: Number(row.size_bytes),
          expiresAt: row.expires_at,
          uploadedAt: row.uploaded_at,
          state: row.state,
          version: Number(row.version),
        }));
      res.json({ documents });
    }),
  );
  app.get(
    '/api/service/hr/employees/:id/documents/:documentId/download',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.employees.read');
      const employee = await employeeOr404(db, param(req, 'id'));
      const row = await documentRow(employee.id, param(req, 'documentId'));
      // Same answer for missing and out-of-scope documents, like the in-app download.
      if (!row || !scopeAllows(context.scopes, categorySensitivity(row.category)))
        throw fault(404, 'DOCUMENT_NOT_FOUND', 'المستند غير موجود.');
      const bytes = Buffer.from(
        decryptSensitive(row.encrypted_content, `employee-document:${row.id}`),
        'base64',
      );
      await audit(context, row.id, 'service_document_downloaded', {
        employeeId: employee.id,
        category: row.category,
      });
      res
        .status(200)
        .set('content-type', row.mime_type)
        .set('content-length', String(bytes.length))
        .set(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        )
        .set('cache-control', 'private, no-store')
        .send(bytes);
    }),
  );

  // 3) Issued letters: the copy frozen when a printable request (salary, employment and experience
  // letters, contract, amendment, clearance, settlement) was approved. Read only; issuing stays an
  // approval step. A frozen copy cannot be masked field by field, so it needs the full read set.
  // Non-printable requests (grievance, discipline, ...) never have a copy and are not exposed.
  const letterKinds = Object.values(formByKind)
    .filter((form) => form.printable)
    .map((form) => form.kind as string);
  const requireLetterScopes = (req: Request) => {
    const context = requireScope(contextFor(req), 'hr.employees.read');
    requireScope(context, 'hr.compensation.read');
    requireScope(context, 'hr.sensitive.read');
    return context;
  };
  app.get(
    '/api/service/hr/employees/:id/letters',
    route(async (req, res) => {
      requireLetterScopes(req);
      const employee = await employeeOr404(db, param(req, 'id'));
      const rows = await db.read<Row>(
        'SELECT id,request_number,kind,updated_at FROM administrative_requests WHERE employee_id=? AND issued_document_json IS NOT NULL ORDER BY updated_at DESC LIMIT 100',
        [employee.id],
      );
      res.json({
        letters: rows
          .filter((row) => letterKinds.includes(row.kind))
          .map((row) => ({
            requestId: row.id,
            number: row.request_number,
            kind: row.kind,
            title: formByKind[row.kind as keyof typeof formByKind]?.title ?? null,
            approvedAt: row.updated_at,
          })),
      });
    }),
  );
  app.get(
    '/api/service/hr/employees/:id/letters/:requestId/letter.pdf',
    route(async (req, res) => {
      const context = requireLetterScopes(req);
      const employee = await employeeOr404(db, param(req, 'id'));
      const row = (
        await db.read<Row>(
          'SELECT id,request_number,kind,issued_document_json FROM administrative_requests WHERE id=? AND employee_id=?',
          [param(req, 'requestId'), employee.id],
        )
      )[0];
      if (!row || !row.issued_document_json || !letterKinds.includes(row.kind))
        throw fault(404, 'LETTER_NOT_FOUND', 'لا توجد نسخة معتمدة لهذا الطلب.');
      let issued: IssuedDocument;
      try {
        issued = JSON.parse(
          decryptSensitive(row.issued_document_json, `issued-document:${row.id}`),
        );
      } catch {
        throw fault(500, 'ISSUED_DOCUMENT_INVALID', 'تعذر قراءة النسخة المعتمدة.');
      }
      const bytes = await pdfOr503(
        hrDocumentHtml(issued.title, <IssuedLetter document={issued} />),
      );
      await audit(context, row.id, 'service_export_issued_letter', {
        employeeId: employee.id,
        kind: row.kind,
        reference: row.request_number,
      });
      sendPdf(res, `letter-${row.request_number}`, bytes);
    }),
  );

  // 4) Payroll run CSV: the same file as «تصدير CSV» on the payroll page. Amounts need
  // hr.compensation.read on top of hr.payroll.read.
  const runOr404 = async (id: string) => {
    try {
      return await payroll.getRun(id, payrollServiceActor as never);
    } catch (error) {
      if ((error as { status?: number }).status === 404)
        throw fault(404, 'PAYROLL_NOT_FOUND', 'المسير غير موجود.');
      throw error;
    }
  };
  app.get(
    '/api/service/hr/payroll/:id/export.csv',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.payroll.read');
      requireScope(context, 'hr.compensation.read');
      const run = await runOr404(param(req, 'id'));
      const csv = payrollCsv(run);
      await audit(context, run.id, 'service_export_payroll_csv', {
        period: run.period,
        state: run.state,
        lines: run.lines.length,
        fields: ['amount', 'component', 'employeeName', 'kind', 'source'],
      });
      sendFile(
        res,
        'text/csv; charset=utf-8',
        `payroll-${safeName(run.period)}.csv`,
        '\uFEFF' + csv,
      );
    }),
  );

  // 5) Payslip: the in-app «طباعة كشف الراتب» sheet, closed runs only (as in the app).
  app.get(
    '/api/service/hr/payroll/:id/payslips/:employeeId/payslip.pdf',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.payroll.read');
      requireScope(context, 'hr.compensation.read');
      const run = await runOr404(param(req, 'id'));
      const employeeId = param(req, 'employeeId');
      if (run.state !== 'closed')
        throw fault(409, 'PAYROLL_NOT_CLOSED', 'كشف الراتب متاح للمسيرات المغلقة فقط.');
      if (!run.lines.some((line) => line.employeeId === employeeId))
        throw fault(404, 'PAYSLIP_NOT_FOUND', 'لا يوجد كشف لهذا الموظف في المسير.');
      const bytes = await pdfOr503(
        hrDocumentHtml(
          `كشف راتب ${run.period}`,
          <section className="payroll-page" dir="rtl">
            <PayslipPaper run={run} employeeId={employeeId} />
          </section>,
        ),
      );
      await audit(context, run.id, 'service_export_payslip', {
        period: run.period,
        employeeId,
        fields: ['amount', 'component', 'kind', 'net'],
      });
      sendPdf(res, `payslip-${run.period}-${employeeId}`, bytes);
    }),
  );

  // 6) Reports page CSVs. The employee directory is the HR view (names); requests and
  // attendance are counts and states without employee identities.
  app.get(
    '/api/service/hr/reports/export.csv',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.employees.read');
      const type = String(req.query.type ?? '');
      if (!['employees', 'requests', 'attendance'].includes(type))
        throw fault(400, 'INVALID_EXPORT', 'حدد نوع تقرير صالحًا.');
      const csv = await reportCsv(db, type as ReportExportType, false);
      await audit(context, type, 'service_export_report_csv', {
        type,
        rows: Math.max(0, csv.split('\r\n').length - 1),
      });
      sendFile(res, 'text/csv; charset=utf-8', `${type}.csv`, '\uFEFF' + csv);
    }),
  );

  // 7) The blank employee import template (no employee data).
  app.get(
    '/api/service/hr/imports/employees/template.xlsx',
    route(async (req, res) => {
      const context = requireScope(contextFor(req), 'hr.employees.read');
      const bytes = await employeesTemplate();
      await audit(context, 'employees-template', 'service_export_import_template', {});
      sendFile(
        res,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'sabq-employees-template.xlsx',
        bytes,
      );
    }),
  );
}
