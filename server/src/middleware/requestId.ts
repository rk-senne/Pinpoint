import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  // pino-http pre-assigns a per-process counter (1, 2, 3 …) that repeats after
  // every restart; audit rows / logs need a globally unique correlation id.
  if (typeof req.id !== 'string' || req.id.length === 0) {
    (req as any).id = randomUUID();
  }
  res.setHeader('X-Request-Id', String(req.id));
  next();
}
