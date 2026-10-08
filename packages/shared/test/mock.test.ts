import { describe, expect, it } from 'vitest';
import { MockDesk } from '../src/mock/index.js';

describe('mock desk', () => {
  it('produces events and drops most tokens over 20 simulated minutes', () => {
    const t0 = 1_760_000_000_000;
    const desk = new MockDesk({ seed: 7, now: t0 });
    let s = desk.tick(t0);
    for (let t = t0; t < t0 + 20 * 60_000; t += 2000) s = desk.tick(t);
    expect(s.pipeline.scannedToday).toBeGreaterThan(100);
    const dropped = Object.values(s.pipeline.droppedByStep).reduce((a, b) => a + b, 0);
    expect(dropped / s.pipeline.scannedToday).toBeGreaterThan(0.85);
    expect(s.events.length).toBeGreaterThan(10);
    expect(new Set(s.events.map((e) => e.id)).size).toBe(s.events.length);
    expect(s.mode).toBe('shadow');
  });

  it('kill switch closes the position and blocks buys', () => {
    const t0 = 1_760_000_000_000;
    const desk = new MockDesk({ seed: 1, now: t0 });
    let t = t0;
    let s = desk.tick(t);
    while (!s.position && t < t0 + 10 * 60_000) s = desk.tick((t += 1000));
    expect(s.position).not.toBeNull();
    s = desk.setKillSwitch(true, t);
    expect(s.position).toBeNull();
    expect(s.rails.buysAllowed).toBe(false);
    for (let i = 0; i < 300; i++) s = desk.tick((t += 1000));
    expect(s.position).toBeNull();
    s = desk.setKillSwitch(false, t);
    expect(s.rails.buysAllowed).toBe(true);
  });

  it('snapshot never carries a secret-shaped string', () => {
    const desk = new MockDesk({ seed: 3, now: 1_760_000_000_000 });
    const json = JSON.stringify(desk.tick(1_760_000_100_000));
    // 64-byte base58 secret keys are 86–88 chars; JSON byte arrays of 64 numbers
    expect(json).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/);
    expect(json).not.toMatch(/\[(\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/);
  });
});
