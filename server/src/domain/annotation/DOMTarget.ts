// DOMTarget value object (Phase 1.5 / task 4.6.1).
//
// Captures the click target on the live page so the Extension overlay can
// re-anchor the pin on subsequent visits. Mirrors the wire shape exported
// from `@pinpoint/shared` but lives in the domain layer so use cases
// can depend on it without pulling the shared schema package.

export interface DOMTarget {
  cssSelector: string;
  xpath: string;
  pageX: number;
  pageY: number;
  tagName: string;
  /** First 100 chars of the element's text content; truncated by the extension. */
  textSnippet: string;
}
