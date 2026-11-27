// Integration: LocalFsScreenshotStore + the signed-URL route over real HTTP
// (supertest) and a real temp directory. No database or S3 needed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFsScreenshotStore } from '../../adapters/outbound/localfs/LocalFsScreenshotStore.js';
import { createScreenshotTokenRoutes } from '../../adapters/inbound/http/screenshots.routes.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const ANNOTATION_ID = '11111111-2222-3333-4444-555555555555';

describe('Integration: local-disk screenshots via signed URL', () => {
  let base: string;
  let now: number;
  let store: LocalFsScreenshotStore;
  let app: express.Express;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-localfs-int-'));
    now = Date.now();
    store = new LocalFsScreenshotStore({
      dir: path.join(base, 'shots'),
      signingSecret: 'integration-secret',
      publicBaseUrl: 'http://localhost',
      now: () => now,
    });
    app = express();
    app.use(
      '/api/v1/screenshots',
      createScreenshotTokenRoutes({
        verifyToken: (t) => store.verifyToken(t),
        fetchScreenshotBuffer: (k) => store.fetchScreenshot(k),
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  const pathOf = (url: string): string => new URL(url).pathname;

  it('serves the exact PNG with image/png, nosniff and private caching — no cookies', async () => {
    const up = await store.uploadScreenshot({ annotationId: ANNOTATION_ID, body: PNG, contentType: 'image/png' });
    const url = await store.presignScreenshotUrl(up.objectKey);
    const res = await request(app).get(pathOf(url)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/^private/);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
  });

  it('403 error envelope for expired, forged and malformed tokens', async () => {
    const up = await store.uploadScreenshot({ annotationId: ANNOTATION_ID, body: PNG, contentType: 'image/png' });
    const token = store.signToken(up.objectKey, 900);
    now += 901_000;
    const expired = await request(app).get(`/api/v1/screenshots/${token}`);
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('FORBIDDEN');

    now -= 901_000;
    for (const bad of [`${token}x`, 'garbage', `${token.split('.')[0]}.1.AAAA`]) {
      const r = await request(app).get(`/api/v1/screenshots/${encodeURIComponent(bad)}`);
      expect(r.status).toBe(403);
    }
  });

  it('404 when the file is gone', async () => {
    const token = store.signToken(`annotations/screenshots/${ANNOTATION_ID}/missing.png`, 900);
    const res = await request(app).get(`/api/v1/screenshots/${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('never serves the markup JSON through the image route', async () => {
    const up = await store.uploadScreenshot({ annotationId: ANNOTATION_ID, body: PNG, contentType: 'image/png' });
    const m = await store.uploadMarkupDocument({ screenshotKey: up.objectKey, markupDocument: { a: 1 } });
    const res = await request(app).get(`/api/v1/screenshots/${store.signToken(m.objectKey, 900)}`);
    expect(res.status).toBe(403);
  });

  it('path-traversal in the token path does not escape the route', async () => {
    const res = await request(app).get('/api/v1/screenshots/..%2f..%2fetc%2fpasswd');
    expect([403, 404]).toContain(res.status);
  });
});
