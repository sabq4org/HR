// Server-side HTML for the printed quote, invoice and customer statement: the same React paper and
// stylesheets the app uses for window.print, so the API PDF matches the in-app preview.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FinanceInvoice, FinanceQuote, FinanceSeller } from '../../shared/finance.js';
import type { CustomerStatement } from '../../shared/ledger.js';
import { InvoicePaper, QuotePaper } from '../../src/finance/paper.js';
import { StatementPaper } from '../../src/finance/statement-paper.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const fontsourceCss = (weight: number) =>
  require.resolve(`@fontsource/ibm-plex-sans-arabic/${weight}.css`);

/** Origin the headless page uses; every request to it is answered from local files only. */
export const DOCUMENT_ORIGIN = 'http://sabq-hr-document.invalid';

/** Local file for a request made by the document page, or null (blocked). */
export function documentAsset(url: string): string | null {
  if (!url.startsWith(`${DOCUMENT_ORIGIN}/`)) return null;
  const path = decodeURIComponent(new URL(url).pathname);
  if (path.includes('..')) return null;
  const fontsource = /^\/fontsource\/(ibm-plex-sans-arabic-[a-z0-9-]+\.woff2?)$/.exec(path);
  if (fontsource) return join(dirname(fontsourceCss(400)), 'files', fontsource[1]!);
  const brand = /^\/(fonts\/[A-Za-z0-9_-]+\.woff2|brand\/[A-Za-z0-9_-]+\.svg)$/.exec(path);
  if (brand) return join(root, 'public', brand[1]!);
  return null;
}

let stylesheet: string | undefined;
/** The app stylesheet in the order main.tsx loads it: Plex fonts, styles.css, finance.css. */
export function documentStylesheet(): string {
  stylesheet ??= [
    ...[400, 500, 600, 700].map((weight) =>
      readFileSync(fontsourceCss(weight), 'utf8').replaceAll('url(./files/', 'url(/fontsource/'),
    ),
    readFileSync(join(root, 'src/styles.css'), 'utf8'),
    readFileSync(join(root, 'src/finance/finance.css'), 'utf8'),
  ].join('\n');
  return stylesheet;
}

/**
 * The page box the browser really uses when the in-app quote/invoice preview is printed. The app
 * ships one CSS bundle, and the paper is not the first box on the sheet, so Chromium ignores
 * `@page finance-document` and applies the last unnamed `@page` in the bundle, which is
 * payroll.css's (A4, 18 mm). The server copies that so its PDF is the same size and position as
 * the preview; tests/domain/finance-document-pdf.test.ts fails if payroll.css changes it.
 */
export const PREVIEW_PAGE_CSS =
  '\n@page { size: A4 portrait; margin: 18mm; }\n.fin-document-paper { page: auto; }';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, extraCss = '') {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<base href="${DOCUMENT_ORIGIN}/">
<title>${escapeHtml(title)}</title>
<style>${documentStylesheet()}${extraCss}</style>
</head>
<body>${body}</body>
</html>`;
}

export function quoteHtml(quote: FinanceQuote, seller: FinanceSeller): string {
  return page(
    `عرض سعر ${quote.number}`,
    renderToStaticMarkup(<QuotePaper quote={quote} seller={seller} />),
    PREVIEW_PAGE_CSS,
  );
}

export function invoiceHtml(invoice: FinanceInvoice, seller: FinanceSeller): string {
  return page(
    `فاتورة ${invoice.number}`,
    renderToStaticMarkup(<InvoicePaper invoice={invoice} seller={seller} />),
    PREVIEW_PAGE_CSS,
  );
}

/** Customer statement; landscape like the preview, which adds the same @page rule while open. */
export function statementHtml(statement: CustomerStatement): string {
  return page(
    `كشف حساب ${statement.customer.name}`,
    renderToStaticMarkup(<StatementPaper statement={statement} />),
    '\n@page { size: A4 landscape; margin: 10mm 12mm; }',
  );
}
