import { describe, expect, it } from 'vitest';
import type { TokenAnalysis } from '@coin/shared';
import { Brain } from '../src/ai/brain.js';
import type { SocialFacts } from '../src/ai/prompts.js';
import { neuronsFor, ProviderError, type ChatRequest, type ChatResult, type Provider, type ProviderId } from '../src/ai/providers.js';
import { ModelRouter, NoProviderError } from '../src/ai/router.js';
import { ChiefOut, VetSocialOut, extractJson, parseModel } from '../src/ai/schema.js';
import { openDb, Repo } from '../src/db/db.js';

const GOOD = { concentration_is_exit_risk: 0.2, momentum_already_spent: 0.3, liquidity_fits_ticket: 0.8, account_is_the_project: 0.9, recycled_account: 0.1, dev_still_loaded: 0.2, vet_quote: 'Holders look spread out.', social_quote: 'Handle is theirs.' };

describe('model JSON validator', () => {
  it('accepts a valid reply, even inside a code fence with prose around it', () => {
    const r = parseModel(VetSocialOut, 'Sure!\n```json\n' + JSON.stringify(GOOD) + '\n```\nDone.');
    expect(r.ok).toBe(true);
  });
  it('accepts numeric strings for scores', () => {
    expect(parseModel(VetSocialOut, JSON.stringify({ ...GOOD, recycled_account: '0.35' })).ok).toBe(true);
  });
  it('rejects out-of-range scores, missing keys and non-numbers', () => {
    expect(parseModel(VetSocialOut, JSON.stringify({ ...GOOD, dev_still_loaded: 1.4 })).ok).toBe(false);
    const { recycled_account: _drop, ...missing } = GOOD;
    expect(parseModel(VetSocialOut, JSON.stringify(missing)).ok).toBe(false);
    expect(parseModel(VetSocialOut, JSON.stringify({ ...GOOD, liquidity_fits_ticket: 'high' })).ok).toBe(false);
    expect(parseModel(VetSocialOut, 'I cannot help with that.').ok).toBe(false);
  });
  it('trims quotes to 60 characters', () => {
    const r = parseModel(VetSocialOut, JSON.stringify({ ...GOOD, vet_quote: 'x'.repeat(200) }));
    expect(r.ok && r.data.vet_quote.length).toBe(60);
  });
  it('parses Chief replies, including a pass', () => {
    expect(parseModel(ChiefOut, '{"pick": null, "reason": "none convince", "quote": "Passing."}').ok).toBe(true);
    expect(parseModel(ChiefOut, '{"pick": "abc", "reason": "r"}').ok).toBe(false);
  });
  it('extractJson returns null for broken JSON', () => expect(extractJson('{"a": 1')).toBeNull());
});

describe('neuron accounting', () => {
  it('uses the Workers AI rates per million tokens', () => {
    expect(neuronsFor('@cf/zai-org/glm-4.7-flash', 1_000_000, 0)).toBe(5500);
    expect(neuronsFor('@cf/openai/gpt-oss-120b', 0, 1_000_000)).toBe(68182);
    // unknown models are charged at the most expensive known rate
    expect(neuronsFor('@cf/other/model', 1_000_000, 0)).toBe(31818);
  });
});

class FakeProvider implements Provider {
  calls = 0;
  constructor(readonly id: ProviderId, public behaviour: 'ok' | '500' | '429' | 'invalid' = 'ok', readonly configured = true, private neurons = 0, public reply: string = JSON.stringify(GOOD)) {}
  async complete(req: ChatRequest): Promise<ChatResult> {
    this.calls++;
    if (this.behaviour === '500') throw new ProviderError(this.id, 'boom', 500);
    if (this.behaviour === '429') throw new ProviderError(this.id, 'slow down', 429);
    return { text: this.behaviour === 'invalid' ? 'not json' : this.reply, model: `${this.id}-${req.task}`, tokensIn: 100, tokensOut: 50, neurons: this.neurons };
  }
}

function setup(providers: Provider[], opts: Partial<{ dailyNeurons: number; switchAt: number }> = {}) {
  const clock = { t: Date.parse('2026-10-13T12:00:00Z') };
  const repo = new Repo(openDb(':memory:'));
  const switches: number[] = [];
  const router = new ModelRouter(providers, repo, { dailyNeurons: opts.dailyNeurons ?? 10_000, switchAt: opts.switchAt ?? 0.9, now: () => clock.t, onBudgetSwitch: (p) => switches.push(p) });
  return { clock, repo, router, switches };
}

const req: ChatRequest = { task: 'score', system: 's', user: 'u', maxTokens: 300 };

describe('model router fallback', () => {
  it('uses Workers AI first', async () => {
    const w = new FakeProvider('workers_ai'), g = new FakeProvider('groq');
    const { router } = setup([w, g]);
    expect((await router.complete(req)).provider).toBe('workers_ai');
    expect(g.calls).toBe(0);
  });
  it('falls to Groq on an error, then Gemini, then rules only', async () => {
    const w = new FakeProvider('workers_ai', '500'), g = new FakeProvider('groq', '429'), m = new FakeProvider('gemini');
    const { router } = setup([w, g, m]);
    expect((await router.complete(req)).provider).toBe('gemini');
    m.behaviour = '500';
    await expect(router.complete(req)).rejects.toBeInstanceOf(NoProviderError);
    expect(router.current()).toBe('rules_only');
    expect(router.state().newTradesBlocked).toBe(true);
  });
  it('a failed provider cools down, then is tried again', async () => {
    const w = new FakeProvider('workers_ai', '500'), g = new FakeProvider('groq');
    const { router, clock } = setup([w, g]);
    await router.complete(req);
    w.behaviour = 'ok';
    expect((await router.complete(req)).provider).toBe('groq');
    clock.t += 3 * 60_000;
    expect((await router.complete(req)).provider).toBe('workers_ai');
  });
  it('skips providers without credentials', async () => {
    const { router } = setup([new FakeProvider('workers_ai', 'ok', false), new FakeProvider('groq')]);
    expect(router.current()).toBe('groq');
  });
  it('switches from Workers AI to Groq at 90% of the daily neurons, once, and back the next UTC day', async () => {
    const w = new FakeProvider('workers_ai', 'ok', true, 400), g = new FakeProvider('groq');
    const { router, switches, clock } = setup([w, g], { dailyNeurons: 1000 });
    for (let i = 0; i < 3; i++) await router.complete(req); // 1200 neurons
    expect(router.neuronsToday()).toBe(1200);
    expect(switches).toHaveLength(1);
    expect(router.current()).toBe('groq');
    expect((await router.complete(req)).provider).toBe('groq');
    expect(w.calls).toBe(3);
    clock.t += 86_400_000;
    expect(router.current()).toBe('workers_ai');
  });
  it('records calls and tokens per provider per day', async () => {
    const { router, repo } = setup([new FakeProvider('workers_ai', 'ok', true, 12.5)]);
    await router.complete(req);
    await router.complete(req);
    expect(repo.aiUsage('2026-10-13').workers_ai).toEqual({ calls: 2, neurons: 25, tokensIn: 200, tokensOut: 100 });
    expect(router.state().callsToday.workers_ai).toBe(2);
  });
});

function token(mint = 'MINT1', price = 0.001): TokenAnalysis {
  return {
    mint, symbol: 'TOK', name: 'Tok', pairAddress: 'P', dexUrl: '', firstSeen: 0, momentum: 0.6, soft: null, checks: [], diedAt: null, verdict: 'pending', verdictReason: '',
    metrics: { ageMinutes: 60, liquidityUsd: 40_000, volumeH24: 200_000, mcapUsd: 300_000, tradesH24: 900, priceUsd: price, change5m: 2, change1h: 10, holders: null, topWallet: 0.03, top10: 0.3, mintRevoked: true, freezeRevoked: true, buyImpactPct: 1, sellImpactPct: 1, sellRoutes: true },
  };
}
const FACTS: SocialFacts = { handle: 'tok', handleHistory: [], websites: [], description: null, ticketUsd: 15 };

function brainSetup(p: FakeProvider) {
  const s = setup([p]);
  s.repo.addToken('MINT1', 'profile', s.clock.t);
  s.repo.saveVerdict(token(), s.clock.t);
  const brain = new Brain(s.router, s.repo, { maxTokens: 300, chiefMaxTokens: 400, cacheMs: 15 * 60_000, repriceAt: 0.2, now: () => s.clock.t });
  return { ...s, brain };
}

describe('Vet + Social scoring', () => {
  it('scores, then serves the cache for 15 minutes without another call', async () => {
    const p = new FakeProvider('workers_ai');
    const { brain, clock } = brainSetup(p);
    const a = await brain.softKill(token(), FACTS, { allowCall: true });
    expect(a.status).toBe('scored');
    expect(a.analysis.verdict).toBe('shortlisted');
    expect(a.quotes?.vet).toBe('Holders look spread out.');
    clock.t += 10 * 60_000;
    expect((await brain.softKill(token(), FACTS, { allowCall: true })).status).toBe('cached');
    expect(p.calls).toBe(1);
  });
  it('a price move over 20% voids the cache: stale until Chief needs it, then re-scored', async () => {
    const p = new FakeProvider('workers_ai');
    const { brain } = brainSetup(p);
    await brain.softKill(token('MINT1', 0.001), FACTS, { allowCall: true });
    expect((await brain.softKill(token('MINT1', 0.00115), FACTS, { allowCall: true })).status).toBe('cached'); // +15%
    expect((await brain.softKill(token('MINT1', 0.00125), FACTS, { allowCall: true })).status).toBe('stale'); // +25%
    expect((await brain.softKill(token('MINT1', 0.00125), FACTS, { allowCall: true, force: true })).status).toBe('scored');
    // force does not re-score scores that are still fresh at the same price
    expect((await brain.softKill(token('MINT1', 0.00125), FACTS, { allowCall: true, force: true })).status).toBe('cached');
    expect(p.calls).toBe(2);
  });
  it('after expiry reuses stale scores unless forced', async () => {
    const p = new FakeProvider('workers_ai');
    const { brain, clock } = brainSetup(p);
    await brain.softKill(token(), FACTS, { allowCall: true });
    clock.t += 20 * 60_000;
    expect((await brain.softKill(token(), FACTS, { allowCall: true })).status).toBe('stale');
    expect((await brain.softKill(token(), FACTS, { allowCall: true, force: true })).status).toBe('scored');
  });
  it('kills at soft_kill when a score breaks its limit', async () => {
    const p = new FakeProvider('workers_ai', 'ok', true, 0, JSON.stringify({ ...GOOD, recycled_account: 0.8 }));
    const { brain } = brainSetup(p);
    const r = await brain.softKill(token(), FACTS, { allowCall: true });
    expect(r.analysis.diedAt).toBe('soft_kill');
    expect(r.analysis.verdictReason).toBe('soft_kill: recycled_account');
  });
  it('retries an invalid reply once, then treats it as a fail', async () => {
    const p = new FakeProvider('workers_ai', 'invalid');
    const { brain } = brainSetup(p);
    const r = await brain.softKill(token(), FACTS, { allowCall: true });
    expect(p.calls).toBe(2);
    expect(r.status).toBe('invalid');
    expect(r.analysis.diedAt).toBe('soft_kill');
  });
  it('waits (rules only) when no model is available', async () => {
    const p = new FakeProvider('workers_ai', '500');
    const { brain } = brainSetup(p);
    const r = await brain.softKill(token(), FACTS, { allowCall: true });
    expect(r.status).toBe('waiting');
    expect(r.analysis.diedAt).toBeNull();
    expect(r.analysis.verdict).toBe('pending');
  });
  it('waits without a call when the per-tick allowance is used up', async () => {
    const p = new FakeProvider('workers_ai');
    const { brain } = brainSetup(p);
    expect((await brain.softKill(token(), FACTS, { allowCall: false })).status).toBe('waiting');
    expect(p.calls).toBe(0);
  });
});

describe('Chief', () => {
  const fin = [token('A'), { ...token('B'), symbol: 'BEE' }, token('C')];
  it('picks one of the finalists by mint or symbol', async () => {
    const p = new FakeProvider('workers_ai', 'ok', true, 0, '{"pick": "B", "reason": "best", "quote": "BEE it is."}');
    const { brain } = brainSetup(p);
    expect((await brain.chiefPick(fin))?.pick?.mint).toBe('B');
    p.reply = '{"pick": "$bee", "reason": "best", "quote": "BEE it is."}';
    expect((await brain.chiefPick(fin))?.pick?.mint).toBe('B');
  });
  it('can pass', async () => {
    const p = new FakeProvider('workers_ai', 'ok', true, 0, '{"pick": null, "reason": "meh", "quote": "Passing today."}');
    const { brain } = brainSetup(p);
    const r = await brain.chiefPick(fin);
    expect(r?.pick).toBeNull();
    expect(r?.quote).toBe('Passing today.');
  });
  it('never picks a token outside the finalists', async () => {
    const p = new FakeProvider('workers_ai', 'ok', true, 0, '{"pick": "ZZZ", "reason": "x", "quote": "ZZZ!"}');
    const { brain } = brainSetup(p);
    const r = await brain.chiefPick(fin);
    expect(r?.pick).toBeNull();
    expect(p.calls).toBe(2);
  });
  it('returns null with no model (no picks in rules-only mode)', async () => {
    const { brain } = brainSetup(new FakeProvider('workers_ai', '500'));
    expect(await brain.chiefPick(fin)).toBeNull();
  });
});
