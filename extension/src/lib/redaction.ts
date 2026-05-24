/**
 * Client-side PII redaction (task 37.1, Requirement 45.1).
 *
 * Walks the live DOM and returns a list of `BoundingBox` rects that the
 * server's screenshot-upload route (`POST /api/v1/annotations/:id/screenshot`)
 * Gaussian-blurs over the captured PNG before persisting it to object
 * storage (task 37.2). The redaction predicate matches:
 *
 *   - `<input type="password">`
 *   - `<input>` whose `autocomplete` attribute starts with `cc-`
 *     (e.g. `cc-number`, `cc-csc`, `cc-exp` per the WHATWG autofill spec)
 *   - any element carrying the `data-fl-redact` opt-in attribute
 *   - any element whose `aria-label` matches a caller-supplied regex
 *     (the configured "PII labels" list lives in the extension options
 *     page; this module accepts it as input so it can be unit-tested
 *     without touching `chrome.storage.sync`)
 *
 * Elements (or any ancestor) carrying `data-fl-no-redact` are skipped —
 * site authors use that attribute to opt subtrees out (Requirement 45.2,
 * task 37.3). The opt-out is implemented via `closest('[data-fl-no-redact]')`
 * so wrapping a subtree in a single ancestor with the attribute opts the
 * whole subtree out in one place. The hook is documented for site
 * authors in `extension/README.md` under "PII Redaction & Opt-Out".
 *
 * Coordinates are emitted in **device pixels** so they line up with the
 * `chrome.tabs.captureVisibleTab` PNG, which is rendered at the device
 * pixel density (`window.devicePixelRatio`). The server applies the blur
 * over those exact pixel coordinates.
 *
 * Implements: Requirements 45.1, 45.2; Tasks 37.1, 37.3.
 */

/**
 * Bounding box used for client → server PII redaction. Coordinates are
 * **integer device pixels** measured from the top-left of the captured
 * screenshot (which is the top-left of the visible viewport, scaled by
 * `window.devicePixelRatio`).
 *
 * Note the abbreviated `w`/`h` field names: they match the in-extension
 * convention. The server's redaction validator expects the canonical
 * `{ x, y, width, height }` shape, so callers serialising to the wire
 * format MUST go through {@link serializeRedactionRects} which renames
 * the fields. Keeping the in-memory and wire shapes separate prevents a
 * hand-written `JSON.stringify(rects)` from silently shipping the wrong
 * keys to the server.
 */
export type BoundingBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * Optional inputs to {@link computeRedactionRects}. Currently a single
 * field — the configured PII aria-label regex. Held in an options bag so
 * task 37.4 ("configured PII labels list with the supplied regex") can
 * flow through additional knobs (e.g. an extra-selectors list) without
 * a breaking signature change.
 */
export interface ComputeRedactionRectsOptions {
  /**
   * Optional regex tested against each element's `aria-label`. When
   * undefined the aria-label predicate is skipped entirely — there is
   * no implicit default so the per-host configuration (or a sensible
   * caller-supplied regex like `/password|credit\s*card|cvv|ssn/i`)
   * is the single source of truth for which labels are sensitive.
   */
  ariaLabelRegex?: RegExp;
}

/**
 * Compute the array of {@link BoundingBox} rects to send alongside the
 * screenshot upload. Pure: no side effects, no DOM mutations.
 *
 * The function:
 *   1. Collects candidate elements via `querySelectorAll` for each
 *      branch of the redaction predicate.
 *   2. Drops elements that themselves (or any ancestor) match
 *      `[data-fl-no-redact]` — the opt-out hook from Req 45.2.
 *   3. Reads each element's `getBoundingClientRect()` and rounds the
 *      coordinates to integer device-pixel space using
 *      `window.devicePixelRatio`. The server applies the Gaussian blur
 *      over those exact pixels, so they MUST match the captured PNG's
 *      coordinate system (which is `viewport-px * devicePixelRatio`).
 *   4. Filters out invisible elements: zero width, zero height, or not
 *      currently part of the document tree (`isConnected === false`).
 *
 * Duplicate elements (an `<input type="password" data-fl-redact>` would
 * match both the password and the data-attribute branches) are
 * de-duplicated so the server never blurs the same pixels twice.
 *
 * @param root  The Document to scan. Defaults to the global `document`
 *              so callers from a content script just say
 *              `computeRedactionRects()`. Tests pass an injected
 *              `Document` so they can drive the function in jsdom
 *              without polluting the shared DOM.
 * @param opts  See {@link ComputeRedactionRectsOptions}.
 * @returns     A possibly-empty array of bounding boxes in device-pixel
 *              coordinates. Empty when no element matches the predicate
 *              — the common no-PII path.
 */
export function computeRedactionRects(
  root: Document = document,
  opts: ComputeRedactionRectsOptions = {},
): BoundingBox[] {
  // Resolve the device pixel ratio from the document's owning window
  // (so an injected `Document` from a different realm uses ITS dpr,
  // not the test runner's). Falls back to the worker-global
  // `devicePixelRatio` when present, and finally to 1 — the common
  // assumption on a non-Retina display and in jsdom.
  const win = root.defaultView ?? null;
  const winDpr =
    win && typeof win.devicePixelRatio === 'number' && Number.isFinite(win.devicePixelRatio)
      ? win.devicePixelRatio
      : null;
  const globalDpr =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio === 'number'
      ? ((globalThis as { devicePixelRatio: number }).devicePixelRatio)
      : null;
  const dpr = winDpr ?? globalDpr ?? 1;
  // Guard against zero / NaN / negative — clamp to 1 so we never emit
  // negative-pixel rects no matter what the platform reports.
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  /**
   * Set-backed dedupe so an element matched by multiple branches of the
   * predicate (e.g. `<input type="password" data-fl-redact>`) only
   * yields one rect.
   */
  const seen = new Set<Element>();
  const out: BoundingBox[] = [];

  const candidates: Element[] = [];

  // 1) Password inputs.
  for (const el of Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  )) {
    candidates.push(el);
  }

  // 2) Credit-card autofill inputs. The HTML autofill spec lists
  //    `cc-name`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`,
  //    `cc-exp-year`, `cc-type`, etc. We blur all of them — the leading
  //    `cc-` prefix is the canonical sigil.
  for (const el of Array.from(
    root.querySelectorAll<HTMLInputElement>('input[autocomplete^="cc-"]'),
  )) {
    candidates.push(el);
  }

  // 3) Explicit opt-in attribute. Any element — not just inputs.
  for (const el of Array.from(root.querySelectorAll('[data-fl-redact]'))) {
    candidates.push(el);
  }

  // 4) aria-label regex match. Only run when a regex was supplied; we do
  //    NOT default to a baked-in pattern because the per-host
  //    configuration (Req 45.1) is the single source of truth.
  if (opts.ariaLabelRegex) {
    const re = opts.ariaLabelRegex;
    for (const el of Array.from(root.querySelectorAll<Element>('[aria-label]'))) {
      const label = el.getAttribute('aria-label');
      if (label !== null && re.test(label)) {
        candidates.push(el);
      }
    }
  }

  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);

    // `data-fl-no-redact` opt-out (Req 45.2 / task 37.3 hook). `closest`
    // walks the element itself and all ancestors, so wrapping a subtree
    // in `<div data-fl-no-redact>...` opts the whole subtree out — the
    // ergonomic affordance the requirement calls for.
    if (el.closest('[data-fl-no-redact]')) continue;

    // Visibility filter. `getBoundingClientRect` returns a zero-rect for
    // `display: none`, detached, or never-laid-out elements, which is
    // exactly the "not in layout" signal we want.
    if (!el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (
      !rect ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue;
    }

    out.push({
      x: Math.round(rect.left * safeDpr),
      y: Math.round(rect.top * safeDpr),
      w: Math.round(rect.width * safeDpr),
      h: Math.round(rect.height * safeDpr),
    });
  }

  return out;
}

/**
 * Serialise an array of {@link BoundingBox} rects into the JSON shape
 * the server's `redactionRects` validator expects:
 *
 *   `[{ x, y, width, height }, ...]`
 *
 * The in-memory `w`/`h` field names (chosen to keep call-sites compact)
 * are renamed to `width`/`height` here. Always use this helper instead
 * of `JSON.stringify(rects)` so the wire format stays in sync.
 *
 * Returns `'[]'` for an empty array, matching the server's no-blur fast
 * path (task 37.2).
 */
export function serializeRedactionRects(rects: readonly BoundingBox[]): string {
  return JSON.stringify(
    rects.map((r) => ({
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
    })),
  );
}
