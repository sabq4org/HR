import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { createDatabase, createPostgresDatabase, type Db } from './database.js';

const WORKSPACE_COOKIE = '__Host-sabq_hr_workspace';
const DEFAULT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
const HARD_WORKSPACE_CAP = 50;
const MUTATION_CAP_PER_WORKSPACE = 250;
// A workspace that was created but never used again is reclaimable after this grace period
// when capacity is full, so cookieless floods cannot lock out real visitors for hours.
const DEFAULT_UNTOUCHED_GRACE_MS = 5_000;
type HostedOptions = {
  publicOrigin: string;
  workspaceTtlMs?: number;
  maxWorkspaces?: number;
  databaseUrl?: string;
  untouchedGraceMs?: number;
};
type Workspace = {
  app: Express;
  db: Db;
  createdAt: number;
  lastSeenAt: number;
  mutations: number;
  touched: boolean;
};

function jsonError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}
function tokenFromRequest(req: Request): string | undefined {
  return (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${WORKSPACE_COOKIE}=`))
    ?.slice(WORKSPACE_COOKIE.length + 1);
}
function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function knownApi(method: string, path: string): boolean {
  if (
    method === 'GET' &&
    (path === '/api/bootstrap' || /^\/api\/employees\/[^/]+(\/photo)?$/.test(path))
  )
    return true;
  if (
    method === 'POST' &&
    ['/api/demo/session', '/api/leaves', '/api/notifications/read'].includes(path)
  )
    return true;
  if (method === 'DELETE' && path === '/api/session') return true;
  if (method === 'POST' && /^\/api\/leaves\/[^/]+\/(decision|cancel)$/.test(path)) return true;
  if (
    method === 'GET' &&
    [
      '/api/admin/overview',
      '/api/admin/documents',
      '/api/admin/reports',
      '/api/admin/reports/export',
      '/api/admin/audit',
    ].includes(path)
  )
    return true;
  if (
    (method === 'GET' || method === 'POST') &&
    ['/api/admin/requests', '/api/admin/attendance', '/api/admin/policies'].includes(path)
  )
    return true;
  if (method === 'GET' && /^\/api\/admin\/(employees\/[^/]+|requests\/[^/]+)$/.test(path))
    return true;
  if (
    method === 'POST' &&
    /^\/api\/admin\/(employees\/[^/]+(\/documents|\/rehire)?|requests\/[^/]+\/actions|attendance\/[^/]+\/decision|policies\/[^/]+\/actions|documents\/[^/]+\/archive)$/.test(
      path,
    )
  )
    return true;
  if (method === 'PATCH' && /^\/api\/admin\/(employees\/[^/]+|requests\/[^/]+)$/.test(path))
    return true;
  if (method === 'GET' && /^\/api\/admin\/documents\/[^/]+\/download$/.test(path)) return true;
  if (
    method === 'GET' &&
    ['/api/admin/payroll', '/api/admin/imports/employees/template'].includes(path)
  )
    return true;
  if (
    method === 'POST' &&
    [
      '/api/admin/employees',
      '/api/admin/payroll',
      '/api/admin/imports/employees/preview',
      '/api/admin/imports/employees/commit',
    ].includes(path)
  )
    return true;
  if (method === 'GET' && /^\/api\/admin\/payroll\/[^/]+(\/export)?$/.test(path)) return true;
  if (method === 'PATCH' && /^\/api\/admin\/payroll\/[^/]+$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/admin\/payroll\/[^/]+\/(actions|payments)$/.test(path))
    return true;
  return false;
}

export async function createHostedDemoApp(
  options: HostedOptions,
): Promise<{ app: Express; close: () => Promise<void> }> {
  const parsedOrigin = new URL(options.publicOrigin);
  if (
    parsedOrigin.protocol !== 'https:' ||
    parsedOrigin.pathname !== '/' ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    parsedOrigin.username ||
    parsedOrigin.password
  ) {
    throw new Error('publicOrigin must be an HTTPS origin without a path or credentials');
  }
  const publicOrigin = parsedOrigin.origin;
  const publicHost = parsedOrigin.host.toLowerCase();
  const workspaceTtlMs = options.workspaceTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxWorkspaces = options.maxWorkspaces ?? HARD_WORKSPACE_CAP;
  const untouchedGraceMs = options.untouchedGraceMs ?? DEFAULT_UNTOUCHED_GRACE_MS;
  if (
    !Number.isFinite(workspaceTtlMs) ||
    workspaceTtlMs <= 0 ||
    workspaceTtlMs > DEFAULT_IDLE_TTL_MS
  ) {
    throw new Error('workspaceTtlMs must be greater than zero and at most two hours');
  }
  if (!Number.isInteger(maxWorkspaces) || maxWorkspaces < 1 || maxWorkspaces > HARD_WORKSPACE_CAP) {
    throw new Error(`maxWorkspaces must be between 1 and ${HARD_WORKSPACE_CAP}`);
  }

  // Fail startup on schema or seed errors before the platform receives a healthy response.
  const probe = options.databaseUrl
    ? await createPostgresDatabase(
        options.databaseUrl,
        `hr_preview_${randomBytes(16).toString('hex')}`,
      )
    : await createDatabase();
  await probe.close();

  const workspaces = new Map<string, Workspace>();
  let pendingCreations = 0;
  const app = express();
  app.disable('x-powered-by');

  const closeWorkspace = async (key: string) => {
    const workspace = workspaces.get(key);
    if (!workspace) return;
    workspaces.delete(key);
    try {
      await workspace.db.close();
    } catch {
      /* already closing */
    }
  };
  const expireWorkspace = (workspace: Workspace, now: number) =>
    now - workspace.lastSeenAt >= workspaceTtlMs || now - workspace.createdAt >= ABSOLUTE_TTL_MS;
  const pruneExpired = async (now = Date.now()) => {
    for (const [key, workspace] of workspaces)
      if (expireWorkspace(workspace, now)) await closeWorkspace(key);
  };
  // Reclaim the oldest workspace that was never used after creation (no request beyond the
  // initial GET /api/session). Visitors who used their workspace are never evicted early.
  const reclaimUntouched = async (now: number) => {
    let oldest: { key: string; createdAt: number } | undefined;
    for (const [key, workspace] of workspaces) {
      if (!workspace.touched && now - workspace.createdAt >= untouchedGraceMs)
        if (!oldest || workspace.createdAt < oldest.createdAt)
          oldest = { key, createdAt: workspace.createdAt };
    }
    if (oldest) await closeWorkspace(oldest.key);
  };
  const createWorkspace = async (
    now = Date.now(),
  ): Promise<{ key: string; token: string; workspace: Workspace } | undefined> => {
    await pruneExpired(now);
    if (workspaces.size + pendingCreations >= maxWorkspaces) await reclaimUntouched(now);
    if (workspaces.size + pendingCreations >= maxWorkspaces) return undefined;
    pendingCreations += 1;
    const token = randomBytes(32).toString('base64url');
    const key = tokenKey(token);
    try {
      const db = options.databaseUrl
        ? await createPostgresDatabase(
            options.databaseUrl,
            `hr_preview_${randomBytes(16).toString('hex')}`,
          )
        : await createDatabase();
      const workspace: Workspace = {
        db,
        app: createApp(db, { publicOrigin }),
        createdAt: now,
        lastSeenAt: now,
        mutations: 0,
        touched: false,
      };
      workspaces.set(key, workspace);
      return { key, token, workspace };
    } finally {
      pendingCreations -= 1;
    }
  };
  const refreshCookie = (res: Response, workspace: Workspace, now: number, token?: string) => {
    const value = token ?? '';
    const idleRemaining = workspaceTtlMs - (now - workspace.lastSeenAt);
    const absoluteRemaining = ABSOLUTE_TTL_MS - (now - workspace.createdAt);
    const maxAge = Math.max(1, Math.min(idleRemaining, absoluteRemaining));
    res.cookie(WORKSPACE_COOKIE, value, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
  };

  app.use(async (req, res, next) => {
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    next();
  });
  app.use(async (req, res, next) => {
    const host = req.get('host')?.toLowerCase();
    const isHealthPath =
      req.path === '/api/health' && (req.method === 'GET' || req.method === 'HEAD');
    if (host !== publicHost && !(isHealthPath && host === 'healthcheck.railway.app')) {
      return jsonError(res, 403, 'PUBLIC_HOST_REQUIRED', 'المضيف غير مسموح.');
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      try {
        if (!origin || origin !== publicOrigin || new URL(origin).origin !== publicOrigin)
          throw new Error('bad origin');
      } catch {
        return jsonError(res, 403, 'ORIGIN_MISMATCH', 'مصدر الطلب غير مطابق للمضيف العام المحدد.');
      }
    }
    if (isHealthPath) return res.json({ status: 'ok', mode: 'synthetic-hosted' });
    if (!req.path.startsWith('/api/') && req.path !== '/api') return next();
    if (req.path === '/api/session' && req.method === 'GET') {
      if (req.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
        return jsonError(
          res,
          403,
          'CROSS_SITE_WORKSPACE_REJECTED',
          'ابدأ مساحة العرض من الموقع نفسه.',
        );
      }
      const now = Date.now();
      const incoming = tokenFromRequest(req);
      const incomingKey = incoming ? tokenKey(incoming) : undefined;
      const existing = incomingKey ? workspaces.get(incomingKey) : undefined;
      if (existing && expireWorkspace(existing, now)) await closeWorkspace(incomingKey!);
      const renewed = incomingKey ? workspaces.get(incomingKey) : undefined;
      if (renewed) {
        renewed.lastSeenAt = now;
        renewed.touched = true;
        refreshCookie(res, renewed, now, incoming);
        return renewed.app(req, res, next);
      }
      const created = await createWorkspace(now);
      if (!created)
        return jsonError(
          res,
          503,
          'WORKSPACE_CAPACITY_REACHED',
          'اكتمل الحد المؤقت لمساحات العرض؛ أعد المحاولة لاحقًا.',
        );
      refreshCookie(res, created.workspace, now, created.token);
      return created.workspace.app(req, res, next);
    }
    if (!knownApi(req.method, req.path))
      return jsonError(res, 404, 'NOT_FOUND', 'المسار غير موجود.');

    const token = tokenFromRequest(req);
    const key = token ? tokenKey(token) : undefined;
    const workspace = key ? workspaces.get(key) : undefined;
    if (!workspace) {
      if (key) pruneExpired();
      return jsonError(res, 401, 'WORKSPACE_REQUIRED', 'افتح مساحة العرض أولًا عبر بدء الجلسة.');
    }
    const now = Date.now();
    if (expireWorkspace(workspace, now)) {
      await closeWorkspace(key!);
      return jsonError(
        res,
        401,
        'WORKSPACE_EXPIRED',
        'انتهت مساحة العرض المؤقتة؛ ابدأ جلسة جديدة.',
      );
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (workspace.mutations >= MUTATION_CAP_PER_WORKSPACE) {
        return jsonError(
          res,
          429,
          'WORKSPACE_MUTATION_LIMIT',
          'وصلت مساحة العرض إلى حد العمليات المؤقت؛ ابدأ مساحة جديدة.',
        );
      }
      workspace.mutations += 1;
    }
    workspace.lastSeenAt = now;
    workspace.touched = true;
    refreshCookie(res, workspace, now, token);
    return workspace.app(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/'))
      return jsonError(res, 404, 'NOT_FOUND', 'المسار غير موجود.');
    next();
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'تعذر إكمال الطلب.' } });
  });

  const sweepMs = Math.max(10, Math.min(workspaceTtlMs, 60_000));
  const cleanupTimer = setInterval(() => {
    void pruneExpired().catch(() => {});
  }, sweepMs);
  cleanupTimer.unref();
  const close = async () => {
    clearInterval(cleanupTimer);
    await Promise.all([...workspaces.keys()].map((key) => closeWorkspace(key)));
  };
  return { app, close };
}
