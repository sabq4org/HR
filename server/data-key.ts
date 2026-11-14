// Startup guard: refuse to serve or write a database with a different data key than
// the one that encrypted it. Without this, a wrong HR_DATA_KEY only surfaces later as
// 500s on photos and documents, and new writes would mix two keys in one database.
import { timingSafeEqual } from 'node:crypto';
import type { Db } from './database.js';
import { dataKeyFingerprint, decryptSensitive } from './administration/security.js';

const mismatch = () =>
  Object.assign(
    new Error(
      'HR_DATA_KEY does not match the key this database was encrypted with. Refusing to start.',
    ),
    { status: 503, code: 'DATA_KEY_MISMATCH' },
  );

/**
 * Compares the active key's fingerprint with the one bound to the database.
 * First run on an existing database: proves the key by decrypting stored samples,
 * then records the fingerprint. Never logs or stores the key itself.
 */
export async function verifyDataKeyBinding(db: Db): Promise<'verified' | 'bound'> {
  const fingerprint = dataKeyFingerprint();
  const bound = (
    await db.read<{ fingerprint: string }>('SELECT fingerprint FROM data_key_binding WHERE id=1')
  )[0];
  if (bound) {
    const a = Buffer.from(bound.fingerprint, 'utf8');
    const b = Buffer.from(fingerprint, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw mismatch();
    return 'verified';
  }
  const samples = await encryptedSamples(db);
  for (const sample of samples) {
    try {
      decryptSensitive(sample.value, sample.context);
    } catch {
      throw mismatch();
    }
  }
  await db.execute(
    'INSERT INTO data_key_binding(id,fingerprint,bound_at) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING',
    [fingerprint, new Date().toISOString()],
  );
  // A concurrent first start may have bound a different key first; re-check, never assume.
  await verifyDataKeyBinding(db);
  return 'bound';
}

type Sample = { value: string; context: string };
// Every column written by encryptSensitive, with the context it was bound to. A legacy
// database is bound only after each kind that holds data proves decryptable, so a key
// that cannot read any stored record is never recorded (PR #3 review).
const SOURCES: { sql: string; map: (row: Record<string, string>) => Sample[] }[] = [
  {
    sql: "SELECT employee_id,encrypted_values_json AS v FROM employee_profile_data WHERE encrypted_values_json<>'{}' ORDER BY employee_id LIMIT 3",
    map: (r) => [{ value: r.v, context: `employee-profile:${r.employee_id}` }],
  },
  {
    sql: 'SELECT id,old_value_ciphertext AS o,new_value_ciphertext AS n,reason_ciphertext AS r FROM employee_profile_history ORDER BY id LIMIT 3',
    map: (r) =>
      [
        { value: r.o, context: `employee-history:${r.id}:old` },
        { value: r.n, context: `employee-history:${r.id}:new` },
        { value: r.r, context: `employee-history:${r.id}:reason` },
      ].filter((x) => x.value),
  },
  {
    sql: 'SELECT id,encrypted_content AS v FROM employee_documents ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `employee-document:${r.id}` }],
  },
  {
    sql: "SELECT id,reason AS v FROM administration_events WHERE reason LIKE 'v1.%' ORDER BY id LIMIT 3",
    map: (r) => [{ value: r.v, context: `administration-event:${r.id}:reason` }],
  },
  {
    sql: "SELECT id,issued_document_json AS v FROM administrative_requests WHERE issued_document_json LIKE 'v1.%' ORDER BY id LIMIT 3",
    map: (r) => [{ value: r.v, context: `issued-document:${r.id}` }],
  },
  {
    sql: "SELECT id,values_json AS v FROM administrative_requests WHERE values_json LIKE '%__encryptedSensitive%' ORDER BY id LIMIT 3",
    map: (r) => {
      const value = (JSON.parse(r.v) as { __encryptedSensitive?: unknown }).__encryptedSensitive;
      return typeof value === 'string' ? [{ value, context: `admin-request:${r.id}:values` }] : [];
    },
  },
  {
    sql: "SELECT id,encrypted_note AS n,encrypted_reason AS r FROM attendance_records WHERE encrypted_note LIKE 'v1.%' OR encrypted_reason LIKE 'v1.%' ORDER BY id LIMIT 3",
    map: (r) =>
      [
        { value: r.n, context: `attendance:${r.id}:note` },
        { value: r.r, context: `attendance:${r.id}:reason` },
      ].filter((x) => x.value?.startsWith('v1.')),
  },
  {
    sql: "SELECT id,source_ciphertext AS v FROM leave_balance_openings WHERE source_ciphertext LIKE 'v1.%' ORDER BY id LIMIT 3",
    map: (r) => [{ value: r.v, context: `leave-opening:${r.id}:source` }],
  },
  {
    sql: "SELECT id,source_ciphertext AS v FROM leave_balance_adjustments WHERE source_ciphertext LIKE 'v1.%' ORDER BY id LIMIT 3",
    map: (r) => [{ value: r.v, context: `leave-adjustment:${r.id}:source` }],
  },
  {
    sql: "SELECT run_id,employee_id,encrypted_reference AS v FROM payroll_payments WHERE encrypted_reference LIKE 'v1.%' ORDER BY id LIMIT 3",
    map: (r) => [{ value: r.v, context: `payroll-payment:${r.run_id}:${r.employee_id}` }],
  },
  // Finance (migration 010): owner-scoped settings, provider credentials and documents.
  {
    sql: 'SELECT owner_id,seller_ciphertext AS v FROM finance_settings ORDER BY owner_id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:seller:${r.owner_id}` }],
  },
  {
    sql: 'SELECT owner_id,api_key_ciphertext AS v FROM finance_provider_credentials ORDER BY owner_id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:api-key:${r.owner_id}` }],
  },
  {
    sql: 'SELECT id,customer_ciphertext AS v FROM finance_customers ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:customer:${r.id}` }],
  },
  {
    sql: 'SELECT id,quote_ciphertext AS v FROM finance_quotes ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:quote:${r.id}` }],
  },
  {
    sql: 'SELECT id,invoice_ciphertext AS v FROM finance_invoices ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:invoice:${r.id}` }],
  },
  {
    sql: "SELECT invoice_id,content_ciphertext AS v FROM finance_private_artifacts WHERE artifact_type='pdf' ORDER BY invoice_id LIMIT 3",
    map: (r) => [{ value: r.v, context: `finance:artifact:${r.invoice_id}:pdf` }],
  },
  // Finance ledger (migration 012).
  {
    sql: 'SELECT id,description_ciphertext AS v FROM finance_journal_entries ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:journal:${r.id}` }],
  },
  {
    sql: 'SELECT id,memo_ciphertext AS v FROM finance_journal_lines WHERE memo_ciphertext IS NOT NULL ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:journal-line:${r.id}` }],
  },
  {
    sql: 'SELECT id,vendor_ciphertext AS v FROM finance_vendors ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:vendor:${r.id}` }],
  },
  {
    sql: 'SELECT id,details_ciphertext AS v FROM finance_vouchers ORDER BY id LIMIT 3',
    map: (r) => [{ value: r.v, context: `finance:voucher:${r.id}` }],
  },
  {
    sql: 'SELECT id,correction_note_ciphertext AS n,filing_reference_ciphertext AS f FROM finance_vat_returns WHERE correction_note_ciphertext IS NOT NULL OR filing_reference_ciphertext IS NOT NULL ORDER BY id LIMIT 3',
    map: (r) =>
      [
        { value: r.n, context: `finance:vat-note:${r.id}` },
        { value: r.f, context: `finance:vat-reference:${r.id}` },
      ].filter((x) => x.value),
  },
];

async function encryptedSamples(db: Db): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const source of SOURCES)
    for (const row of await db.read<Record<string, string>>(source.sql))
      samples.push(...source.map(row));
  return samples;
}
