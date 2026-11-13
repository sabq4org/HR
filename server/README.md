# Server operations — synthetic HR preview 0.2.0

One Express application serves the API and built React UI. SQLite and PostgreSQL implement the same asynchronous `read`, `execute`, `transaction`, and `close` contract. Always use the transaction's `tx`; never call the outer database from within it. SQLite serializes operations; PostgreSQL uses one client and a schema-scoped advisory lock per transaction. Queries on that client are serialized. SQL values are parameterized.

## Modes and keys

- Local default: loopback on port 4317, SQLite `.data/hr-local.sqlite`. `HR_DB_PATH` overrides the local file. `npm run preview` opts into the same synthetic local mode with a built UI.
- Local PostgreSQL: `HR_DB_DRIVER=postgres`, dedicated `DATABASE_URL`, fixed `HR_DATA_KEY`; schema `hr_development`. Actual credentials belong in ignored environment configuration.
- Hosted preview: `HR_MODE=hosted-demo` plus explicit HTTPS `HR_PUBLIC_ORIGIN`. Forbids `HR_DB_PATH`; binds `0.0.0.0:$PORT`. Default is one ephemeral in-memory database per visitor. A Secure/HttpOnly/SameSite cookie identifies the workspace; persona switching stays inside it. Workspaces expire, are capped, and never use the developer's SQLite file.
- Optional hosted PostgreSQL creates `hr_preview_<random>` schemas and drops them at normal expiry/close. Crash-orphan cleanup is not implemented; leave `DATABASE_URL` unset for the present public preview. Do not mistake this option for durable user accounts or production tenancy.

Sensitive profile values, medical/request fields, file contents, history values/reasons and issued letters use AES-256-GCM with record-bound authenticated context. Local key file is owner-readable only; cloud connections require an explicit fixed key outside disposable hosted mode. Public memory workspaces use an ephemeral process key. This is application field encryption, not whole-disk encryption or a production key-management system.

## Schema upgrades

Six numbered migrations exist for each database dialect. Versions are recorded in `schema_migrations`; each migration and its version entry commit together. SQLite uses `BEGIN IMMEDIATE`, PostgreSQL uses transactions and an advisory lock.

1. Core employees, leave requests, decisions, append-only ledger and audit.
2. Synthetic policy versions, schedules and employment periods.
3. Policy working days and one open employment period.
4. Administrative profiles/history, workflows, documents, attendance, policies and audit.
5. Payroll runs/lines/payments/events, staged permissions and closed-record guards.
6. Additive completion of the preview schema: issued snapshots, notification request links, document capacity, unique primary payroll period, immutable events and closed-run insert guard. SQLite skips only ALTER ADD COLUMN statements whose column is already present from the unpublished intermediate development schema.

Seeds insert missing reference profiles/personas only; reopening never resets existing requests, ledgers, profiles, decisions or audit. All fixture values are fictional. No production data migration or cloud database provisioning has occurred.

Before upgrading a persistent local preview, run `npm run db:backup`. For intermediate development databases that already contain payroll runs, check duplicate primary periods first:

```sql
SELECT period, count(*)
FROM payroll_runs
WHERE correction_of IS NULL AND state <> 'rejected'
GROUP BY period HAVING count(*) > 1;
```

If any appear, stop and review the conflicting synthetic runs before applying migration 006. Never delete closed runs or rewrite their history to force the index. A failed migration rolls back and preserves the original database, but prevents startup until resolved. The local database used for this delivery passed all six migrations after backup.

## Backup and restore

`npm run db:backup` uses SQLite's consistent backup API, verifies integrity/foreign keys, and opens a temporary restored copy to compare schema, every application table's count, and content digests without printing sensitive rows. Backup and companion `.sqlite.key` files are permission 600. With `HR_DATA_KEY` supplied externally, preserve that secret in your approved secret manager; it is not copied from the environment.

The database file is not wholly encrypted; sensitive field payloads remain encrypted. The local companion key is convenient for synthetic recovery only, not a production storage boundary. `.data` and `.env*` are excluded from Git. No backup is uploaded.

For recovery, stop the process, preserve the whole current `.data` directory, create a clean one, restore the verified database to `.data/hr-local.sqlite`, restore its matching key to `.data/hr-data.key` with mode 600 (or configure the original external key), then start a compatible version. Do not restore over an active database or retain old WAL files. Use forward repair migrations rather than destructive down migrations.

`npm run test:recovery` creates a temporary employee profile and private attachment, backs up/restores SQLite, and verifies decryption and bytes. With `HR_TEST_DATABASE_URL` targeting localhost plus PostgreSQL binaries, it also tests pg_dump/pg_restore into an isolated temporary database and verifies the same encrypted content. Generated recovery resources are removed. It deliberately refuses remote PostgreSQL recovery targets. Production backup cadence, RPO/RTO and restore access remain unapproved.

## Permissions and financial boundaries

The server resolves current role/status, checks ownership or team scope, and hides confidential values outside permitted roles. Decisions, their side effects, audit and notifications occur in one transaction with idempotency keys and versions. No creator/subject self approval. Closed payroll and ledger events are not overwritten. Corrections use separate linked runs.

Payroll uses explicit synthetic salary components in profiles and integer halalas. Missing salary profiles are excluded and counted. Approved rewards/overtime have canonical reviewed amounts and may be consumed only once. Advances need a separately approved repayment plan before automatic deduction; no statutory GOSI/EOS formula or banking transfer is implemented. Future employee changes remain pending until their effective date; no scheduler applies them early.

Private uploads accept bounded PDF/PNG/JPEG with file-signature checks and authenticated attachment delivery. They have no public static URL. There is no antivirus engine; do not use real confidential documents in the preview. Internal notifications use the transactional outbox; no external mail/SMS worker is enabled.
