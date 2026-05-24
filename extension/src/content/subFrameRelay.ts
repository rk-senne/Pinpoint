/**
 * Sub-frame click relay (task 40.2, Requirement 48.2).
 *
 * Background
 * ----------
 * The Extension's `content.ts` runs in every same-origin frame on the
 * page (manifest `all_frames: true`, task 40.1). The full
 * `<fl-overlay-host>` is mounted only in the top frame so we never end
 * up with duplicate UIs nested inside iframes. Sub-frames instead
 * register **only** this tiny click-relay: on user click, it computes
 * the click rect (translated into the parent frame's viewport
 * coordinates when possible) and `postMessage`s it to `window.parent`
 * so the top-frame overlay host can anchor a popover at the relayed
 * coordinates (task 40.3).
 *
 * Design notes
 * ------------
 *  - We register a **single** capture-phase `click` listener on the
 *    sub-frame's `document`. Capture phase is used so the relay sees
 *    the click even if a host page handler calls `stopPropagation` on
 *    the bubbling phase. Per the task description we relay every click
 *    rather than filtering on "annotatable" elements — keeping the
 *    sub-frame surface as small as possible. The top frame decides
 *    whether to act on the message.
 *
 *  - We compute the click target's `getBoundingClientRect()` in the
 *    sub-frame's viewport, then add `window.frameElement`'s offset
 *    when that element is reachable (i.e. the parent is same-origin).
 *    For cross-origin frames `frameElement` access throws, so we keep
 *    the local rect and let the top frame translate via the
 *    `MessageEvent.source` / `MessageEvent.origin` (task 40.3 / 40.4).
 *
 *  - We only post to **same-origin** parents. Cross-origin frames are
 *    skipped entirely — `installSubFrameRelay()` returns a no-op
 *    teardown (so callers can invoke it unconditionally) and never
 *    attaches a click listener. This is the **task 40.4 / Requirement
 *    48.3** implementation: a cross-origin frame contributes nothing to
 *    the overlay, neither click coordinates nor any UI. The top-frame
 *    `<fl-overlay-host>` listener (task 40.3) additionally validates
 *    `MessageEvent.origin` against `window.location.origin` as a
 *    defense-in-depth check, so even a misbehaving sender from another
 *    origin cannot drive the popover.
 *
 *  - We deliberately do NOT mount any UI, append nodes to `document`,
 *    or call any other content-script subsystems (Outbox, Syncer,
 *    OverlayHost). Sub-frames stay completely passive.
 *
 * The function returns a teardown handle so unit tests can detach the
 * listener cleanly between cases.
 */

/** Shape of the rect payload published in `pinpoint:subframe-click`. */
export interface SubFrameClickRect {
  /** X-coordinate of the rect, ideally in the parent frame's viewport. */
  x: number;
  /** Y-coordinate of the rect, ideally in the parent frame's viewport. */
  y: number;
  /** Click target width (CSS pixels). */
  w: number;
  /** Click target height (CSS pixels). */
  h: number;
}

/** Message envelope `postMessage`d to `window.parent` on every click. */
export interface SubFrameClickMessage {
  type: 'pinpoint:subframe-click';
  rect: SubFrameClickRect;
}

/** Constant used by the top-frame listener (task 40.3) to filter messages. */
export const SUBFRAME_CLICK_MESSAGE_TYPE = 'pinpoint:subframe-click';

/**
 * Dependencies the relay reads at install time. Defaults pull from the
 * ambient `document` / `window`; tests override them to drive specific
 * scenarios (cross-origin parent, missing `frameElement`, etc.) without
 * having to spin up real iframes inside jsdom.
 */
export interface SubFrameRelayDeps {
  /** Document the click listener is attached to. Defaults to `document`. */
  doc?: Document;
  /** Sub-frame `Window`. Defaults to `window`. */
  ownWindow?: Window;
  /**
   * Parent window the relay posts to. Defaults to `ownWindow.parent`
   * unless that strictly equals `ownWindow` (i.e. we are the top frame),
   * in which case the default is `null` and no listener is attached.
   */
  parentWindow?: Window | null;
  /**
   * The iframe element wrapping this sub-frame in the parent document.
   * Defaults to `ownWindow.frameElement`. May throw on access for
   * cross-origin parents — callers (and the default branch below) catch
   * the error and treat the value as `null` so the relay still works
   * with local-rect coordinates.
   */
  frameElement?: Element | null;
}

/**
 * Install the sub-frame click relay. Idempotent in the sense that
 * callers must invoke the returned teardown before installing again on
 * the same document; the function itself does not maintain any global
 * state.
 *
 * Returns a no-op teardown when the relay is intentionally skipped
 * (top frame, cross-origin parent) so callers can always invoke it
 * unconditionally without branching on the install result.
 */
export function installSubFrameRelay(
  deps: SubFrameRelayDeps = {},
): () => void {
  const ownWindow = deps.ownWindow ?? window;
  const doc = deps.doc ?? ownWindow.document;

  // Default: posting to the parent unless we are the top frame.
  let parent: Window | null;
  if (deps.parentWindow !== undefined) {
    parent = deps.parentWindow;
  } else {
    parent = ownWindow.parent === ownWindow ? null : ownWindow.parent;
  }
  if (!parent) return () => {};

  // Same-origin gate (task 40.4 / Requirement 48.3). Cross-origin
  // frames are skipped entirely so we never leak click coordinates to
  // an unrelated origin and so the cross-origin frame contributes
  // nothing to the overlay. Reading `parent.location.origin` throws a
  // `SecurityError` for cross-origin parents, which is exactly the
  // signal we want — we treat the throw as "not same origin" and
  // return a no-op teardown below. The top-frame `<fl-overlay-host>`
  // listener also re-validates `MessageEvent.origin` for
  // defense-in-depth.
  let sameOrigin = false;
  try {
    sameOrigin = parent.location.origin === ownWindow.location.origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return () => {};

  // `frameElement` is null for the top frame (already filtered above)
  // and throws on cross-origin access (also filtered above), so we
  // expect a usable element here on the happy path. Tests can override
  // via `deps.frameElement` to exercise the "no frame element" fallback.
  let frameElement: Element | null;
  if (deps.frameElement !== undefined) {
    frameElement = deps.frameElement;
  } else {
    try {
      frameElement = ownWindow.frameElement ?? null;
    } catch {
      frameElement = null;
    }
  }

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const local = target.getBoundingClientRect();
    let x = local.x;
    let y = local.y;

    // Translate into the parent frame's viewport coordinates when we
    // have a usable frame element. Otherwise post the local rect and
    // let the top frame fall back to translating via the postMessage
    // source (task 40.3).
    if (frameElement && typeof frameElement.getBoundingClientRect === 'function') {
      const frameRect = frameElement.getBoundingClientRect();
      x += frameRect.x;
      y += frameRect.y;
    }

    const message: SubFrameClickMessage = {
      type: SUBFRAME_CLICK_MESSAGE_TYPE,
      rect: { x, y, w: local.width, h: local.height },
    };

    try {
      parent!.postMessage(message, '*');
    } catch (err) {
      // postMessage shouldn't throw for same-origin targets, but if it
      // somehow does we must not break the host page.
      console.error('[pinpoint] subframe relay postMessage failed', err);
    }
  };

  doc.addEventListener('click', onClick, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
  };
}
