import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type { AsyncDb } from '../database.js';
import type { PayrollLine, PayrollRun } from '../../shared/administration.js';
import { getApprovedPayrollSource, getProfileValues } from '../administration/service.js';
import { decryptSensitive, encryptSensitive } from '../administration/security.js';

type Actor = {
  id: string;
  role: 'employee' | 'manager' | 'hr' | 'finance' | 'approver' | 'auditor';
};
type Options = { db: AsyncDb; requireActor: (req: Request) => Actor | Promise<Actor> };
type Row = Record<string, any>;
const now = () => new Date().toISOString();
const fail = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decimalRiyalToMinor(value: unknown): number | null {
  const input = String(value ?? '').trim();
  const match = input.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const minor = whole * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

export function registerPayroll(app: Express, { db, requireActor }: Options) {
  const route = (
    method: 'get' | 'post' | 'patch',
    path: string,
    handler: (req: Request, actor: Actor) => Promise<unknown>,
  ) => {
    app[method](`/api/admin${path}`, async (req, res) => {
      try {
        const value = await handler(req, await requireActor(req));
        if (path.endsWith('/export'))
          res.type('text/csv; charset=utf-8').attachment('payroll.csv').send(value);
        else res.json(value);
      } catch (e) {
        const err = e as any;
        res.status(err.status ?? 500).json({
          error: {
            code: err.code ?? 'internal_error',
            message: err.status ? err.message : 'تعذرت معالجة الطلب.',
          },
        });
      }
    });
  };
  async function getRun(id: string, actor: Actor, query: AsyncDb = db): Promise<PayrollRun> {
    const r = (await query.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [id]))[0];
    if (!r) throw fail(404, 'not_found', 'المسير غير موجود.');
    // Approvers see runs that reached their step, including runs they (or a peer approver)
    // rejected at that step; a run rejected by finance never had reviewed_by set.
    if (
      actor.role === 'approver' &&
      !['pending_approver', 'closed'].includes(r.state) &&
      !(r.state === 'rejected' && r.reviewed_by)
    )
      throw fail(404, 'not_found', 'المسير غير موجود.');
    const lines = await query.read<Row>(
      `SELECT l.*,e.name employee_name FROM payroll_lines l JOIN employee_access e ON e.id=l.employee_id WHERE l.run_id=? ORDER BY e.name,l.id`,
      [id],
    );
    if (
      ['employee', 'manager'].includes(actor.role) &&
      (r.state !== 'closed' || !lines.some((l) => l.employee_id === actor.id))
    )
      throw fail(404, 'not_found', 'المسير غير موجود.');
    if (!['employee', 'manager', 'hr', 'finance', 'approver', 'auditor'].includes(actor.role))
      throw fail(403, 'forbidden', 'لا تملك صلاحية الاطلاع.');
    const visible = ['employee', 'manager'].includes(actor.role)
      ? lines.filter((l) => l.employee_id === actor.id)
      : lines;
    const payments = ['employee', 'manager'].includes(actor.role)
      ? await query.read<Row>(
          'SELECT employee_id,state,paid_minor,encrypted_reference,recorded_at FROM payroll_payments WHERE run_id=? AND employee_id=?',
          [id, actor.id],
        )
      : await query.read<Row>(
          'SELECT employee_id,state,paid_minor,encrypted_reference,recorded_at FROM payroll_payments WHERE run_id=?',
          [id],
        );
    const earningsMinor = visible
      .filter((l) => l.kind === 'earning')
      .reduce((n, l) => n + Number(l.amount_minor), 0);
    const deductionsMinor = visible
      .filter((l) => l.kind === 'deduction')
      .reduce((n, l) => n + Number(l.amount_minor), 0);
    if (!Number.isSafeInteger(earningsMinor) || !Number.isSafeInteger(deductionsMinor))
      throw fail(500, 'payroll_total_invalid', 'مجموع المسير يتجاوز دقة العملة الآمنة.');
    const events = await query.read<Row>(
      'SELECT pe.*,COALESCE(e.name,pe.actor_id) actor_name FROM payroll_events pe LEFT JOIN employee_access e ON e.id=pe.actor_id WHERE pe.run_id=? ORDER BY pe.created_at,pe.id',
      [id],
    );
    return {
      id: r.id,
      period: r.period,
      version: Number(r.version),
      state: r.state,
      preparedBy: actor.role === 'auditor' ? 'redacted' : r.prepared_by,
      reviewedBy: actor.role === 'auditor' ? (r.reviewed_by ? 'redacted' : null) : r.reviewed_by,
      approvedBy: actor.role === 'auditor' ? (r.approved_by ? 'redacted' : null) : r.approved_by,
      policyId: r.policy_id,
      correctionOf: r.correction_of,
      reason: actor.role === 'auditor' ? '[معلومة محمية]' : r.reason,
      lines: visible.map((l, index): PayrollLine => ({
        id: l.id,
        employeeId: actor.role === 'auditor' ? '' : l.employee_id,
        employeeName: actor.role === 'auditor' ? `موظف ${index + 1}` : l.employee_name,
        component: l.component,
        kind: l.kind,
        amountMinor: Number(l.amount_minor),
        source: actor.role === 'auditor' ? 'مصدر مالي معتمد' : l.source,
        sourceRequestId: actor.role === 'auditor' ? null : l.source_request_id,
      })),
      payments: payments.map((p) => ({
        employeeId: actor.role === 'auditor' ? '' : p.employee_id,
        state: p.state,
        paidMinor: Number(p.paid_minor),
        reference:
          actor.role === 'finance'
            ? decryptSensitive(p.encrypted_reference, `payroll-payment:${id}:${p.employee_id}`)
            : '',
        recordedAt: p.recorded_at,
      })),
      totals: { earningsMinor, deductionsMinor, netMinor: earningsMinor - deductionsMinor },
      createdAt: r.created_at,
      closedAt: r.closed_at,
      canEdit: actor.role === 'hr' && r.state === 'draft' && r.prepared_by === actor.id,
      canReview:
        actor.role === 'finance' && r.state === 'pending_finance' && r.prepared_by !== actor.id,
      timeline: events.map((e) => ({
        id: e.id,
        actorId: actor.role === 'auditor' ? '' : e.actor_id,
        actorName: actor.role === 'auditor' ? e.actor_role : e.actor_name,
        role: e.actor_role,
        action: e.action,
        reason: actor.role === 'auditor' ? (e.reason ? '[معلومة محمية]' : null) : e.reason,
        createdAt: e.created_at,
        version: Number(e.version),
      })),
    };
  }
  async function validateRunNet(tx: AsyncDb, run: Row, requireCorrection: boolean) {
    const lines = await tx.read<Row>(
      'SELECT employee_id,kind,amount_minor FROM payroll_lines WHERE run_id=?',
      [run.id],
    );
    const deltas = new Map<string, number>();
    let nonZero = false;
    for (const line of lines) {
      const amount = Number(line.amount_minor) * (line.kind === 'earning' ? 1 : -1);
      if (amount) nonZero = true;
      deltas.set(line.employee_id, (deltas.get(line.employee_id) || 0) + amount);
      if (!Number.isSafeInteger(deltas.get(line.employee_id)))
        throw fail(400, 'payroll_total_invalid', 'مجموع أسطر الموظف يتجاوز دقة العملة الآمنة.');
    }
    if (requireCorrection && run.correction_of && !nonZero)
      throw fail(409, 'empty_correction', 'أدخل فرقًا ماليًا قبل اعتماد مسير التصحيح.');
    let base = new Map<string, number>();
    if (run.correction_of) {
      const original = await tx.read<Row>(
        "SELECT employee_id,kind,amount_minor FROM payroll_lines WHERE run_id=? AND (SELECT state FROM payroll_runs WHERE id=?)='closed'",
        [run.correction_of, run.correction_of],
      );
      for (const line of original) {
        const amount = Number(line.amount_minor) * (line.kind === 'earning' ? 1 : -1);
        base.set(line.employee_id, (base.get(line.employee_id) || 0) + amount);
        if (!Number.isSafeInteger(base.get(line.employee_id)))
          throw fail(400, 'payroll_total_invalid', 'مجموع المسير الأصلي يتجاوز دقة العملة الآمنة.');
      }
    }
    for (const [employeeId, delta] of deltas) {
      if (!Number.isSafeInteger((base.get(employeeId) || 0) + delta))
        throw fail(400, 'payroll_total_invalid', 'مجموع التصحيح يتجاوز دقة العملة الآمنة.');
      if ((base.get(employeeId) || 0) + delta < 0)
        throw fail(400, 'negative_net', 'لا يمكن أن يقل الصافي بعد التصحيح عن صفر.');
      if (run.correction_of && !base.has(employeeId))
        throw fail(
          400,
          'correction_employee_missing',
          'لا يمكن تصحيح موظف غير موجود في المسير الأصلي.',
        );
    }
  }
  async function replay<T>(
    req: Request,
    actor: Actor,
    action: string,
    payload: unknown,
    work: (tx: AsyncDb) => Promise<T>,
  ): Promise<T> {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 200)
      throw fail(400, 'idempotency_key_required', 'مفتاح Idempotency-Key مطلوب.');
    const digest = hash(payload);
    return db.transaction(async (tx) => {
      const prior = (
        await tx.read<Row>(
          'SELECT payload_hash,response_json FROM payroll_commands WHERE actor_id=? AND action=? AND command_key=?',
          [actor.id, action, key],
        )
      )[0];
      if (prior) {
        if (prior.payload_hash !== digest)
          throw fail(409, 'idempotency_conflict', 'استُخدم المفتاح نفسه بمحتوى مختلف.');
        const replayed = JSON.parse(prior.response_json) as {
          resource?: string;
          id?: string;
          excludedCount?: number;
        };
        if (replayed.resource !== 'payroll_run' || !replayed.id)
          throw fail(500, 'idempotency_record_invalid', 'تعذر التحقق من نتيجة العملية السابقة.');
        return {
          run: await getRun(replayed.id, actor, tx),
          ...(Number.isSafeInteger(replayed.excludedCount)
            ? { excludedCount: replayed.excludedCount }
            : {}),
        } as T;
      }
      const result = await work(tx);
      const runId = (result as { run?: { id?: string } } | null)?.run?.id;
      if (!runId) throw fail(500, 'idempotency_record_invalid', 'تعذر حفظ نتيجة العملية.');
      const excludedCount = (result as { excludedCount?: number }).excludedCount;
      await tx.execute(
        'INSERT INTO payroll_commands(actor_id,action,command_key,payload_hash,response_json,created_at) VALUES(?,?,?,?,?,?)',
        [
          actor.id,
          action,
          key,
          digest,
          JSON.stringify({
            resource: 'payroll_run',
            id: runId,
            ...(Number.isSafeInteger(excludedCount) ? { excludedCount } : {}),
          }),
          now(),
        ],
      );
      return result;
    });
  }
  route('get', '/payroll', async (req, actor) => {
    const rows = await db.read<Row>(
      ['employee', 'manager'].includes(actor.role)
        ? "SELECT * FROM payroll_runs WHERE state='closed' ORDER BY period DESC"
        : actor.role === 'approver'
          ? "SELECT * FROM payroll_runs WHERE state IN ('pending_approver','closed') ORDER BY created_at DESC"
          : 'SELECT * FROM payroll_runs ORDER BY created_at DESC',
    );
    const runs = [];
    for (const row of rows) {
      try {
        runs.push(await getRun(row.id, actor));
      } catch (e) {
        if ((e as any).status !== 404) throw e;
      }
    }
    return { runs };
  });
  route('get', '/payroll/sources', async (_req, actor) => {
    if (actor.role !== 'hr')
      throw fail(403, 'forbidden', 'مصادر الإضافات المعتمدة متاحة للموارد البشرية فقط.');
    const approved = await db.read<Row>(
      "SELECT id FROM administrative_requests WHERE state='approved' AND kind IN ('reward','overtime') ORDER BY created_at,id",
    );
    const options = [];
    for (const row of approved) {
      if (
        (
          await db.read<Row>('SELECT 1 found FROM payroll_lines WHERE source_request_id=?', [
            row.id,
          ])
        ).length
      )
        continue;
      const source = await getApprovedPayrollSource(db, row.id);
      if (
        source.kind === 'overtime' &&
        (source.values.compensation !== 'payment' || source.values.consent !== true)
      )
        continue;
      const amountMinor = decimalRiyalToMinor(source.values.amount);
      if (amountMinor === null || amountMinor <= 0) continue;
      const employee = (
        await db.read<Row>('SELECT name FROM employee_access WHERE id=?', [source.employeeId])
      )[0];
      if (!employee) continue;
      options.push({
        id: source.id,
        kind: source.kind,
        employeeId: source.employeeId,
        employeeName: employee.name,
        amountMinor,
        label: source.kind === 'reward' ? 'مكافأة معتمدة' : 'عمل إضافي معتمد',
      });
    }
    return { sources: options };
  });
  route('get', '/payroll/:id', async (req, actor) => ({
    run: await getRun(String(req.params.id), actor),
  }));
  route('post', '/payroll', async (req, actor) => {
    if (actor.role !== 'hr') throw fail(403, 'forbidden', 'إنشاء المسير متاح للموارد البشرية فقط.');
    const { period, policyId = 'payroll-policy-demo-v2', reason, correctionOf } = req.body ?? {};
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) ||
      typeof reason !== 'string' ||
      reason.trim().length < 3
    )
      throw fail(400, 'invalid_input', 'أدخل فترة صحيحة وسببًا واضحًا.');
    const result = await replay(
      req,
      actor,
      'create',
      { period, policyId, reason, correctionOf },
      async (tx) => {
        const policy = (
          await tx.read<Row>(
            "SELECT * FROM administrative_policies WHERE id=? AND state='synthetic_approved'",
            [policyId],
          )
        )[0];
        if (!policy) throw fail(400, 'policy_unavailable', 'إصدار القواعد غير متاح.');
        const calculation = JSON.parse(policy.values_json);
        if (
          policy.policy_key !== 'payroll-demo' ||
          calculation.currency !== 'SAR' ||
          calculation.calculation !== 'synthetic-profile-components'
        )
          throw fail(
            400,
            'unsupported_calculator',
            'إصدار القواعد لا يطابق حاسبة مكونات الملف الاصطناعية.',
          );
        const periodStart = `${period}-01`;
        const periodEnd = new Date(
          Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0),
        )
          .toISOString()
          .slice(0, 10);
        if (
          policy.effective_from > periodStart ||
          (policy.effective_to && policy.effective_to < periodEnd)
        )
          throw fail(400, 'policy_out_of_period', 'إصدار القواعد لا يسري على فترة المسير.');
        let original: Row | undefined;
        if (correctionOf) {
          original = (
            await tx.read<Row>("SELECT * FROM payroll_runs WHERE id=? AND state='closed'", [
              correctionOf,
            ])
          )[0];
          if (!original) throw fail(400, 'invalid_correction', 'المسير الأصلي المغلق غير موجود.');
          if (original.period !== period)
            throw fail(
              400,
              'correction_period_mismatch',
              'يجب أن يطابق مسير التصحيح فترة المسير الأصلي.',
            );
        } else {
          const existing = (
            await tx.read<Row>(
              "SELECT id FROM payroll_runs WHERE period=? AND correction_of IS NULL AND state<>'rejected'",
              [period],
            )
          )[0];
          if (existing)
            throw fail(
              409,
              'period_already_exists',
              'يوجد مسير أساسي لهذه الفترة؛ استخدم مسير تصحيح مرتبط عند الحاجة.',
            );
        }
        const id = randomUUID(),
          created = now();
        await tx.execute(
          "INSERT INTO payroll_runs(id,period,version,state,prepared_by,policy_id,correction_of,reason,created_at,updated_at) VALUES(?,?,1,'draft',?,?,?,?,?,?)",
          [id, period, actor.id, policyId, correctionOf ?? null, reason.trim(), created, created],
        );
        let excludedCount = 0;
        if (original) {
          const priorLines = await tx.read<Row>(
            'SELECT employee_id,component,kind FROM payroll_lines WHERE run_id=?',
            [original.id],
          );
          for (const line of priorLines)
            await tx.execute(
              'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
              [
                randomUUID(),
                id,
                line.employee_id,
                `فرق: ${line.component}`,
                line.kind,
                0,
                `Adjustment placeholder; linked to ${original.id}`,
                null,
                created,
              ],
            );
        } else {
          const people = await tx.read<Row>(
            "SELECT id,name FROM employee_access WHERE status='active' AND role NOT IN ('finance','approver') AND id<>? ORDER BY id",
            [actor.id],
          );
          for (const person of people) {
            const profile = await getProfileValues(tx, person.id);
            const salaryComponents = [
              ['الراتب الأساسي', 'basicSalary'],
              ['بدل السكن', 'housingAllowance'],
              ['بدل النقل', 'transportAllowance'],
              ['بدلات ثابتة أخرى', 'otherAllowance'],
            ] as const;
            const components = salaryComponents.map(([component, key]) => ({
              component,
              amountMinor: decimalRiyalToMinor(profile[key]),
            }));
            if (
              components.some(
                (component) => component.amountMinor === null || component.amountMinor < 0,
              ) ||
              components.every((component) => component.amountMinor === 0)
            ) {
              excludedCount += 1;
              continue;
            }
            for (const component of components) {
              if (!component.amountMinor) continue;
              await tx.execute(
                'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
                [
                  randomUUID(),
                  id,
                  person.id,
                  component.component,
                  'earning',
                  component.amountMinor,
                  'الملف الوظيفي الاصطناعي؛ قيمة عرض فقط بلا احتساب نظامي.',
                  null,
                  created,
                ],
              );
            }
          }
          const count = (
            await tx.read<Row>('SELECT COUNT(*) count FROM payroll_lines WHERE run_id=?', [id])
          )[0];
          if (Number(count?.count ?? 0) === 0)
            throw fail(
              400,
              'no_salary_profiles',
              'لا توجد ملفات رواتب اصطناعية مكتملة؛ أضف المكونات للملف قبل إعداد المسير.',
            );
        }
        await tx.execute(
          'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
          [randomUUID(), id, actor.id, actor.role, 'created', reason.trim(), created, 1],
        );
        return { run: await getRun(id, actor, tx), ...(correctionOf ? {} : { excludedCount }) };
      },
    );
    return result;
  });
  route('patch', '/payroll/:id', async (req, actor) => {
    if (actor.role !== 'hr') throw fail(403, 'forbidden', 'تعديل المسير متاح للموارد البشرية فقط.');
    const body = req.body ?? {};
    return replay(req, actor, `edit:${req.params.id}`, body, async (tx) => {
      const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]))[0];
      if (!run) throw fail(404, 'not_found', 'المسير غير موجود.');
      if (run.state !== 'draft' || run.prepared_by !== actor.id)
        throw fail(409, 'immutable_or_forbidden', 'لا يمكن تعديل هذا المسير.');
      if (Number(body.version) !== Number(run.version))
        throw fail(409, 'version_conflict', 'تغير المسير؛ حدّث الصفحة ثم أعد المحاولة.');
      if (
        !Array.isArray(body.lines) ||
        typeof body.reason !== 'string' ||
        body.reason.trim().length < 3
      )
        throw fail(400, 'invalid_input', 'الأسطر والسبب مطلوبان.');
      const ids = new Set<string>();
      const sources = new Set<string>();
      for (const line of body.lines) {
        const identity = `${line.employeeId}:${line.component}:${line.kind}`;
        if (
          !line.employeeId ||
          ids.has(identity) ||
          !['earning', 'deduction'].includes(line.kind) ||
          !Number.isSafeInteger(line.amountMinor) ||
          line.amountMinor < 0 ||
          !line.component
        )
          throw fail(400, 'invalid_line', 'سطر راتب غير صالح أو مكرر.');
        // Separation of duties: the preparer never enters a line for their own pay.
        if (line.employeeId === actor.id)
          throw fail(
            403,
            'preparer_cannot_include_self',
            'لا يضيف معدّ المسير سطرًا لراتبه؛ يُعدّ راتبه في مسير يعده زميل آخر.',
          );
        const subject = (
          await tx.read<Row>('SELECT status FROM employee_access WHERE id=?', [
            String(line.employeeId),
          ])
        )[0];
        if (!subject || ['terminated', 'suspended'].includes(String(subject.status)))
          throw fail(400, 'invalid_employee', 'الموظف في السطر غير موجود أو غير نشط.');
        ids.add(identity);
        if (line.sourceRequestId) {
          if (sources.has(line.sourceRequestId))
            throw fail(400, 'duplicate_source', 'مصدر الطلب مكرر داخل المسير.');
          sources.add(line.sourceRequestId);
          const source = await getApprovedPayrollSource(tx, line.sourceRequestId);
          if (source.employeeId !== line.employeeId)
            throw fail(400, 'invalid_source', 'المصدر المعتمد يعود لموظف آخر.');
          if (source.kind === 'advance')
            throw fail(
              400,
              'advance_allocation_required',
              'السلفة تحتاج خطة حسم شهرية معتمدة؛ لا يحددها هذا المسير التجريبي.',
            );
          if (!['reward', 'overtime'].includes(source.kind))
            throw fail(400, 'invalid_source', 'نوع الطلب لا يدعم الإدراج في هذا المسير.');
          if (
            source.kind === 'overtime' &&
            (source.values.compensation !== 'payment' || source.values.consent !== true)
          )
            throw fail(
              400,
              'non_cash_overtime',
              'لا يدرج العمل الإضافي إلا إذا كان المقترح ماليًا وموافقة الموظف موثقة.',
            );
          const sourceMinor = decimalRiyalToMinor(source.values.amount);
          if (
            sourceMinor === null ||
            sourceMinor <= 0 ||
            sourceMinor !== line.amountMinor ||
            line.kind !== 'earning'
          )
            throw fail(
              400,
              'source_amount_mismatch',
              'يجب مطابقة قيمة المصدر المعتمد بالهللات كسطر استحقاق.',
            );
          const consumed = (
            await tx.read<Row>(
              'SELECT 1 found FROM payroll_lines WHERE source_request_id=? AND run_id<>?',
              [line.sourceRequestId, run.id],
            )
          )[0];
          if (consumed) throw fail(409, 'source_consumed', 'سبق استخدام مصدر الطلب في مسير آخر.');
        }
      }
      if (!body.lines.length)
        throw fail(400, 'empty_run', 'يجب أن يحتوي المسير على سطر واحد على الأقل.');
      await tx.execute('DELETE FROM payroll_lines WHERE run_id=?', [run.id]);
      for (const l of body.lines)
        await tx.execute(
          'INSERT INTO payroll_lines(id,run_id,employee_id,component,kind,amount_minor,source,source_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          [
            randomUUID(),
            run.id,
            l.employeeId,
            l.component,
            l.kind,
            l.amountMinor,
            run.correction_of
              ? `فرق تصحيحي مرتبط بالمسير ${run.correction_of}`
              : l.sourceRequestId
                ? `طلب ${l.sourceRequestId} معتمد؛ قيمة مقترحة`
                : String(l.source || 'Synthetic manual adjustment'),
            l.sourceRequestId ?? null,
            now(),
          ],
        );
      await validateRunNet(tx, run, false);
      await tx.execute(
        'UPDATE payroll_runs SET version=version+1,updated_at=? WHERE id=? AND version=?',
        [now(), run.id, run.version],
      );
      await tx.execute(
        'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          run.id,
          actor.id,
          actor.role,
          'edited',
          body.reason.trim(),
          now(),
          Number(run.version) + 1,
        ],
      );
      return { run: await getRun(run.id, actor, tx) };
    });
  });
  route('post', '/payroll/:id/actions', async (req, actor) => {
    const body = req.body ?? {};
    const allowed =
      body.action === 'submit'
        ? actor.role === 'hr'
        : body.action === 'review'
          ? actor.role === 'finance'
          : body.action === 'approve'
            ? actor.role === 'approver'
            : body.action === 'reject'
              ? ['finance', 'approver'].includes(actor.role)
              : false;
    if (!allowed) throw fail(403, 'forbidden', 'لا تملك صلاحية تنفيذ هذا الإجراء.');
    if (
      body.action === 'reject' &&
      (typeof body.reason !== 'string' || body.reason.trim().length < 3)
    )
      throw fail(400, 'reason_required', 'سبب الرفض مطلوب.');
    return replay(req, actor, `action:${req.params.id}`, body, async (tx) => {
      const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]))[0];
      if (!run) throw fail(404, 'not_found', 'المسير غير موجود.');
      if (Number(body.version) !== Number(run.version))
        throw fail(409, 'version_conflict', 'تغير المسير؛ حدّث الصفحة ثم أعد المحاولة.');
      if (run.state === 'closed')
        throw fail(409, 'closed_immutable', 'المسير المغلق غير قابل للتعديل.');
      const action = body.action;
      let next: string,
        reviewed = run.reviewed_by,
        approved = run.approved_by;
      if (
        action === 'submit' &&
        actor.role === 'hr' &&
        run.state === 'draft' &&
        run.prepared_by === actor.id
      )
        next = 'pending_finance';
      else if (
        action === 'review' &&
        actor.role === 'finance' &&
        run.state === 'pending_finance' &&
        run.prepared_by !== actor.id
      ) {
        const ownLine = (
          await tx.read<Row>('SELECT 1 found FROM payroll_lines WHERE run_id=? AND employee_id=?', [
            run.id,
            actor.id,
          ])
        )[0];
        if (ownLine)
          throw fail(
            403,
            'subject_cannot_review',
            'لا تراجع المالية مسيرًا يتضمن راتب المراجع نفسه؛ يراجعه زميل آخر.',
          );
        next = 'pending_approver';
        reviewed = actor.id;
      } else if (
        action === 'approve' &&
        actor.role === 'approver' &&
        run.state === 'pending_approver' &&
        run.prepared_by !== actor.id &&
        run.reviewed_by !== actor.id
      ) {
        const conflict = (
          await tx.read<Row>('SELECT 1 found FROM payroll_lines WHERE run_id=? AND employee_id=?', [
            run.id,
            actor.id,
          ])
        )[0];
        if (conflict)
          throw fail(403, 'subject_cannot_approve', 'لا يمكن اعتماد مسير يتضمن راتب المعتمد.');
        next = 'closed';
        approved = actor.id;
      } else if (
        action === 'reject' &&
        ['finance', 'approver'].includes(actor.role) &&
        ['pending_finance', 'pending_approver'].includes(run.state)
      ) {
        next = 'rejected';
      } else throw fail(403, 'transition_forbidden', 'لا تملك صلاحية تنفيذ هذه الخطوة.');
      if (next === 'closed') {
        await validateRunNet(tx, run, true);
      }
      const closed = next === 'closed' ? now() : null;
      await tx.execute(
        'UPDATE payroll_runs SET state=?,reviewed_by=?,approved_by=?,version=version+1,updated_at=?,closed_at=? WHERE id=? AND version=?',
        [next, reviewed, approved, now(), closed, run.id, run.version],
      );
      await tx.execute(
        'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          run.id,
          actor.id,
          actor.role,
          action,
          body.reason ?? null,
          now(),
          Number(run.version) + 1,
        ],
      );
      return { run: await getRun(run.id, actor, tx) };
    });
  });
  route('post', '/payroll/:id/payments', async (req, actor) => {
    if (actor.role !== 'finance')
      throw fail(403, 'forbidden', 'تسجيل حالة الدفع اليدوي للمالية فقط.');
    const body = req.body ?? {};
    return replay(req, actor, `payment:${req.params.id}`, body, async (tx) => {
      const run = (await tx.read<Row>('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]))[0];
      if (!run) throw fail(404, 'not_found', 'المسير غير موجود.');
      if (run.state !== 'closed')
        throw fail(409, 'run_not_closed', 'يسجل الدفع بعد إغلاق المسير فقط.');
      if (Number(run.version) !== Number(body.version))
        throw fail(409, 'version_conflict', 'تغير المسير؛ حدّث الصفحة.');
      if (
        !['paid', 'failed', 'partial'].includes(body.state) ||
        !Number.isSafeInteger(body.paidMinor) ||
        body.paidMinor < 0 ||
        typeof body.reference !== 'string' ||
        !body.reference.trim()
      )
        throw fail(400, 'invalid_payment', 'بيانات حالة الدفع غير صالحة.');
      const line = await tx.read<Row>(
        "SELECT SUM(CASE WHEN kind='earning' THEN amount_minor ELSE -amount_minor END) net FROM payroll_lines WHERE run_id=? AND employee_id=?",
        [run.id, body.employeeId],
      );
      if (!line.length || line[0].net === null)
        throw fail(404, 'employee_not_in_run', 'الموظف غير مدرج في المسير.');
      const net = Number(line[0].net);
      if (net <= 0) throw fail(400, 'no_positive_payment', 'لا يمكن تسجيل دفعة موجبة لهذه القيمة.');
      if (
        body.paidMinor > net ||
        (body.state === 'paid' && body.paidMinor !== net) ||
        (body.state === 'failed' && body.paidMinor !== 0) ||
        (body.state === 'partial' && (body.paidMinor === 0 || body.paidMinor === net))
      )
        throw fail(400, 'payment_amount_mismatch', 'المبلغ لا يطابق حالة الدفع.');
      await tx.execute(
        'INSERT INTO payroll_payments(id,run_id,employee_id,state,paid_minor,encrypted_reference,recorded_at,recorded_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,employee_id) DO UPDATE SET state=excluded.state,paid_minor=excluded.paid_minor,encrypted_reference=excluded.encrypted_reference,recorded_at=excluded.recorded_at,recorded_by=excluded.recorded_by',
        [
          randomUUID(),
          run.id,
          body.employeeId,
          body.state,
          body.paidMinor,
          encryptSensitive(body.reference, `payroll-payment:${run.id}:${body.employeeId}`),
          now(),
          actor.id,
        ],
      );
      await tx.execute(
        'INSERT INTO payroll_events(id,run_id,actor_id,actor_role,action,reason,created_at,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          run.id,
          actor.id,
          actor.role,
          'payment_recorded',
          `حالة دفع يدوية: ${body.state}`,
          now(),
          Number(run.version),
        ],
      );
      return { run: await getRun(run.id, actor, tx) };
    });
  });
  route('get', '/payroll/:id/export', async (req, actor) => {
    const run = await getRun(String(req.params.id), actor);
    if (actor.role === 'employee')
      throw fail(403, 'forbidden', 'تصدير المسير متاح للأدوار المالية والإدارية فقط.');
    return [
      ['الموظف', 'المكوّن', 'النوع', 'المبلغ بالريال', 'المصدر'],
      ...run.lines.map((l) => [
        l.employeeName,
        l.component,
        l.kind,
        (l.amountMinor / 100).toFixed(2),
        l.source,
      ]),
    ]
      .map((row) =>
        row
          .map((v) => {
            const value = String(v);
            const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
            return '"' + safe.replace(/"/g, '""') + '"';
          })
          .join(','),
      )
      .join('\r\n');
  });
}
