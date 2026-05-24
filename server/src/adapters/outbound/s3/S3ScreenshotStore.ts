// S3ScreenshotStore — outbound adapter for the `ScreenshotStore` port
// (Phase 1.5 / task 4.8.2).
//
// Persists annotation screenshots and their sibling Markup_Document JSON
// blobs to an S3-compatible bucket. This file is the **only** place in
// the codebase allowed to import `@aws-sdk/client-s3`; everything else
// depends on the `ScreenshotStore` interface declared under
// `domain/annotation/ports/`.
//
// The adapter is configuration-driven so the same code path serves
// production AWS S3 and the local MinIO container used for development
// and tests. The `S3Client` instance is injected — there is no module
// state and no env access in this file. The composition root
// (`server/src/composition/container.ts`) is responsible for reading
// env vars and constructing the client + config.
//
// Server-side Gaussian blur over `redactionRects` (Req 45.1 / Task 37.2)
// is **not** applied here. The port's `UploadScreenshotInput` does not
// expose a rects field; the use case in `domain/annotation/...` calls
// the redaction service before invoking this adapter, so the bytes that
// reach `uploadScreenshot` are already redacted. Keeping the blur out
// of the adapter preserves the "no business logic in adapters" rule.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import crypto from 'crypto';
import type {
  ScreenshotStore,
  UploadScreenshotInput,
  UploadScreenshotResult,
  UploadMarkupInput,
  UploadMarkupResult,
} from '../../../domain/annotation/ports/ScreenshotStore.js';

export interface S3ScreenshotStoreConfig {
  /** Bucket the adapter reads from and writes to. */
  bucket: string;
  /** AWS region used when synthesizing virtual-hosted URLs. */
  region: string;
  /** Optional custom endpoint (MinIO, LocalStack, etc.). */
  endpoint?: string;
  /** Use path-style URLs (`<endpoint>/<bucket>/<key>`). Required for MinIO. */
  forcePathStyle?: boolean;
  /**
   * Optional public base URL. When set, screenshot URLs are built as
   * `<publicBaseUrl>/<key>` so a CDN can be fronted in front of the
   * bucket without changing the persisted key.
   */
  publicBaseUrl?: string;
  /** Object-key prefix. Defaults to `annotations/screenshots`. */
  keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = 'annotations/screenshots';
const MARKUP_KEY_SUFFIX = '.markup.json';

export class S3ScreenshotStore implements ScreenshotStore {
  constructor(
    private readonly client: S3Client,
    private readonly config: S3ScreenshotStoreConfig,
  ) {}

  async uploadScreenshot(
    input: UploadScreenshotInput,
  ): Promise<UploadScreenshotResult> {
    const objectKey = this.buildScreenshotKey(input.annotationId);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );

    return { objectKey, url: this.buildScreenshotUrl(objectKey) };
  }

  buildScreenshotUrl(objectKey: string): string {
    const publicBase = this.config.publicBaseUrl;
    if (publicBase) {
      const trimmed = publicBase.replace(/\/+$/, '');
      return `${trimmed}/${objectKey}`;
    }

    if (this.config.forcePathStyle && this.config.endpoint) {
      const endpoint = this.config.endpoint.replace(/\/+$/, '');
      return `${endpoint}/${this.config.bucket}/${objectKey}`;
    }

    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${objectKey}`;
  }

  async uploadMarkupDocument(
    input: UploadMarkupInput,
  ): Promise<UploadMarkupResult> {
    const objectKey = this.buildMarkupKey(input.screenshotKey);
    const body = Buffer.from(JSON.stringify(input.markupDocument), 'utf8');

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: body,
        ContentType: 'application/json',
      }),
    );

    return { objectKey, url: this.buildScreenshotUrl(objectKey) };
  }

  async fetchMarkupDocument(screenshotKey: string): Promise<unknown | null> {
    const objectKey = this.buildMarkupKey(screenshotKey);

    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
        }),
      );
      const body = result.Body;
      if (!body) return null;

      // The AWS SDK for Node returns a Readable for `GetObject.Body`. Use
      // its `transformToString` helper when available (SDK v3 ≥ 3.300) and
      // fall back to manual chunk concat for older shims / S3-compatible
      // backends that do not implement the helper.
      let text: string;
      const maybeHelper = body as {
        transformToString?: (encoding?: string) => Promise<string>;
      };
      if (typeof maybeHelper.transformToString === 'function') {
        text = await maybeHelper.transformToString('utf-8');
      } else {
        const chunks: Buffer[] = [];
        const stream = body as NodeJS.ReadableStream;
        for await (const chunk of stream) {
          chunks.push(
            typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk),
          );
        }
        text = Buffer.concat(chunks).toString('utf-8');
      }

      if (text.length === 0) return null;
      return JSON.parse(text);
    } catch (err) {
      // Treat any "no such key"/"not found" surface as a missing markup
      // so callers can return 404 cleanly. The S3 SDK is inconsistent
      // across versions / S3-compatible backends about which exception
      // is raised, so we match on the most common shapes rather than a
      // single class.
      const e = err as {
        name?: string;
        Code?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        e?.name === 'NoSuchKey' ||
        e?.Code === 'NoSuchKey' ||
        e?.name === 'NotFound' ||
        e?.$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  // --- key helpers -----------------------------------------------------

  /**
   * Build the deterministic-but-unique S3 object key for an annotation's
   * screenshot. The random suffix prevents a re-upload (e.g., the user
   * retakes a screenshot) from silently overwriting a previous version
   * that may still be referenced by an exported PDF.
   */
  private buildScreenshotKey(annotationId: string): string {
    const prefix = this.config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    const suffix = crypto.randomBytes(8).toString('hex');
    return `${prefix}/${annotationId}/${suffix}.png`;
  }

  /**
   * Sibling key convention (Req 35.2): `<screenshot_object_key>.markup.json`
   * so a viewer that has only the screenshot key can derive the markup
   * key without an extra database round-trip.
   */
  private buildMarkupKey(screenshotKey: string): string {
    return `${screenshotKey}${MARKUP_KEY_SUFFIX}`;
  }
}
