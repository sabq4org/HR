# Local server operations

For the public synthetic preview, see `docs/decisions/002-hosted-synthetic-preview.md`.
`HR_MODE=hosted-demo` uses isolated in-memory databases, forbids `HR_DB_PATH`, and
requires an explicit HTTPS `HR_PUBLIC_ORIGIN`. It never opens the local database
described below. Preview workspaces are temporary and cannot be backed up.

The server uses `node:sqlite` and stores its synthetic local database at
`.data/hr-local.sqlite` by default. `server/index.ts` creates `.data` before
opening the database. `HR_DB_PATH` can point to a separate local file for
isolated development or migration checks. The database contains fictional
fixtures only; the seeded leave policy, employment periods, and work schedules
are explicitly marked synthetic and are not company policy or legal rules.

## Migrations

`schema_migrations` records applied versions. SQL migrations live in
`server/migrations/` and run in ascending order under `BEGIN IMMEDIATE`; the
version row commits in the same transaction as each migration. Migration 001
creates core HR and append-only records. Migration 002 adds synthetic policy,
schedule, and employment period references and pins leave requests to them.
Migration 003 persists the policy's working days and enforces one open
employment period per fictional employee. Seeds run transactionally after
migration, insert fixtures only when missing, and never reset a request, ledger
entry, decision, or audit record on restart.

Run `npm run db:backup` before upgrading. The command uses SQLite's consistent
backup API, checks integrity and foreign keys, restores into a temporary
directory, and compares counts and a content digest. Only local synthetic
backups are supported; they are not encrypted or uploaded.

If a migration fails, its schema changes and version row roll back together.
To restore, stop the server, move the entire current `.data` directory to a
safe location, create a new `.data` directory, and copy the verified backup
to `.data/hr-local.sqlite`. Never retain stale WAL sidecars next to a restored
database. Restart a compatible application version. There is no destructive
down migration; use forward migrations preserving the ledger and audit history.
