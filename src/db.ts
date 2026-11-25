import { MongoClient, type ClientSession, type Document, type ObjectId } from 'mongodb';
import { env } from './env.js';
import { log } from './log.js';
import { TABLE_NAMES, type TableName } from './tables.js';

/** Running on Cloudflare Workers (see worker.ts) rather than Node. */
const onWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers';

/**
 * An object created on first use instead of when the code loads (the database client needs
 * MONGODB_URI, which on Cloudflare may not be readable at load time; see env.ts).
 */
function lazy<T extends object>(make: () => T): T {
  let value: T | null = null;
  return new Proxy({} as T, {
    get(_target, key) {
      value ??= make();
      const v = Reflect.get(value, key, value);
      return typeof v === 'function' ? v.bind(value) : v;
    },
  });
}

export const client = lazy(() => new MongoClient(
  env.MONGODB_URI,
  onWorkers
    ? {
        // Inside the Durable Object (Cloudflare's recommended settings, with a few connections so
        // parallel queries don't queue; Workers allow up to 6 connections opening at once).
        maxPoolSize: 4,
        minPoolSize: 0,
        maxIdleTimeMS: 20_000,
        serverSelectionTimeoutMS: 5000,
      }
    : {
        maxPoolSize: 10,
        // Keep connections open and ready: opening one (TCP + TLS + auth) costs several round trips
        // to Atlas, which made the first parallel requests after a quiet period slow.
        minPoolSize: 5,
        // Node tries IPv6 first but gives up after 250 ms by default, which is too short on
        // IPv6-only / NAT64 networks (some ISPs, phone hotspots); the IPv4 fallback then hangs.
        autoSelectFamilyAttemptTimeout: 2000,
      }
));
export const db = lazy(() => client.db(env.MONGODB_DB));

/** Cluster host for log messages (never includes the username/password). */
function clusterHost() {
  return env.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, '').split(/[/?]/)[0];
}

/** Connect, log it, and keep logging when the connection is lost or comes back. */
export async function connectDb() {
  log.info(`MongoDB: connecting to ${clusterHost()} ...`);
  const started = Date.now();
  try {
    await client.connect();
    await db.command({ ping: 1 });
  } catch (e) {
    log.error(`MongoDB: connection failed: ${(e as Error).message}`);
    throw e;
  }
  log.info(`MongoDB: connected to ${clusterHost()} (database "${env.MONGODB_DB}") in ${Date.now() - started}ms`);

  // Watch whether a primary (writable server) is reachable and log changes only.
  let writable = true;
  client.on('topologyDescriptionChanged', ({ newDescription }) => {
    const now = [...newDescription.servers.values()].some((s) => s.isWritable);
    if (now === writable) return;
    writable = now;
    if (now) log.info('MongoDB: connection restored');
    else log.warn('MongoDB: connection lost, retrying ...');
  });
}

export type UserDoc = {
  _id: string; // UUID string (also the JWT subject)
  email: string; // stored lower-cased
  password_hash: string;
  created_at: Date;
  /** Last sync version handed out to this user's rows. Also serialises that user's pushes. */
  sync_version: number;
  /** Rewritten at the start of every push, purely to lock the user's row for that transaction. */
  sync_lock?: ObjectId;
  settings?: { unit?: 'kg' | 'lb'; rest_seconds?: number; technique_links?: Partial<Record<'normal' | 'warmup' | 'drop', string>> };
};

/** A synced row: the client's fields plus the owner and the server sync version. */
export type SyncedDoc = Document & {
  user_id: string;
  id: string;
  updated_at: number;
  deleted: boolean;
  version: number;
};

export const users = lazy(() => db.collection<UserDoc>('users'));
export const table = (t: TableName) => db.collection<SyncedDoc>(t);

/**
 * Run `fn` in a multi-document transaction (retried automatically on transient
 * write conflicts). Needs a replica set: MongoDB Atlas always is one.
 */
export async function tx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  return client.withSession((session) => session.withTransaction(() => fn(session)));
}

/** Read several collections from one consistent point in time. */
export async function snapshot<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  return client.withSession((session) =>
    session.withTransaction(() => fn(session), { readConcern: { level: 'snapshot' } })
  );
}

/** Create the indexes the API relies on (idempotent). */
export async function ensureIndexes() {
  await users.createIndex({ email: 1 }, { unique: true });
  for (const t of TABLE_NAMES) {
    await table(t).createIndex({ user_id: 1, id: 1 }, { unique: true });
    await table(t).createIndex({ user_id: 1, version: 1 });
  }
  // Lookups the data API makes on every screen.
  await table('workout_sets').createIndex({ user_id: 1, workout_id: 1 });
  await table('workout_sets').createIndex({ user_id: 1, exercise_id: 1 });
  await table('workouts').createIndex({ user_id: 1, finished_at: 1, date: -1 });
  await table('routine_days').createIndex({ user_id: 1, routine_id: 1 });
  await table('routine_day_exercises').createIndex({ user_id: 1, day_id: 1 });
  await table('exercise_videos').createIndex({ user_id: 1, exercise_id: 1 });
}
