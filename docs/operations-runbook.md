# HR pilot operations runbook

## Scope and ownership

The operations worker creates internal in-app reminders in `outbox`. It does not send email, SMS, or push notifications. It does not approve requests, change employee data, close records, or perform scheduled effective-date changes. Document reminders exclude the medical-insurance category. Reminder text contains no employee name, document category, expiry date, leave type, reason, or profile value. Contract end dates are decrypted only in process to determine eligibility.

The scheduler defaults to one hourly pass. It runs one pass immediately after startup, then at the configured interval. A single process will not overlap its own passes. Multiple application processes may run concurrently; the database uniqueness constraint makes enqueueing idempotent. Configure `intervalMs` from 60 seconds through 24 hours, `overdueAfterDays` from 1 through 365, and document thresholds as unique whole days from 0 through 365. Defaults are 60 minutes, 3 overdue days, and 30/7/0 days to expiry. Expiry date thresholds use the current calendar date in Riyadh; approval age uses elapsed time.

## Routine monitoring

Inspect the newest runs using the database's normal read-only SQL console:

```sql
SELECT job_name, started_at, finished_at, status, reminders_created, failure_code
FROM operations_job_runs
ORDER BY started_at DESC
LIMIT 50;
```

Alert an operator when the latest run is `failed`, remains `running` beyond two configured intervals, or no run has started within two configured intervals. Failure codes are deliberately generic; they do not include SQL, employee values, document details, or exception text. The application currently has no external alert delivery integration. Investigate service logs and database health through the approved host tooling, without dumping protected rows into tickets or chat.

The `operations_reminder_dedupe` table is idempotency metadata. Its key binds resource type/id/version, threshold, and recipient. A correction that increments a resource version can create a new reminder. Existing notices remain in the internal outbox; do not remove or rewrite them to re-run maintenance.

## Backup and restore

Before a migration or local maintenance window, stop the app and run:

```sh
npm run db:backup
npm run db:verify
```

The backup command uses SQLite's online backup API, checks integrity and foreign keys, and opens a separate restored copy to compare schema and table content. It writes only under `.data/backups`, refuses to proceed if the source is missing, and never replaces the active database. Backup files and any local companion key are mode `0600`. If `HR_DATA_KEY` is externally managed, back it up separately in the authorized secret manager; the CLI does not print or copy it. Keep database backups and the matching data key together under the approved access policy.

For local SQLite restore: stop the process; preserve the current `.data` directory; copy a verified backup into the configured `HR_DB_PATH` (default `.data/hr-operational.sqlite` in operational mode, `.data/hr-local.sqlite` in local demo); provide the original external `HR_DATA_KEY` for operational mode (or restore the matching demo `.sqlite.key` as `.data/hr-data.key` with mode `0600`); ensure no old WAL/SHM files are paired with the restored file; run `npm run db:verify` with the same mode/path configuration; then start the compatible app. Never restore on top of an active database. Keep the preserved original until the restored app has been checked.

For PostgreSQL recovery, use the local-only recovery workflow in `npm run test:recovery` with installed `pg_dump`/`pg_restore` and a localhost `HR_TEST_DATABASE_URL` (also read from ignored `.env.pg-test`). The command verifies SQLite first, then fails if the PostgreSQL connection is missing; it does not start a database service. The script writes a custom-format dump to a temporary owner-only file, restores into a separate temporary database, checks encrypted profile/document recovery, the operations run record, decrypted TOTP and recovery-code login/replay rejection, then removes its temporary resources. For hosted PostgreSQL, arrange a provider-native backup and restore rehearsal under the approved access process; this repository does not configure a hosted backup schedule or key escrow. `db:backup` refuses PostgreSQL mode rather than backing up a local SQLite file.

After restoring, inspect recent `operations_job_runs`, run one explicit maintenance pass through the application-supported startup path, and confirm internal reminders are visible only to active recipients. Do not trigger approvals or perform manual future-dated employee mutations as a recovery check.

## Rollback and incident response

Migrations are forward-only and transactional. If migration 015 fails, preserve the database and sanitized startup error, restore the pre-change verified backup if required, and investigate before another start. Do not delete migration records or operational tables manually. If reminder content or recipient scope is wrong, stop scheduler startup using the normal host process controls, preserve the database, correct the code, and deploy through the authorized release workflow. Do not mass-delete outbox rows or dedupe keys; use a reviewed forward repair with an audit trail.

No production recovery point objective (RPO), recovery time objective (RTO), backup cadence, or restore access has been measured or approved by this runbook. The local checks establish only that the documented local recovery procedure works for the tested copy.
