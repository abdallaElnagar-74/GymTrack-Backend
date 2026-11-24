import { Router, type Request } from 'express';
import { ObjectId, type AnyBulkWriteOperation, type ClientSession } from 'mongodb';
import { z } from 'zod';
import { snapshot, table, tx, users, type SyncedDoc } from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { HttpError } from './errors.js';
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
 *
 * Versions are per user: every write to one of the user's rows takes the next value of
 * `users.sync_version`. A push runs in one transaction that first writes the user
 * document, so concurrent pushes for the same user are serialised (MongoDB retries the
 * loser), and a pull reads from a single snapshot, so it never sees half a push.
 */

const PULL_LIMIT = 2000;

const userId = (req: Request) => (req as AuthedRequest).userId;

/** Fields returned to the client for a row of table `t`. */
const projection = (t: TableName) =>
  Object.fromEntries(
    ['id', ...TABLES[t].columns, 'updated_at', 'deleted', 'version'].map((c) => [c, 1] as const)
  ) as Record<string, 1> & { _id?: 0 };

export const syncRouter = Router();
syncRouter.use(requireAuth);

syncRouter.get('/pull', async (req, res) => {
  const since = z.coerce.number().int().min(0).default(0).parse(req.query.since);
  const uid = userId(req);

  const result = await snapshot(async (session) => {
    const changes = {} as Record<TableName, Record<string, unknown>[]>;
    let newVersion = since;
    let truncatedAt = Infinity;

    for (const t of TABLE_NAMES) {
      const rows = await table(t)
        .find({ user_id: uid, version: { $gt: since } }, { session, projection: { ...projection(t), _id: 0 } })
        .sort({ version: 1 })
        .limit(PULL_LIMIT)
        .toArray();
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

  const result = await tx(async (session) => {
    // Writing the user document takes that user's "lock" for the rest of the transaction.
    const user = await users.findOneAndUpdate(
      { _id: uid },
      { $set: { sync_lock: new ObjectId() } },
      { session, returnDocument: 'after', projection: { sync_version: 1 } }
    );
    if (!user) throw new HttpError(401, 'Account no longer exists');
    let version = user.sync_version ?? 0;
    const nextVersion = () => ++version;
    let count = 0;

    // Parents come before children in TABLE_NAMES, so cascades from earlier tables
    // are already written when a later table loads its existing rows.
    for (const t of TABLE_NAMES) {
      const rows = changes[t] as Record<string, unknown>[];
      if (!rows.length) continue;
      const fields = [...TABLES[t].columns, 'updated_at', 'deleted'];

      const existing = new Map<string, { updated_at: number; deleted: boolean }>();
      const ids = [...new Set(rows.map((r) => r.id as string))];
      for await (const d of table(t).find(
        { user_id: uid, id: { $in: ids } },
        { session, projection: { _id: 0, id: 1, updated_at: 1, deleted: 1 } }
      )) {
        existing.set(d.id, { updated_at: d.updated_at, deleted: d.deleted });
      }

      const ops: AnyBulkWriteOperation<SyncedDoc>[] = [];
      const deleted: { id: string; at: number }[] = [];
      for (const row of rows) {
        const id = row.id as string;
        const updatedAt = row.updated_at as number;
        const isDeleted = row.deleted === true;
        const cur = existing.get(id);
        // Last-write-wins: only overwrite when the incoming edit is newer
        // (or equally new but a delete, so deletes win ties).
        const wins =
          !cur || updatedAt > cur.updated_at || (updatedAt === cur.updated_at && isDeleted && !cur.deleted);
        if (!wins) continue;

        const doc = Object.fromEntries(fields.map((c) => [c, row[c] ?? null]));
        ops.push({
          updateOne: {
            filter: { user_id: uid, id },
            update: { $set: { ...doc, version: nextVersion() } },
            upsert: true,
          },
        });
        existing.set(id, { updated_at: updatedAt, deleted: isDeleted });
        if (isDeleted) deleted.push({ id, at: updatedAt });
        count++;
      }

      if (ops.length) await table(t).bulkWrite(ops, { session, ordered: true });
      for (const d of deleted) await cascadeDelete(session, uid, t, d.id, d.at, nextVersion);
    }

    if (version !== user.sync_version) {
      await users.updateOne({ _id: uid }, { $set: { sync_version: version } }, { session });
    }
    return { applied: count, version };
  });

  res.json(result);
});

/** Tombstone children of a deleted row (recursively), so every device removes them. */
async function cascadeDelete(
  session: ClientSession,
  uid: string,
  parent: TableName,
  id: string,
  at: number,
  nextVersion: () => number
) {
  for (const [child, fk] of CASCADES[parent] ?? []) {
    const kids = await table(child)
      .find({ user_id: uid, [fk]: id, deleted: false }, { session, projection: { _id: 0, id: 1 } })
      .toArray();
    if (!kids.length) continue;
    await table(child).bulkWrite(
      kids.map((k) => ({
        updateOne: {
          filter: { user_id: uid, id: k.id },
          update: { $set: { deleted: true, version: nextVersion() }, $max: { updated_at: at } },
        },
      })),
      { session }
    );
    for (const k of kids) await cascadeDelete(session, uid, child, k.id, at, nextVersion);
  }
}
