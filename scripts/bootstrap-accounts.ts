import {
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createDatabase, createPostgresDatabase } from '../server/database.js';
import { readRuntimeConfig } from '../server/runtime-config.js';
import { bootstrapAccounts, validateBootstrapInput } from '../server/bootstrap-accounts.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath)
  throw new Error(
    'Usage: npm run accounts:bootstrap -- /secure/identities.json /secure/invitations.json',
  );
const config = readRuntimeConfig();
if (config.mode !== 'operational' || config.seed)
  throw new Error(
    'Initial accounts require HR_MODE=operational with synthetic fixture seeding disabled.',
  );
const inputHandle = openSync(resolve(inputPath), 'r');
let identities;
try {
  const info = fstatSync(inputHandle);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16_384)
    throw new Error('Input must be an owner-readable regular file under 16 KiB.');
  identities = validateBootstrapInput(JSON.parse(readFileSync(inputHandle, 'utf8')));
} finally {
  closeSync(inputHandle);
}
// Reserve the destination first; refuse an existing file or symlink.
const outputHandle = openSync(resolve(outputPath), 'wx', 0o600);
let db;
try {
  if (config.driver === 'sqlite')
    mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  db =
    config.driver === 'postgres'
      ? await createPostgresDatabase(config.databaseUrl!, config.schema, { seed: false })
      : await createDatabase(config.databasePath, { seed: false });
  const origin = config.publicOrigin ?? `http://127.0.0.1:${config.port}`;
  await bootstrapAccounts(db, identities, {
    beforeCommit(invitations) {
      writeFileSync(
        outputHandle,
        JSON.stringify(
          invitations.map(({ activationToken, ...entry }) => ({
            ...entry,
            activationUrl: `${origin}/activate#token=${encodeURIComponent(activationToken)}`,
          })),
          null,
          2,
        ),
      );
      fsyncSync(outputHandle);
    },
  });
  process.stdout.write(
    'Initial accounts prepared. Activation links were written to the owner-only output file. No credentials are printed.\n',
  );
} finally {
  await db?.close();
  closeSync(outputHandle);
}
