import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { pool } from './db.js';
import { env } from './env.js';
import { migrate } from './migrate.js';

await migrate();

const server = createApp().listen(env.PORT, '0.0.0.0', () => {
  console.log(`Gym API listening on http://localhost:${env.PORT}`);
  // Print LAN addresses: the phone needs one of these (not "localhost").
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${env.PORT}`);
    }
  }
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
