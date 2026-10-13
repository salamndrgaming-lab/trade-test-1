/** Number, money and threshold formatting shared by the cards, panels and canvas. */

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 10_000 ? usd0.format(v) : usd2.format(v);
}

export function fmtSignedUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v))}`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
}

export function fmtCompactUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** Memecoin prices span 1e-9 to 1e2: keep four significant digits in plain decimals (the canvas font has no subscripts). */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  if (v >= 1) return `$${v.toFixed(v >= 1000 ? 0 : 2)}`;
  const zeros = Math.max(0, Math.floor(-Math.log10(v)));
  return `$${v.toFixed(Math.min(zeros + 3, 12))}`;
}

/** Plain-language name for each threshold key (hard, chain and soft). */
export const THRESHOLD_LABEL: Record<string, string> = {
  min_age_minutes: 'Age',
  min_liquidity_usd: 'Liquidity',
  min_mcap_usd: 'Market cap',
  max_top_wallet: 'Top wallet',
  max_top_10: 'Top 10 wallets',
  min_volume_h24: 'Volume 24h',
  min_trades_h24: 'Trades 24h',
  mint_revoked: 'Mint revoked',
  freeze_revoked: 'Freeze revoked',
  sell_routes: 'Sell route',
  buy_impact_pct: 'Buy impact',
  sell_impact_pct: 'Sell impact',
  concentration_is_exit_risk: 'Exit risk',
  momentum_already_spent: 'Momentum spent',
  liquidity_fits_ticket: 'Fits ticket',
  account_is_the_project: 'Real account',
  recycled_account: 'Recycled account',
  dev_still_loaded: 'Dev loaded',
};

/** A check's value or limit in the unit its key implies. */
export function fmtThresholdValue(key: string, v: number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (!Number.isFinite(v)) return '—';
  if (key.endsWith('_usd')) return fmtCompactUsd(v);
  if (key === 'min_age_minutes') return v >= 120 ? `${(v / 60).toFixed(1)} h` : `${Math.round(v)} min`;
  if (key === 'max_top_wallet' || key === 'max_top_10') return `${(v * 100).toFixed(1)}%`;
  if (key.endsWith('_pct')) return `${v.toFixed(2)}%`;
  if (key === 'min_volume_h24') return fmtCompactUsd(v);
  if (key === 'min_trades_h24') return Math.round(v).toLocaleString('en-US');
  return v.toFixed(2);
}

export function fmtDate(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtUtcClock(t: number): string {
  return new Date(t).toISOString().slice(11, 19);
}
