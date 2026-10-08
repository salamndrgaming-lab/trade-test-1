import { MockDesk } from '@coin/shared/mock';
import { readEnv } from './config.js';
import { log } from './log.js';
import { buildServer } from './server.js';

const env = readEnv();

if (env.mode === 'live') {
  const bar = '!'.repeat(64);
  log.warn(bar);
  log.warn('TRADING_MODE=live — this bot WILL sign and send real swaps with real money.');
  log.warn(bar);
} else {
  log.info('TRADING_MODE=shadow — quotes only, nothing is ever signed or sent.');
}

if (!env.mockState) {
  log.error('Only MOCK_STATE=true is implemented in phase 1.');
  process.exit(1);
}

const desk = new MockDesk({ mode: env.mode, seed: Date.now() & 0xffff });
const app = await buildServer({ snapshot: () => desk.tick() });
await app.listen({ host: env.host, port: env.port });
log.info('bot api listening', { host: env.host, port: env.port, source: 'mock' });
