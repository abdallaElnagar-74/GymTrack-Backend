import type { NextFunction, Request, Response } from 'express';
import { ZodError, z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', details: z.flattenError(err) });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if ((err as any)?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request too large' });
    return;
  }
  if ((err as any)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}
