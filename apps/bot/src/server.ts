import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { StateSnapshot } from '@coin/shared';

export interface StateSource {
  snapshot(): StateSnapshot;
}

/** Read-only API. Write endpoints (kill switch, mode, rails) arrive in phase 4 behind the Access JWT check. */
export async function buildServer(source: StateSource, opts: { allowedOrigin?: string } = {}) {
  const app = Fastify({ logger: false });
  // Only the dashboard's own origin may read /state from a browser; cookies (Cloudflare Access) are allowed.
  if (opts.allowedOrigin) await app.register(cors, { origin: opts.allowedOrigin.split(',').map((s) => s.trim()), credentials: true });
  app.get('/health', async () => ({ ok: true, t: Date.now() }));
  app.get('/state', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return source.snapshot();
  });
  return app;
}
