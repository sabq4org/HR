import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import type { AsyncDb } from '../database.js';
import type { Actor } from './service.js';
import { payloadHash } from './security.js';
import { fault, isRecord } from './validation.js';

export type RequireActor = (req: Request) => Promise<Actor>;
export type RoutesContext = { db: AsyncDb; requireActor: RequireActor };
export type Marker = { type: string; id: string };

export function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    void handler(req, res).catch((error: unknown) => {
      const err = error as { status?: number; code?: string; message?: string };
      const capacityError =
        typeof err.message === 'string' && err.message.includes('WORKSPACE_')
          ? 'workspace-capacity'
          : null;
      res.status(err.status ?? (capacityError ? 429 : 500)).json({
        error: {
          code: err.code ?? (capacityError ? 'WORKSPACE_CAPACITY' : 'INTERNAL_ERROR'),
          message:
            err.status && err.message
              ? err.message
              : capacityError
                ? 'وصلت مساحة المعاينة إلى حدها المسموح.'
                : 'تعذر إكمال العملية.',
        },
      });
    });
  };
}

export function actorOrThrow(actor: Actor | null | undefined): Actor {
  if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول إلى مساحة العمل.');
  return actor;
}

export function requireRecord(
  value: unknown,
  message = 'صيغة الطلب غير صالحة.',
): Record<string, unknown> {
  if (!isRecord(value)) throw fault(400, 'INVALID_INPUT', message);
  return value;
}

export function requiredString(value: unknown, code: string, message: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw fault(400, code, message);
  return value;
}

export function versionValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw fault(400, 'INVALID_VERSION', 'أرسل رقم نسخة صالحًا.');
  return value as number;
}

export async function idempotent<T>(
  db: AsyncDb,
  actor: Actor,
  action: string,
  keyValue: string | undefined,
  payload: unknown,
  replay: (tx: AsyncDb, marker: Marker) => Promise<T>,
  operation: (tx: AsyncDb) => Promise<{ marker: Marker; result: T }>,
): Promise<T> {
  const key = keyValue?.trim();
  if (!key || key.length > 200)
    throw fault(400, 'IDEMPOTENCY_KEY_REQUIRED', 'أرسل مفتاح منع تكرار صالحًا.');
  const hash = payloadHash(payload);
  return db.transaction(async (tx) => {
    const prior = (
      await tx.read<{ payload_hash: string; response_json: string }>(
        'SELECT payload_hash,response_json FROM administration_idempotency WHERE actor_id=? AND action=? AND key=?',
        [actor.id, action, key],
      )
    )[0];
    if (prior) {
      if (prior.payload_hash !== hash)
        throw fault(409, 'IDEMPOTENCY_CONFLICT', 'استخدم مفتاح منع التكرار نفسه مع طلب مختلف.');
      let marker: Marker;
      try {
        marker = JSON.parse(prior.response_json) as Marker;
      } catch {
        throw fault(500, 'IDEMPOTENCY_DATA_INVALID', 'تعذر استرجاع نتيجة العملية.');
      }
      return replay(tx, marker);
    }
    const { marker, result } = await operation(tx);
    await tx.execute(
      `INSERT INTO administration_idempotency(actor_id,action,key,payload_hash,response_json,created_at)
      VALUES(?,?,?,?,?,?)`,
      [actor.id, action, key, hash, JSON.stringify(marker), new Date().toISOString()],
    );
    return result;
  });
}

export function registerRoute(
  app: Express,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  handler: (req: Request, res: Response) => Promise<void>,
) {
  app[method](path, route(handler));
}

export function newId(): string {
  return randomUUID();
}
