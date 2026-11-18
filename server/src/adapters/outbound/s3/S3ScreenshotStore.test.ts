import { describe, it, expect, vi } from 'vitest';
import { S3ScreenshotStore } from './S3ScreenshotStore.js';
import type { S3ScreenshotStoreConfig } from './S3ScreenshotStore.js';
import { StorageUnavailableError } from '../../../domain/annotation/ports/ScreenshotStore.js';

// Minimal mock of S3Client — we only care about .send()
function createMockS3Client(sendImpl: (...args: unknown[]) => unknown) {
  return { send: vi.fn(sendImpl) } as unknown as ConstructorParameters<typeof S3ScreenshotStore>[0];
}

const config: S3ScreenshotStoreConfig = {
  bucket: 'test-bucket',
  region: 'us-east-1',
};

describe('S3ScreenshotStore.fetchScreenshot', () => {
  it('returns a Buffer when S3 returns a body with transformToByteArray', async () => {
    const payload = Buffer.from('fake-png-bytes');
    const mockBody = {
      transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(payload)),
    };
    const client = createMockS3Client(async () => ({ Body: mockBody }));
    const store = new S3ScreenshotStore(client, config);

    const result = await store.fetchScreenshot('annotations/screenshots/abc/123.png');

    expect(result).toBeInstanceOf(Buffer);
    expect(result).toEqual(payload);
    expect(mockBody.transformToByteArray).toHaveBeenCalledOnce();
  });

  it('returns null when S3 throws NoSuchKey', async () => {
    const noSuchKeyError = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const client = createMockS3Client(async () => { throw noSuchKeyError; });
    const store = new S3ScreenshotStore(client, config);

    const result = await store.fetchScreenshot('missing/key.png');

    expect(result).toBeNull();
  });

  it('returns null when S3 returns 404 via $metadata', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), {
      name: 'SomeOtherName',
      $metadata: { httpStatusCode: 404 },
    });
    const client = createMockS3Client(async () => { throw notFoundError; });
    const store = new S3ScreenshotStore(client, config);

    const result = await store.fetchScreenshot('missing/key.png');

    expect(result).toBeNull();
  });

  it('re-throws unexpected errors', async () => {
    const unexpectedError = new Error('NetworkFailure');
    const client = createMockS3Client(async () => { throw unexpectedError; });
    const store = new S3ScreenshotStore(client, config);

    await expect(store.fetchScreenshot('some/key.png')).rejects.toThrow('NetworkFailure');
  });

  it('returns null when Body is falsy', async () => {
    const client = createMockS3Client(async () => ({ Body: undefined }));
    const store = new S3ScreenshotStore(client, config);

    const result = await store.fetchScreenshot('annotations/screenshots/abc/123.png');

    expect(result).toBeNull();
  });
});

describe('S3ScreenshotStore upload failures', () => {
  const cases: Array<[string, unknown]> = [
    ['missing credentials', Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' })],
    ['connection refused', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['aggregate connection refused', Object.assign(new Error(''), { errors: [{ code: 'ECONNREFUSED' }] })],
    ['no such bucket', Object.assign(new Error('nb'), { name: 'NoSuchBucket' })],
    ['provider 5xx', Object.assign(new Error('boom'), { name: 'X', $metadata: { httpStatusCode: 503 } })],
  ];
  it.each(cases)('maps %s to StorageUnavailableError', async (_label, failure) => {
    const store = new S3ScreenshotStore(createMockS3Client(async () => { throw failure; }), config);
    await expect(
      store.uploadScreenshot({ annotationId: 'a', body: Buffer.from('x'), contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(
      store.uploadMarkupDocument({ screenshotKey: 'k.png', markupDocument: {} }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('leaves unrelated errors untouched', async () => {
    const bug = new TypeError('bad input');
    const store = new S3ScreenshotStore(createMockS3Client(async () => { throw bug; }), config);
    await expect(
      store.uploadScreenshot({ annotationId: 'a', body: Buffer.from('x'), contentType: 'image/png' }),
    ).rejects.toBe(bug);
  });
});
