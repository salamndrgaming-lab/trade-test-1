import type { TradingMode } from '@coin/shared';

export interface BotEnv {
  mode: TradingMode;
  host: string;
  port: number;
  mockState: boolean;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  const raw = (env.TRADING_MODE ?? 'shadow').trim().toLowerCase();
  if (raw !== 'shadow' && raw !== 'live') throw new Error(`TRADING_MODE must be "shadow" or "live", got "${raw}"`);
  return {
    mode: raw,
    host: env.BOT_HOST ?? '127.0.0.1',
    port: Number(env.BOT_PORT ?? 8787),
    mockState: (env.MOCK_STATE ?? 'true') !== 'false',
  };
}
