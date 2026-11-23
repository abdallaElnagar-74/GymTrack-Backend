import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db.js';

/** Locate the migrations folder both from src/ (tsx) and dist/src/ (compiled). */
async function migrationsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, '..', 'migrations'), path.join(here, '..', '..', 'migrations')]) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations folder not found');
}

/** Apply every migrations/*.sql file that hasn't been applied yet, in name order. */
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`migrated ${file}`);
  }
}

// Allow `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch(async (e) => {
      console.error(e);
      await pool.end();
      process.exit(1);
    });
}
