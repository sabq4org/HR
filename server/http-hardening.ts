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
