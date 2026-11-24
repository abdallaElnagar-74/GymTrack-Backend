import { z } from 'zod';

const schema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must be a mongodb:// or mongodb+srv:// URL'),
  MONGODB_DB: z.string().min(1).default('gymapp'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Settings from the environment, checked on first use (not when the code loads): Cloudflare
 * starts the Worker once while deploying, and a deploy must not fail just because secrets
 * aren't readable at that moment. A missing or invalid value throws on the first request.
 */
function load(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', z.prettifyError(parsed.error));
    console.error('Copy .env.example to .env and fill it in (on Cloudflare: Settings -> Variables and Secrets).');
    throw new Error('Invalid environment: ' + z.prettifyError(parsed.error).replace(/\s+/g, ' '));
  }
  return (cached = parsed.data);
}

export const env: Env = new Proxy({} as Env, {
  get: (_target, key) => load()[key as keyof Env],
});
