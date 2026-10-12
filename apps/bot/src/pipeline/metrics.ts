import type { TokenMetrics } from '@coin/shared';
import type { DexPair } from '../sources/dexscreener.js';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sig = (x: number) => 1 / (1 + Math.exp(-x));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Market metrics straight from the DexScreener pair. On-chain fields start as null and are filled in later. */
export function metricsFromPair(p: DexPair, now: number): TokenMetrics {
  const h24 = p.txns?.h24;
  return {
    ageMinutes: p.pairCreatedAt ? Math.max(0, (now - p.pairCreatedAt) / 60_000) : 0,
    liquidityUsd: num(p.liquidity?.usd),
    volumeH24: num(p.volume?.h24),
    mcapUsd: num(p.marketCap ?? p.fdv),
    tradesH24: h24 ? h24.buys + h24.sells : 0,
    priceUsd: Number(p.priceUsd ?? 0) || 0,
    change5m: num(p.priceChange?.m5),
    change1h: num(p.priceChange?.h1),
    holders: null,
    topWallet: null,
    top10: null,
    mintRevoked: null,
    freezeRevoked: null,
    buyImpactPct: null,
    sellImpactPct: null,
    sellRoutes: null,
  };
}

/**
 * Scan's momentum score, 0–1, from 5m/1h price change, volume acceleration, buy pressure and trade activity.
 * Pure arithmetic; no model involved.
 */
export function momentum(p: DexPair): number {
  const p5 = num(p.priceChange?.m5);
  const p1 = num(p.priceChange?.h1);
  const v1 = num(p.volume?.h1);
  const v24 = num(p.volume?.h24);
  const accel = v24 > 0 ? (v1 * 24) / v24 : 0; // >1 means the last hour is busier than the day's average
  const t1 = p.txns?.h1;
  const buys = t1?.buys ?? 0;
  const sells = t1?.sells ?? 0;
  const pressure = buys + sells > 0 ? buys / (buys + sells) : 0.5;
  const activity = clamp01((buys + sells) / 300);
  const score = 0.3 * sig(p5 / 10) + 0.25 * sig(p1 / 40) + 0.2 * clamp01(accel / 3) + 0.15 * pressure + 0.1 * activity;
  return Math.round(clamp01(score) * 1000) / 1000;
}

/** First X/Twitter handle in the pair's socials, lower-cased without @. */
export function xHandle(p: DexPair): string | null {
  for (const s of p.info?.socials ?? []) {
    const url = s.url ?? '';
    const m = /(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(url);
    if ((s.type === 'twitter' || m) && m) return m[1]!.toLowerCase();
  }
  return null;
}
