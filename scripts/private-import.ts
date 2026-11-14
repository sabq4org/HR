// Local-only import of the Sabq employee workbook into the private database.
// Usage: npm run private:import -- <workbook.xlsx> [--dry-run] [--include-incomplete] [--db path]
// Prints counts and row numbers only, never personal values. See docs/private-local.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from '../server/database.js';
import { mapSabqWorkbook } from '../server/imports/sabq-workbook.js';
import { importMappedWorkbook } from '../server/private/local-admin.js';

if (process.env.HR_MODE) throw new Error('Private import never runs in a hosted mode.');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const includeIncomplete = args.includes('--include-incomplete');
const dbIndex = args.indexOf('--db');
const dbPath = resolve(dbIndex >= 0 ? args[dbIndex + 1] : '.data/hr-private.sqlite');
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');
if (!file) throw new Error('Usage: npm run private:import -- <workbook.xlsx> [--dry-run]');

const mapped = await mapSabqWorkbook(readFileSync(resolve(file)));
const db = await createDatabase(dbPath, { seed: false });
try {
  const summary = await importMappedWorkbook(db, mapped, { dryRun, includeIncomplete });
  console.log(
    JSON.stringify(
      {
        mode: dryRun ? 'dry-run (nothing saved)' : 'imported',
        includeIncomplete,
        database: dbPath,
        rowsRead: mapped.rows.length,
        imported: summary.imported,
        photos: summary.photos,
        photosFoundInWorkbook: mapped.photosFound,
        skipped: summary.skipped,
        issueCounts: summary.issueCounts,
        mappedColumns: mapped.mappedColumns,
        ignoredColumns: mapped.ignoredColumns,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
}
