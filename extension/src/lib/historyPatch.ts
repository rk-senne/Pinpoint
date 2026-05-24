/**
 * historyPatch — observe SPA navigation in the host page.
 *
 * Per task 29.1 of the pinpoint-app spec (Requirement 38.1): the
 * content script needs to know when the host page changes URL via
 * `history.pushState`, `history.replaceState`, or the browser's back /
 * forward buttons (`popstate`). Neither method emits a built-in event,
 * so we monkey-patch them on the page's `History` prototype object and
 * dispatch a single `pinpoint:locationchange` `CustomEvent` on
 * `window` with `detail: { url: location.href }`.
 *
 * Listeners (added by task 29.3) re-resolve the active project. This
 * module deliberately does not perform that re-resolution itself — it
 * only emits the signal.
 *
 * The patch is idempotent: a sentinel flag on `window` ensures repeated
 * calls (HMR, double script injection) do not stack patches and emit
 * the event multiple times per navigation.
 *
 * Implements: Requirement 38.1.
 */

/** Name of the custom event emitted on every SPA navigation. */
export const LOCATION_CHANGE_EVENT = 'pinpoint:locationchange';

/** Detail payload attached to the `pinpoint:locationchange` event. */
export interface LocationChangeDetail {
  readonly url: string;
}

/** Sentinel key used to make `installHistoryPatch` idempotent. */
const INSTALLED_FLAG = '__pinpointHistoryPatchInstalled__';

interface PatchedWindow extends Window {
  [INSTALLED_FLAG]?: boolean;
}

/**
 * Patch `history.pushState` / `history.replaceState` and forward
 * `popstate` events as `pinpoint:locationchange` `CustomEvent`s.
 *
 * Safe to call multiple times — only the first call patches `history`;
 * subsequent calls are a no-op so we never stack wrappers and never
 * emit duplicate events for a single navigation.
 */
export function installHistoryPatch(target: Window = window): void {
  const patchedWindow = target as PatchedWindow;
  if (patchedWindow[INSTALLED_FLAG]) return;
  patchedWindow[INSTALLED_FLAG] = true;

  const history = target.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;

  const dispatchLocationChange = (): void => {
    target.dispatchEvent(
      new CustomEvent<LocationChangeDetail>(LOCATION_CHANGE_EVENT, {
        detail: { url: target.location.href },
      }),
    );
  };

  history.pushState = function patchedPushState(
    ...args: Parameters<typeof history.pushState>
  ): ReturnType<typeof history.pushState> {
    const result = originalPush.apply(this, args);
    dispatchLocationChange();
    return result;
  };

  history.replaceState = function patchedReplaceState(
    ...args: Parameters<typeof history.replaceState>
  ): ReturnType<typeof history.replaceState> {
    const result = originalReplace.apply(this, args);
    dispatchLocationChange();
    return result;
  };

  target.addEventListener('popstate', () => {
    dispatchLocationChange();
  });
}
