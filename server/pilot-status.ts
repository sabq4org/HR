import type { Express } from 'express';
import type { Db } from './database.js';
import type { RequireActor } from './app.js';

export function registerPilotStatus(app: Express, db: Db, requireActor: RequireActor) {
  app.get('/api/operations/status', async (req, res) => {
    try {
      const actor = await requireActor(req);
      if (!['hr', 'auditor'].includes(actor.role)) {
        res
          .status(403)
          .json({ error: { code: 'FORBIDDEN', message: 'متابعة التشغيل متاحة للمختصين فقط.' } });
        return;
      }
      const runs = await db.read<{
        started_at: string;
        finished_at: string | null;
        status: string;
        reminders_created: number;
        failure_code: string | null;
      }>(
        'SELECT started_at,finished_at,status,reminders_created,failure_code FROM operations_job_runs ORDER BY started_at DESC LIMIT 10',
      );
      res.json({
        storage: 'durable',
        dialect: db.dialect,
        mfaRequired: true,
        notifications: 'internal',
        runs: runs.map((run) => ({
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          status: run.status,
          remindersCreated: Number(run.reminders_created),
          failureCode: run.failure_code,
        })),
      });
    } catch (error) {
      const failure = error as Error & { status?: number; code?: string };
      res.status(failure.status ?? 503).json({
        error: {
          code: failure.code ?? 'STATUS_UNAVAILABLE',
          message: failure.status ? failure.message : 'تعذر قراءة حالة التشغيل.',
        },
      });
    }
  });
}
