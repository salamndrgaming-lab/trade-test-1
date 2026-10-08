import { describe, expect, it } from 'vitest';
import { MockDesk } from '@coin/shared/mock';
import { buildServer } from '../src/server.js';
import { readEnv } from '../src/config.js';
import { log } from '../src/log.js';

describe('bot api', () => {
  it('serves /state', async () => {
    const desk = new MockDesk({ seed: 2 });
    const app = await buildServer({ snapshot: () => desk.tick() });
    const res = await app.inject({ method: 'GET', url: '/state' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.v).toBe(1);
    expect(body.mode).toBe('shadow');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('config', () => {
  it('defaults to shadow', () => expect(readEnv({}).mode).toBe('shadow'));
  it('rejects unknown modes', () => expect(() => readEnv({ TRADING_MODE: 'yolo' })).toThrow());
});

describe('log redaction', () => {
  it('drops query strings from URLs and secret-named fields', () => {
    const r = log.redact({ rpc: 'https://rpc.example.com/?api-key=abc123', apiKey: 'xyz' }) as Record<string, string>;
    expect(r.rpc).toBe('https://rpc.example.com/?[redacted]');
    expect(r.apiKey).toBe('[redacted]');
  });
});
