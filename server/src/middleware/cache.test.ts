import { describe, it, expect } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { request } from '../__tests__/supertestClient.js';
import { cacheMiddleware } from './cache.js';

describe('cacheMiddleware', () => {
  it('never caches non-2xx responses', async () => {
    let calls = 0;
    const app = express();
    app.use('/x', cacheMiddleware(60_000));
    app.get('/x', (_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.status(503).json({ error: 'down' });
        return;
      }
      res.json({ ok: true });
    });
    expect((await request(app).get('/x')).status).toBe(503);
    const second = await request(app).get('/x');
    expect(second.status).toBe(200);
    expect(second.headers['x-cache']).toBe('MISS');
    expect((await request(app).get('/x')).headers['x-cache']).toBe('HIT');
  });

  it('is not mounted on tenant-scoped routes in the composition root', () => {
    const src = readFileSync(path.resolve(__dirname, '../composition/container.ts'), 'utf8');
    const mounts = src.split('\n').filter((l) => /app\.use\(.*cacheMiddleware\(/.test(l));
    expect(mounts.join('\n')).not.toMatch(/analytics|guidelines|projects|annotations/);
  });
});
