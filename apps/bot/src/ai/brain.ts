import { evaluateChain, type SoftScores, type TokenAnalysis } from '@coin/shared';
import type { Repo } from '../db/db.js';
import { log } from '../log.js';
import { CHIEF_SYSTEM, VET_SOCIAL_SYSTEM, chiefUser, vetSocialUser, type SocialFacts } from './prompts.js';
import { NoProviderError, type ModelRouter } from './router.js';
import { ChiefOut, VetSocialOut, parseModel, softFrom } from './schema.js';

export interface BrainOptions {
  /** output cap for the scoring call */
  maxTokens: number;
  /** output cap for Chief (reasoning tokens count as output) */
  chiefMaxTokens: number;
  /** how long model scores stay fresh */
  cacheMs: number;
  /** price move that voids cached scores */
  repriceAt: number;
  now?: () => number;
}

export type SoftStatus = 'scored' | 'cached' | 'stale' | 'waiting' | 'invalid';

export interface SoftResult {
  analysis: TokenAnalysis;
  status: SoftStatus;
  /** true when this call spent a model request */
  called: boolean;
  quotes?: { vet: string; social: string };
}

export interface PickResult {
  pick: TokenAnalysis | null;
  reason: string;
  quote: string;
  provider: string;
}

/**
 * Vet + Social (one JSON call per token) and Chief (one call per pick).
 * Model replies are validated with zod; an invalid reply is retried once, then counts as a fail.
 */
export class Brain {
  private now: () => number;
  constructor(private router: ModelRouter, private repo: Repo, private opts: BrainOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * soft_kill for a token that survived chain_kill.
   * Scores are reused for `cacheMs` unless the price moved more than `repriceAt`; after expiry
   * (price steady) the old scores are reused as "stale" unless `force` (Chief refreshes its finalists).
   */
  async softKill(a: TokenAnalysis, facts: SocialFacts, o: { allowCall: boolean; force?: boolean }): Promise<SoftResult> {
    const now = this.now();
    const price = a.metrics.priceUsd;
    const cache = this.repo.getSoft(a.mint);
    const moved = !cache || !cache.price || !price ? !cache : Math.abs(price / cache.price - 1) > this.opts.repriceAt;
    const fresh = !!cache && now < cache.expiresAt && !moved;

    if (fresh) return { analysis: this.apply(a, cache!.soft), status: 'cached', called: false };
    // Expired or repriced scores are only refreshed when they are about to drive a decision (force: Chief's
    // finalists). Everywhere else the last scores stand, marked stale. That keeps a busy day inside the free budget.
    if (cache && !o.force) return { analysis: this.apply(a, { ...cache.soft, cachedUntil: Math.min(cache.expiresAt, moved ? now : cache.expiresAt) }), status: 'stale', called: false };
    if (!o.allowCall) return { analysis: this.waiting(a, 'Waiting for the model scores'), status: 'waiting', called: false };

    const user = vetSocialUser(a, facts, now);
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        text = (await this.router.complete({ task: 'score', system: VET_SOCIAL_SYSTEM, user, maxTokens: this.opts.maxTokens })).text;
      } catch (e) {
        if (e instanceof NoProviderError) return { analysis: this.waiting(a, 'No model available: rules only, no new trades'), status: 'waiting', called: attempt > 0 };
        throw e;
      }
      const parsed = parseModel(VetSocialOut, text);
      if (parsed.ok) {
        const soft: SoftScores = { ...softFrom(parsed.data), cachedUntil: now + this.opts.cacheMs };
        this.repo.saveSoft(a.mint, soft, soft.cachedUntil, price);
        return { analysis: this.apply(a, soft), status: 'scored', called: true, quotes: { vet: parsed.data.vet_quote, social: parsed.data.social_quote } };
      }
      lastErr = parsed.error;
      log.warn('model reply failed validation', { mint: a.mint, attempt: attempt + 1, error: parsed.error.slice(0, 200) });
    }
    // two invalid replies: treat as a fail at soft_kill
    const r = evaluateChain(a.metrics, null, 'soft_kill');
    return {
      analysis: { ...a, soft: null, checks: r.checks, diedAt: 'soft_kill', verdict: 'dropped', verdictReason: `soft_kill: model reply invalid twice (${lastErr.slice(0, 80)})` },
      status: 'invalid',
      called: true,
    };
  }

  private apply(a: TokenAnalysis, soft: SoftScores): TokenAnalysis {
    const r = evaluateChain(a.metrics, soft, 'soft_kill');
    if (r.diedAt) {
      const failed = r.checks.filter((c) => c.step === r.diedAt && c.pass === false).map((c) => c.key);
      return { ...a, soft, checks: r.checks, diedAt: r.diedAt, verdict: 'dropped', verdictReason: `${r.diedAt}: ${failed.join(', ')}` };
    }
    return { ...a, soft, checks: r.checks, diedAt: null, verdict: 'shortlisted', verdictReason: 'Passed soft_kill. In the running for Chief.' };
  }

  private waiting(a: TokenAnalysis, reason: string): TokenAnalysis {
    return { ...a, diedAt: null, verdict: 'pending', verdictReason: reason };
  }

  /** Chief picks one of up to three finalists, or passes. Returns null when no model is available. */
  async chiefPick(finalists: TokenAnalysis[]): Promise<PickResult | null> {
    const user = chiefUser(finalists);
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await this.router.complete({ task: 'pick', system: CHIEF_SYSTEM, user, maxTokens: this.opts.chiefMaxTokens });
      } catch (e) {
        if (e instanceof NoProviderError) return null;
        throw e;
      }
      const parsed = parseModel(ChiefOut, res.text);
      if (parsed.ok) {
        const p = parsed.data.pick;
        const chosen = p ? finalists.find((t) => t.mint === p || t.symbol.toLowerCase() === p.replace(/^\$/, '').toLowerCase()) : null;
        if (p && !chosen) {
          log.warn('Chief picked a token that is not a finalist', { pick: p.slice(0, 60) });
          continue;
        }
        return { pick: chosen ?? null, reason: parsed.data.reason, quote: parsed.data.quote, provider: res.provider };
      }
      log.warn('Chief reply failed validation', { attempt: attempt + 1, error: parsed.error.slice(0, 200) });
    }
    return { pick: null, reason: 'Chief reply invalid twice', quote: 'Nothing convincing. Passing.', provider: 'none' };
  }
}
