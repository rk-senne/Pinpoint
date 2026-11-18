// Pure DOM/format helpers used by <fl-popover> (extracted from Popover.ts).

import type { CapturedConsoleEntry, CapturedNetworkEntry, EnvironmentMetadata } from '@pinpoint/shared';

/**
 * Derive an initial-bubble label (1–2 chars) from a user id when the
 * popover does not have a member-name lookup. Falls back to "?" for empty
 * input. The host wires the proper initials via the same `viewers`
 * setter once it has the member directory loaded; this helper exists so
 * the popover stays useful with raw user ids during early load.
 */
export function initialsFromId(id: string): string {
  if (!id) return '?';
  const trimmed = id.trim();
  if (!trimmed) return '?';
  // Favor the leading two alphanumerics so a UUID like
  // `a1b2c3d4-5678-…` renders as `A1`.
  const match = trimmed.match(/[a-zA-Z0-9]{1,2}/);
  return (match ? match[0] : trimmed.slice(0, 2)).toUpperCase();
}

/**
 * Format a `(family, version)` pair from `EnvironmentMetadata` for the
 * create-mode "Will attach" badge (task 19.2). Drops the family entirely
 * when it is the literal string `unknown` so the badge stays useful in
 * environments where Bowser couldn't classify the UA. Appends the
 * version with a leading space when present (e.g. `Chrome 124.0.6367.91`,
 * `macOS`).
 */
export function formatFamilyAndVersion(family: string, version: string | null): string {
  if (!family || family === 'unknown') return '';
  if (version && version.length > 0) return `${family} ${version}`;
  return family;
}

/**
 * Build a `<li>` row for a captured console entry (Req 36.3, task 27.4).
 * Format: `[level] timestamp — message` with the stack folded into a
 * nested `<details>` when present so a noisy stack does not dominate the
 * popover. The level pill is colored via `data-level` so error / warn
 * pop visually without bloating the row.
 */
export function renderConsoleEntry(entry: CapturedConsoleEntry): HTMLLIElement {
  const li = document.createElement('li');
  const level = document.createElement('span');
  level.className = 'fl-capture-console-level';
  level.dataset.level = entry.level;
  level.textContent = entry.level;
  const time = document.createElement('span');
  time.className = 'fl-capture-console-time';
  time.textContent = entry.timestamp;
  const message = document.createElement('span');
  message.className = 'fl-capture-console-message';
  message.textContent = ` — ${entry.message}`;
  li.appendChild(level);
  li.appendChild(time);
  li.appendChild(message);
  if (entry.stack && entry.stack.length > 0) {
    const stackDetails = document.createElement('details');
    stackDetails.className = 'fl-capture-console-stack';
    const stackSummary = document.createElement('summary');
    stackSummary.textContent = 'stack';
    const pre = document.createElement('pre');
    pre.textContent = entry.stack;
    stackDetails.appendChild(stackSummary);
    stackDetails.appendChild(pre);
    li.appendChild(stackDetails);
  }
  return li;
}

/**
 * Build a `<li>` row for a captured network entry (Req 36.3, task 27.4).
 * Format: `method? name (status, duration ms)` — the request method is
 * omitted when not present on the entry because `PerformanceObserver`
 * does not surface it on every Resource Timing record. Duration is
 * rounded to the nearest millisecond so the numbers stay readable.
 */
export function renderNetworkEntry(entry: CapturedNetworkEntry): HTMLLIElement {
  const li = document.createElement('li');
  const method = (entry as { method?: string }).method;
  if (method) {
    const methodEl = document.createElement('span');
    methodEl.className = 'fl-capture-network-method';
    methodEl.textContent = method;
    li.appendChild(methodEl);
  }
  const name = document.createElement('span');
  name.className = 'fl-capture-network-name';
  name.textContent = entry.name;
  li.appendChild(name);
  const meta = document.createElement('span');
  meta.className = 'fl-capture-network-status';
  const statusText =
    typeof entry.responseStatus === 'number' ? String(entry.responseStatus) : '—';
  if (typeof entry.responseStatus === 'number' && entry.responseStatus >= 400) {
    meta.dataset.bad = 'true';
  }
  const durationMs = Math.round(entry.duration);
  meta.textContent = ` (${statusText}, ${durationMs} ms)`;
  li.appendChild(meta);
  return li;
}

/**
 * Walk down through every open shadow root to find the truly-focused
 * leaf element. `document.activeElement` only surfaces the shallowest
 * host when focus is inside a shadow tree, so a popover anchored to a
 * Custom Element on the page would otherwise capture the host element
 * instead of the inner `<input>` or `<button>` the user was actually on.
 *
 * Returns `null` when no element has focus (e.g. focus is on
 * `document.body`) — callers fall back to a sensible default in that
 * case (Req 42.3 / task 33.3).
 */
export function deepActiveElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let current: Element | null = document.activeElement;
  // The browser parks focus on <body> when nothing else has it; treat
  // that the same as "no previous focus" so we restore to the toolbar /
  // body fallback rather than re-focusing <body> only to lose it again.
  if (!current || current === document.body || current === document.documentElement) {
    return null;
  }
  while (current && (current as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
    const inner: Element | null = (current as Element & { shadowRoot: ShadowRoot }).shadowRoot.activeElement;
    if (!inner) break;
    current = inner;
  }
  return current instanceof HTMLElement ? current : null;
}

/**
 * Decide whether `el` is a viable focus target on popover close
 * (Req 42.3 / task 33.3). The element must (a) still be connected to a
 * document, (b) expose a callable `focus()` method, and (c) not be a
 * disabled form control. Hidden / `display:none` ancestors are not
 * checked here because the browser silently no-ops `focus()` on them
 * and we want to fall through to the body/toolbar fallback rather than
 * silently land focus where no caret is visible.
 */
export function isFocusable(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false;
  if (typeof el.focus !== 'function') return false;
  if (!el.isConnected) return false;
  // Disabled form controls reject focus; querying `disabled` works for
  // <button>, <input>, <select>, <textarea>, <fieldset> in lib.dom.
  const maybeDisabled = el as HTMLElement & { disabled?: boolean };
  if (maybeDisabled.disabled === true) return false;
  return true;
}
