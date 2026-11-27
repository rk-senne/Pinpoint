import { Request, Response, NextFunction } from 'express';

const MAX_BODY_SIZE = 1_048_576; // 1MB (JSON bodies)
/**
 * The screenshot upload is multipart (multer enforces the real 10 MB file cap);
 * the generic 1 MB JSON cap used to reject every legitimate screenshot > 1 MB
 * (PP-18). Content-Length for that single route may cover file + markup + form
 * overhead.
 */
const SCREENSHOT_ROUTE = /^\/api\/v1\/annotations\/[^/]+\/screenshot\/?$/;
const MAX_SCREENSHOT_REQUEST_SIZE = 12 * 1024 * 1024;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitize(obj: unknown): unknown {
  if (typeof obj === 'string') return obj.replace(/\0/g, '').trim();
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj !== null && typeof obj === 'object') {
    // '__proto__' / 'constructor' / 'prototype' would rewire the result
    // (prototype pollution): skip them, and define own properties instead of
    // assigning so no key can ever reach a setter on Object.prototype.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (UNSAFE_KEYS.has(k)) continue;
      Object.defineProperty(out, k, { value: sanitize(v), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return obj;
}

export function inputSanitizer(req: Request, res: Response, next: NextFunction): void {
  const len = req.headers['content-length'];
  const isScreenshotUpload = req.method === 'POST' && SCREENSHOT_ROUTE.test((req.originalUrl ?? req.url).split('?')[0] ?? '');
  const limit = isScreenshotUpload ? MAX_SCREENSHOT_REQUEST_SIZE : MAX_BODY_SIZE;
  if (len && Number(len) > limit) {
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds ${isScreenshotUpload ? '12MB' : '1MB'}.`,
      },
    });
    return;
  }
  if (req.body && typeof req.body === 'object') {
    req.body = sanitize(req.body);
  }
  next();
}
