import pg from 'pg';
import { env } from './env.js';

// BIGINT columns hold millisecond timestamps / versions, which fit safely in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

/** Run `fn` inside a transaction. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
