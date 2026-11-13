import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const KEY_BYTES = 32;
let processKey: Buffer | undefined;

function loadKey(): Buffer {
  const configured = process.env.HR_DATA_KEY;
  if (configured) {
    const key = Buffer.from(configured, 'base64url');
    if (key.length !== KEY_BYTES || key.toString('base64url') !== configured.replace(/=+$/, '')) {
      throw Object.assign(new Error('HR_DATA_KEY must be a 32-byte base64url value.'), {
        status: 503,
        code: 'DATA_KEY_CONFIGURATION_INVALID',
      });
    }
    return key;
  }

  if (process.env.HR_MODE === 'hosted-demo') return (processKey ??= randomBytes(KEY_BYTES));
  // LOCAL_DEMO is only enabled by the loopback-only local entrypoint. It still
  // uses a stable local key so synthetic data remains readable after restart.
  if (
    process.env.LOCAL_DEMO !== 'true' &&
    (process.env.NODE_ENV === 'production' || process.env.DATABASE_URL)
  ) {
    throw Object.assign(new Error('Configure HR_DATA_KEY before storing sensitive data.'), {
      status: 503,
      code: 'DATA_KEY_REQUIRED',
    });
  }

  const path = resolve('.data/hr-data.key');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const key = randomBytes(KEY_BYTES);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, key.toString('base64url'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      /* file may have been created by another process */
    }
  }
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw Object.assign(new Error('The local data key must be readable only by its owner.'), {
      status: 503,
      code: 'DATA_KEY_PERMISSIONS_INVALID',
    });
  }
  const value = readFileSync(path, 'utf8').trim();
  const key = Buffer.from(value, 'base64url');
  if (key.length !== KEY_BYTES || key.toString('base64url') !== value) {
    throw Object.assign(new Error('The local data key is invalid.'), {
      status: 503,
      code: 'DATA_KEY_CONFIGURATION_INVALID',
    });
  }
  return key;
}

export function encryptSensitive(plaintext: string, context: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSensitive(value: string, context: string): string {
  const [version, encodedIv, encodedTag, encodedData, ...extra] = value.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || encodedData === undefined || extra.length) {
    throw Object.assign(new Error('Encrypted value has an unsupported format.'), {
      status: 500,
      code: 'ENCRYPTED_DATA_INVALID',
    });
  }
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(encodedIv, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedData, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function payloadHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
