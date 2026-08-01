import { gzipSync } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';

/**
 * Lightweight gzip compression middleware using Node.js built-in zlib.
 * Only compresses JSON responses larger than `threshold` bytes when the
 * client advertises gzip support. See docs/PERFORMANCE_SPEC.md § Enhancement 5.
 */
export function compress(threshold = 1024) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const acceptEncoding = _req.headers['accept-encoding'] ?? '';
    if (typeof acceptEncoding !== 'string' || !acceptEncoding.includes('gzip')) {
      next();
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = function (body: unknown): Response {
      const raw = JSON.stringify(body);
      if (raw && raw.length > threshold) {
        const compressed = gzipSync(raw);
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Vary', 'Accept-Encoding');
        res.removeHeader('Content-Length');
        res.end(compressed);
        return res;
      }
      return originalJson(body);
    };
    next();
  };
}
