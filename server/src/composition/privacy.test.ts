import { describe, expect, it, vi } from 'vitest';

import { LocalFsScreenshotStore } from '../adapters/outbound/localfs/LocalFsScreenshotStore.js';
import { S3ScreenshotStore } from '../adapters/outbound/s3/S3ScreenshotStore.js';
import { LocalFsScreenshotEraser, S3ScreenshotEraser } from '../adapters/outbound/privacy/ScreenshotErasers.js';
import { buildPrivacyRouteDeps, pickScreenshotEraser } from './privacy.js';

const config = { storage: { driver: 'local', localDir: '/tmp/x' }, s3: { bucket: 'pp-bucket' } } as never;
const send = vi.fn();

describe('composition/privacy', () => {
  it('uses the disk eraser for the local store and the S3 eraser otherwise', () => {
    const local = new LocalFsScreenshotStore({ dir: '/tmp/pp', signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' });
    expect(pickScreenshotEraser({ screenshotStore: local, s3Client: { send }, config })).toBeInstanceOf(LocalFsScreenshotEraser);
    const s3 = new S3ScreenshotStore({ send } as never, { bucket: 'pp-bucket', region: 'r', forcePathStyle: true, keyPrefix: 'k' } as never);
    expect(pickScreenshotEraser({ screenshotStore: s3, s3Client: { send }, config })).toBeInstanceOf(S3ScreenshotEraser);
  });

  it('wires the use cases and repo into the route deps', () => {
    const deps = buildPrivacyRouteDeps({
      db: (() => undefined) as never,
      config,
      s3Client: { send },
      passwordHasher: { hash: async () => 'h', verify: async () => true },
      screenshotStore: {},
    });
    expect(typeof deps.eraseAccount.execute).toBe('function');
    expect(typeof deps.eraseOrg.execute).toBe('function');
    expect(typeof deps.repo.streamUserExport).toBe('function');
  });
});
