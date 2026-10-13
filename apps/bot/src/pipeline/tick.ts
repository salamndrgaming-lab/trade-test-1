import type { TokenAnalysis } from '@coin/shared';
import type { Brain, SoftResult } from '../ai/brain.js';
import type { SocialFacts } from '../ai/prompts.js';
import type { BotEnv } from '../config.js';
import type { Repo } from '../db/db.js';
import { log } from '../log.js';
import { bestPair, type DexPair, type DexScreener } from '../sources/dexscreener.js';
import type { Jupiter } from '../sources/jupiter.js';
import { SOL_MINT, type SolanaRpc } from '../sources/solana.js';
import type { LiveDesk } from '../state/desk.js';
import { evaluateToken, ticketLamports } from './evaluate.js';
import { crawlerSummary, dropLine, scanSummary, survivorLines } from './lines.js';
import { xHandle } from './metrics.js';

export interface PipelineDeps {
  env: BotEnv;
  repo: Repo;
  desk: LiveDesk;
  dex: DexScreener;
  rpc: SolanaRpc;
  jupiter: Jupiter;
  /** phase 3: model scores (soft_kill) and Chief's pick. Without it survivors wait at soft_kill. */
  brain?: Brain;
  now?: () => number;
}

export interface TickReport {
  discovered: number;
  evaluated: number;
  dropped: number;
  survivors: number;
  deferred: number;
  scored: number;
  picked: string | null;
  errors: string[];
  calls: { dexscreener: number; rpc: number; jupiter: number };
}

/** Max tokens pulled into one tick (3 DexScreener batch calls). */
const MAX_PER_TICK = 90;

export class Pipeline {
  private now: () => number;
  private walletSol: number | null = null;
  private solUsd: number | null = null;
  constructor(private d: PipelineDeps) {
    this.now = d.now ?? Date.now;
  }

  async tick(): Promise<TickReport> {
    const { repo, desk, dex, rpc, jupiter, env } = this.d;
    const start = this.now();
    const calls0 = { dexscreener: dex.calls, rpc: rpc.calls, jupiter: jupiter.calls };
    const report: TickReport = { discovered: 0, evaluated: 0, dropped: 0, survivors: 0, deferred: 0, scored: 0, picked: null, errors: [], calls: { dexscreener: 0, rpc: 0, jupiter: 0 } };

    // ── Crawler: new Solana tokens from the profile and boost feeds ──
    desk.setStatus('crawler', 'working');
    const fresh = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const [source, fn] of [['profile', () => dex.latestProfiles()], ['boost', () => dex.latestBoosts()]] as const) {
      try {
        for (const p of await fn()) {
          if (!fresh.has(p.tokenAddress)) fresh.set(p.tokenAddress, source);
          if (p.description && !descriptions.has(p.tokenAddress)) descriptions.set(p.tokenAddress, p.description);
        }
      } catch (e) {
        report.errors.push(`${source} feed: ${String(e)}`);
      }
    }
    const known = repo.knownMints([...fresh.keys()]);
    const newMints = [...fresh.keys()].filter((m) => !known.has(m));
    for (const m of newMints) repo.addToken(m, fresh.get(m)!, start);
    report.discovered = newMints.length;

    const recheck = repo.dueForRecheck(start, env.watchMs, env.recheckMs, MAX_PER_TICK).filter((m) => !newMints.includes(m));
    const batch = [...newMints, ...recheck].slice(0, MAX_PER_TICK);
    desk.say('crawler', crawlerSummary(newMints.length, recheck.length));

    // ── market data for the whole batch ──
    let pairs: DexPair[] = [];
    try {
      pairs = await dex.pairsForTokens(batch);
    } catch (e) {
      report.errors.push(`pairs: ${String(e)}`);
    }

    // ── kill chain, one token at a time ──
    const ticket = ticketLamports(this.walletSol, env.quoteTicketSol);
    desk.ticketSol = Number(ticket) / 1e9;
    const deadline = start + env.tickMs * 0.8;
    const isNew = new Set(newMints);
    let scanDrops = 0;
    let scoreCalls = 0;
    for (const mint of batch) {
      const pair = bestPair(pairs, mint);
      if (!pair) {
        repo.markChecked(mint, this.now()); // no pool yet; try again on the next recheck
        continue;
      }
      if (this.now() > deadline) { report.deferred++; continue; }
      desk.setStatus('scan', 'working');
      let a: TokenAnalysis | null;
      try {
        a = await evaluateToken({ rpc, jupiter, holdersViaGpa: env.holdersViaGpa }, mint, pair, ticket, this.now());
      } catch (e) {
        report.errors.push(`${mint}: ${String(e)}`);
        repo.markChecked(mint, this.now());
        continue;
      }
      if (!a) {
        // passed the arithmetic but there is no ticket size to quote with yet (wallet balance unknown or empty)
        report.deferred++;
        continue;
      }
      const prev = repo.verdictFor(mint);
      const handle = xHandle(pair);
      if (handle) repo.recordHandle(handle, mint, this.now());
      repo.saveVerdict(a, this.now());
      let soft: SoftResult | null = null;
      if (!a.diedAt && this.d.brain) {
        // soft_kill: Vet + Social model scores (cached 15 min unless the price moves > 20%)
        const facts: SocialFacts = {
          handle,
          handleHistory: handle ? repo.handleHistory(handle, mint) : [],
          websites: (pair.info?.websites ?? []).map((w) => w.url),
          description: descriptions.get(mint) ?? repo.getFacts<SocialFacts>(mint)?.description ?? null,
          ticketUsd: (Number(ticket) / 1e9) * (this.solUsd ?? 0),
        };
        desk.setStatus('social', 'working');
        try {
          soft = await this.d.brain.softKill(a, facts, { allowCall: scoreCalls < env.ai.scoresPerTick });
          if (soft.called) { scoreCalls++; report.scored++; }
          a = soft.analysis;
          repo.saveVerdict(a, this.now());
          repo.saveFacts(mint, facts);
        } catch (e) {
          report.errors.push(`model: ${String(e)}`);
        }
      }
      // a pick stays a pick while it survives the checks
      if (prev?.verdict === 'picked' && !a.diedAt) {
        a = { ...a, verdict: 'picked', verdictReason: 'Chief pick' };
        repo.saveVerdict(a, this.now());
      }
      desk.setCurrent(a);
      report.evaluated++;
      if (a.diedAt) report.dropped++;
      else report.survivors++;
      if (a.diedAt === 'free_kill' || a.diedAt === 'trade_kill') scanDrops++;
      // animate only what changed: a new token, or a token whose fate moved
      if (isNew.has(mint) || !prev || prev.diedAt !== a.diedAt || prev.verdict !== a.verdict) this.animate(a, isNew.has(mint), soft);
    }
    if (report.evaluated) desk.say('scan', scanSummary(report.evaluated, scanDrops));
    if (ticket === 0n && report.deferred) desk.say('size', 'No wallet balance yet. Holding quotes.');

    // ── Chief: pick one of the top three survivors ──
    if (this.d.brain) {
      try {
        report.picked = await this.chief(start);
      } catch (e) {
        report.errors.push(`model: ${String(e)}`);
      }
    }

    // the big screen follows Chief's latest pick, else the newest survivor
    const last = repo.lastPick();
    const lastTok = last && start - last.t < env.watchMs ? repo.recentVerdicts(200).find((t) => t.mint === last.mint) : null;
    const top = lastTok ?? repo.survivors(1, start - env.watchMs)[0];
    desk.setFocus(top ? { mint: top.mint, symbol: top.symbol, pairAddress: top.pairAddress } : null);

    desk.tickDone(this.now(), summarizeErrors(report.errors));
    report.calls = { dexscreener: dex.calls - calls0.dexscreener, rpc: rpc.calls - calls0.rpc, jupiter: jupiter.calls - calls0.jupiter };
    log.info('tick', { ms: this.now() - start, ...report, errors: report.errors.length });
    for (const e of report.errors.slice(0, 5)) log.warn('tick error', { detail: e });
    return report;
  }

  private lastDecisionAt = 0;
  private offered = new Set<string>();

  /** Chief looks at the top 3 shortlisted tokens by momentum, refreshes stale scores, and picks one or passes. */
  private async chief(now: number): Promise<string | null> {
    const { repo, desk, env, brain } = this.d;
    if (!brain) return null;
    // Chief decides only when a token it has not seen enters the top 3, and at most every CHIEF_MIN_MINUTES
    if (now - this.lastDecisionAt < env.ai.chiefMinMs) return null;
    const pool = repo.shortlisted(now - env.watchMs).sort((x, y) => (y.momentum ?? 0) - (x.momentum ?? 0));
    let finalists = pool.slice(0, 3);
    if (!finalists.length || finalists.every((t) => this.offered.has(t.mint))) return null;

    // finalists get fresh scores before Chief sees them
    const refreshed: TokenAnalysis[] = [];
    for (const t of finalists) {
      const facts = repo.getFacts<SocialFacts>(t.mint);
      if (!facts) { refreshed.push(t); continue; }
      const r = await brain.softKill(t, facts, { allowCall: true, force: (t.soft?.cachedUntil ?? 0) <= now });
      repo.saveVerdict(r.analysis, this.now());
      if (!r.analysis.diedAt && r.analysis.verdict === 'shortlisted') refreshed.push(r.analysis);
      else if (r.analysis.verdict === 'pending') refreshed.push(t);
    }
    finalists = refreshed;
    if (!finalists.length) return null;

    desk.setStatus('chief', 'working');
    const res = await brain.chiefPick(finalists);
    if (!res) return null; // no model: rules only, no picks
    this.lastDecisionAt = now;
    for (const t of finalists) this.offered.add(t.mint);
    if (this.offered.size > 2000) this.offered = new Set([...this.offered].slice(-500));
    if (!res.pick) {
      desk.say('chief', res.quote);
      return null;
    }
    const p = res.pick;
    repo.addPick(this.now(), p.mint, p.symbol, res.provider, res.reason);
    repo.saveVerdict({ ...p, verdict: 'picked', verdictReason: `Chief: ${res.reason}`.slice(0, 200) }, this.now());
    desk.emit({ agent: 'social', kind: 'handoff', to: 'chief', mint: p.mint, symbol: p.symbol });
    desk.emit({ agent: 'chief', kind: 'pick', mint: p.mint, symbol: p.symbol });
    desk.say('chief', res.quote);
    desk.emit({ agent: 'chief', kind: 'handoff', to: 'size', mint: p.mint, symbol: p.symbol });
    desk.say('size', `Would size ${desk.ticketSol.toFixed(3)} SOL. Buying starts phase 4.`);
    return p.symbol;
  }

  private animate(a: TokenAnalysis, isNew: boolean, soft: SoftResult | null = null) {
    const { desk } = this.d;
    const tok = { mint: a.mint, symbol: a.symbol };
    if (isNew) desk.emit({ agent: 'crawler', kind: 'token_found', ...tok });
    desk.emit({ agent: 'crawler', kind: 'handoff', to: 'scan', ...tok });
    const freeOk = a.diedAt !== 'free_kill';
    desk.emit({ agent: 'scan', kind: 'check', mint: a.mint, step: 'free_kill', pass: freeOk });
    if (freeOk) desk.emit({ agent: 'scan', kind: 'check', mint: a.mint, step: 'trade_kill', pass: a.diedAt !== 'trade_kill' });
    if (a.diedAt === 'free_kill' || a.diedAt === 'trade_kill') {
      desk.emit({ agent: 'scan', kind: 'drop', ...tok, step: a.diedAt, reason: a.verdictReason });
      return;
    }
    desk.emit({ agent: 'scan', kind: 'handoff', to: 'vet', ...tok });
    desk.setStatus('vet', 'working');
    desk.emit({ agent: 'vet', kind: 'check', mint: a.mint, step: 'chain_kill', pass: a.diedAt !== 'chain_kill' });
    if (a.diedAt === 'chain_kill') {
      const l = dropLine(a);
      desk.emit({ agent: 'vet', kind: 'drop', ...tok, step: 'chain_kill', reason: a.verdictReason });
      desk.say(l.agent, l.text);
      return;
    }
    const s = survivorLines(a);
    desk.say('vet', soft?.quotes?.vet ?? s.vet);
    desk.emit({ agent: 'vet', kind: 'handoff', to: 'social', ...tok });
    if (!soft || soft.status === 'waiting') {
      desk.say('social', s.social);
      return;
    }
    const ok = a.diedAt !== 'soft_kill';
    desk.emit({ agent: 'social', kind: 'check', mint: a.mint, step: 'soft_kill', pass: ok });
    if (soft.quotes) desk.say('social', soft.quotes.social);
    if (!ok) desk.emit({ agent: 'social', kind: 'drop', ...tok, step: 'soft_kill', reason: a.verdictReason });
  }

  /** Sample the big-screen token's price for candles (every 15 s). */
  async sampleFocus() {
    const f = this.d.desk.focusToken;
    if (!f?.pairAddress) return;
    try {
      const p = await this.d.dex.pair(f.pairAddress);
      if (p) this.d.desk.addPriceSample(f.mint, Number(p.priceUsd ?? 0), (p.volume?.m5 ?? 0) / 5, this.now());
    } catch (e) {
      log.warn('price sample failed', { err: String(e) });
    }
  }

  /** Wallet balance and SOL price (every 5 min). Public key only. */
  async refreshWallet() {
    const { env, dex, rpc, repo, desk } = this.d;
    let solUsd: number | null = null;
    try {
      const sol = bestPair(await dex.pairsForTokens([SOL_MINT]), SOL_MINT);
      solUsd = sol?.priceUsd ? Number(sol.priceUsd) : null;
      if (solUsd) this.solUsd = solUsd;
    } catch (e) {
      log.warn('SOL price failed', { err: String(e) });
    }
    if (!env.walletPubkey) {
      desk.setWallet('', null, solUsd);
      return;
    }
    try {
      const lamports = await rpc.getBalanceLamports(env.walletPubkey);
      this.walletSol = Number(lamports) / 1e9;
      desk.setWallet(env.walletPubkey, this.walletSol, solUsd);
      if (solUsd) repo.saveBalance(this.now(), this.walletSol, this.walletSol * solUsd, solUsd);
    } catch (e) {
      log.warn('balance failed', { err: String(e) });
    }
  }
}

/** Turn raw tick errors into a few plain lines for the dashboard. */
export function summarizeErrors(errors: string[]): string[] {
  const out = new Set<string>();
  for (const e of errors) {
    if (/feed:|pairs:/.test(e)) out.add('DexScreener is not answering. No new tokens this minute.');
    else if (/RPC/.test(e)) out.add('The Solana RPC is failing some calls.');
    else if (/^model:/.test(e)) out.add('The AI models are failing. Survivors wait at soft_kill.');
    else out.add('Some tokens could not be checked this minute.');
  }
  return [...out];
}
