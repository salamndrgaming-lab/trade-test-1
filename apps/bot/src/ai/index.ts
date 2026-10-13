import type { BotEnv } from '../config.js';
import type { Repo } from '../db/db.js';
import type { Transport } from '../http/transport.js';
import { Brain } from './brain.js';
import { OpenAiCompatible, WorkersAi } from './providers.js';
import { ModelRouter } from './router.js';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/** Wire the fallback chain: Workers AI → Groq → Gemini → rules only. */
export function buildAi(env: BotEnv, repo: Repo, transport: Transport, now: () => number = Date.now, onBudgetSwitch?: (pct: number) => void) {
  const a = env.ai;
  const router = new ModelRouter(
    [
      new WorkersAi(transport, a.cfAccountId, a.cfToken, { score: a.scoreModel, pick: a.pickModel }),
      new OpenAiCompatible('groq', transport, GROQ_URL, a.groqKey, a.groqModel, 25),
      new OpenAiCompatible('gemini', transport, GEMINI_URL, a.geminiKey, a.geminiModel, 10),
    ],
    repo,
    { dailyNeurons: a.dailyNeurons, switchAt: a.switchAt, now, onBudgetSwitch },
  );
  const brain = new Brain(router, repo, { maxTokens: a.maxTokens, chiefMaxTokens: a.chiefMaxTokens, cacheMs: 15 * 60_000, repriceAt: 0.2, now });
  return { router, brain };
}

export { Brain, ModelRouter };
