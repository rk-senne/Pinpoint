import { Request, Response, NextFunction } from 'express';

const MAX_BODY_SIZE = 1_048_576; // 1MB

function sanitize(obj: unknown): unknown {
  if (typeof obj === 'string') return obj.replace(/\0/g, '').trim();
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitize(v);
    return out;
  }
  return obj;
}

export function inputSanitizer(req: Request, res: Response, next: NextFunction): void {
  const len = req.headers['content-length'];
  if (len && Number(len) > MAX_BODY_SIZE) {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 1MB.' } });
    return;
  }
  if (req.body && typeof req.body === 'object') {
    req.body = sanitize(req.body);
  }
  next();
}
