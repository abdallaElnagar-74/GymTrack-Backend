import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { client, connectDb } from './db.js';
import { env } from './env.js';
import { log } from './log.js';
import { migrate } from './migrate.js';

try {
  await connectDb();
  await migrate();
  log.info('MongoDB: indexes ready');
} catch {
  log.error('Could not start: database unavailable. Check MONGODB_URI and Atlas → Network Access.');
  await client.close();
  process.exit(1);
}

const server = createApp({ logRequests: true }).listen(env.PORT, '0.0.0.0', () => {
  log.info(`Gym API listening on http://localhost:${env.PORT}`);
  // Print LAN addresses: the phone needs one of these (not "localhost").
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) log.info(`  on your network: http://${a.address}:${env.PORT}`);
    }
  }
});

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down ...`);
  server.close();
  await client.close();
  log.info('MongoDB: disconnected');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
