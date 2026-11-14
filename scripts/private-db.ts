// Opens the private (real-data) database for the local admin scripts.
// - Default: SQLite at .data/hr-private.sqlite (or HR_DB_PATH / --db) on this machine.
// - HR_PRIVATE_DATABASE_URL set: the private PostgreSQL schema `hr_private` (e.g. Neon)
//   used by the private-hosted service. HR_DATA_KEY must then equal the service's key,
//   otherwise the hosted app could not decrypt what the import writes.
import { resolve } from 'node:path';
import { createDatabase, createPostgresDatabase } from '../server/database.js';

export async function openPrivateDatabase(sqlitePath?: string) {
  if (process.env.HR_MODE) throw new Error('Private admin tools never run inside a hosted mode.');
  const url = process.env.HR_PRIVATE_DATABASE_URL;
  if (url) {
    if (!process.env.HR_DATA_KEY)
      throw new Error('Set HR_DATA_KEY to the same value as the hosted service before writing.');
    return {
      db: await createPostgresDatabase(url, 'hr_private', { seed: false }),
      target: 'PostgreSQL schema hr_private (HR_PRIVATE_DATABASE_URL)',
    };
  }
  const path = resolve(sqlitePath ?? process.env.HR_DB_PATH ?? '.data/hr-private.sqlite');
  return { db: await createDatabase(path, { seed: false }), target: path };
}
