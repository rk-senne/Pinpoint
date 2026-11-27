// ScreenshotEraser port — deletes screenshot objects (and their sibling
// Markup_Document) from the screenshot store when an organisation or account
// is erased. Kept separate from the `ScreenshotStore` read/write port so the
// privacy feature does not widen the upload/serve surface.

export interface ScreenshotEraseResult {
  /** Keys the store confirmed gone (or that did not exist). */
  deleted: number;
  /** Keys that could not be deleted; the caller reports them for follow-up. */
  failed: string[];
}

export interface ScreenshotEraser {
  /** Delete the screenshot objects and their `<key>.markup.json` siblings. Never throws for per-key failures. */
  deleteScreenshots(objectKeys: readonly string[]): Promise<ScreenshotEraseResult>;
}
