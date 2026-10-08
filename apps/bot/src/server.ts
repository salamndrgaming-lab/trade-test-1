import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { StateSnapshot } from '@coin/shared';

export interface StateSource {
  snapshot(): StateSnapshot;
}

/** Read-only API. Write endpoints (kill switch, mode, rails) arrive in phase 4 behind the Access JWT check. */
export async function buildServer(source: StateSource) {
  const app = Fastify({ logger: false });
  // Same-origin in production (Access in front of both); open CORS only matters for local dev.
  await app.register(cors, { origin: true });
  app.get('/health', async () => ({ ok: true, t: Date.now() }));
  app.get('/state', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return source.snapshot();
  });
  return app;
}
