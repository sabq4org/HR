# Server operations — HR account pilot 0.3.0

One Express application serves the API and built React UI. SQLite and PostgreSQL implement the same asynchronous `read`, `execute`, `transaction`, and `close` contract. Always use the transaction's `tx`; never call the outer database from within it. SQLite serializes operations; PostgreSQL uses one client and a schema-scoped advisory lock per transaction. Queries on that client are serialized. SQL values are parameterized.

## Modes and keys

- Local default: loopback on port 4317, SQLite `.data/hr-local.sqlite`. `HR_DB_PATH` overrides the local file. `npm run preview` opts into the same synthetic local mode with a built UI.
- Local PostgreSQL: `HR_DB_DRIVER=postgres`, dedicated `DATABASE_URL`, fixed `HR_DATA_KEY`; schema `hr_development`. Actual credentials belong in ignored environment configuration.
- Hosted preview: `HR_MODE=hosted-demo` plus explicit HTTPS `HR_PUBLIC_ORIGIN`. Forbids `HR_DB_PATH`; binds `0.0.0.0:$PORT`. Default is one ephemeral in-memory database per visitor. A Secure/HttpOnly/SameSite cookie identifies the workspace; persona switching stays inside it. Workspaces expire, are capped, and never use the developer's SQLite file.
- Optional hosted PostgreSQL creates `hr_preview_<random>` schemas and drops them at normal expiry/close. Crash-orphan cleanup is not implemented; leave `DATABASE_URL` unset for the present public preview. Do not mistake this option for durable user accounts or production tenancy.
- Account pilot: `HR_MODE=operational`, a fixed 32-byte base64url `HR_DATA_KEY`, and no synthetic seed by default. Local SQLite uses `.data/hr-operational.sqlite`; PostgreSQL uses `hr_operational`. Public hosting requires dedicated PostgreSQL and an explicit HTTPS `HR_PUBLIC_ORIGIN`; public fixture seeding and in-memory databases are rejected. Initial HR and approver accounts are explicitly nominated through the offline `accounts:bootstrap` command. Demo login is unavailable. See [account guide](../docs/account-pilot-guide.md).

Sensitive profile values, medical/request fields, file contents, history values/reasons and issued letters use AES-256-GCM with record-bound authenticated context. Local key file is owner-readable only; cloud connections require an explicit fixed key outside disposable hosted mode. Public memory workspaces use an ephemeral process key. This is application field encryption, not whole-disk encryption or a production key-management system.

## Schema upgrades

Ten numbered migrations exist for each database dialect. Versions are recorded in `schema_migrations`; each migration and its version entry commit together. SQLite uses `BEGIN IMMEDIATE`, PostgreSQL uses transactions and an advisory lock.

1. Core employees, leave requests, decisions, append-only ledger and audit.
2. Synthetic policy versions, schedules and employment periods.
3. Policy working days and one open employment period.
4. Administrative profiles/history, workflows, documents, attendance, policies and audit.
5. Payroll runs/lines/payments/events, staged permissions and closed-record guards.
6. Additive completion of the preview schema: issued snapshots, notification request links, document capacity, unique primary payroll period, immutable events and closed-run insert guard. SQLite skips only ALTER ADD COLUMN statements whose column is already present from the unpublished intermediate development schema.

7. Pin new payroll runs to profile-components policy version 2; retain and retire only the intermediate local flat-salary version 1 without rewriting its values. Reject a policy whose calculator does not match the implemented synthetic engine.

8. Internal accounts, hashed sessions and recovery codes, encrypted TOTP secrets, persistent throttling and independently approved role changes.
9. Annual-leave policy/calendar snapshots, independent policy assignments, linked amendment requests, immutable approval history and compensating ledger references.
10. Scheduled maintenance runs and deduplicated internal reminders.

Demo seeds insert missing reference profiles/personas only; reopening never resets existing requests, ledgers, profiles, decisions or audit. Operational mode skips them unless explicitly opted into a local synthetic test. All delivery fixtures are fictional. No production data migration or cloud database provisioning has occurred. Existing leave records without a calculation snapshot are not assigned invented historic rules: approval/amendment is blocked pending a separately reviewed migration; pending records may be rejected.

Before upgrading a persistent local preview, run `npm run db:backup`. For intermediate development databases that already contain payroll runs, check duplicate primary periods first:

```sql
SELECT period, count(*)
FROM payroll_runs
WHERE correction_of IS NULL AND state <> 'rejected'
GROUP BY period HAVING count(*) > 1;
```

If any appear, stop and review the conflicting synthetic runs before applying migration 006. Never delete closed runs or rewrite their history to force the index. A failed migration rolls back and preserves the original database, but prevents startup until resolved. The local database used for this delivery passed all seven migrations after backup.

## Backup and restore

`npm run db:backup` uses SQLite's consistent backup API, verifies integrity/foreign keys, and opens a temporary restored copy to compare schema, every application table's count, and content digests without printing sensitive rows. Backup and companion `.sqlite.key` files are permission 600. With `HR_DATA_KEY` supplied externally, preserve that secret in your approved secret manager; it is not copied from the environment.

The database file is not wholly encrypted; sensitive field payloads remain encrypted. The local companion key is convenient for synthetic recovery only, not a production storage boundary. `.data` and `.env*` are excluded from Git. No backup is uploaded.

For recovery, stop the process, preserve the whole current `.data` directory, create a clean one, restore the verified database to `.data/hr-local.sqlite`, restore its matching key to `.data/hr-data.key` with mode 600 (or configure the original external key), then start a compatible version. Do not restore over an active database or retain old WAL files. Use forward repair migrations rather than destructive down migrations.

`npm run test:recovery` creates a temporary employee profile, private attachment, maintenance run and activated synthetic account. It restores SQLite and verifies decryption, bytes and login with a one-use recovery code, including rejection of reuse. Full verification then requires a localhost `HR_TEST_DATABASE_URL` plus `pg_dump`/`pg_restore` to restore into an isolated temporary database; the command fails if that configuration is missing. It reads ignored `.env.pg-test` when present. Generated recovery resources are removed; remote PostgreSQL targets are refused. Production backup cadence, RPO/RTO and restore access remain unapproved. See [operations runbook](../docs/operations-runbook.md) for schedules, key handling and rollback. The SQLite backup command refuses PostgreSQL mode rather than backing up the wrong file.

## Permissions and financial boundaries

The server resolves current role/status, checks ownership or team scope, and hides confidential values outside permitted roles. Decisions, their side effects, audit and notifications occur in one transaction with idempotency keys and versions. No creator/subject self approval. Closed payroll and ledger events are not overwritten. Corrections use separate linked runs.

Payroll uses explicit synthetic salary components in profiles and integer halalas. Missing salary profiles are excluded and counted. Approved rewards/overtime have canonical reviewed amounts and may be consumed only once. Advances need a separately approved repayment plan before automatic deduction; no statutory GOSI/EOS formula or banking transfer is implemented. Future employee changes remain pending until their effective date; no scheduler applies them early.

All payroll API routes are blocked in operational account mode until the financial phase is approved. Annual leave needs an approved dated policy assignment and opening balance. Requests spanning policy boundaries are rejected for HR review, not silently calculated from one policy. Future assignments cannot be approved early. Approved annual-leave changes preserve the original record and apply counter-entries atomically. Role changes revoke existing sessions; reset/privileged provisioning and approvals require fresh MFA where specified in the account guide.

Private uploads accept bounded PDF/PNG/JPEG with file-signature checks and authenticated attachment delivery. They have no public static URL. There is no antivirus engine; do not use real confidential documents in the preview. Internal notifications use the transactional outbox; operational mode checks expiry/overdue reminders on startup and hourly by default, with durable deduplication. No external mail/SMS worker is enabled.
