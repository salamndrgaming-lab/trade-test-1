import type { RateLimiter } from '../http/ratelimit.js';
import type { HttpRequest, HttpResponse, Transport } from '../http/transport.js';
import { log } from '../log.js';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

/** One request through a limiter, with one retry after a 429 (honouring x-ratelimit-reset) or a network error. */
export async function call(transport: Transport, limiter: RateLimiter, req: HttpRequest, now = Date.now, opts: { retry429?: boolean } = {}): Promise<HttpResponse> {
  const retry429 = opts.retry429 ?? true;
  for (let attempt = 0; ; attempt++) {
    await limiter.take();
    let res: HttpResponse;
    try {
      res = await transport.send(req);
    } catch (e) {
      if (attempt >= 1) throw e;
      log.warn('request failed, retrying once', { service: req.service, request: req.service === 'rpc' ? req.key.split(' ')[0] : req.key, err: String(e) });
      continue;
    }
    if (res.status === 429 && attempt < 1 && retry429) {
      const reset = Number(res.headers['x-ratelimit-reset']);
      const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + 60_000;
      limiter.pauseUntil(until);
      log.warn('rate limited, backing off', { service: req.service, waitMs: until - now() });
      continue;
    }
    return res;
  }
}
