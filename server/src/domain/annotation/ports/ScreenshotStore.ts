// ScreenshotStore outbound port (Phase 1.5 / task 4.6.2).
//
// Persists and retrieves screenshot PNGs (and the sibling Markup_Document
// JSON) for annotations. The S3 adapter is the only file in the codebase
// that imports `@aws-sdk/client-s3`.

export interface UploadScreenshotInput {
  annotationId: string;
  body: Buffer;
  contentType: string;
}

export interface UploadScreenshotResult {
  /** S3 object key of the persisted PNG. */
  objectKey: string;
  /** Publicly addressable URL for the PNG. */
  url: string;
}

export interface UploadMarkupInput {
  /** Object key of the screenshot the markup is layered on top of. */
  screenshotKey: string;
  /** Markup_Document JSON (caller has already validated the shape). */
  markupDocument: unknown;
}

export interface UploadMarkupResult {
  objectKey: string;
  url: string;
}

export interface ScreenshotStore {
  uploadScreenshot(input: UploadScreenshotInput): Promise<UploadScreenshotResult>;
  buildScreenshotUrl(objectKey: string): string;

  uploadMarkupDocument(input: UploadMarkupInput): Promise<UploadMarkupResult>;
  fetchMarkupDocument(screenshotKey: string): Promise<unknown | null>;
}
