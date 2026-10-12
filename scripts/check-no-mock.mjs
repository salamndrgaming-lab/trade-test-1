#!/usr/bin/env node
// Fails if production code can reach the dev-only mock desk:
//  1. the built web bundle (apps/web/dist) must not contain the mock marker
//  2. bot sources must never import @coin/shared/mock
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = '__coin_trader_mock_desk__';
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const problems = [];

const dist = process.env.CHECK_DIST ?? 'apps/web/dist';
if (!existsSync(dist)) problems.push(`${dist} missing: run pnpm build:web first`);
else for (const f of walk(dist)) if (/\.(js|html|css)$/.test(f) && readFileSync(f, 'utf8').includes(MARKER)) problems.push(`${f} contains the mock desk`);

for (const f of walk('apps/bot/src')) if (/\.ts$/.test(f) && /@coin\/shared\/mock|mock\/desk/.test(readFileSync(f, 'utf8'))) problems.push(`${f} imports the mock desk`);

if (problems.length) {
  console.error('✗ mock data reachable from production:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('no-mock check: passed (web bundle and bot are mock-free)');
