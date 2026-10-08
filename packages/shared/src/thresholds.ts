/** Single source of truth for the kill chain. Shown live on the dashboard. */

export const KILL_CHAIN = ['free_kill', 'trade_kill', 'chain_kill', 'soft_kill', 'pick'] as const;
export type KillStep = (typeof KILL_CHAIN)[number];

export const HARD = {
  min_age_minutes: 15,
  min_liquidity_usd: 12_000,
  min_volume_h24: 40_000,
  min_mcap_usd: 60_000,
  min_trades_h24: 150,
  max_top_wallet: 0.05,
  max_top_10: 0.6,
} as const;
export type HardKey = keyof typeof HARD;

export const SOFT = {
  concentration_is_exit_risk: { op: 'max', value: 0.55 },
  momentum_already_spent: { op: 'max', value: 0.6 },
  liquidity_fits_ticket: { op: 'min', value: 0.6 },
  account_is_the_project: { op: 'min', value: 0.7 },
  recycled_account: { op: 'max', value: 0.5 },
  dev_still_loaded: { op: 'max', value: 0.55 },
} as const satisfies Record<string, { op: 'min' | 'max'; value: number }>;
export type SoftKey = keyof typeof SOFT;
export const SOFT_KEYS = Object.keys(SOFT) as SoftKey[];

export const MAX_PRICE_IMPACT_PCT = 3;

/** Which chain step each hard check belongs to. */
export const HARD_STEP: Record<HardKey, KillStep> = {
  min_age_minutes: 'free_kill',
  min_liquidity_usd: 'free_kill',
  min_mcap_usd: 'free_kill',
  max_top_wallet: 'free_kill',
  max_top_10: 'free_kill',
  min_volume_h24: 'trade_kill',
  min_trades_h24: 'trade_kill',
};

export function hardOp(key: HardKey): 'min' | 'max' {
  return key.startsWith('min_') ? 'min' : 'max';
}

export function passes(op: 'min' | 'max', value: number, limit: number): boolean {
  return op === 'min' ? value >= limit : value <= limit;
}
