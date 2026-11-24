import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authRouter } from './auth.js';
import { syncRouter } from './sync.js';
import { dataRouter } from './data.js';
import { errorHandler } from './errors.js';
import { db } from './db.js';
import { requestLogger } from './log.js';

export function createApp({ logRequests = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  if (logRequests) app.use(requestLogger);
  app.use(helmet());
  // The mobile app isn't a browser, but the Expo web build is; tokens are sent
  // in the Authorization header (no cookies), so allowing any origin is safe.
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '20mb' })); // backup files can be large

  app.get('/health', async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ ok: true });
  });

  app.use('/auth', authRouter);
  app.use('/api', dataRouter);
  // Only used once per phone: uploads data that older app versions kept on the phone.
  app.use('/sync', syncRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);
  return app;
}
