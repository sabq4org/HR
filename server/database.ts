import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;
const migrationFiles = [
  { version: 1, name: 'core', url: new URL('./migrations/001_core.sql', import.meta.url) },
  {
    version: 2,
    name: 'policy-and-employment',
    url: new URL('./migrations/002_policy_and_employment.sql', import.meta.url),
  },
  {
    version: 3,
    name: 'policy-workdays',
    url: new URL('./migrations/003_policy_workdays.sql', import.meta.url),
  },
];
export const DEMO_POLICY_ID = 'policy-demo-annual-v1';

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

function columns(db: Db, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  );
}

function applyMigrations(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const migration of migrationFiles) {
    const already = db
      .prepare('SELECT 1 AS found FROM schema_migrations WHERE version=?')
      .get(migration.version);
    if (already) continue;
    let sql = readFileSync(fileURLToPath(migration.url), 'utf8');
    if (migration.version === 2) {
      // A previous local prototype may have the core tables but no migration ledger.
      // Skip only an ALTER already represented in that legacy table.
      if (columns(db, 'leave_requests').has('policy_version_id'))
        sql = sql.replace(/ALTER TABLE leave_requests ADD COLUMN policy_version_id[^;]+;/, '');
      if (columns(db, 'leave_requests').has('work_schedule_id'))
        sql = sql.replace(/ALTER TABLE leave_requests ADD COLUMN work_schedule_id[^;]+;/, '');
    }
    if (migration.version === 3 && columns(db, 'policy_versions').has('working_days_json')) {
      sql = sql.replace(/ALTER TABLE policy_versions ADD COLUMN working_days_json[^;]+;/, '');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }
}

function seed(db: Db): void {
  db.exec('BEGIN IMMEDIATE');
  try {
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
    ] as const;
    const insertEmployee = db.prepare(
      'INSERT OR IGNORE INTO employees(id,employee_number,name,initials,title,department,email,location,manager_id,join_date,role,color) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const row of employees) insertEmployee.run(...row);

    const today = todayInRiyadh();
    const now = new Date().toISOString();
    const day = new Date(`${today}T12:00:00Z`).getUTCDay();
    const nextSunday = addDays(today, (7 - day) % 7);
    db.prepare(
      `INSERT OR IGNORE INTO policy_versions(id,policy_key,version,effective_from,approval_status,source,allocated_days,created_at,working_days_json)
      VALUES(?,'annual-leave','demo-1',?,'synthetic-demo-only','Synthetic demo fixture; not law or Sabq policy.',24,?,'[0,1,2,3,4]')`,
    ).run(DEMO_POLICY_ID, today, now);

    const insertSchedule =
      db.prepare(`INSERT OR IGNORE INTO work_schedules(id,employee_id,version,timezone,working_days_json,source,created_at)
      VALUES(?,?,'demo-1','Asia/Riyadh','[0,1,2,3,4]','Synthetic demo fixture; Sun-Thu only.',?)`);
    const insertPeriod =
      db.prepare(`INSERT OR IGNORE INTO employment_periods(id,employee_id,start_date,relationship_type,source,status,created_at)
      VALUES(?,?,?,'fictional-demo-record','Synthetic demo fixture; not an employment record.','synthetic-demo-only',?)`);
    const insertAllocation = db.prepare(`INSERT INTO leave_ledger(employee_id,kind,days,created_at)
      SELECT ?,'allocation',allocated_days,? FROM policy_versions WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM leave_ledger WHERE employee_id=? AND kind='allocation')`);
    for (const row of employees) {
      const scheduleId = scheduleIdFor(row[0]);
      insertSchedule.run(scheduleId, row[0], now);
      insertPeriod.run(`period-demo-${row[0]}-1`, row[0], row[9], now);
      insertAllocation.run(row[0], now, DEMO_POLICY_ID, row[0]);
      db.prepare(
        'UPDATE leave_requests SET policy_version_id=?,work_schedule_id=? WHERE employee_id=? AND (policy_version_id IS NULL OR work_schedule_id IS NULL)',
      ).run(DEMO_POLICY_ID, scheduleId, row[0]);
    }

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
      // Upcoming approved sample keeps the team calendar populated within the coming week.
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
    const request =
      db.prepare(`INSERT INTO leave_requests(id,employee_id,start_date,end_date,days,note,status,created_at,manager_decision_at,hr_decision_at,decision_reason,policy_version_id,work_schedule_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
    for (const [id, employee, start, end, days, note, status] of examples) {
      const managerAt = status === 'pending_manager' ? null : now;
      const hrAt =
        status === 'pending_hr' || status === 'rejected'
          ? null
          : status === 'approved'
            ? now
            : null;
      const inserted = request.run(
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
      );
      const ledgerKind =
        status === 'pending_manager' || status === 'pending_hr'
          ? 'reserve'
          : status === 'approved'
            ? 'consume'
            : null;
      const ledgerDays = status === 'approved' ? -days : days;
      if (inserted.changes && ledgerKind)
        db.prepare(
          `INSERT INTO leave_ledger(employee_id,leave_id,kind,days,created_at)
        VALUES(?,?,?,?,?)`,
        ).run(employee, id, ledgerKind, ledgerDays, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export function scheduleIdFor(employeeId: string): string {
  return `schedule-demo-${employeeId}-v1`;
}

export function createDatabase(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  applyMigrations(db);
  seed(db);
  return db;
}
