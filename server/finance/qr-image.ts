// Builds a self-contained QR image for the Chromium invoice paper. The official tax-invoice
// artifact remains GET /api/finance/invoices/:id/pdf; this only visualises the stored qrCode
// payload (typically the ZATCA TLV string) as an SVG data URL so the print HTML needs no
// extra network request.
import { create as createQr } from 'qrcode';

/** SVG data URL for a QR payload, or undefined when the value is empty or cannot be encoded. */
export function invoiceQrSrc(value: string): string | undefined {
  const payload = value.trim();
  if (!payload) return undefined;
  try {
    return qrDataUrl(payload);
  } catch {
    return undefined;
  }
}

export function qrDataUrl(value: string): string {
  const qr = createQr(value, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const cells: string[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (qr.modules.get(row, col)) cells.push(`M${col} ${row}h1v1h-1z`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#000" d="${cells.join('')}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
