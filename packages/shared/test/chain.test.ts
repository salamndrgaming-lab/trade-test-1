import { describe, expect, it } from 'vitest';
import { KILL_CHAIN, evaluateChain, type SoftScores, type TokenMetrics } from '../src/index.js';

const good: TokenMetrics = {
  ageMinutes: 60, liquidityUsd: 30_000, volumeH24: 100_000, mcapUsd: 200_000, tradesH24: 500,
  priceUsd: 0.001, change5m: 4, change1h: 20, holders: 900, topWallet: 0.03, top10: 0.4,
  mintRevoked: true, freezeRevoked: true, buyImpactPct: 1, sellImpactPct: 1.2, sellRoutes: true,
};
const soft: SoftScores = {
  concentration_is_exit_risk: 0.2, momentum_already_spent: 0.3, liquidity_fits_ticket: 0.8,
  account_is_the_project: 0.9, recycled_account: 0.1, dev_still_loaded: 0.2, cachedUntil: 0,
};

describe('kill chain', () => {
  it('runs in the fixed order', () => {
    expect(KILL_CHAIN).toEqual(['free_kill', 'trade_kill', 'chain_kill', 'soft_kill', 'pick']);
  });

  it('a clean token survives to pick', () => {
    const r = evaluateChain(good, soft);
    expect(r.diedAt).toBeNull();
    expect(r.checks.every((c) => c.pass === true)).toBe(true);
  });

  it('dies at the first failing step even when later steps also fail', () => {
    const r = evaluateChain({ ...good, ageMinutes: 3, volumeH24: 10, mintRevoked: false }, { ...soft, recycled_account: 0.99 });
    expect(r.diedAt).toBe('free_kill');
    expect(r.checks.filter((c) => c.step !== 'free_kill').every((c) => c.pass === null)).toBe(true);
  });

  it('trade_kill comes before chain_kill', () => {
    expect(evaluateChain({ ...good, tradesH24: 20, freezeRevoked: false }, soft).diedAt).toBe('trade_kill');
  });

  it('chain_kill: unroutable sell or too much impact', () => {
    expect(evaluateChain({ ...good, sellRoutes: false }, soft).diedAt).toBe('chain_kill');
    expect(evaluateChain({ ...good, buyImpactPct: 3.01 }, soft).diedAt).toBe('chain_kill');
    expect(evaluateChain({ ...good, sellImpactPct: null }, soft).diedAt).toBe('chain_kill');
  });

  it('soft_kill uses min/max per score', () => {
    expect(evaluateChain(good, { ...soft, account_is_the_project: 0.69 }).diedAt).toBe('soft_kill');
    expect(evaluateChain(good, { ...soft, dev_still_loaded: 0.56 }).diedAt).toBe('soft_kill');
    expect(evaluateChain(good, null).diedAt).toBe('soft_kill');
  });

  it('missing hard data never passes', () => {
    expect(evaluateChain({ ...good, topWallet: null }, soft).diedAt).toBe('free_kill');
  });

  it('upTo stops before later steps', () => {
    const r = evaluateChain(good, null, 'chain_kill');
    expect(r.diedAt).toBeNull();
    expect(r.checks.filter((c) => c.step === 'soft_kill').every((c) => c.pass === null)).toBe(true);
  });
});
