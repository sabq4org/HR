// Add only missing optional profile fields from a reviewed workbook-to-employee
// manifest. Dry-run is the default. Apply is local administration only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openPrivateDatabase } from './private-db.js';
import { mapSabqSupplementWorkbook, type SupplementRow } from '../server/imports/sabq-workbook.js';
import type { FormValues } from '../shared/administration.js';
import { ensureLocalAdmin, LOCAL_ADMIN_ID } from '../server/private/local-admin.js';
import {
  appendEvent,
  getProfileValues,
  readEmployee,
  saveProfileValues,
  type Actor,
} from '../server/administration/service.js';
import { sha256 } from '../server/administration/security.js';
import { todayInRiyadh } from '../server/database.js';
import { employeeFields } from '../shared/catalog.js';
import { validateValues } from '../server/administration/validation.js';
import { validateProfileRelationships } from '../server/administration/service.js';

export type MappingManifest = {
  version: 1;
  sourceSha256: string;
  rows: { rowNumber: number; employeeId: string; expectedRecordVersion: number }[];
};
export type SupplementPlan = {
  patch: FormValues;
  conflicts: string[];
  unchanged: string[];
};

export function planMissingOnly(existing: FormValues, incoming: FormValues): SupplementPlan {
  const patch: FormValues = Object.create(null) as FormValues;
  const conflicts: string[] = [];
  const unchanged: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim()))
      continue;
    const old = existing[key];
    if (old === undefined || old === null || (typeof old === 'string' && !old.trim())) {
      patch[key] = value;
    } else if (JSON.stringify(old) === JSON.stringify(value)) {
      unchanged.push(key);
    } else {
      conflicts.push(key);
    }
  }
  return { patch, conflicts, unchanged };
}

export function validateManifest(value: unknown, sourceSha256: string): MappingManifest {
  const manifest = value as Partial<MappingManifest> | null;
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.sourceSha256 !== sourceSha256 ||
    !Array.isArray(manifest.rows)
  )
    throw new Error('Invalid mapping manifest or source file hash mismatch.');
  const rowNumbers = new Set<number>();
  const employeeIds = new Set<string>();
  for (const row of manifest.rows) {
    if (
      !Number.isInteger(row.rowNumber) ||
      row.rowNumber < 2 ||
      !Number.isInteger(row.expectedRecordVersion) ||
      row.expectedRecordVersion < 1 ||
      typeof row.employeeId !== 'string' ||
      !row.employeeId.trim() ||
      rowNumbers.has(row.rowNumber) ||
      employeeIds.has(row.employeeId)
    )
      throw new Error('Invalid or duplicate mapping-manifest row.');
    rowNumbers.add(row.rowNumber);
    employeeIds.add(row.employeeId);
  }
  return manifest as MappingManifest;
}

function enrichedValues(row: SupplementRow, sourceHash: string): FormValues {
  const values = { ...row.values } as FormValues;
  const sourceNote = 'تصدير الموظفين؛ بيانات منقولة بانتظار مراجعة مستقلة.';
  const hasAny = (keys: string[]) => keys.some((key) => values[key] !== undefined);

  if (hasAny(['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance']))
    values.salarySource ??= sourceNote;
  if (hasAny(['insuranceNumber', 'insuranceStartDate'])) {
    values.insuranceSource ??= sourceNote;
    values.insuranceVerificationStatus ??= 'unverified';
  }
  if (values.annualLeaveEntitlement !== undefined) {
    values.annualLeaveSource ??= sourceNote;
    values.annualLeaveVerificationStatus ??= 'unverified';
  }
  if (
    hasAny([
      'bankName',
      'iban',
      'bankCountry',
      'accountNumber',
      'accountType',
      'currency',
      'swiftCode',
      'bankBranch',
      'bankAccountName',
    ])
  )
    values.bankVerificationStatus ??= 'unverified';
  // No effective date or verification date is fabricated when the source omits it.
  return values;
}

type Counts = {
  sourceRows: number;
  mappedRows: number;
  eligibleRows: number;
  unmatchedRows: number;
  invalidFields: number;
  conflicts: number;
  unchangedFields: number;
  fieldsToFill: number;
  invalidPatches: number;
  appliedRows: number;
  repeatedRows: number;
  staleRows: number;
  issueCounts: Record<string, number>;
};

export async function supplementProfiles(
  db: Parameters<typeof readEmployee>[0],
  rows: SupplementRow[],
  sourceHash: string,
  manifest?: MappingManifest,
  apply = false,
): Promise<Counts> {
  const counts: Counts = {
    sourceRows: rows.length,
    mappedRows: 0,
    eligibleRows: 0,
    unmatchedRows: 0,
    invalidFields: 0,
    conflicts: 0,
    unchangedFields: 0,
    fieldsToFill: 0,
    invalidPatches: 0,
    appliedRows: 0,
    repeatedRows: 0,
    staleRows: 0,
    issueCounts: {},
  };
  const byRow = new Map(manifest?.rows.map((entry) => [entry.rowNumber, entry]));
  if (manifest) {
    const availableRows = new Set(rows.map((row) => row.rowNumber));
    if (manifest.rows.some((entry) => !availableRows.has(entry.rowNumber)))
      throw new Error('Mapping manifest contains a row that is absent from the source workbook.');
  }
  const sourceIdCounts = new Map<string, number>();
  for (const row of rows)
    if (row.sourceId) sourceIdCounts.set(row.sourceId, (sourceIdCounts.get(row.sourceId) ?? 0) + 1);
  const actor: Actor = { id: LOCAL_ADMIN_ID, role: 'hr' };
  for (const row of rows) {
    for (const issue of row.issues)
      counts.issueCounts[issue] = (counts.issueCounts[issue] ?? 0) + 1;
    counts.invalidFields += row.issues.length;
    if (row.sourceId && (sourceIdCounts.get(row.sourceId) ?? 0) > 1) {
      counts.issueCounts.duplicate_source_id = (counts.issueCounts.duplicate_source_id ?? 0) + 1;
      counts.unmatchedRows++;
      continue;
    }
    const mapping = byRow.get(row.rowNumber);
    if (!mapping) {
      counts.unmatchedRows++;
      continue;
    }
    counts.mappedRows++;
    const incoming = enrichedValues(row, sourceHash);
    await db.transaction(async (tx) => {
      const employee = await readEmployee(tx, mapping.employeeId);
      if (!employee) {
        counts.staleRows++;
        return;
      }
      const eventKey = `${sourceHash}:${row.rowNumber}:${employee.id}`;
      const prior = await tx.read<{ details_json: string }>(
        "SELECT details_json FROM administration_events WHERE resource_type='employee' AND resource_id=? AND action='profile_supplement_applied'",
        [employee.id],
      );
      if (
        prior.some((event) => {
          try {
            return (JSON.parse(event.details_json) as { eventKey?: string }).eventKey === eventKey;
          } catch {
            return false;
          }
        })
      ) {
        counts.repeatedRows++;
        return;
      }
      if (employee.record_version !== mapping.expectedRecordVersion) {
        counts.staleRows++;
        return;
      }
      const existing = await getProfileValues(tx, employee.id);
      const plan = planMissingOnly(existing, incoming);
      counts.conflicts += plan.conflicts.length;
      counts.unchangedFields += plan.unchanged.length;
      try {
        const validated = validateValues(employeeFields, plan.patch, { partial: true });
        validateProfileRelationships({ ...existing, ...validated });
      } catch (error) {
        counts.invalidPatches++;
        const code = (error as { code?: string }).code ?? 'UNKNOWN';
        const issue = `invalid_profile_patch:${code}`;
        counts.issueCounts[issue] = (counts.issueCounts[issue] ?? 0) + 1;
        return;
      }
      counts.fieldsToFill += Object.keys(plan.patch).length;
      if (Object.keys(plan.patch).length > 0) counts.eligibleRows++;
      if (!apply || !Object.keys(plan.patch).length) return;
      const version = await saveProfileValues(
        tx,
        actor,
        employee.id,
        plan.patch,
        `استكمال من تصدير الموظفين؛ مرجع ${sourceHash.slice(0, 12)}، الصف ${row.rowNumber}. لا يغيّر رصيد الإجازة أو يعتمد الاستحقاق.`,
        todayInRiyadh(),
        mapping.expectedRecordVersion,
      );
      await appendEvent(
        tx,
        actor,
        'employee',
        employee.id,
        'profile_supplement_applied',
        null,
        { eventKey, sourceHash, rowNumber: row.rowNumber, fields: Object.keys(plan.patch) },
        version,
      );
      counts.appliedRows++;
    });
  }
  return counts;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply && args.includes('--dry-run')) throw new Error('Choose either --apply or --dry-run.');
  const manifestIndex = args.indexOf('--manifest');
  const dbIndex = args.indexOf('--db');
  const manifestFile = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined;
  const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
  let fileArg: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--manifest' || args[index] === '--db') {
      index++;
      continue;
    }
    if (!args[index].startsWith('--') && !fileArg) fileArg = args[index];
  }
  if ((manifestIndex >= 0 && !manifestFile) || (dbIndex >= 0 && !dbPath))
    throw new Error('An option value is missing.');
  if (!fileArg || args.includes('--help')) {
    console.log(
      'Usage: npx tsx scripts/profile-supplement.ts <workbook.xlsx> [--manifest <private.json>] [--dry-run] [--apply] [--db path]',
    );
    process.exit(fileArg || args.includes('--help') ? 0 : 2);
  }
  if (apply && !manifestFile) throw new Error('--apply requires an explicit --manifest file.');
  const workbookPath = resolve(fileArg);
  const bytes = readFileSync(workbookPath);
  const sourceHash = sha256(bytes);
  const mapped = await mapSabqSupplementWorkbook(bytes);
  const manifest = manifestFile
    ? validateManifest(JSON.parse(readFileSync(resolve(manifestFile), 'utf8')), sourceHash)
    : undefined;
  const { db } = await openPrivateDatabase(dbPath);
  try {
    if (apply) await ensureLocalAdmin(db);
    const summary = await supplementProfiles(db, mapped.rows, sourceHash, manifest, apply);
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          sourceSha256: sourceHash,
          manifestProvided: !!manifest,
          ...summary,
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
