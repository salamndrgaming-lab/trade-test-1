import type { AiProvider, StateSnapshot } from '@coin/shared';
import { utcDay, type Repo } from '../db/db.js';
import { log } from '../log.js';
import { ProviderError, type ChatRequest, type ChatResult, type Provider, type ProviderId } from './providers.js';

export class NoProviderError extends Error {
  constructor(readonly tried: string[]) {
    super(`no AI provider available (${tried.join('; ') || 'none configured'})`);
  }
}

export interface RouterOptions {
  dailyNeurons: number;
  /** fraction of the daily neurons at which Workers AI hands over to Groq */
  switchAt: number;
  now?: () => number;
  /** called once per UTC day when Workers AI crosses the switch point */
  onBudgetSwitch?: (pct: number) => void;
}

/**
 * Fallback chain: Workers AI → Groq → Gemini → rules only (no model, no new trades).
 * Workers AI is skipped once today's neurons reach `switchAt` of the free allowance.
 * A provider that errors cools down (until its retry-after, or 2 minutes) and the next one is tried.
 */
export class ModelRouter {
  private cooldown = new Map<ProviderId, number>();
  private now: () => number;
  private warnedDay = '';

  constructor(private providers: Provider[], private repo: Repo, private opts: RouterOptions) {
    this.now = opts.now ?? Date.now;
  }

  neuronsToday(): number {
    return this.repo.aiUsage(utcDay(this.now())).workers_ai?.neurons ?? 0;
  }

  private available(p: Provider): boolean {
    if (!p.configured) return false;
    if ((this.cooldown.get(p.id) ?? 0) > this.now()) return false;
    if (p.id === 'workers_ai' && this.neuronsToday() >= this.opts.dailyNeurons * this.opts.switchAt) return false;
    return true;
  }

  /** The provider the next call would go to. */
  current(): AiProvider {
    return this.providers.find((p) => this.available(p))?.id ?? 'rules_only';
  }

  async complete(req: ChatRequest): Promise<ChatResult & { provider: ProviderId }> {
    const tried: string[] = [];
    for (const p of this.providers) {
      if (!this.available(p)) continue;
      try {
        const r = await p.complete(req);
        this.record(p.id, r);
        return { ...r, provider: p.id };
      } catch (e) {
        const status = e instanceof ProviderError ? e.status : 0;
        const until = e instanceof ProviderError && e.retryAtMs ? e.retryAtMs : this.now() + (status === 429 ? 60_000 : 120_000);
        this.cooldown.set(p.id, until);
        tried.push(String(e instanceof Error ? e.message : e));
        log.warn('AI provider failed, falling back', { provider: p.id, status, task: req.task });
      }
    }
    throw new NoProviderError(tried);
  }

  private record(id: ProviderId, r: ChatResult) {
    const day = utcDay(this.now());
    this.repo.addAiUsage(day, id, r.neurons, r.tokensIn, r.tokensOut);
    if (id === 'workers_ai') {
      const used = this.neuronsToday();
      const pct = used / this.opts.dailyNeurons;
      if (pct >= this.opts.switchAt && this.warnedDay !== day) {
        this.warnedDay = day;
        log.warn('Workers AI at budget switch point; moving to Groq', { neurons: Math.round(used) });
        this.opts.onBudgetSwitch?.(pct);
      }
    }
  }

  state(): StateSnapshot['ai'] {
    const usage = this.repo.aiUsage(utcDay(this.now()));
    const provider = this.current();
    return {
      provider,
      neuronsUsedToday: Math.round(usage.workers_ai?.neurons ?? 0),
      neuronsDailyLimit: this.opts.dailyNeurons,
      switchAt: this.opts.switchAt,
      callsToday: {
        workers_ai: usage.workers_ai?.calls ?? 0,
        groq: usage.groq?.calls ?? 0,
        gemini: usage.gemini?.calls ?? 0,
        rules_only: 0,
      },
      newTradesBlocked: provider === 'rules_only',
    };
  }
}
