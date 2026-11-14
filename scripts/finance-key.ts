/**
 * Generates an accountant service key. The key is written only to a file you name (mode 600,
 * directory 700) and is never printed. Only its SHA-256 digest is printed, for
 * HR_FINANCE_API_KEY_HASHES on the server.
 *
 *   npm run finance:key -- --out /secure/dir/sabq-hr-finance.key \
 *     [--env-out /secure/dir/sabq-hr-finance.env --url http://127.0.0.1:4320]
 *
 * --env-out also writes `export SABQ_HR_FINANCE_URL=...` and `export SABQ_HR_FINANCE_TOKEN=...`
 * for a client to `source`. Never commit either file.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateServiceKey, hashServiceKey } from '../server/finance/service-keys.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = option('--out');
const envFile = option('--env-out');
const url = option('--url');
if (!out) throw new Error('Usage: finance-key --out <file> [--env-out <file> --url <base url>]');
if (envFile && !url) throw new Error('--env-out needs --url.');
if (url && !/^https?:\/\/[^\s'"]+$/.test(url)) throw new Error('--url must be an http(s) URL.');
const repo = resolve('.');
for (const target of [out, envFile].filter(Boolean) as string[]) {
  const path = resolve(target);
  if (path.startsWith(`${repo}/`)) throw new Error('Write keys outside the repository.');
  if (existsSync(path) && !args.includes('--force'))
    throw new Error(`${path} exists; pass --force to rotate.`);
}
const key = generateServiceKey();
const write = (target: string, content: string) => {
  const path = resolve(target);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
};
write(out, `${key}\n`);
if (envFile)
  write(
    envFile,
    `# Sabq HR finance API (accountant scope). Do not commit or print.\nexport SABQ_HR_FINANCE_URL='${url}'\nexport SABQ_HR_FINANCE_TOKEN='${key}'\n`,
  );
process.stdout.write(`${hashServiceKey(key)}\n`);
