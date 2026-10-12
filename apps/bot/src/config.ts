import { z } from 'zod';
import type { TradingMode } from '@coin/shared';

/** Safety rails. Enforced in code (phase 4); shown on the dashboard now. */
export const RAILS = {
  maxTicketPct: 2,
  dailyLossCapPct: 10,
  maxOpenPositions: 1,
  stopLossPct: -25,
  takeProfitPct: 50,
  lossStreakPause: 2,
  pauseMinutes: 60,
  maxPriceImpactPct: 3,
} as const;

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  TRADING_MODE: z.enum(['shadow', 'live']).default('shadow'),
  BOT_HOST: z.string().default('127.0.0.1'),
  BOT_PORT: z.coerce.number().int().positive().default(8787),
  /** Browser origin allowed to read /state (the Pages site). Empty = same-origin only. */
  ALLOWED_ORIGIN: z.string().default(''),

  /** live = real APIs. record = real APIs + save responses as fixtures. fixtures = replay saved responses (dev/test only). */
  DATA_SOURCE: z.enum(['live', 'record', 'fixtures']).default('live'),
  FIXTURES_DIR: z.string().default('fixtures/recorded'),
  DB_PATH: z.string().default('data/coin-trader.sqlite'),

  SOLANA_RPC_URL: z.string().url().optional(),
  DEXSCREENER_BASE: z.string().url().default('https://api.dexscreener.com'),
  DEXSCREENER_MAX_PER_MIN: z.coerce.number().int().min(1).max(60).default(55),
  JUPITER_BASE: z.string().url().default('https://api.jup.ag/swap/v2'),
  JUPITER_API_KEY: z.string().optional(),

  /** Public key only. Used for the balance and ticket size. The private key is never read in this phase. */
  BOT_WALLET_PUBKEY: z.string().optional(),
  /** Ticket used for chain_kill quotes when no wallet is configured yet. */
  QUOTE_TICKET_SOL: z.coerce.number().positive().optional(),

  TICK_SECONDS: z.coerce.number().int().min(15).default(60),
  RECHECK_MINUTES: z.coerce.number().int().min(1).default(5),
  WATCH_HOURS: z.coerce.number().min(0.5).default(3),
  HOLDERS_VIA_GPA: bool.default(false),
});

export interface BotEnv {
  production: boolean;
  mode: TradingMode;
  host: string;
  port: number;
  allowedOrigin: string;
  dataSource: 'live' | 'record' | 'fixtures';
  fixturesDir: string;
  dbPath: string;
  rpcUrl: string | null;
  dexBase: string;
  dexMaxPerMin: number;
  jupBase: string;
  jupApiKey: string | null;
  walletPubkey: string | null;
  quoteTicketSol: number | null;
  tickMs: number;
  recheckMs: number;
  watchMs: number;
  holdersViaGpa: boolean;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Bad environment: ${msg}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  if (production && e.DATA_SOURCE === 'fixtures') throw new Error('DATA_SOURCE=fixtures is for development only and is refused when NODE_ENV=production');
  if (e.DATA_SOURCE !== 'fixtures' && !e.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL is required (any Solana mainnet RPC URL)');
  if (!e.BOT_WALLET_PUBKEY && !e.QUOTE_TICKET_SOL) throw new Error('Set BOT_WALLET_PUBKEY (preferred) or QUOTE_TICKET_SOL so chain_kill can quote at ticket size');
  return {
    production,
    mode: e.TRADING_MODE,
    host: e.BOT_HOST,
    port: e.BOT_PORT,
    allowedOrigin: e.ALLOWED_ORIGIN,
    dataSource: e.DATA_SOURCE,
    fixturesDir: e.FIXTURES_DIR,
    dbPath: e.DB_PATH,
    rpcUrl: e.SOLANA_RPC_URL ?? null,
    dexBase: e.DEXSCREENER_BASE.replace(/\/$/, ''),
    dexMaxPerMin: e.DEXSCREENER_MAX_PER_MIN,
    jupBase: e.JUPITER_BASE.replace(/\/$/, ''),
    jupApiKey: e.JUPITER_API_KEY || null,
    walletPubkey: e.BOT_WALLET_PUBKEY || null,
    quoteTicketSol: e.QUOTE_TICKET_SOL ?? null,
    tickMs: e.TICK_SECONDS * 1000,
    recheckMs: e.RECHECK_MINUTES * 60_000,
    watchMs: e.WATCH_HOURS * 3_600_000,
    holdersViaGpa: e.HOLDERS_VIA_GPA,
  };
}
