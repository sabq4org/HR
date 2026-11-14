import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { seedAdministrationProfiles } from './administration/seed.js';

export interface DbResult<T> {
  rows: T[];
  rowCount: number;
}
export interface AsyncDb {
  readonly dialect: 'sqlite' | 'postgres';
  read<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  transaction<T>(work: (tx: AsyncDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export type Db = AsyncDb;
export const DEMO_POLICY_ID = 'policy-demo-annual-v1';

type Migration = { version: number; name: string; url: URL };
function migrationsIn(directory: URL): Migration[] {
  return readdirSync(fileURLToPath(directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{3}_[a-z0-9_-]+\.sql$/i.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(/^(\d{3})_(.+)\.sql$/i)!;
      return { version: Number(match[1]), name: match[2], url: new URL(entry.name, directory) };
    })
    .sort((a, b) => a.version - b.version);
}

export function todayInRiyadh(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function sqliteParams(params: unknown[] = []): SQLInputValue[] {
  return params.map((value) => value as SQLInputValue);
}
class SqliteTx implements AsyncDb {
  readonly dialect = 'sqlite' as const;
  constructor(
    private readonly connection: DatabaseSync,
    private readonly root: SqliteAdapter,
  ) {}
  async read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.connection.prepare(sql).all(...sqliteParams(params)) as T[];
  }
  async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    const result = this.connection.prepare(sql).run(...sqliteParams(params));
    return { rowCount: Number(result.changes) };
  }
  async transaction<T>(_work: (tx: AsyncDb) => Promise<T>): Promise<T> {
    throw new Error('Nested database transactions are not supported; pass the active tx through.');
  }
  async close(): Promise<void> {
    throw new Error('A transaction-scoped database cannot be closed.');
  }
}

class SqliteAdapter implements AsyncDb {
  readonly dialect = 'sqlite' as const;
  private readonly mutex = new AsyncMutex();
  private closed = false;
  constructor(readonly connection: DatabaseSync) {}
  private assertOpen() {
    if (this.closed) throw new Error('SQLite database is closed.');
  }
  async read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.mutex.run(() => {
      this.assertOpen();
      return this.connection.prepare(sql).all(...sqliteParams(params)) as T[];
    });
  }
  async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    return this.mutex.run(() => {
      this.assertOpen();
      const result = this.connection.prepare(sql).run(...sqliteParams(params));
      return { rowCount: Number(result.changes) };
    });
  }
  async transaction<T>(work: (tx: AsyncDb) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      this.assertOpen();
      this.connection.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(new SqliteTx(this.connection, this));
        this.connection.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.connection.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    await this.mutex.run(() => {
      if (!this.closed) {
        this.closed = true;
        this.connection.close();
      }
    });
  }
}

type SharedPool = { pool: Pool; refs: number; ending?: Promise<void> };
const pools = new Map<string, SharedPool>();
function acquirePool(url: string): SharedPool {
  let shared = pools.get(url);
  if (!shared || shared.ending) {
    shared = {
      pool: new Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000 }),
      refs: 0,
    };
    pools.set(url, shared);
  }
  shared.refs += 1;
  return shared;
}
async function releasePool(url: string, shared: SharedPool): Promise<void> {
  shared.refs -= 1;
  if (shared.refs > 0) return;
  if (pools.get(url) === shared) pools.delete(url);
  shared.ending = shared.pool.end();
  await shared.ending;
}

function pgSql(sql: string): string {
  let output = '';
  let parameter = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockDepth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      output += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      output += char;
      if (char === '/' && next === '*') {
        output += next;
        i += 1;
        blockDepth += 1;
      } else if (char === '*' && next === '/') {
        output += next;
        i += 1;
        blockDepth -= 1;
      }
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote && next === quote) {
        output += next;
        i += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '-' && next === '-') {
      output += '--';
      i += 1;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      output += '/*';
      i += 1;
      blockDepth = 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
      continue;
    }
    if (char === '?') {
      parameter += 1;
      output += `$${parameter}`;
      continue;
    }
    output += char;
  }
  if (quote || blockDepth) throw new Error('Malformed SQL passed to PostgreSQL adapter.');
  return output;
}

class PgTx implements AsyncDb {
  readonly dialect = 'postgres' as const;
  private readonly operations = new AsyncMutex();
  constructor(private readonly client: PoolClient) {}
  async read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.operations.run(async () => {
      const result = await this.client.query(pgSql(sql), params);
      return result.rows as T[];
    });
  }
  async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    return this.operations.run(async () => {
      const result = await this.client.query(pgSql(sql), params);
      return { rowCount: result.rowCount ?? 0 };
    });
  }
  async transaction<T>(_work: (tx: AsyncDb) => Promise<T>): Promise<T> {
    throw new Error('Nested database transactions are not supported; pass the active tx through.');
  }
  async close(): Promise<void> {
    throw new Error('A transaction-scoped database cannot be closed.');
  }
}

const SCHEMA_RE = /^hr_(?:development|test_[a-z0-9_]+|preview_[a-f0-9]{16,64})$/;
function quoteSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema) || schema === 'hr_public')
    throw new Error('Refusing an unsafe or public PostgreSQL schema name.');
  return `"${schema}"`;
}
async function withPgTransaction<T>(
  pool: Pool,
  schema: string,
  work: (client: PoolClient) => Promise<T>,
  lock: boolean,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${quoteSchema(schema)}`);
    if (lock)
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))'.replace('?', '$1'),
        [schema],
      );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

class PostgresAdapter implements AsyncDb {
  readonly dialect = 'postgres' as const;
  private closed = false;
  private readonly dropSchema: boolean;
  constructor(
    private readonly url: string,
    private readonly shared: SharedPool,
    readonly schema: string,
    dropSchema: boolean,
  ) {
    this.dropSchema = dropSchema;
  }
  private assertOpen() {
    if (this.closed) throw new Error('PostgreSQL database is closed.');
  }
  async read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.assertOpen();
    return withPgTransaction(
      this.shared.pool,
      this.schema,
      async (client) => (await client.query(pgSql(sql), params)).rows as T[],
      false,
    );
  }
  async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    this.assertOpen();
    return withPgTransaction(
      this.shared.pool,
      this.schema,
      async (client) => {
        const result = await client.query(pgSql(sql), params);
        return { rowCount: result.rowCount ?? 0 };
      },
      true,
    );
  }
  async transaction<T>(work: (tx: AsyncDb) => Promise<T>): Promise<T> {
    this.assertOpen();
    return withPgTransaction(
      this.shared.pool,
      this.schema,
      (client) => work(new PgTx(client)),
      true,
    );
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.dropSchema)
        await this.shared.pool.query(`DROP SCHEMA IF EXISTS ${quoteSchema(this.schema)} CASCADE`);
    } finally {
      await releasePool(this.url, this.shared);
    }
  }
}

function sqliteColumns(connection: DatabaseSync, table: string): Set<string> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('Unsafe SQLite table name.');
  return new Set(
    (connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
}
function omitDuplicateSqliteAlters(connection: DatabaseSync, sql: string): string {
  return sql.replace(
    /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)[^;]*;/gi,
    (statement, table: string, column: string) =>
      sqliteColumns(connection, table).has(column) ? '' : statement,
  );
}
async function applySqliteMigrations(connection: DatabaseSync): Promise<void> {
  connection.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const migration of migrationsIn(new URL('./migrations/', import.meta.url))) {
    const already = connection
      .prepare('SELECT 1 AS found FROM schema_migrations WHERE version=?')
      .get(migration.version);
    if (already) continue;
    const sql = omitDuplicateSqliteAlters(
      connection,
      readFileSync(fileURLToPath(migration.url), 'utf8'),
    );
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec(sql);
      connection
        .prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
        .run(migration.version, migration.name, new Date().toISOString());
      connection.exec('COMMIT');
    } catch (error) {
      try {
        connection.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }
}

async function applyPostgresMigrations(pool: Pool, schema: string): Promise<void> {
  await withPgTransaction(
    pool,
    schema,
    async (client) => {
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)',
      );
    },
    false,
  );
  for (const migration of migrationsIn(new URL('./migrations/postgres/', import.meta.url))) {
    const sql = readFileSync(fileURLToPath(migration.url), 'utf8');
    await withPgTransaction(
      pool,
      schema,
      async (client) => {
        const already = await client.query(
          'SELECT 1 AS found FROM schema_migrations WHERE version=$1',
          [migration.version],
        );
        if (already.rowCount) return;
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(version,name,applied_at) VALUES($1,$2,$3)',
          [migration.version, migration.name, new Date().toISOString()],
        );
      },
      true,
    );
  }
}

export async function createDatabase(
  path = ':memory:',
  options: { seed?: boolean } = {},
): Promise<Db> {
  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  await applySqliteMigrations(connection);
  const db = new SqliteAdapter(connection);
  try {
    // Private (real-data) databases never receive synthetic personas or fixtures.
    if (options.seed === false) {
      const synthetic = await db.read<{ id: string }>(
        "SELECT id FROM employees WHERE id IN ('emp-noura','emp-omar','emp-sara') LIMIT 1",
      );
      if (synthetic.length)
        throw new Error('Refusing to open a synthetic demo database as a private data database.');
      return db;
    }
    await seed(db);
    await seedAdministrationProfiles(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function createPostgresDatabase(url: string, schema = 'hr_development'): Promise<Db> {
  if (!url) throw new Error('A PostgreSQL connection string is required.');
  const quoted = quoteSchema(schema);
  const dropSchema = schema.startsWith('hr_preview_');
  const shared = acquirePool(url);
  let client: PoolClient | undefined;
  try {
    client = await shared.pool.connect();
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    if (dropSchema && exists.rowCount)
      throw new Error('Refusing to reuse an existing PostgreSQL preview schema.');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
  } catch (error) {
    client?.release();
    await releasePool(url, shared);
    throw error;
  }
  client.release();
  const db = new PostgresAdapter(url, shared, schema, dropSchema);
  try {
    await applyPostgresMigrations(shared.pool, schema);
    await seed(db);
    await seedAdministrationProfiles(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function seed(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const employees = [
      [
        'emp-omar',
        'S-002',
        'عمر الشمري',
        'ع ش',
        'مدير التحرير',
        'التحرير',
        'omar@example.test',
        'الرياض',
        null,
        '2018-06-15',
        'manager',
        '#D9E8F5',
      ],
      [
        'emp-noura',
        'S-001',
        'نورة العتيبي',
        'ن ع',
        'مديرة الموارد البشرية',
        'الموارد البشرية',
        'noura@example.test',
        'الرياض',
        'emp-omar',
        '2020-03-01',
        'hr',
        '#CDE8DF',
      ],
      [
        'emp-sara',
        'S-003',
        'سارة القحطاني',
        'س ق',
        'محررة أخبار',
        'التحرير',
        'sara@example.test',
        'الرياض',
        'emp-omar',
        '2022-01-09',
        'employee',
        '#F4DFD3',
      ],
      [
        'emp-fahad',
        'S-004',
        'فهد الدوسري',
        'ف د',
        'محرر اقتصادي',
        'الاقتصاد',
        'fahad@example.test',
        'الرياض',
        'emp-omar',
        '2021-08-22',
        'employee',
        '#E8E2F5',
      ],
      [
        'emp-lina',
        'S-005',
        'لينا الحربي',
        'ل ح',
        'محررة محلية',
        'المحليات',
        'lina@example.test',
        'جدة',
        'emp-omar',
        '2023-02-12',
        'employee',
        '#F5E8C9',
      ],
      [
        'emp-yousef',
        'S-006',
        'يوسف المطيري',
        'ي م',
        'مصور صحفي',
        'التصوير',
        'yousef@example.test',
        'الرياض',
        'emp-omar',
        '2020-10-04',
        'employee',
        '#DCEAD9',
      ],
      [
        'emp-maha',
        'S-007',
        'مها الزهراني',
        'م ز',
        'منتجة محتوى',
        'الوسائط',
        'maha@example.test',
        'جدة',
        'emp-omar',
        '2024-04-07',
        'employee',
        '#F0DDEA',
      ],
      [
        'emp-khaled',
        'S-008',
        'خالد العنزي',
        'خ ع',
        'محرر رياضي',
        'الرياضة',
        'khaled@example.test',
        'الرياض',
        'emp-omar',
        '2019-11-17',
        'employee',
        '#D6E8EB',
      ],
      [
        'emp-reem',
        'S-009',
        'ريم الحربي',
        'ر ح',
        'مديرة الشؤون المالية',
        'المالية',
        'reem@example.test',
        'الرياض',
        'emp-omar',
        '2022-05-01',
        'employee',
        '#DFE6F8',
      ],
      [
        'emp-abdullah',
        'S-010',
        'عبدالله السبيعي',
        'ع س',
        'معتمد إداري',
        'الإدارة',
        'abdullah@example.test',
        'الرياض',
        'emp-omar',
        '2019-02-10',
        'employee',
        '#E9E1D2',
      ],
      [
        'emp-hind',
        'S-011',
        'هند الزهراني',
        'ه ز',
        'مدققة داخلية',
        'المراجعة',
        'hind@example.test',
        'الرياض',
        'emp-omar',
        '2021-09-12',
        'employee',
        '#E4E5E7',
      ],
    ] as const;
    const now = new Date().toISOString();
    const today = todayInRiyadh();
    const insertEmployee =
      'INSERT INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING';
    for (const row of employees) await tx.execute(insertEmployee, [...row]);
    for (const [id, role] of [
      ['emp-reem', 'finance'],
      ['emp-abdullah', 'approver'],
      ['emp-hind', 'auditor'],
    ])
      await tx.execute('UPDATE employees SET access_role=? WHERE id=? AND access_role IS NULL', [
        role,
        id,
      ]);
    await tx.execute(
      `INSERT INTO policy_versions(id,policy_key,version,effective_from,approval_status,source,allocated_days,created_at,working_days_json)
      VALUES(?,'annual-leave','demo-1',?,'synthetic-demo-only','Synthetic demo fixture; not law or Sabq policy.',24,?,'[0,1,2,3,4]') ON CONFLICT(id) DO NOTHING`,
      [DEMO_POLICY_ID, today, now],
    );
    for (const row of employees) {
      const scheduleId = scheduleIdFor(row[0]);
      await tx.execute(
        `INSERT INTO work_schedules(id,employee_id,version,timezone,working_days_json,source,created_at)
        VALUES(?,?,'demo-1','Asia/Riyadh','[0,1,2,3,4]','Synthetic demo fixture; Sun-Thu only.',?) ON CONFLICT(id) DO NOTHING`,
        [scheduleId, row[0], now],
      );
      await tx.execute(
        `INSERT INTO employment_periods(id,employee_id,start_date,relationship_type,source,status,created_at)
        VALUES(?,?,?,'fictional-demo-record','Synthetic demo fixture; not an employment record.','synthetic-demo-only',?) ON CONFLICT(id) DO NOTHING`,
        [`period-demo-${row[0]}-1`, row[0], row[9], now],
      );
      await tx.execute(
        `INSERT INTO leave_ledger(employee_id,kind,days,created_at)
        SELECT ?,'allocation',allocated_days,? FROM policy_versions WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM leave_ledger WHERE employee_id=? AND kind='allocation')`,
        [row[0], now, DEMO_POLICY_ID, row[0]],
      );
      await tx.execute(
        'UPDATE leave_requests SET policy_version_id=?,work_schedule_id=? WHERE employee_id=? AND (policy_version_id IS NULL OR work_schedule_id IS NULL)',
        [DEMO_POLICY_ID, scheduleId, row[0]],
      );
    }
    const day = new Date(`${today}T12:00:00Z`).getUTCDay();
    const nextSunday = addDays(today, (7 - day) % 7);
    const examples = [
      [
        'leave-demo-sara',
        'emp-sara',
        addDays(nextSunday, 7),
        addDays(nextSunday, 8),
        2,
        'إجازة سنوية تجريبية',
        'pending_manager',
      ],
      [
        'leave-demo-fahad',
        'emp-fahad',
        addDays(nextSunday, 14),
        addDays(nextSunday, 16),
        3,
        'إجازة سنوية تجريبية',
        'pending_hr',
      ],
      [
        'leave-demo-lina',
        'emp-lina',
        nextSunday,
        addDays(nextSunday, 1),
        2,
        'إجازة سنوية تجريبية',
        'approved',
      ],
      [
        'leave-demo-yousef',
        'emp-yousef',
        addDays(nextSunday, -7),
        addDays(nextSunday, -6),
        2,
        'إجازة سنوية تجريبية',
        'rejected',
      ],
    ] as const;
    for (const [id, employee, start, end, days, note, status] of examples) {
      const managerAt = status === 'pending_manager' ? null : now;
      const hrAt = status === 'approved' ? now : null;
      const inserted = await tx.execute(
        `INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,note,status,created_at,manager_decision_at,hr_decision_at,decision_reason,policy_version_id,work_schedule_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        [
          id,
          employee,
          start,
          end,
          days,
          note,
          status,
          now,
          managerAt,
          hrAt,
          status === 'rejected' ? 'مثال توضيحي' : null,
          DEMO_POLICY_ID,
          scheduleIdFor(employee),
        ],
      );
      if (inserted.rowCount) {
        const ledgerKind =
          status === 'pending_manager' || status === 'pending_hr'
            ? 'reserve'
            : status === 'approved'
              ? 'consume'
              : null;
        const ledgerDays = status === 'approved' ? -days : days;
        if (ledgerKind)
          await tx.execute(
            'INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at) VALUES(?,?,?,?,?)',
            [employee, id, ledgerKind, ledgerDays, now],
          );
      }
    }
  });
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export function scheduleIdFor(employeeId: string): string {
  return `schedule-demo-${employeeId}-v1`;
}
