import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createHostedDemoApp } from '../../server/hosted-demo.js';
import { todayInRiyadh } from '../../server/database.js';

const PUBLIC_ORIGIN = 'https://hr-production-90b34ef5.up.railway.app';
const PUBLIC_HOST = 'hr-production-90b34ef5.up.railway.app';
const WORKSPACE_COOKIE = '__Host-sabq_hr_workspace';
const USER_COOKIE = '__Host-sabq_hr_demo';

type Reply = { status: number; headers: import('node:http').IncomingHttpHeaders; body: string };
async function listen(options: { workspaceTtlMs?: number; maxWorkspaces?: number } = {}) {
  const hosted = createHostedDemoApp({ publicOrigin: PUBLIC_ORIGIN, ...options });
  const server = createServer(hosted.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No hosted test listener');
  return {
    hosted,
    server,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      hosted.close();
    },
  };
}
function request(
  server: Server,
  port: number,
  path: string,
  options: {
    method?: string;
    host?: string;
    origin?: string;
    cookie?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Reply> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { host: options.host ?? PUBLIC_HOST, ...options.headers };
  if (options.origin) headers.origin = options.origin;
  if (options.cookie) headers.cookie = options.cookie;
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function cookie(reply: Reply, name: string): string | undefined {
  const values = reply.headers['set-cookie'];
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return list.find((value) => value.startsWith(`${name}=`))?.split(';')[0];
}
function json<T>(reply: Reply): T {
  return JSON.parse(reply.body) as T;
}
async function createWorkspace(server: Server, port: number, host = PUBLIC_HOST) {
  const response = await request(server, port, '/api/session', { host });
  assert.equal(response.status, 200);
  const workspaceCookie = cookie(response, WORKSPACE_COOKIE);
  assert.ok(workspaceCookie);
  return { workspaceCookie: workspaceCookie!, response };
}
async function login(server: Server, port: number, workspaceCookie: string, employeeId: string) {
  const response = await request(server, port, '/api/demo/session', {
    method: 'POST',
    origin: PUBLIC_ORIGIN,
    cookie: workspaceCookie,
    body: { employeeId },
  });
  assert.equal(response.status, 200);
  const userCookie = cookie(response, USER_COOKIE);
  assert.ok(userCookie);
  const userSetCookie = (response.headers['set-cookie'] ?? []).toString();
  assert.match(userSetCookie, /__Host-sabq_hr_demo=/);
  assert.match(userSetCookie, /Secure/i);
  assert.match(userSetCookie, /HttpOnly/i);
  assert.match(userSetCookie, /SameSite=Strict/i);
  return {
    userCookie: userCookie!,
    workspaceCookie: cookie(response, WORKSPACE_COOKIE) ?? workspaceCookie,
  };
}
function futureSunday(offset = 35) {
  const d = new Date(`${todayInRiyadh()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) + offset);
  return d.toISOString().slice(0, 10);
}
const plus = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

test('only GET /api/session creates a secure workspace; health and unknown API routes do not', async () => {
  const env = await listen();
  try {
    env.hosted.app.get('/asset.js', (_req, res) => res.type('text/javascript').send('void 0;'));
    const asset = await request(env.server, env.port, '/asset.js');
    assert.equal(asset.status, 200);
    assert.equal(cookie(asset, WORKSPACE_COOKIE), undefined);
    const health = await request(env.server, env.port, '/api/health', {
      host: 'healthcheck.railway.app',
    });
    assert.equal(health.status, 200);
    assert.equal(json<{ mode: string }>(health).mode, 'synthetic-hosted');
    assert.equal(cookie(health, WORKSPACE_COOKIE), undefined);
    assert.equal(
      (await request(env.server, env.port, '/api/session', { host: 'healthcheck.railway.app' }))
        .status,
      403,
    );
    const unknown = await request(env.server, env.port, '/api/not-a-route');
    assert.equal(unknown.status, 404);
    assert.equal(cookie(unknown, WORKSPACE_COOKIE), undefined);
    assert.equal(
      (
        await request(env.server, env.port, '/api/leaves', {
          method: 'POST',
          origin: PUBLIC_ORIGIN,
          body: {},
        })
      ).status,
      401,
    );
    const crossSite = await request(env.server, env.port, '/api/session', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(cookie(crossSite, WORKSPACE_COOKIE), undefined);
    const workspace = await createWorkspace(env.server, env.port);
    assert.equal(json<{ mode: string; me: unknown }>(workspace.response).mode, 'synthetic-hosted');
    assert.equal(json<{ me: unknown }>(workspace.response).me, null);
    const setCookie = workspace.response.headers['set-cookie']?.toString() ?? '';
    assert.match(setCookie, /__Host-sabq_hr_workspace=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    assert.doesNotMatch(setCookie, /Domain=/i);
    assert.equal(workspace.response.headers['cache-control'], 'no-store, max-age=0');
    assert.equal(workspace.response.headers['x-content-type-options'], 'nosniff');
  } finally {
    await env.close();
  }
});

test('workspaces are isolated, origin and Host are pinned, forwarded headers cannot switch identity', async () => {
  const env = await listen();
  try {
    const one = await createWorkspace(env.server, env.port);
    const two = await createWorkspace(env.server, env.port);
    assert.notEqual(one.workspaceCookie, two.workspaceCookie);
    const sara = await login(env.server, env.port, one.workspaceCookie, 'emp-sara');
    assert.match(
      (
        await request(env.server, env.port, '/api/session', {
          cookie: `${sara.workspaceCookie}; ${sara.userCookie}`,
          headers: { 'x-forwarded-host': 'attacker.example' },
        })
      ).body,
      /synthetic-hosted/,
    );
    const start = futureSunday();
    const submitted = await request(env.server, env.port, '/api/leaves', {
      method: 'POST',
      origin: PUBLIC_ORIGIN,
      cookie: `${sara.workspaceCookie}; ${sara.userCookie}`,
      headers: { 'idempotency-key': 'hosted-isolation' },
      body: { startDate: start, endDate: plus(start, 1), note: 'بيانات هذه المساحة فقط' },
    });
    assert.equal(submitted.status, 201);
    const leaveId = json<{ leave: { id: string } }>(submitted).leave.id;
    const other = await login(env.server, env.port, two.workspaceCookie, 'emp-sara');
    const otherBootstrap = await request(env.server, env.port, '/api/bootstrap', {
      cookie: `${other.workspaceCookie}; ${other.userCookie}`,
    });
    assert.equal(otherBootstrap.status, 200);
    assert.doesNotMatch(otherBootstrap.body, new RegExp(leaveId));
    assert.equal(
      (
        await request(env.server, env.port, '/api/bootstrap', {
          host: 'attacker.example',
          cookie: `${sara.workspaceCookie}; ${sara.userCookie}`,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(env.server, env.port, '/api/notifications/read', {
          method: 'POST',
          origin: `${PUBLIC_ORIGIN}/evil`,
          cookie: `${sara.workspaceCookie}; ${sara.userCookie}`,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(env.server, env.port, '/api/notifications/read', {
          method: 'POST',
          origin: PUBLIC_ORIGIN,
          headers: { 'x-forwarded-host': 'attacker.example' },
          cookie: `${sara.workspaceCookie}; ${sara.userCookie}`,
        })
      ).status,
      204,
    );
  } finally {
    await env.close();
  }
});

test('workspace capacity is bounded and stale cookies cannot adopt another workspace', async () => {
  const env = await listen({ maxWorkspaces: 1 });
  try {
    assert.equal((await request(env.server, env.port, '/api/health')).status, 200);
    const first = await createWorkspace(env.server, env.port);
    const blocked = await request(env.server, env.port, '/api/session');
    assert.equal(blocked.status, 503);
    assert.equal(cookie(blocked, WORKSPACE_COOKIE), undefined);
    const forged = await request(env.server, env.port, '/api/session', {
      cookie: `${WORKSPACE_COOKIE}=forged-token`,
    });
    assert.equal(forged.status, 503);
    const health = await request(env.server, env.port, '/api/health');
    assert.equal(health.status, 200);
    assert.ok(first.workspaceCookie);
  } finally {
    await env.close();
  }
});

test('idle workspace expiry closes its database and a later session gets a fresh workspace', async () => {
  const env = await listen({ workspaceTtlMs: 30 });
  try {
    const first = await createWorkspace(env.server, env.port);
    await new Promise((resolve) => setTimeout(resolve, 45));
    const expired = await request(env.server, env.port, '/api/bootstrap', {
      cookie: first.workspaceCookie,
    });
    assert.equal(expired.status, 401);
    const fresh = await createWorkspace(env.server, env.port);
    assert.notEqual(fresh.workspaceCookie, first.workspaceCookie);
    const boot = await request(env.server, env.port, '/api/bootstrap', {
      cookie: fresh.workspaceCookie,
    });
    assert.equal(boot.status, 401);
  } finally {
    await env.close();
  }
});

test('per-workspace mutation quota stops unbounded requests', async () => {
  const env = await listen();
  try {
    const workspace = await createWorkspace(env.server, env.port);
    const sara = await login(env.server, env.port, workspace.workspaceCookie, 'emp-sara');
    const sessionCookie = `${sara.workspaceCookie}; ${sara.userCookie}`;
    for (let i = 0; i < 249; i++) {
      const response = await request(env.server, env.port, '/api/notifications/read', {
        method: 'POST',
        origin: PUBLIC_ORIGIN,
        cookie: sessionCookie,
      });
      assert.equal(response.status, 204);
    }
    assert.equal(
      (
        await request(env.server, env.port, '/api/notifications/read', {
          method: 'POST',
          origin: PUBLIC_ORIGIN,
          cookie: sessionCookie,
        })
      ).status,
      429,
    );
  } finally {
    await env.close();
  }
});
