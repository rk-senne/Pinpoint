import { describe, it, expect, vi } from 'vitest';
import { S3ScreenshotStore } from './S3ScreenshotStore.js';
import type { S3ScreenshotStoreConfig } from './S3ScreenshotStore.js';

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
