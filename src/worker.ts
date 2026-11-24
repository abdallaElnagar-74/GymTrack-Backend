/**
 * Cloudflare Workers entry (`npx wrangler deploy`). The Node entry for local dev / Docker is index.ts.
 *
 * Workers can't reuse a database connection across requests, so a plain Worker would open a new
 * TLS connection to MongoDB Atlas on every request. Instead the Worker forwards every request to
 * ONE Durable Object, which runs the Express app and keeps its MongoDB connections open between
 * requests (Cloudflare's recommended setup for MongoDB). The Durable Object is placed next to the
 * Atlas cluster (`locationHint`), so its database queries are fast.
 */
import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createApp } from './app.js';
import { connectDb } from './db.js';
import { log } from './log.js';

/** Routing key for Express inside the runtime, not a real network port. */
const PORT = 8080;

/**
 * Region of the MongoDB Atlas cluster (AWS sa-east-1, São Paulo -> "sam").
 * Change it if the cluster moves: wnam, enam, sam, weur, eeur, apac, oc, afr, me.
 */
const LOCATION_HINT = 'sam';

let ready: Promise<void> | null = null;

/** Connect to MongoDB and start Express once per Durable Object instance. */
function start() {
  ready ??= (async () => {
    await connectDb();
    createApp({ logRequests: true }).listen(PORT);
  })().catch((e) => {
    ready = null; // try again on the next request
    throw e;
  });
  return ready;
}

/** Runs the API. One instance ("main") serves every request. */
export class Api extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    try {
      await start();
    } catch (e) {
      log.error('Could not start: database unavailable.', (e as Error).message);
      return Response.json({ error: 'Database unavailable, try again shortly' }, { status: 503 });
    }
    return handleAsNodeRequest(PORT, request);
  }
}

type Env = { API: DurableObjectNamespace<Api> };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.API.get(env.API.idFromName('main'), { locationHint: LOCATION_HINT });
    return stub.fetch(request);
  },
};
