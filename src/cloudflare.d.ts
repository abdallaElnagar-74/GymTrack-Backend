/**
 * Minimal types for the Cloudflare runtime modules used by worker.ts, so `npm run build`
 * (plain tsc with Node types) still type-checks. Wrangler bundles worker.ts itself.
 */
declare module 'cloudflare:workers' {
  export abstract class DurableObject {
    constructor(ctx: unknown, env: unknown);
    fetch?(request: Request): Promise<Response>;
  }
}

declare module 'cloudflare:node' {
  export function handleAsNodeRequest(port: number, request: Request): Promise<Response>;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace<_T = unknown> {
  idFromName(name: string): unknown;
  get(id: unknown, options?: { locationHint?: string }): DurableObjectStub;
}
