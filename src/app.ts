import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authRouter } from './auth.js';
import { syncRouter } from './sync.js';
import { errorHandler } from './errors.js';
import { pool } from './db.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  // The mobile app isn't a browser, but the Expo web build is; tokens are sent
  // in the Authorization header (no cookies), so allowing any origin is safe.
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/auth', authRouter);
  app.use('/sync', syncRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);
  return app;
}
