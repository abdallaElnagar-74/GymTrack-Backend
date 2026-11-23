import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from './db.js';
import { env } from './env.js';
import { HttpError } from './errors.js';

const TOKEN_TTL = '60d';
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 12);

const credentials = z.object({
  email: z.email().max(254).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

export type AuthedRequest = Request & { userId: string };

function signToken(userId: string) {
  return jwt.sign({}, env.JWT_SECRET, { subject: userId, expiresIn: TOKEN_TTL, algorithm: 'HS256' });
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
  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1', [sub]);
  if (!rowCount) throw new HttpError(401, 'Account no longer exists');
  (req as AuthedRequest).userId = sub;
  next();
}

// Slow down password guessing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hash]
    );
    res.status(201).json({ token: signToken(rows[0].id), user: { id: rows[0].id, email } });
  } catch (e: any) {
    if (e?.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const { rows } = await pool.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE lower(email) = $1',
    [email]
  );
  const user = rows[0];
  // Compare even when the user doesn't exist, so timing doesn't reveal which emails are registered.
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Wrong email or password');
  res.json({ token: signToken(user.id), user: { id: user.id, email } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query<{ id: string; email: string; created_at: Date }>(
    'SELECT id, email, created_at FROM users WHERE id = $1',
    [(req as AuthedRequest).userId]
  );
  res.json({ user: rows[0] });
});

/** Permanently delete the account and all synced data. */
authRouter.delete('/me', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [(req as AuthedRequest).userId]);
  res.status(204).end();
});
