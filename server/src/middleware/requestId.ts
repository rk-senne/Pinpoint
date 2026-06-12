import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  if (!req.id) {
    (req as any).id = randomUUID();
  }
  res.setHeader('X-Request-Id', String(req.id));
  next();
}
