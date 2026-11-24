import type { NextFunction, Request, Response } from 'express';

/** Local time, e.g. "2026-11-23 19:14:28". */
const time = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Timestamped terminal logging. */
export const log = {
  info: (...args: unknown[]) => console.log(`[${time()}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${time()}] WARN`, ...args),
  error: (...args: unknown[]) => console.error(`[${time()}] ERROR`, ...args),
};

/** One line per request: method, path, status, duration. Never logs bodies or tokens. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const path = req.originalUrl.split('?')[0];
    const line = `${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`;
    if (res.statusCode >= 500) log.error(line);
    else if (res.statusCode >= 400) log.warn(line);
    else log.info(line);
  });
  next();
}
