// FakeScreenshotStore — in-memory ScreenshotStore fake
// (Phase 1.5 / task 4.11.1).
//
// Stores buffers in a Map keyed by `objectKey`. `uploadScreenshot`
// returns a synthetic `objectKey` derived from the annotation id and an
// incrementing counter so multiple uploads for the same annotation get
// distinct keys (mirrors the random-suffix strategy in S3ScreenshotStore
// while remaining deterministic).

import type {
  ScreenshotStore,
  UploadMarkupInput,
  UploadMarkupResult,
  UploadScreenshotInput,
  UploadScreenshotResult,
} from '../../domain/annotation/ports/ScreenshotStore.js';

const DEFAULT_KEY_PREFIX = 'annotations/screenshots';
const MARKUP_KEY_SUFFIX = '.markup.json';
const URL_BASE = 'https://fake-screenshots.test';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

export class FakeScreenshotStore implements ScreenshotStore {
  /** Public for direct inspection in tests; key → object. */
  readonly objects = new Map<string, StoredObject>();
  private counter = 0;

  async uploadScreenshot(
    input: UploadScreenshotInput,
  ): Promise<UploadScreenshotResult> {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(8, '0');
    const objectKey = `${DEFAULT_KEY_PREFIX}/${input.annotationId}/${suffix}.png`;

    this.objects.set(objectKey, {
      body: Buffer.from(input.body),
      contentType: input.contentType,
    });

    return { objectKey, url: this.buildScreenshotUrl(objectKey) };
  }

  buildScreenshotUrl(objectKey: string): string {
    return `${URL_BASE}/${objectKey}`;
  }

  async uploadMarkupDocument(
    input: UploadMarkupInput,
  ): Promise<UploadMarkupResult> {
    const objectKey = `${input.screenshotKey}${MARKUP_KEY_SUFFIX}`;
    this.objects.set(objectKey, {
      body: Buffer.from(JSON.stringify(input.markupDocument), 'utf8'),
      contentType: 'application/json',
    });
    return { objectKey, url: this.buildScreenshotUrl(objectKey) };
  }

  async fetchMarkupDocument(screenshotKey: string): Promise<unknown | null> {
    const objectKey = `${screenshotKey}${MARKUP_KEY_SUFFIX}`;
    const stored = this.objects.get(objectKey);
    if (!stored) return null;
    try {
      return JSON.parse(stored.body.toString('utf8'));
    } catch {
      return null;
    }
  }
}
