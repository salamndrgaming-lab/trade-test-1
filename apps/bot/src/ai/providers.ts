import { createHash } from 'node:crypto';
import { RateLimiter } from '../http/ratelimit.js';
import type { Transport } from '../http/transport.js';
import { call } from '../sources/http.js';

export type ProviderId = 'workers_ai' | 'groq' | 'gemini';
export type Task = 'score' | 'pick';

export interface ChatRequest {
  task: Task;
  system: string;
  user: string;
  maxTokens: number;
}

export interface ChatResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Workers AI neurons this call cost (0 for other providers) */
  neurons: number;
}

export class ProviderError extends Error {
  constructor(readonly provider: ProviderId, message: string, readonly status: number, readonly retryAtMs: number | null = null) {
    super(`${provider}: ${message}`);
  }
}

export interface Provider {
  readonly id: ProviderId;
  readonly configured: boolean;
  complete(req: ChatRequest): Promise<ChatResult>;
}

/**
 * Workers AI neuron rates (Cloudflare Workers AI pricing page, per million tokens).
 * Free plan: 10,000 neurons per UTC day.
 */
export const NEURON_RATES: Record<string, { in: number; out: number }> = {
  '@cf/zai-org/glm-4.7-flash': { in: 5500, out: 36400 },
  '@cf/openai/gpt-oss-120b': { in: 31818, out: 68182 },
};

export function neuronsFor(model: string, tokensIn: number, tokensOut: number): number {
  const r = NEURON_RATES[model];
  // unknown model: charge at the most expensive known rate so the budget never under-counts
  const rate = r ?? { in: 31818, out: 68182 };
  return (tokensIn * rate.in + tokensOut * rate.out) / 1e6;
}

/** Rough token count when a provider omits usage: 1 token per 4 characters, rounded up. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const key = (provider: ProviderId, task: Task, body: unknown) =>
  `${provider} ${task} ${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16)}`;

function retryAt(headers: Record<string, string>): number | null {
  const ra = Number(headers['retry-after']);
  if (Number.isFinite(ra) && ra > 0) return Date.now() + ra * 1000;
  return null;
}

interface OpenAiChat {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string } | string;
  errors?: { message?: string }[];
}

function chatText(j: OpenAiChat): string {
  return j.choices?.[0]?.message?.content ?? '';
}

function errMsg(j: unknown, status: number): string {
  const o = (j ?? {}) as OpenAiChat;
  if (typeof o.error === 'string') return o.error;
  return o.error?.message ?? o.errors?.[0]?.message ?? `HTTP ${status}`;
}

/**
 * Cloudflare Workers AI over REST.
 * Scoring: GLM-4.7-Flash through the OpenAI-compatible chat endpoint, thinking switched off, JSON mode.
 * Chief: gpt-oss-120b through the Responses API with reasoning effort "low".
 */
export class WorkersAi implements Provider {
  readonly id = 'workers_ai' as const;
  private limiter = new RateLimiter(60, 60_000);
  constructor(
    private transport: Transport,
    private accountId: string | null,
    private token: string | null,
    private models: { score: string; pick: string },
  ) {}

  get configured() {
    return !!(this.accountId && this.token);
  }

  private base() {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1`;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const model = this.models[req.task];
    const headers = { authorization: `Bearer ${this.token}` };
    const isResponses = model.includes('gpt-oss');
    const body = isResponses
      ? { model, input: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }], reasoning: { effort: 'low' }, max_output_tokens: req.maxTokens }
      : {
          model,
          messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
          max_completion_tokens: req.maxTokens,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          chat_template_kwargs: { enable_thinking: false },
        };
    const res = await call(this.transport, this.limiter, { service: 'ai', method: 'POST', url: `${this.base()}/${isResponses ? 'responses' : 'chat/completions'}`, headers, body, key: key(this.id, req.task, body) }, Date.now, { retry429: false });
    if (res.status !== 200) throw new ProviderError(this.id, errMsg(res.json, res.status), res.status, retryAt(res.headers));

    let text: string;
    let tin: number | undefined;
    let tout: number | undefined;
    if (isResponses) {
      const j = res.json as { output?: { type: string; content?: { type: string; text?: string }[] }[]; output_text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      text = j.output_text ?? (j.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
      tin = j.usage?.input_tokens;
      tout = j.usage?.output_tokens;
    } else {
      const j = res.json as OpenAiChat;
      text = chatText(j);
      tin = j.usage?.prompt_tokens;
      tout = j.usage?.completion_tokens;
    }
    const tokensIn = tin ?? estimateTokens(req.system + req.user);
    const tokensOut = tout ?? Math.max(estimateTokens(text), req.maxTokens / 2);
    return { text, model, tokensIn, tokensOut, neurons: neuronsFor(model, tokensIn, tokensOut) };
  }
}

/** Any OpenAI-compatible chat endpoint (Groq, Gemini). */
export class OpenAiCompatible implements Provider {
  private limiter: RateLimiter;
  constructor(
    readonly id: 'groq' | 'gemini',
    private transport: Transport,
    private url: string,
    private apiKey: string | null,
    private model: string | null,
    perMinute: number,
  ) {
    this.limiter = new RateLimiter(perMinute, 60_000);
  }

  get configured() {
    return !!(this.apiKey && this.model);
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      max_completion_tokens: req.maxTokens,
      temperature: 0.2,
      reasoning_effort: 'low',
    };
    const res = await call(this.transport, this.limiter, { service: 'ai', method: 'POST', url: this.url, headers: { authorization: `Bearer ${this.apiKey}` }, body, key: key(this.id, req.task, body) }, Date.now, { retry429: false });
    if (res.status !== 200) throw new ProviderError(this.id, errMsg(res.json, res.status), res.status, retryAt(res.headers));
    const j = res.json as OpenAiChat;
    const text = chatText(j);
    return { text, model: this.model!, tokensIn: j.usage?.prompt_tokens ?? estimateTokens(req.system + req.user), tokensOut: j.usage?.completion_tokens ?? estimateTokens(text), neurons: 0 };
  }
}
