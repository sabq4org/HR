import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { generateSecret, generateURI, verify } from 'otplib';
import type { Actor, AccountSummary } from '../../shared/access.js';
import type { Role } from '../../shared/contracts.js';
import type { AsyncDb } from '../database.js';
import { decryptSensitive, encryptSensitive, sha256 } from '../administration/security.js';
import { isSystemOwner } from '../system-owner.js';

const SESSION_COOKIE_LOCAL = 'sabq_hr_account';
const SESSION_COOKIE_SECURE = '__Host-sabq_hr_account';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ACTIVATION_TTL_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const STEP_UP_MAX_ATTEMPTS = 10;
const RECOVERY_COUNT = 10;
const PASSWORD_COST = 1 << 15;
const PASSWORD_MAXMEM = 64 * 1024 * 1024;
const LOGIN_FAILURE = {
  code: 'AUTH_FAILED',
  message: 'تعذر تسجيل الدخول. تحقق من البيانات وحاول لاحقًا.',
};
const scryptOptions = { N: PASSWORD_COST, r: 8, p: 1, maxmem: PASSWORD_MAXMEM };

type Fault = Error & { status: number; code: string };
type Employee = { id: string; name: string; employee_number: string; role: Role; status: string };
type Account = {
  employee_id: string;
  login_name: string;
  password_hash: string | null;
  totp_secret_ciphertext: string | null;
  totp_last_step: number;
  activation_token_hash: string | null;
  activation_expires_at: string | null;
  activated_at: string | null;
  enabled: number | boolean;
};
type TotpVerification = { valid: boolean; timeStep?: number; epoch?: number };
const ROLES: Role[] = ['employee', 'manager', 'hr', 'finance', 'approver', 'auditor'];

function fault(status: number, code: string, message: string): Fault {
  return Object.assign(new Error(message), { status, code });
}
function normalizeLogin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const login = value.trim().toLowerCase();
  if (login.length < 3 || login.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login))
    return undefined;
  return login;
}
function tokenFrom(req: Request, cookieName: string): string | undefined {
  const prefix = `${cookieName}=`;
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}
function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function rateKey(scope: string, value: string): string {
  return sha256(`account-rate:${scope}:${value.slice(0, 300)}`);
}
function isEnabled(account: Account): boolean {
  return account.enabled === true || account.enabled === 1;
}
function tokenHash(token: string): string {
  return sha256(token);
}
function accountContext(employeeId: string): string {
  return `employee-account:${employeeId}:totp:v1`;
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `scrypt$${PASSWORD_COST}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
async function verifyPassword(password: string, value: string | null): Promise<boolean> {
  const parts = value?.split('$');
  const validStored =
    parts?.length === 4 &&
    parts[0] === 'scrypt' &&
    parts[1] === String(PASSWORD_COST) &&
    /^[A-Za-z0-9_-]{20,24}$/.test(parts[2]) &&
    /^[A-Za-z0-9_-]{80,90}$/.test(parts[3]);
  const salt = validStored ? Buffer.from(parts![2], 'base64url') : Buffer.alloc(16);
  const expected = validStored ? Buffer.from(parts![3], 'base64url') : Buffer.alloc(64);
  const actual = await derivePassword(password, salt);
  return validStored && expected.length === actual.length && timingSafeEqual(expected, actual);
}
function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, scryptOptions, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}
function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
function recoveryCode(): string {
  return `${newToken(8)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5)}-${newToken(8)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5)}`;
}
function faultResponse(res: Response, error: unknown) {
  const item = error as { status?: number; code?: string; message?: string };
  const status = item.status ?? 500;
  res.status(status).json({
    error: {
      code: item.code ?? 'INTERNAL_ERROR',
      message: status === 500 ? 'تعذر إكمال العملية.' : (item.message ?? 'تعذر إكمال العملية.'),
    },
  });
}
function endpoint(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    void handler(req, res).catch((error) => faultResponse(res, error));
  };
}

/** Create an employee account and a single-use activation token. Intended for a trusted local CLI. */
export async function provisionEmployeeAccount(
  db: AsyncDb,
  input: { employeeId: string; loginName: string; actorId?: string; actorRole?: Role },
): Promise<{ activationToken: string; expiresAt: string }> {
  return db.transaction((tx) => provisionEmployeeAccountInTransaction(tx, input));
}

export async function provisionEmployeeAccountInTransaction(
  tx: AsyncDb,
  input: { employeeId: string; loginName: string; actorId?: string; actorRole?: Role },
): Promise<{ activationToken: string; expiresAt: string }> {
  const loginName = normalizeLogin(input.loginName);
  if (!loginName) throw fault(400, 'INVALID_LOGIN', 'أدخل بريدًا إلكترونيًا صالحًا للحساب.');
  const employee = (
    await tx.read<Employee>(
      'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
      [input.employeeId],
    )
  )[0];
  if (!employee || ['suspended', 'terminated'].includes(employee.status))
    throw fault(404, 'EMPLOYEE_NOT_AVAILABLE', 'ملف الموظف غير متاح للحساب.');
  const activationToken = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_MS).toISOString();
  const duplicate = (
    await tx.read<{ employee_id: string }>(
      'SELECT employee_id FROM employee_accounts WHERE login_name=?',
      [loginName],
    )
  )[0];
  if (duplicate && duplicate.employee_id !== input.employeeId)
    throw fault(409, 'LOGIN_IN_USE', 'بيانات الحساب غير متاحة.');
  const old = (
    await tx.read<Account>('SELECT * FROM employee_accounts WHERE employee_id=?', [
      input.employeeId,
    ])
  )[0];
  if (old) throw fault(409, 'ACCOUNT_EXISTS', 'يوجد حساب لهذا الموظف بالفعل.');
  await tx.execute(
    `INSERT INTO employee_accounts(employee_id,login_name,password_hash,totp_secret_ciphertext,
      activation_token_hash,activation_expires_at,activated_at,enabled,created_at,updated_at)
      VALUES(?,?,NULL,NULL,?,?,NULL,FALSE,?,?)`,
    [
      input.employeeId,
      loginName,
      tokenHash(activationToken),
      expiresAt,
      now.toISOString(),
      now.toISOString(),
    ],
  );
  await audit(
    tx,
    input.actorId ?? null,
    input.actorRole ?? null,
    input.employeeId,
    input.actorId ? 'account.provisioned' : 'account.provisioned.bootstrap',
  );
  return { activationToken, expiresAt };
}

/** Trusted local-CLI bootstrap only; runtime role changes go through two-person approval. */
export async function assignEmployeeRole(
  db: AsyncDb,
  input: { employeeId: string; role: Role; actorId?: string; actorRole?: Role },
): Promise<void> {
  return db.transaction((tx) => assignEmployeeRoleInTransaction(tx, input));
}

export async function assignEmployeeRoleInTransaction(
  tx: AsyncDb,
  input: { employeeId: string; role: Role; actorId?: string; actorRole?: Role },
): Promise<void> {
  if (!ROLES.includes(input.role)) throw fault(400, 'INVALID_ROLE', 'الدور المطلوب غير صالح.');
  if (input.actorId === input.employeeId)
    throw fault(403, 'SELF_ROLE_CHANGE', 'لا يمكن تغيير دور الحساب الذاتي.');
  const employee = (
    await tx.read<{ id: string }>('SELECT id FROM employees WHERE id=?', [input.employeeId])
  )[0];
  if (!employee) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
  const result = await tx.execute('UPDATE employees SET access_role=? WHERE id=?', [
    input.role,
    input.employeeId,
  ]);
  if (!result.rowCount) throw fault(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.');
  await tx.execute(
    'UPDATE account_sessions SET revoked_at=? WHERE employee_id=? AND revoked_at IS NULL',
    [new Date().toISOString(), input.employeeId],
  );
  await audit(
    tx,
    input.actorId ?? null,
    input.actorRole ?? null,
    input.employeeId,
    'account.role.bootstrap-assigned',
  );
}

/** Controlled operator recovery only; no runtime route exposes this last-admin bypass. */
export async function resetEmployeeAccountForOperator(
  tx: AsyncDb,
  input: { employeeId: string; reason: string; actorId?: string },
): Promise<{ activationToken: string; expiresAt: string }> {
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500)
    throw fault(400, 'OPERATOR_REASON_REQUIRED', 'سجّل سبب استعادة واضحًا من 8 إلى 500 حرف.');
  const account = (
    await tx.read<Account>('SELECT * FROM employee_accounts WHERE employee_id=?', [
      input.employeeId,
    ])
  )[0];
  if (!account) throw fault(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود.');
  const employee = (
    await tx.read<Employee>(
      'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
      [input.employeeId],
    )
  )[0];
  if (!employee || ['suspended', 'terminated'].includes(employee.status))
    throw fault(404, 'EMPLOYEE_NOT_AVAILABLE', 'ملف الموظف غير متاح للحساب.');
  const activationToken = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_MS).toISOString();
  await tx.execute(
    `UPDATE employee_accounts SET password_hash=NULL,totp_secret_ciphertext=NULL,totp_last_step=-1,
      activation_token_hash=?,activation_expires_at=?,activated_at=NULL,enabled=FALSE,updated_at=?
     WHERE employee_id=?`,
    [tokenHash(activationToken), expiresAt, now.toISOString(), input.employeeId],
  );
  await tx.execute(
    'UPDATE account_sessions SET revoked_at=? WHERE employee_id=? AND revoked_at IS NULL',
    [now.toISOString(), input.employeeId],
  );
  await tx.execute('DELETE FROM account_recovery_codes WHERE employee_id=?', [input.employeeId]);
  await audit(
    tx,
    input.actorId ?? null,
    'operator',
    input.employeeId,
    'account.operator-recovery',
    { reason },
  );
  return { activationToken, expiresAt };
}

export function createAccountAccess(db: AsyncDb, options: { secure: boolean }) {
  const cookieName = options.secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_LOCAL;
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: options.secure,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
  const accountByEmployee = async (employeeId: string) =>
    (
      await db.read<Account>('SELECT * FROM employee_accounts WHERE employee_id=?', [employeeId])
    )[0];
  const actorFor = async (req: Request): Promise<Actor | undefined> => {
    const rawToken = tokenFrom(req, cookieName);
    if (!rawToken || rawToken.length > 200) return undefined;
    const session = (
      await db.read<{ employee_id: string; expires_at: string; revoked_at: string | null }>(
        'SELECT employee_id,expires_at,revoked_at FROM account_sessions WHERE token_hash=?',
        [tokenHash(rawToken)],
      )
    )[0];
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now())
      return undefined;
    const [employee, account] = await Promise.all([
      db.read<Employee>(
        'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
        [session.employee_id],
      ),
      accountByEmployee(session.employee_id),
    ]);
    const current = employee[0];
    if (
      !current ||
      !account ||
      !isEnabled(account) ||
      !account.activated_at ||
      ['suspended', 'terminated'].includes(current.status)
    ) {
      await db.execute(
        'UPDATE account_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL',
        [new Date().toISOString(), tokenHash(rawToken)],
      );
      return undefined;
    }
    return {
      id: current.id,
      role: current.role,
      ...((await isSystemOwner(db, current.id, current.role)) ? { owner: true } : {}),
    };
  };
  const logout = async (req: Request, res: Response) => {
    const rawToken = tokenFrom(req, cookieName);
    if (rawToken)
      await db.execute(
        'UPDATE account_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL',
        [new Date().toISOString(), tokenHash(rawToken)],
      );
    res.clearCookie(cookieName, {
      httpOnly: true,
      sameSite: 'strict',
      secure: options.secure,
      path: '/',
    });
  };

  const register = (app: Express) => {
    app.post(
      '/api/auth/activation/setup',
      endpoint(async (req, res) => {
        const token =
          typeof req.body?.token === 'string' && req.body.token.length <= 200 ? req.body.token : '';
        const setup = await db.transaction(async (tx) => {
          const row =
            token &&
            (
              await tx.read<Account>(
                'SELECT * FROM employee_accounts WHERE activation_token_hash=? AND activation_expires_at>? AND enabled=FALSE',
                [tokenHash(token), new Date().toISOString()],
              )
            )[0];
          if (!row) return null;
          let secret: string;
          if (row.totp_secret_ciphertext)
            secret = decryptSensitive(row.totp_secret_ciphertext, accountContext(row.employee_id));
          else {
            secret = generateSecret();
            const saved = await tx.execute(
              'UPDATE employee_accounts SET totp_secret_ciphertext=?,updated_at=? WHERE employee_id=? AND activation_token_hash=? AND totp_secret_ciphertext IS NULL',
              [
                encryptSensitive(secret, accountContext(row.employee_id)),
                new Date().toISOString(),
                row.employee_id,
                tokenHash(token),
              ],
            );
            if (!saved.rowCount) return null;
          }
          return { secret, loginName: row.login_name };
        });
        if (!setup)
          throw fault(400, 'ACTIVATION_INVALID', 'رابط التفعيل غير صالح أو انتهت صلاحيته.');
        const uri = generateURI({
          issuer: 'سبق للموارد البشرية',
          label: setup.loginName,
          secret: setup.secret,
        });
        res.json({ ...setup, uri });
      }),
    );

    app.post(
      '/api/auth/activation/complete',
      endpoint(async (req, res) => {
        const token =
          typeof req.body?.token === 'string' && req.body.token.length <= 200 ? req.body.token : '';
        const password = req.body?.password;
        const otp = req.body?.otp;
        if (typeof password !== 'string' || password.length < 12 || password.length > 128)
          throw fault(400, 'PASSWORD_POLICY', 'استخدم كلمة مرور من 12 إلى 128 حرفًا.');
        if (typeof otp !== 'string' || !/^\d{6}$/.test(otp))
          throw fault(400, 'MFA_REQUIRED', 'أدخل رمز المصادقة من ستة أرقام.');
        const activationRateKeys = [
          rateKey('activation', token),
          rateKey('activation-ip', req.socket.remoteAddress ?? 'unknown'),
        ];
        if (!(await reserveRateLimit(db, activationRateKeys, Date.now(), [5, 30])))
          throw fault(429, 'AUTH_FAILED', LOGIN_FAILURE.message);
        const hash = tokenHash(token);
        const row = (
          await db.read<Account>(
            'SELECT * FROM employee_accounts WHERE activation_token_hash=? AND activation_expires_at>? AND enabled=FALSE',
            [hash, new Date().toISOString()],
          )
        )[0];
        if (!row?.totp_secret_ciphertext)
          throw fault(400, 'ACTIVATION_INVALID', 'رابط التفعيل غير صالح أو انتهت صلاحيته.');
        const secret = decryptSensitive(
          row.totp_secret_ciphertext,
          accountContext(row.employee_id),
        );
        const verification = (await verify({
          secret,
          token: otp,
          epoch: Date.now() / 1000,
          epochTolerance: [30, 0],
        })) as TotpVerification;
        if (!verification.valid) throw fault(400, 'MFA_INVALID', 'رمز المصادقة غير صحيح.');
        const activationStep =
          verification.timeStep ?? Math.floor((verification.epoch ?? Date.now() / 1000) / 30);
        const passwordHash = await hashPassword(password);
        const now = new Date().toISOString();
        const recoveryCodes = await db.transaction(async (tx) => {
          const employee = (
            await tx.read<Employee>(
              'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
              [row.employee_id],
            )
          )[0];
          if (!employee || ['suspended', 'terminated'].includes(employee.status)) return null;
          const result = await tx.execute(
            `UPDATE employee_accounts SET password_hash=?,enabled=TRUE,activated_at=?,activation_token_hash=NULL,
            activation_expires_at=NULL,totp_last_step=?,updated_at=?
           WHERE employee_id=? AND activation_token_hash=? AND activation_expires_at>? AND enabled=FALSE AND totp_last_step<?`,
            [passwordHash, now, activationStep, now, row.employee_id, hash, now, activationStep],
          );
          if (!result.rowCount) return null;
          await audit(tx, null, null, row.employee_id, 'account.activated');
          await tx.execute(
            'DELETE FROM account_login_limits WHERE key_hash IN (?,?)',
            activationRateKeys,
          );
          return issueRecoveryCodes(tx, row.employee_id, now);
        });
        if (!recoveryCodes)
          throw fault(400, 'ACTIVATION_INVALID', 'رابط التفعيل غير صالح أو انتهت صلاحيته.');
        res.json({ activated: true, recoveryCodes });
      }),
    );

    app.post(
      '/api/auth/login',
      endpoint(async (req, res) => {
        const loginName = normalizeLogin(req.body?.loginName);
        const password =
          typeof req.body?.password === 'string' ? req.body.password.slice(0, 128) : '';
        const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim().slice(0, 40) : '';
        const ip = req.socket.remoteAddress ?? 'unknown';
        const identity =
          loginName ??
          String(req.body?.loginName ?? '')
            .trim()
            .toLowerCase()
            .slice(0, 254);
        const loginRateKeys = [rateKey('login', identity), rateKey('login-ip', ip)];
        const now = Date.now();
        if (!(await reserveRateLimit(db, loginRateKeys, now, [LOGIN_MAX_ATTEMPTS, 60]))) {
          await verifyPassword(password, null);
          return res.status(401).json({ error: LOGIN_FAILURE });
        }
        const row = loginName
          ? (
              await db.read<Account>('SELECT * FROM employee_accounts WHERE login_name=?', [
                loginName,
              ])
            )[0]
          : undefined;
        const passwordOk = await verifyPassword(password, row?.password_hash ?? null);
        let success = false;
        let recovered = false;
        let totpStep = -1;
        if (
          row &&
          isEnabled(row) &&
          row.activated_at &&
          passwordOk &&
          row.totp_secret_ciphertext &&
          typeof otp === 'string'
        ) {
          if (/^\d{6}$/.test(otp)) {
            const secret = decryptSensitive(
              row.totp_secret_ciphertext,
              accountContext(row.employee_id),
            );
            const verification = (await verify({
              secret,
              token: otp,
              epoch: now / 1000,
              epochTolerance: [30, 0],
              afterTimeStep: Number(row.totp_last_step),
            })) as TotpVerification;
            if (verification.valid) {
              totpStep =
                verification.timeStep ?? Math.floor((verification.epoch ?? now / 1000) / 30);
              success = true;
            }
          } else if (/^[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(otp)) {
            recovered = true;
            success = true;
          }
        }
        if (!success || !row) {
          return res.status(401).json({ error: LOGIN_FAILURE });
        }
        const token = newToken();
        const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
        const employee = await db.transaction(async (tx) => {
          const current = (
            await tx.read<Account>('SELECT * FROM employee_accounts WHERE employee_id=?', [
              row.employee_id,
            ])
          )[0];
          const currentEmployee = (
            await tx.read<Employee>(
              'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
              [row.employee_id],
            )
          )[0];
          if (
            !current ||
            !isEnabled(current) ||
            !current.activated_at ||
            !currentEmployee ||
            ['suspended', 'terminated'].includes(currentEmployee.status)
          )
            return null;
          if (!recovered) {
            const updated = await tx.execute(
              'UPDATE employee_accounts SET totp_last_step=?,updated_at=? WHERE employee_id=? AND totp_last_step<? AND enabled=TRUE',
              [totpStep, new Date(now).toISOString(), row.employee_id, totpStep],
            );
            if (!updated.rowCount) return null;
          } else {
            const codeHash = sha256(`recovery:${row.employee_id}:${otp.toUpperCase()}`);
            const used = await tx.execute(
              'UPDATE account_recovery_codes SET used_at=? WHERE employee_id=? AND code_hash=? AND used_at IS NULL',
              [new Date(now).toISOString(), row.employee_id, codeHash],
            );
            if (used.rowCount !== 1) return null;
          }
          await tx.execute(
            'INSERT INTO account_sessions(token_hash,employee_id,expires_at,created_at,revoked_at) VALUES(?,?,?,?,NULL)',
            [tokenHash(token), row.employee_id, expiresAt, new Date(now).toISOString()],
          );
          await tx.execute(
            'DELETE FROM account_login_limits WHERE key_hash IN (?,?)',
            loginRateKeys,
          );
          await audit(
            tx,
            currentEmployee.id,
            currentEmployee.role,
            currentEmployee.id,
            recovered ? 'account.login.recovery' : 'account.login',
          );
          return currentEmployee;
        });
        if (!employee) return res.status(401).json({ error: LOGIN_FAILURE });
        res.cookie(cookieName, token, cookieOptions).json({
          me: {
            id: employee.id,
            name: employee.name,
            employeeNumber: employee.employee_number,
            role: employee.role,
          },
        });
      }),
    );

    app.get(
      '/api/auth/session',
      endpoint(async (req, res) => {
        const actor = await actorFor(req);
        if (!actor) return res.json({ me: null });
        const employee = (
          await db.read<Employee>(
            'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
            [actor.id],
          )
        )[0];
        res.json({
          me: employee
            ? {
                id: employee.id,
                name: employee.name,
                employeeNumber: employee.employee_number,
                role: employee.role,
              }
            : null,
        });
      }),
    );
    app.delete(
      '/api/auth/session',
      endpoint(async (req, res) => {
        await logout(req, res);
        res.status(204).end();
      }),
    );

    app.post(
      '/api/auth/recovery-codes/rotate',
      endpoint(async (req, res) => {
        const actor = await actorFor(req);
        if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول للمتابعة.');
        const otp = req.body?.otp;
        const mfaKeys = freshMfaRateKeys(req, actor.id);
        if (!(await reserveRateLimit(db, mfaKeys, Date.now(), [STEP_UP_MAX_ATTEMPTS, 30])))
          throw fault(
            403,
            'MFA_STEP_UP_REQUIRED',
            'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.',
          );
        const codes = await db.transaction(async (tx) => {
          await consumeFreshMfa(tx, actor.id, otp, mfaKeys);
          const freshCodes = await issueRecoveryCodes(tx, actor.id, new Date().toISOString());
          await audit(tx, actor.id, actor.role, actor.id, 'account.recovery-codes.rotated');
          return freshCodes;
        });
        res.json({ recoveryCodes: codes });
      }),
    );

    app.get(
      '/api/accounts/candidates',
      endpoint(async (req, res) => {
        const actor = await hrActor(req, actorFor);
        void actor;
        const employees = await db.read<{
          id: string;
          name: string;
          employee_number: string;
          role: Role;
          status: string;
          email: string;
        }>(
          `SELECT e.id,e.name,e.employee_number,e.role,e.status,e.email FROM employee_access e
         LEFT JOIN employee_accounts a ON a.employee_id=e.id WHERE a.employee_id IS NULL
         AND e.status NOT IN ('suspended','terminated') ORDER BY e.employee_number`,
        );
        res.json({ employees });
      }),
    );

    app.get(
      '/api/accounts/role-changes',
      endpoint(async (req, res) => {
        const actor = await actorFor(req);
        if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول للمتابعة.');
        if (actor.role !== 'hr' && actor.role !== 'approver')
          throw fault(403, 'FORBIDDEN', 'لا تملك صلاحية مراجعة تغييرات الأدوار.');
        const changes =
          await db.read(`SELECT c.id,c.employee_id employeeId,e.name employeeName,e.employee_number employeeNumber,
        e.role currentRole,c.requested_role requestedRole,c.requested_by requestedBy,c.state,c.created_at createdAt
        FROM account_role_changes c JOIN employee_access e ON e.id=c.employee_id
        WHERE c.state='pending' ORDER BY c.created_at`);
        res.json({ changes });
      }),
    );
    app.post(
      '/api/accounts/:employeeId/role-change',
      endpoint(async (req, res) => {
        const actor = await hrActor(req, actorFor);
        const employeeId = routeParam(req, 'employeeId');
        const role = req.body?.role;
        if (actor.id === employeeId)
          throw fault(403, 'SELF_ROLE_CHANGE', 'لا يمكن اقتراح تغيير دورك.');
        if (typeof role !== 'string' || !ROLES.includes(role as Role))
          throw fault(400, 'INVALID_ROLE', 'الدور المطلوب غير صالح.');
        const employee = (
          await db.read<{ id: string; role: Role; status: string }>(
            'SELECT id,role,status FROM employee_access WHERE id=?',
            [employeeId],
          )
        )[0];
        if (!employee || ['suspended', 'terminated'].includes(employee.status))
          throw fault(404, 'EMPLOYEE_NOT_AVAILABLE', 'ملف الموظف غير متاح.');
        if (employee.role === role)
          throw fault(409, 'ROLE_UNCHANGED', 'الموظف يحمل هذا الدور بالفعل.');
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.transaction(async (tx) => {
          const pending = (
            await tx.read<{ id: string }>(
              "SELECT id FROM account_role_changes WHERE employee_id=? AND state='pending'",
              [employeeId],
            )
          )[0];
          if (pending)
            throw fault(409, 'ROLE_CHANGE_PENDING', 'يوجد تغيير دور قيد المراجعة لهذا الموظف.');
          await tx.execute(
            "INSERT INTO account_role_changes(id,employee_id,requested_role,requested_by,state,created_at) VALUES(?,?,?,?,'pending',?)",
            [id, employeeId, role, actor.id, now],
          );
          await audit(tx, actor.id, actor.role, employeeId, 'account.role.proposed');
        });
        res.status(201).json({ id, state: 'pending' });
      }),
    );
    app.post(
      '/api/accounts/role-changes/:id/decision',
      endpoint(async (req, res) => {
        const actor = await actorFor(req);
        if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول للمتابعة.');
        if (actor.role !== 'approver') throw fault(403, 'FORBIDDEN', 'تتطلب الموافقة دور المعتمد.');
        const decision = req.body?.decision;
        if (decision !== 'approve' && decision !== 'reject')
          throw fault(400, 'INVALID_DECISION', 'اختر اعتماد التغيير أو رفضه.');
        const mfaKeys = decision === 'approve' ? freshMfaRateKeys(req, actor.id) : [];
        if (
          decision === 'approve' &&
          !(await reserveRateLimit(db, mfaKeys, Date.now(), [STEP_UP_MAX_ATTEMPTS, 30]))
        )
          throw fault(
            403,
            'MFA_STEP_UP_REQUIRED',
            'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.',
          );
        const now = new Date().toISOString();
        await db.transaction(async (tx) => {
          const change = (
            await tx.read<{
              id: string;
              employee_id: string;
              requested_role: Role;
              requested_by: string;
              state: string;
            }>('SELECT * FROM account_role_changes WHERE id=?', [routeParam(req, 'id')])
          )[0];
          if (!change || change.state !== 'pending')
            throw fault(404, 'ROLE_CHANGE_NOT_FOUND', 'طلب تغيير الدور غير موجود أو حُسم.');
          if (change.requested_by === actor.id || change.employee_id === actor.id)
            throw fault(
              403,
              'ROLE_CHANGE_SEPARATION',
              'لا يمكن لمقدم الطلب أو الموظف المستهدف اعتماد تغيير الدور.',
            );
          if (decision === 'approve') {
            await protectLastPrivilegedRole(tx, change.employee_id, change.requested_role);
            await consumeFreshMfa(tx, actor.id, req.body?.otp, mfaKeys);
          }
          const updated = await tx.execute(
            "UPDATE account_role_changes SET state=?,decided_by=?,decision_reason=?,decided_at=? WHERE id=? AND state='pending'",
            [
              decision === 'approve' ? 'approved' : 'rejected',
              actor.id,
              typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null,
              now,
              change.id,
            ],
          );
          if (!updated.rowCount)
            throw fault(409, 'ROLE_CHANGE_CONFLICT', 'حُسم الطلب في الوقت نفسه.');
          if (decision === 'approve') {
            await tx.execute('UPDATE employees SET access_role=? WHERE id=?', [
              change.requested_role,
              change.employee_id,
            ]);
            await tx.execute(
              'UPDATE account_sessions SET revoked_at=? WHERE employee_id=? AND revoked_at IS NULL',
              [now, change.employee_id],
            );
          }
          await audit(
            tx,
            actor.id,
            actor.role,
            change.employee_id,
            `account.role.${decision === 'approve' ? 'approved' : 'rejected'}`,
          );
        });
        res.status(204).end();
      }),
    );

    app.get(
      '/api/accounts',
      endpoint(async (req, res) => {
        const actor = await actorFor(req);
        if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول للمتابعة.');
        if (actor.role !== 'hr')
          throw fault(403, 'FORBIDDEN', 'تتطلب إدارة الحسابات صلاحية الشؤون الإدارية.');
        const rows = await db.read<AccountSummary>(
          `SELECT e.id employeeId,e.name employeeName,e.employee_number employeeNumber,
         a.login_name loginName,e.role,e.status,a.enabled,a.activated_at activatedAt
         FROM employee_accounts a JOIN employee_access e ON e.id=a.employee_id ORDER BY e.employee_number`,
        );
        res.json({
          accounts: rows.map((row) => ({
            ...row,
            enabled: row.enabled === true || row.enabled === (1 as unknown),
          })),
        });
      }),
    );
    app.post(
      '/api/accounts/:employeeId/provision',
      endpoint(async (req, res) => {
        const actor = await hrActor(req, actorFor);
        const employeeId = routeParam(req, 'employeeId');
        if (actor.id === employeeId)
          throw fault(403, 'SELF_ACCOUNT_CHANGE', 'لا يمكن إدارة حسابك من هذه الشاشة.');
        const initialTarget = (
          await db.read<Employee>(
            'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
            [employeeId],
          )
        )[0];
        if (!initialTarget || ['suspended', 'terminated'].includes(initialTarget.status))
          throw fault(404, 'EMPLOYEE_NOT_AVAILABLE', 'ملف الموظف غير متاح للحساب.');
        const stepUpRoles: Role[] = ['hr', 'approver', 'finance'];
        const requiresStepUp = stepUpRoles.includes(initialTarget.role);
        const mfaKeys = requiresStepUp ? freshMfaRateKeys(req, actor.id) : [];
        if (
          requiresStepUp &&
          !(await reserveRateLimit(db, mfaKeys, Date.now(), [STEP_UP_MAX_ATTEMPTS, 30]))
        )
          throw fault(
            403,
            'MFA_STEP_UP_REQUIRED',
            'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.',
          );
        const result = await db.transaction(async (tx) => {
          const target = (
            await tx.read<Employee>(
              'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
              [employeeId],
            )
          )[0];
          if (!target || ['suspended', 'terminated'].includes(target.status))
            throw fault(404, 'EMPLOYEE_NOT_AVAILABLE', 'ملف الموظف غير متاح للحساب.');
          if (stepUpRoles.includes(target.role)) {
            if (!mfaKeys.length)
              throw fault(
                403,
                'MFA_STEP_UP_REQUIRED',
                'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.',
              );
            await consumeFreshMfa(tx, actor.id, req.body?.otp, mfaKeys);
          } else if (mfaKeys.length) {
            await tx.execute('DELETE FROM account_login_limits WHERE key_hash IN (?,?)', mfaKeys);
          }
          return provisionEmployeeAccountInTransaction(tx, {
            employeeId,
            loginName: String(req.body?.loginName ?? ''),
            actorId: actor.id,
            actorRole: actor.role,
          });
        });
        res.status(201).json({
          activationUrl: `/activate#token=${encodeURIComponent(result.activationToken)}`,
          expiresAt: result.expiresAt,
        });
      }),
    );
    app.post(
      '/api/accounts/:employeeId/disable',
      endpoint(async (req, res) => {
        const actor = await hrActor(req, actorFor);
        const targetId = routeParam(req, 'employeeId');
        if (actor.id === targetId)
          throw fault(403, 'SELF_ACCOUNT_CHANGE', 'لا يمكن تعطيل حسابك من هذه الشاشة.');
        const target = await accountByEmployee(targetId);
        if (!target) throw fault(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود.');
        const now = new Date().toISOString();
        await db.transaction(async (tx) => {
          await protectLastPrivilegedRole(tx, targetId, undefined);
          const current = (
            await tx.read<Account>('SELECT * FROM employee_accounts WHERE employee_id=?', [
              targetId,
            ])
          )[0];
          if (!current) throw fault(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود.');
          await tx.execute(
            'UPDATE employee_accounts SET enabled=FALSE,activation_token_hash=NULL,activation_expires_at=NULL,updated_at=? WHERE employee_id=?',
            [now, targetId],
          );
          await tx.execute(
            'UPDATE account_sessions SET revoked_at=? WHERE employee_id=? AND revoked_at IS NULL',
            [now, targetId],
          );
          await tx.execute('DELETE FROM account_recovery_codes WHERE employee_id=?', [targetId]);
          await audit(tx, actor.id, actor.role, targetId, 'account.disabled');
        });
        res.status(204).end();
      }),
    );
    app.post(
      '/api/accounts/:employeeId/reset',
      endpoint(async (req, res) => {
        const actor = await hrActor(req, actorFor);
        const targetId = routeParam(req, 'employeeId');
        if (actor.id === targetId)
          throw fault(403, 'SELF_ACCOUNT_CHANGE', 'لا يمكن إعادة ضبط حسابك من هذه الشاشة.');
        const target = await accountByEmployee(targetId);
        if (!target) throw fault(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود.');
        const rawToken = newToken();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_MS).toISOString();
        const mfaKeys = freshMfaRateKeys(req, actor.id);
        if (!(await reserveRateLimit(db, mfaKeys, Date.now(), [STEP_UP_MAX_ATTEMPTS, 30])))
          throw fault(
            403,
            'MFA_STEP_UP_REQUIRED',
            'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.',
          );
        await db.transaction(async (tx) => {
          await protectLastPrivilegedRole(tx, targetId, undefined);
          const current = (
            await tx.read<Account>('SELECT * FROM employee_accounts WHERE employee_id=?', [
              targetId,
            ])
          )[0];
          if (!current) throw fault(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود.');
          if (
            !isEnabled(current) &&
            current.activation_token_hash &&
            current.activation_expires_at &&
            Date.parse(current.activation_expires_at) > now.getTime()
          )
            throw fault(
              409,
              'ACTIVATION_PENDING',
              'رابط تفعيل صالح موجود بالفعل؛ لا يمكن استبداله قبل انتهائه.',
            );
          await consumeFreshMfa(tx, actor.id, req.body?.otp, mfaKeys);
          await tx.execute(
            `UPDATE employee_accounts SET password_hash=NULL,totp_secret_ciphertext=NULL,totp_last_step=-1,
          activation_token_hash=?,activation_expires_at=?,activated_at=NULL,enabled=FALSE,updated_at=? WHERE employee_id=?`,
            [tokenHash(rawToken), expiresAt, now.toISOString(), targetId],
          );
          await tx.execute(
            'UPDATE account_sessions SET revoked_at=? WHERE employee_id=? AND revoked_at IS NULL',
            [now.toISOString(), targetId],
          );
          await tx.execute('DELETE FROM account_recovery_codes WHERE employee_id=?', [targetId]);
          await audit(tx, actor.id, actor.role, targetId, 'account.reset');
        });
        res.json({ activationUrl: `/activate#token=${encodeURIComponent(rawToken)}`, expiresAt });
      }),
    );
  };
  return { register, actorFor, logout };
}

async function hrActor(
  req: Request,
  actorFor: (req: Request) => Promise<Actor | undefined>,
): Promise<Actor> {
  const actor = await actorFor(req);
  if (!actor) throw fault(401, 'AUTH_REQUIRED', 'سجّل الدخول للمتابعة.');
  if (actor.role !== 'hr')
    throw fault(403, 'FORBIDDEN', 'تتطلب إدارة الحسابات صلاحية الشؤون الإدارية.');
  return actor;
}
function freshMfaRateKeys(req: Request, employeeId: string): string[] {
  return [
    rateKey('step-up-employee', employeeId),
    rateKey('step-up-ip', req.socket.remoteAddress ?? 'unknown'),
  ];
}
async function consumeFreshMfa(
  tx: AsyncDb,
  employeeId: string,
  value: unknown,
  rateKeys: string[],
): Promise<void> {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value))
    throw fault(403, 'MFA_STEP_UP_REQUIRED', 'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.');
  const account = (
    await tx.read<Account>('SELECT * FROM employee_accounts WHERE employee_id=?', [employeeId])
  )[0];
  if (!account || !isEnabled(account) || !account.activated_at || !account.totp_secret_ciphertext)
    throw fault(403, 'MFA_STEP_UP_REQUIRED', 'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.');
  const verification = (await verify({
    secret: decryptSensitive(account.totp_secret_ciphertext, accountContext(employeeId)),
    token: value,
    epoch: Date.now() / 1000,
    epochTolerance: [30, 0],
    afterTimeStep: Number(account.totp_last_step),
  })) as TotpVerification;
  if (!verification.valid)
    throw fault(403, 'MFA_STEP_UP_REQUIRED', 'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.');
  const step = verification.timeStep ?? Math.floor((verification.epoch ?? Date.now() / 1000) / 30);
  const result = await tx.execute(
    'UPDATE employee_accounts SET totp_last_step=?,updated_at=? WHERE employee_id=? AND enabled=TRUE AND totp_last_step<?',
    [step, new Date().toISOString(), employeeId, step],
  );
  if (!result.rowCount)
    throw fault(403, 'MFA_STEP_UP_REQUIRED', 'تعذر تأكيد الإجراء. تحقق من الرمز وحاول مجددًا.');
  await tx.execute('DELETE FROM account_login_limits WHERE key_hash IN (?,?)', rateKeys);
}
async function protectLastPrivilegedRole(
  tx: AsyncDb,
  employeeId: string,
  nextRole: Role | undefined,
) {
  const employee = (
    await tx.read<Employee>(
      'SELECT id,name,employee_number,role,status FROM employee_access WHERE id=?',
      [employeeId],
    )
  )[0];
  if (!employee) return;
  for (const privilegedRole of ['hr', 'approver'] as const) {
    if (employee.role !== privilegedRole || nextRole === privilegedRole) continue;
    const rows = await tx.read<{ total: number | string }>(
      `SELECT COUNT(*) total FROM employee_accounts a JOIN employee_access e ON e.id=a.employee_id
       WHERE a.enabled=TRUE AND a.activated_at IS NOT NULL AND e.role=? AND e.status NOT IN ('suspended','terminated')`,
      [privilegedRole],
    );
    if (Number(rows[0]?.total ?? 0) <= 1)
      throw fault(
        409,
        privilegedRole === 'hr' ? 'LAST_HR_ACCOUNT' : 'LAST_APPROVER_ACCOUNT',
        `لا يمكن إزالة آخر حساب ${privilegedRole === 'hr' ? 'موارد بشرية' : 'معتمد'} نشط.`,
      );
  }
}
async function audit(
  db: AsyncDb,
  actorId: string | null,
  actorRole: string | null,
  employeeId: string,
  action: string,
  details: Record<string, string> = {},
) {
  await db.execute(
    'INSERT INTO account_audit(id,actor_id,actor_role,employee_id,action,created_at,details_json) VALUES(?,?,?,?,?,?,?)',
    [
      randomUUID(),
      actorId,
      actorRole,
      employeeId,
      action,
      new Date().toISOString(),
      JSON.stringify(details),
    ],
  );
}
async function issueRecoveryCodes(tx: AsyncDb, employeeId: string, now: string): Promise<string[]> {
  await tx.execute('DELETE FROM account_recovery_codes WHERE employee_id=?', [employeeId]);
  const codes = Array.from({ length: RECOVERY_COUNT }, recoveryCode);
  for (const code of codes)
    await tx.execute(
      'INSERT INTO account_recovery_codes(employee_id,code_hash,created_at,used_at) VALUES(?,?,?,NULL)',
      [employeeId, sha256(`recovery:${employeeId}:${code}`), now],
    );
  return codes;
}
async function reserveRateLimit(
  db: AsyncDb,
  keys: string[],
  now: number,
  limits: number[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Check every bucket before changing any so a blocked IP cannot consume only one bucket.
    for (const key of keys) {
      const existing = (
        await tx.read<{
          window_started_at: string;
          attempts: number;
          blocked_until: string | null;
        }>(
          'SELECT window_started_at,attempts,blocked_until FROM account_login_limits WHERE key_hash=?',
          [key],
        )
      )[0];
      if (existing?.blocked_until && Date.parse(existing.blocked_until) > now) return false;
    }
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const existing = (
        await tx.read<{ window_started_at: string; attempts: number }>(
          'SELECT window_started_at,attempts FROM account_login_limits WHERE key_hash=?',
          [key],
        )
      )[0];
      const expired = !existing || now - Date.parse(existing.window_started_at) >= LOGIN_WINDOW_MS;
      const attempts = expired ? 1 : Number(existing.attempts) + 1;
      const blocked = attempts >= limits[i] ? new Date(now + LOGIN_WINDOW_MS).toISOString() : null;
      await tx.execute(
        'INSERT INTO account_login_limits(key_hash,window_started_at,attempts,blocked_until) VALUES(?,?,?,?) ON CONFLICT(key_hash) DO UPDATE SET window_started_at=excluded.window_started_at,attempts=excluded.attempts,blocked_until=excluded.blocked_until',
        [
          key,
          expired ? new Date(now).toISOString() : existing!.window_started_at,
          attempts,
          blocked,
        ],
      );
    }
    return true;
  });
}
