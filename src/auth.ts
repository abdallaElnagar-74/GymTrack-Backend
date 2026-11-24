import { randomBytes, randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { MongoServerError } from 'mongodb';
import { z } from 'zod';
import { table, tx, users } from './db.js';
import { env } from './env.js';
import { HttpError } from './errors.js';
import { TABLE_NAMES } from './tables.js';
import { moveUserData, seedExercises } from './data.js';

const TOKEN_TTL = '60d';
// A real bcrypt hash (cost 12) of a throwaway string, so logins for unknown emails take as long as real
// ones. Precomputed: Workers don't allow generating random salts while the module loads.
const DUMMY_HASH = '$2b$12$vNpsuScQWr27RBRCwBxyv.KyUG6wcWgdx2InS1XSVobr9h3bAA3Wm';

const credentials = z.object({
  email: z.email().max(254).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

export type AuthedRequest = Request & { userId: string };

function signToken(userId: string) {
  return jwt.sign({}, env.JWT_SECRET, { subject: userId, expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}

/**
 * Accounts recently confirmed to exist (user id -> expiry time), so most requests skip that
 * database round trip. Deleting an account here removes it at once; on other server instances
 * a deleted account's token keeps working for at most KNOWN_USER_TTL.
 */
const knownUsers = new Map<string, number>();
const KNOWN_USER_TTL = 5 * 60 * 1000;
const MAX_KNOWN_USERS = 10_000;

export const forgetUser = (id: string) => knownUsers.delete(id);

async function userExists(id: string) {
  const until = knownUsers.get(id);
  if (until && until > Date.now()) return true;
  const exists = (await users.countDocuments({ _id: id }, { limit: 1 })) > 0;
  if (exists) {
    if (knownUsers.size >= MAX_KNOWN_USERS) knownUsers.clear();
    knownUsers.set(id, Date.now() + KNOWN_USER_TTL);
  } else knownUsers.delete(id);
  return exists;
}

/** Require a valid `Authorization: Bearer <token>` header. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Not signed in');
  let sub: string | undefined;
  try {
    sub = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }).sub as string | undefined;
  } catch {
    throw new HttpError(401, 'Session expired, please sign in again');
  }
  if (!sub) throw new HttpError(401, 'Invalid token');
  if (!(await userExists(sub))) throw new HttpError(401, 'Account no longer exists');
  (req as AuthedRequest).userId = sub;
  next();
}

const onWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers';

// Slow down password guessing. Created on the first request: its store starts a timer, which
// Cloudflare Workers don't allow while the module loads.
let limiter: RequestHandler | null = null;
const authLimiter: RequestHandler = (req, res, next) => (limiter ??= makeLimiter())(req, res, next);

const makeLimiter = () =>
  rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
  validate: { creationStack: false }, // created lazily on purpose (see above)
  // On Cloudflare the visitor's address is in CF-Connecting-IP (set by Cloudflare; req.ip isn't the
  // visitor there). Elsewhere the header could be faked, so it's only trusted on Workers.
  keyGenerator: (req) =>
    ipKeyGenerator(
      String((onWorkers ? req.headers['cf-connecting-ip'] : undefined) ?? req.ip ?? 'unknown')
    ),
});

export const authRouter = Router();

const emailTaken = (e: unknown) => e instanceof MongoServerError && e.code === 11000;

/** Accounts the app creates by itself so it works without signing in ("guest" accounts). */
const DEVICE_DOMAIN = '@devices.gymtracker.app';

authRouter.post('/register', authLimiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  // `seed: false` = start without the starter exercises (used when uploading data from an old app version).
  const { seed } = z.object({ seed: z.boolean().default(true) }).parse({ seed: req.body?.seed });
  const hash = await bcrypt.hash(password, 12);
  const id = randomUUID();
  try {
    // Emails are stored lower-cased, so the unique index on `email` is case-insensitive.
    await users.insertOne({ _id: id, email, password_hash: hash, created_at: new Date(), sync_version: 0 });
  } catch (e) {
    if (emailTaken(e)) throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
  if (seed) await seedExercises(id);
  res.status(201).json({ token: signToken(id), user: { id, email } });
});

/**
 * Create a guest account so the app works without signing in. The server picks the
 * credentials; the app keeps them to log back in when its token expires.
 */
authRouter.post('/guest', authLimiter, async (req, res) => {
  const { seed } = z.object({ seed: z.boolean().default(true) }).parse({ seed: req.body?.seed });
  const email = `device-${randomBytes(12).toString('hex')}${DEVICE_DOMAIN}`;
  const password = randomBytes(24).toString('hex');
  const id = randomUUID();
  const hash = await bcrypt.hash(password, 12);
  await users.insertOne({ _id: id, email, password_hash: hash, created_at: new Date(), sync_version: 0 });
  if (seed) await seedExercises(id);
  res.status(201).json({ token: signToken(id), user: { id, email }, password });
});

async function requireGuest(req: Request) {
  const uid = (req as AuthedRequest).userId;
  const me = await users.findOne({ _id: uid }, { projection: { email: 1 } });
  if (!me?.email.endsWith(DEVICE_DOMAIN)) throw new HttpError(400, 'Already signed in with an email account');
  return uid;
}

/** Guest -> new email account: the same account (and data) gets a real email and password. */
authRouter.post('/upgrade', authLimiter, requireAuth, async (req, res) => {
  const uid = await requireGuest(req);
  const { email, password } = credentials.parse(req.body);
  const hash = await bcrypt.hash(password, 12);
  try {
    await users.updateOne({ _id: uid }, { $set: { email, password_hash: hash } });
  } catch (e) {
    if (emailTaken(e)) throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
  res.json({ token: signToken(uid), user: { id: uid, email } });
});

/** Guest -> existing email account: the guest's data is moved into it and the guest account removed. */
authRouter.post('/merge', authLimiter, requireAuth, async (req, res) => {
  const guest = await requireGuest(req);
  const { email, password } = credentials.parse(req.body);
  const user = await users.findOne({ email }, { projection: { password_hash: 1 } });
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Wrong email or password');
  if (user._id !== guest) {
    await tx(async (session) => {
      await moveUserData(guest, user._id, session);
      await users.deleteOne({ _id: guest }, { session });
    });
    forgetUser(guest);
  }
  res.json({ token: signToken(user._id), user: { id: user._id, email } });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const user = await users.findOne({ email }, { projection: { password_hash: 1 } });
  // Compare even when the user doesn't exist, so timing doesn't reveal which emails are registered.
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Wrong email or password');
  res.json({ token: signToken(user._id), user: { id: user._id, email } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await users.findOne(
    { _id: (req as AuthedRequest).userId },
    { projection: { email: 1, created_at: 1 } }
  );
  if (!user) throw new HttpError(401, 'Account no longer exists');
  res.json({ user: { id: user._id, email: user.email, created_at: user.created_at } });
});

/** Permanently delete the account and all synced data. */
authRouter.delete('/me', requireAuth, async (req, res) => {
  const uid = (req as AuthedRequest).userId;
  await tx(async (session) => {
    for (const t of TABLE_NAMES) await table(t).deleteMany({ user_id: uid }, { session });
    await users.deleteOne({ _id: uid }, { session });
  });
  forgetUser(uid);
  res.status(204).end();
});
