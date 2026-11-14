import {
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, createPostgresDatabase } from '../server/database.js';
import { readRuntimeConfig } from '../server/runtime-config.js';
import { resetEmployeeAccountForOperator } from '../server/access/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath)
  throw new Error(
    'Usage: npm run accounts:recover -- /secure/recovery-request.json /secure/invitation.json',
  );
const config = readRuntimeConfig();
if (config.mode !== 'operational' || config.seed)
  throw new Error('Operator recovery requires unseeded operational mode.');
const descriptor = openSync(resolve(inputPath), 'r');
let input: { employeeId: string; reason: string };
try {
  const info = fstatSync(descriptor);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096)
    throw new Error('Recovery request must be an owner-readable regular file under 4 KiB.');
  input = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (
    typeof input.employeeId !== 'string' ||
    !input.employeeId ||
    typeof input.reason !== 'string' ||
    input.reason.trim().length < 8 ||
    input.reason.length > 500
  )
    throw new Error('Provide an employeeId and an approved recovery reason of 8–500 characters.');
} finally {
  closeSync(descriptor);
}
const output = openSync(resolve(outputPath), 'wx', 0o600);
let db;
try {
  db =
    config.driver === 'postgres'
      ? await createPostgresDatabase(config.databaseUrl!, config.schema, { seed: false })
      : await createDatabase(config.databasePath, { seed: false });
  await db.transaction(async (tx) => {
    const invitation = await resetEmployeeAccountForOperator(tx, input);
    const origin = config.publicOrigin ?? `http://127.0.0.1:${config.port}`;
    writeFileSync(
      output,
      JSON.stringify(
        {
          employeeId: input.employeeId,
          expiresAt: invitation.expiresAt,
          activationUrl: `${origin}/activate#token=${encodeURIComponent(invitation.activationToken)}`,
        },
        null,
        2,
      ),
    );
    fsyncSync(output);
  });
  process.stdout.write(
    'Account recovery was audited and existing sessions revoked. The activation link is in the owner-only output file.\n',
  );
} finally {
  await db?.close();
  closeSync(output);
}
