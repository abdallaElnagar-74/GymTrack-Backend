import { z } from 'zod';

const schema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must be a mongodb:// or mongodb+srv:// URL'),
  MONGODB_DB: z.string().min(1).default('gymapp'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.string().default('development'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', z.prettifyError(parsed.error));
  console.error('Copy .env.example to .env and fill it in (on Cloudflare: Settings -> Variables and Secrets).');
  throw new Error('Invalid environment');
}

export const env = parsed.data;
