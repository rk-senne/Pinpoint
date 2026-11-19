// Integration: the real S3ScreenshotStore against an S3-compatible server
// (MinIO locally / in CI). Gated on `S3_ENDPOINT`, mirroring how the other
// integration tests gate on the database: skipped when it is unset.
//
//   S3_ENDPOINT=http://127.0.0.1:9000 S3_FORCE_PATH_STYLE=true S3_BUCKET=pinpoint \
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... npx vitest --run <this file>

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { S3ScreenshotStore } from '../../adapters/outbound/s3/S3ScreenshotStore.js';

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET || 'pinpoint';
const region = process.env.S3_REGION || 'us-east-1';

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(!endpoint)('Integration: S3ScreenshotStore against S3-compatible storage', () => {
  let store: S3ScreenshotStore;

  beforeAll(() => {
    const client = new S3Client({
      region,
      endpoint,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
    store = new S3ScreenshotStore(client, {
      bucket,
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
  });

  it('put → get round-trips the exact bytes', async () => {
    const annotationId = crypto.randomUUID();
    const { objectKey, url } = await store.uploadScreenshot({
      annotationId,
      body: PNG,
      contentType: 'image/png',
    });
    expect(objectKey).toMatch(new RegExp(`/${annotationId}/[0-9a-f]{16}\\.png$`));
    expect(url).toContain(objectKey);

    const got = await store.fetchScreenshot(objectKey);
    expect(got).not.toBeNull();
    expect(crypto.createHash('sha256').update(got!).digest('hex')).toBe(
      crypto.createHash('sha256').update(PNG).digest('hex'),
    );
  });

  it('returns null for a missing key (404 path)', async () => {
    expect(await store.fetchScreenshot(`annotations/screenshots/${crypto.randomUUID()}/nope.png`)).toBeNull();
    expect(await store.fetchMarkupDocument(`annotations/screenshots/${crypto.randomUUID()}/nope.png`)).toBeNull();
  });

  it('markup document sibling round-trips', async () => {
    const { objectKey } = await store.uploadScreenshot({
      annotationId: crypto.randomUUID(),
      body: PNG,
      contentType: 'image/png',
    });
    const doc = { version: 1, shapes: [{ kind: 'rect', x: 1 }] };
    await store.uploadMarkupDocument({ screenshotKey: objectKey, markupDocument: doc });
    expect(await store.fetchMarkupDocument(objectKey)).toEqual(doc);
  });

  it('the plain URL of a private bucket is NOT loadable, the presigned URL is', async () => {
    const { objectKey, url } = await store.uploadScreenshot({
      annotationId: crypto.randomUUID(),
      body: PNG,
      contentType: 'image/png',
    });
    expect((await fetch(url)).status).toBe(403);

    const presigned = await store.presignScreenshotUrl(objectKey, 60);
    const res = await fetch(presigned);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);

    // Tampering with the key invalidates the signature.
    expect((await fetch(presigned.replace('.png', 'x.png'))).status).toBe(403);
  });
});
