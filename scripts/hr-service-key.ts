/**
 * Generates an HR service key for «محاسب سبق». The key is written only to a file you name
 * (mode 600, directory 700) and is never printed. Only its SHA-256 digest is printed, for
 * HR_SERVICE_API_KEY_HASHES on the server.
 *
 *   npm run hr:key -- --out /secure/dir/sabq-hr-service.key \
 *     [--env-out /secure/dir/sabq-hr-service.env --url https://hr.example]
 *
 * --env-out also writes `export SABQ_HR_SERVICE_URL=...` and `export SABQ_HR_SERVICE_TOKEN=...`
 * for the bot to `source`. Never commit either file. This key is separate from the finance key.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateHrServiceKey, hashHrServiceKey } from '../server/service-api/keys.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = option('--out');
const envFile = option('--env-out');
const url = option('--url');
if (!out) throw new Error('Usage: hr-service-key --out <file> [--env-out <file> --url <base url>]');
if (envFile && !url) throw new Error('--env-out needs --url.');
if (url && !/^https?:\/\/[^\s'"]+$/.test(url)) throw new Error('--url must be an http(s) URL.');
const repo = resolve('.');
for (const target of [out, envFile].filter(Boolean) as string[]) {
  const path = resolve(target);
  if (path.startsWith(`${repo}/`)) throw new Error('Write keys outside the repository.');
  if (existsSync(path) && !args.includes('--force'))
    throw new Error(`${path} exists; pass --force to rotate.`);
}
const key = generateHrServiceKey();
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
    `# Sabq HR service API («محاسب سبق», read scopes). Do not commit or print.\nexport SABQ_HR_SERVICE_URL='${url}'\nexport SABQ_HR_SERVICE_TOKEN='${key}'\n`,
  );
process.stdout.write(`${hashHrServiceKey(key)}\n`);
