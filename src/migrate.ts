import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, ensureIndexes } from './db.js';

/** MongoDB is schemaless; "migrating" just means making sure the indexes exist. */
export async function migrate() {
  await ensureIndexes();
}

// Allow `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => client.close())
    .catch(async (e) => {
      console.error(e);
      await client.close();
      process.exit(1);
    });
}
