// Prints server-rendered document HTML to PDF with headless Chromium (A4, print media), the same
// engine the in-app "print or save PDF" uses. One browser is launched on demand, renders are
// serialized, and the browser closes after a short idle period to keep memory low.
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { DOCUMENT_ORIGIN, documentAsset } from './document-html.js';

const IDLE_MS = 60_000;
const RENDER_TIMEOUT_MS = 30_000;
const SYSTEM_CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser'];

/** Chromium to use: HR_PDF_CHROMIUM_PATH, the system package, then Playwright's own build. */
export function chromiumExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.HR_PDF_CHROMIUM_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  for (const candidate of SYSTEM_CANDIDATES) if (existsSync(candidate)) return candidate;
  try {
    const bundled = chromium.executablePath();
    return bundled && existsSync(bundled) ? bundled : null;
  } catch {
    return null;
  }
}

let browser: Promise<Browser> | null = null;
let idle: NodeJS.Timeout | undefined;
let queue: Promise<unknown> = Promise.resolve();

function launch(executablePath: string): Promise<Browser> {
  browser ??= chromium
    .launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
    })
    .then((b) => {
      b.on('disconnected', () => {
        browser = null;
      });
      return b;
    })
    .catch((error) => {
      browser = null;
      throw error;
    });
  return browser;
}

export async function closeChromium() {
  clearTimeout(idle);
  const current = browser;
  browser = null;
  if (current) await (await current.catch(() => null))?.close().catch(() => undefined);
}

async function render(html: string, executablePath: string): Promise<Buffer> {
  clearTimeout(idle);
  const instance = await launch(executablePath);
  const context = await instance.newContext();
  try {
    // The page may only load the app's own fonts and logo from disk; nothing reaches the network.
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === `${DOCUMENT_ORIGIN}/document`)
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      const file = documentAsset(url);
      if (!file || !existsSync(file)) return route.abort('blockedbyclient');
      const type = file.endsWith('.svg')
        ? 'image/svg+xml'
        : file.endsWith('.woff')
          ? 'font/woff'
          : 'font/woff2';
      return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.goto(`${DOCUMENT_ORIGIN}/document`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMedia({ media: 'print' });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await context.close().catch(() => undefined);
    idle = setTimeout(() => void closeChromium(), IDLE_MS);
    idle.unref();
  }
}

/** PDF bytes, or null when no Chromium is installed (the caller falls back). */
export function htmlToPdf(html: string): Promise<Buffer | null> {
  const executablePath = chromiumExecutable();
  if (!executablePath) return Promise.resolve(null);
  const job = queue.then(() => render(html, executablePath));
  queue = job.catch(() => undefined);
  return job;
}
