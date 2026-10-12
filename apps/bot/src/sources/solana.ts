import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { RateLimiter } from '../http/ratelimit.js';
import type { Transport } from '../http/transport.js';
import { ApiError, call } from './http.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  program: string;
}

export interface Concentration {
  /** share of supply in the largest non-program wallet, 0–1 */
  topWallet: number;
  /** share of supply in the 10 largest non-program wallets, 0–1 */
  top10: number;
  /** token accounts skipped because a program (pool, bonding curve, lock) owns them */
  excludedPrograms: number;
}

/** PDAs (pool vaults, bonding curves, lockers) are off the ed25519 curve; real wallets are on it. */
export function isOnCurve(address: string): boolean {
  try {
    ed25519.Point.fromBytes(bs58.decode(address));
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal JSON-RPC client. The RPC URL may carry an API key, so it is never logged
 * and never used as a fixture key.
 */
export class SolanaRpc {
  readonly limiter: RateLimiter;
  calls = 0;
  private id = 0;
  constructor(private transport: Transport, private url: string, perSecond = 8) {
    this.limiter = new RateLimiter(perSecond, 1000);
  }

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    this.calls++;
    const body = { jsonrpc: '2.0', id: ++this.id, method, params };
    const res = await call(this.transport, this.limiter, { service: 'rpc', method: 'POST', url: this.url, body, key: `${method} ${JSON.stringify(params)}` });
    const j = res.json as { result?: T; error?: { code: number; message: string } } | null;
    if (res.status !== 200 || !j || j.error) throw new ApiError(`RPC ${method} failed: ${j?.error?.message ?? `HTTP ${res.status}`}`, res.status, j);
    return j.result as T;
  }

  async getMint(mint: string): Promise<MintInfo | null> {
    type R = { value: { owner: string; data: { parsed?: { type: string; info: { mintAuthority: string | null; freezeAuthority: string | null; supply: string; decimals: number } } } } | null };
    const r = await this.rpc<R>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const info = r.value?.data.parsed;
    if (!r.value || !info || info.type !== 'mint') return null;
    return {
      mintAuthority: info.info.mintAuthority ?? null,
      freezeAuthority: info.info.freezeAuthority ?? null,
      supply: BigInt(info.info.supply),
      decimals: info.info.decimals,
      program: r.value.owner,
    };
  }

  /**
   * Holder concentration from the 20 largest token accounts, skipping accounts owned by programs
   * (the AMM pool, a bonding curve, a lock) so the pool itself never counts as a whale.
   */
  async concentration(mint: string, supply: bigint, pairAddress: string | null): Promise<Concentration> {
    type L = { value: { address: string; amount: string }[] };
    const largest = await this.rpc<L>('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    const accts = largest.value;
    type M = { value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[] };
    const owners = accts.length
      ? (await this.rpc<M>('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }])).value.map((v) => v?.data.parsed?.info?.owner ?? null)
      : [];
    const wallets: bigint[] = [];
    let excluded = 0;
    accts.forEach((a, i) => {
      const owner = owners[i];
      if (!owner || owner === pairAddress || !isOnCurve(owner)) { excluded++; return; }
      wallets.push(BigInt(a.amount));
    });
    // several token accounts can share one owner; the largest-accounts call is per account, which slightly understates a whale
    wallets.sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
    const share = (x: bigint) => (supply > 0n ? Number((x * 1_000_000n) / supply) / 1_000_000 : 0);
    const top10 = wallets.slice(0, 10).reduce((s, x) => s + x, 0n);
    return { topWallet: share(wallets[0] ?? 0n), top10: share(top10), excludedPrograms: excluded };
  }

  /** Holder count via getProgramAccounts. Heavy; many public RPCs refuse it, so it is opt-in. */
  async holderCount(mint: string, program: string): Promise<number | null> {
    try {
      const filters: unknown[] = [{ memcmp: { offset: 0, bytes: mint } }];
      if (program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') filters.push({ dataSize: 165 });
      const r = await this.rpc<unknown[]>('getProgramAccounts', [program, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters, commitment: 'confirmed' }]);
      return r.length;
    } catch {
      return null;
    }
  }

  async getBalanceLamports(pubkey: string): Promise<bigint> {
    const r = await this.rpc<{ value: number }>('getBalance', [pubkey, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }
}

export { SYSTEM_PROGRAM };
