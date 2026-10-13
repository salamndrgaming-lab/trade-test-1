import { z } from 'zod';
import { SOFT_KEYS, type SoftKey } from '@coin/shared';

/** A 0–1 score. Accepts "0.4" as well as 0.4; anything else fails validation. */
const score = z.preprocess((v) => (typeof v === 'string' && /^\s*\d*\.?\d+\s*$/.test(v) ? Number(v) : v), z.number().min(0).max(1));
const quote = z.string().trim().min(1).transform((s) => s.replace(/\s+/g, ' ').slice(0, 60));

/** Vet + Social: the six soft scores and one short line for each agent card. */
export const VetSocialOut = z.object({
  concentration_is_exit_risk: score,
  momentum_already_spent: score,
  liquidity_fits_ticket: score,
  account_is_the_project: score,
  recycled_account: score,
  dev_still_loaded: score,
  vet_quote: quote,
  social_quote: quote,
});
export type VetSocialOut = z.infer<typeof VetSocialOut>;

/** Chief: one mint from the candidates, or null to pass. */
export const ChiefOut = z.object({
  pick: z.string().trim().nullable(),
  reason: z.string().trim().transform((s) => s.slice(0, 160)),
  quote,
});
export type ChiefOut = z.infer<typeof ChiefOut>;

/** Pull the first JSON object out of a model reply (tolerates code fences and stray prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

export function parseModel<T>(schema: z.ZodType<T>, text: string): Parsed<T> {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: 'no JSON object in reply' };
  const r = schema.safeParse(json);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, data: r.data };
}

export function softFrom(o: VetSocialOut): Record<SoftKey, number> {
  return Object.fromEntries(SOFT_KEYS.map((k) => [k, Math.round(o[k] * 1000) / 1000])) as Record<SoftKey, number>;
}
