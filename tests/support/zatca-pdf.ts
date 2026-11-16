import { deflateSync } from 'node:zlib';

/** A synthetic Phase 2 ZATCA TLV (tags 1–8) as base64. Tags 6–8 are filler bytes. */
export function syntheticTlv(values: {
  seller?: string;
  vat: string;
  timestamp?: string;
  total: string;
  tax: string;
}): string {
  const parts: Buffer[] = [];
  const add = (tag: number, value: Buffer) => parts.push(Buffer.from([tag, value.length]), value);
  add(1, Buffer.from(values.seller ?? 'Synthetic Seller', 'utf8'));
  add(2, Buffer.from(values.vat, 'utf8'));
  add(3, Buffer.from(values.timestamp ?? '2026-11-16T11:06:38', 'utf8'));
  add(4, Buffer.from(values.total, 'utf8'));
  add(5, Buffer.from(values.tax, 'utf8'));
  add(6, Buffer.alloc(44, 6));
  add(7, Buffer.alloc(72, 7));
  add(8, Buffer.alloc(88, 8));
  return Buffer.concat(parts).toString('base64');
}

/** A minimal UBL invoice like the one Wafeq signs, carrying the QR as an additional reference. */
export function syntheticUbl(number: string, qr: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI><ext:ExtensionContent><cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
<cbc:ProfileID>reporting:1.0</cbc:ProfileID>
<cbc:ID>${number}</cbc:ID>
<cbc:UUID>00000000-0000-4000-8000-000000000001</cbc:UUID>
<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID></cac:AdditionalDocumentReference>
<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">AAAA</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
</Invoice>`;
}

/** A PDF/A-3-shaped file whose only embedded file is `xml`, Flate-compressed like Wafeq's. */
export function syntheticWafeqPdf(xml: string | null): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  chunks.push(Buffer.from('1 0 obj\n<</Type/Catalog>>\nendobj\n', 'latin1'));
  if (xml !== null) {
    const data = deflateSync(Buffer.from(xml, 'utf8'));
    chunks.push(
      Buffer.from(
        `6 0 obj\n<</Filter/FlateDecode\n/Type/EmbeddedFile\n/Params<<\n/Size ${Buffer.byteLength(xml)}>>\n/Subtype/text#2Fxml\n/Length ${data.length}>>stream\n`,
        'latin1',
      ),
      data,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    );
  }
  chunks.push(Buffer.from('trailer\n<</Root 1 0 R>>\n%%EOF\n', 'latin1'));
  return Buffer.concat(chunks);
}
