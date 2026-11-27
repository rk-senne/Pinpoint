// ScreenshotEraser adapters (local disk + S3-compatible) for the privacy
// erasure use cases. Each deletes the PNG and its sibling `<key>.markup.json`.
// Per-key failures are collected, never thrown: the database erasure has
// already committed, so the operator must be told which objects remain.

import { promises as fs } from 'node:fs';
import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';

import type { ScreenshotEraseResult, ScreenshotEraser } from '../../../domain/privacy/ports/ScreenshotEraser.js';

const MARKUP_SUFFIX = '.markup.json';

export interface LocalKeyResolver {
  /** Absolute path for a safe object key; throws for unsafe keys. */
  resolveKeyPath(objectKey: string): string;
}

export class LocalFsScreenshotEraser implements ScreenshotEraser {
  constructor(private readonly store: LocalKeyResolver) {}

  async deleteScreenshots(objectKeys: readonly string[]): Promise<ScreenshotEraseResult> {
    let deleted = 0;
    const failed: string[] = [];
    for (const key of objectKeys) {
      try {
        // `force` makes a missing file a success (already gone).
        await fs.rm(this.store.resolveKeyPath(key), { force: true });
        await fs.rm(this.store.resolveKeyPath(`${key}${MARKUP_SUFFIX}`), { force: true });
        deleted += 1;
      } catch {
        failed.push(key);
      }
    }
    return { deleted, failed };
  }
}

export class S3ScreenshotEraser implements ScreenshotEraser {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly bucket: string,
  ) {}

  async deleteScreenshots(objectKeys: readonly string[]): Promise<ScreenshotEraseResult> {
    const keys = objectKeys.flatMap((k) => [k, `${k}${MARKUP_SUFFIX}`]);
    const failedKeys = new Set<string>();
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      try {
        const out = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        for (const e of out.Errors ?? []) if (e.Key) failedKeys.add(e.Key);
      } catch {
        for (const k of chunk) failedKeys.add(k);
      }
    }
    // A screenshot counts as failed when either object failed.
    const failed = objectKeys.filter((k) => failedKeys.has(k) || failedKeys.has(`${k}${MARKUP_SUFFIX}`));
    return { deleted: objectKeys.length - failed.length, failed };
  }
}
