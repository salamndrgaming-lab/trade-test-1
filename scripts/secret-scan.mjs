#!/usr/bin/env node
// Pre-commit secret scan. Uses gitleaks when installed; always runs these built-in checks too.
//   node scripts/secret-scan.mjs          → scan staged files
//   node scripts/secret-scan.mjs --all    → scan every tracked file
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const all = process.argv.includes('--all');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
const files = (all ? git('ls-files') : git('diff', '--cached', '--name-only', '--diff-filter=ACM'))
  .split('\n').filter(Boolean).filter((f) => existsSync(f));

const RULES = [
  { name: 'committed .env file', file: /(^|\/)\.env(\.(?!example$)[^/]*)?$/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'Solana secret key (base58, 64 bytes)', re: /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![1-9A-HJ-NP-Za-km-z])/ },
  { name: 'Solana secret key (JSON byte array)', re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/ },
  { name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'assigned secret in env-style line', re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PRIVATE_KEY|PASSPHRASE)[A-Z0-9_]*\s*=\s*['"]?[^\s'"#]{12,}/m },
];
const SKIP = /(^|\/)(pnpm-lock\.yaml|.*\.png|.*\.ico|.*\.woff2?)$/;

const hits = [];
for (const f of files) {
  for (const r of RULES) if (r.file?.test(f)) hits.push(`${f}: ${r.name}`);
  if (SKIP.test(f)) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/secret-scan:\s*allow/.test(line)) return;
    for (const r of RULES) if (r.re?.test(line)) hits.push(`${f}:${i + 1}: ${r.name}`);
  });
}

const gl = spawnSync('gitleaks', all ? ['detect', '--no-banner', '--redact'] : ['protect', '--staged', '--no-banner', '--redact'], { stdio: 'inherit' });
const gitleaksFailed = !gl.error && gl.status !== 0;

if (hits.length || gitleaksFailed) {
  console.error('\n✗ secret scan blocked this commit:');
  for (const h of hits) console.error('  ' + h);
  console.error('\nRemove the secret (keys belong in the server .env or the encrypted key file). False positive? add "secret-scan: allow" on that line.');
  process.exit(1);
}
if (gl.error) console.log('secret scan: built-in checks passed (install gitleaks for a deeper scan)');
else console.log('secret scan: passed');
