import type { RequestHandler } from 'express';

// Content-Security-Policy for the built single-page app. Scripts come only from this
// origin (Vite emits external module files). Inline style attributes are used by React
// components, hence 'unsafe-inline' for styles only. Photos and printable reports use
// blob:/data: URLs. Not applied to the Vite dev server, which injects inline scripts.
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * Baseline headers for every response, mounted before any route so API responses carry
 * them as well. HSTS only when the app is pinned to an HTTPS public origin.
 */
export function securityHeaders(options: { hosted: boolean; https: boolean }): RequestHandler {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.startsWith('/api')) res.setHeader('Content-Security-Policy', API_CSP);
    if (options.hosted) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (options.https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

/** CSP for HTML and static assets of the production build. */
export const pageCsp: RequestHandler = (req, res, next) => {
  if (!req.path.startsWith('/api')) res.setHeader('Content-Security-Policy', PAGE_CSP);
  next();
};

/**
 * Counts failed credentials per client address inside a sliding window. A single global
 * counter would let anyone who knows the URL lock every legitimate user out.
 */
export function clientFailureLimiter(options: {
  maxFailures: number;
  windowMs: number;
  maxTrackedClients?: number;
}) {
  const { maxFailures, windowMs } = options;
  const maxTracked = options.maxTrackedClients ?? 5_000;
  const failures = new Map<string, number[]>();
  const recent = (client: string, now: number) => {
    const list = (failures.get(client) ?? []).filter((t) => t > now - windowMs);
    if (list.length) failures.set(client, list);
    else failures.delete(client);
    return list;
  };
  return {
    /** Seconds the client must still wait, or 0 when it may try. */
    retryAfterSeconds(client: string, now: number): number {
      const list = recent(client, now);
      return list.length >= maxFailures
        ? Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000))
        : 0;
    },
    recordFailure(client: string, now: number): void {
      const list = recent(client, now);
      if (!list.length && failures.size >= maxTracked) {
        for (const key of failures.keys()) recent(key, now);
        // Still full: forget the oldest-tracked client (Map keeps insertion order).
        if (failures.size >= maxTracked) failures.delete(failures.keys().next().value!);
      }
      failures.set(client, [...list, now]);
    },
    clear(client: string): void {
      failures.delete(client);
    },
  };
}
