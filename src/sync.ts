import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { pool, tx } from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { CASCADES, TABLES, TABLE_NAMES, pushSchema, type TableName } from './tables.js';

/**
 * Offline-first sync protocol
 *
 *   GET  /sync/pull?since=<version>   -> { changes: {table: rows[]}, version, hasMore }
 *   POST /sync/push { changes }       -> { applied, version }
 *
 * Clients pull first (merging server rows into the local DB), then push their local
 * changes. Conflicts are resolved by last-write-wins on the client `updated_at`.
 * Deletes are pushed as rows with `deleted: true` and kept as tombstones.
 */

const PULL_LIMIT = 2000;

/** Serialise sync operations per user, so versions are observed in commit order. */
async function lockUser(c: pg.PoolClient, userId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
}

const userId = (req: Request) => (req as AuthedRequest).userId;

export const syncRouter = Router();
syncRouter.use(requireAuth);

syncRouter.get('/pull', async (req, res) => {
  const since = z.coerce.number().int().min(0).default(0).parse(req.query.since);
  const uid = userId(req);

  const result = await tx(async (c) => {
    await lockUser(c, uid);
    const changes = {} as Record<TableName, Record<string, unknown>[]>;
    let newVersion = since;
    let truncatedAt = Infinity;

    for (const t of TABLE_NAMES) {
      const cols = ['id', ...TABLES[t].columns, 'updated_at', 'deleted', 'version'].join(', ');
      const { rows } = await c.query(
        `SELECT ${cols} FROM ${t} WHERE user_id = $1 AND version > $2 ORDER BY version LIMIT $3`,
        [uid, since, PULL_LIMIT]
      );
      changes[t] = rows;
      if (rows.length) newVersion = Math.max(newVersion, rows[rows.length - 1].version);
      if (rows.length === PULL_LIMIT) truncatedAt = Math.min(truncatedAt, rows[rows.length - 1].version);
    }

    // If any table was cut off, only advance to the point every table has fully covered.
    // Rows above that point may be re-sent next time; applying them again is harmless.
    const hasMore = truncatedAt !== Infinity;
    return { changes, version: hasMore ? truncatedAt : newVersion, hasMore };
  });

  res.json(result);
});

syncRouter.post('/push', async (req, res) => {
  const { changes } = pushSchema.parse(req.body);
  const uid = userId(req);

  const applied = await tx(async (c) => {
    await lockUser(c, uid);
    let count = 0;

    for (const t of TABLE_NAMES) {
      const { columns } = TABLES[t];
      const all = ['id', ...columns, 'updated_at', 'deleted'];
      const placeholders = all.map((_, i) => `$${i + 2}`).join(', ');
      const updates = [...columns, 'updated_at', 'deleted'].map((col) => `${col} = EXCLUDED.${col}`).join(', ');

      // Last-write-wins: only overwrite when the incoming edit is newer
      // (or equally new but a delete, so deletes win ties).
      const sql = `
        INSERT INTO ${t} (user_id, ${all.join(', ')}, version)
        VALUES ($1, ${placeholders}, nextval('sync_version'))
        ON CONFLICT (user_id, id) DO UPDATE SET ${updates}, version = nextval('sync_version')
        WHERE EXCLUDED.updated_at > ${t}.updated_at
           OR (EXCLUDED.updated_at = ${t}.updated_at AND EXCLUDED.deleted AND NOT ${t}.deleted)
        RETURNING id, deleted, updated_at`;

      for (const row of changes[t] as Record<string, unknown>[]) {
        const values = all.map((col) => row[col] ?? null);
        const { rows } = await c.query(sql, [uid, ...values]);
        if (!rows.length) continue; // older than what the server has
        count++;
        if (rows[0].deleted) await cascadeDelete(c, uid, t, rows[0].id, rows[0].updated_at);
      }
    }
    return count;
  });

  const { rows } = await pool.query<{ v: number }>(
    `SELECT COALESCE(MAX(version), 0)::bigint AS v FROM (${TABLE_NAMES.map(
      (t) => `SELECT MAX(version) AS version FROM ${t} WHERE user_id = $1`
    ).join(' UNION ALL ')}) x`,
    [uid]
  );
  res.json({ applied, version: rows[0].v });
});

/** Tombstone children of a deleted row (recursively), so every device removes them. */
async function cascadeDelete(c: pg.PoolClient, uid: string, table: TableName, id: string, at: number) {
  for (const [child, fk] of CASCADES[table] ?? []) {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE ${child} SET deleted = true, updated_at = GREATEST(updated_at, $3), version = nextval('sync_version')
       WHERE user_id = $1 AND ${fk} = $2 AND NOT deleted RETURNING id`,
      [uid, id, at]
    );
    for (const r of rows) await cascadeDelete(c, uid, child, r.id, at);
  }
}
