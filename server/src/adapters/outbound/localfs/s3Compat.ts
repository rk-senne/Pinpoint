// The PDF report renderer reads screenshot bytes through an S3-shaped client
// (`send(new GetObjectCommand(...))`). For the local driver this adapter
// answers exactly that call from disk so the renderer needs no change.

import type { S3Client } from '@aws-sdk/client-s3';
import type { LocalFsScreenshotStore } from './LocalFsScreenshotStore.js';

export function localStoreAsS3Reader(store: LocalFsScreenshotStore): S3Client {
  const reader = {
    async send(command: { input?: { Key?: string } }): Promise<{ Body: { transformToByteArray(): Promise<Uint8Array> } }> {
      const key = command.input?.Key;
      const bytes = key ? await store.fetchScreenshot(key) : null;
      if (!bytes) {
        const err = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }
      return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
    },
  };
  return reader as unknown as S3Client;
}
