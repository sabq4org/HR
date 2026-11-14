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
  const samples: { value: string; context: string }[] = [
    ...(
      await db.read<{ employee_id: string; encrypted_values_json: string }>(
        "SELECT employee_id,encrypted_values_json FROM employee_profile_data WHERE encrypted_values_json<>'{}' ORDER BY employee_id LIMIT 3",
      )
    ).map((r) => ({
      value: r.encrypted_values_json,
      context: `employee-profile:${r.employee_id}`,
    })),
    ...(
      await db.read<{ id: string; encrypted_content: string }>(
        'SELECT id,encrypted_content FROM employee_documents ORDER BY id LIMIT 3',
      )
    ).map((r) => ({ value: r.encrypted_content, context: `employee-document:${r.id}` })),
  ];
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
