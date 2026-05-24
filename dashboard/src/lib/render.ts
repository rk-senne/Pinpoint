/**
 * Render helpers for the post-React Dashboard.
 *
 * The Dashboard composes UI by cloning HTML `<template>` elements and binding
 * a small number of named slots and actions back to TypeScript. These helpers
 * are the only place those conventions live.
 *
 * Conventions:
 *   - `<template id="...">`  — declares a reusable fragment in `index.html`.
 *   - `data-slot="name"`     — element whose content is filled from
 *                              `cloneTemplate`'s `slots` argument.
 *   - `data-action="name"`   — element whose default user event (click) maps
 *                              to a handler in `bindEvents`. The shorthand
 *                              `event:name` (e.g. `submit:save`) lets a slot
 *                              listen on a different DOM event.
 *
 * Requirements: 31.1
 */

/**
 * Clone the contents of a `<template>` element and optionally fill `data-slot`
 * placeholders.
 *
 * @param id     The id of the `<template>` element in the document.
 * @param slots  Optional map of slot name → string (becomes `textContent`) or
 *               `Node` (replaces the slot's children, used as-is, not cloned).
 * @returns      A `DocumentFragment` containing the cloned, filled markup.
 *               Append it to the DOM with `parent.appendChild(fragment)` or
 *               capture `firstElementChild` for further wiring.
 *
 * Throws when no `<template>` with the given id exists. Slot names that have
 * no matching `data-slot` element are silently ignored so templates can omit
 * optional slots.
 */
export function cloneTemplate(
  id: string,
  slots?: Record<string, string | Node>,
): DocumentFragment {
  const tpl = document.getElementById(id);
  if (!(tpl instanceof HTMLTemplateElement)) {
    throw new Error(`cloneTemplate: no <template> element found with id "${id}"`);
  }

  const fragment = tpl.content.cloneNode(true) as DocumentFragment;

  if (slots) {
    for (const [name, value] of Object.entries(slots)) {
      const selector = `[data-slot="${cssEscapeAttr(name)}"]`;
      const targets = fragment.querySelectorAll(selector);
      for (const target of Array.from(targets)) {
        if (typeof value === 'string') {
          target.textContent = value;
        } else {
          // Node is used as-is. Callers passing the same Node into multiple
          // slots should clone it themselves — DOM semantics will move the
          // node from the first slot to the second otherwise.
          target.replaceChildren(value);
        }
      }
    }
  }

  return fragment;
}

/**
 * Wire `data-action` attributes on `root` (and its descendants) to handlers.
 *
 * The default event is `click`. To bind a different event, prefix the action
 * with `event:`, e.g. `data-action="submit:save"` invokes `handlers.save` on
 * the `submit` event.
 *
 * Elements whose action name has no corresponding handler are skipped, so a
 * template can declare actions that only some screens implement.
 *
 * @returns A cleanup function that removes every listener added by this call.
 *          Useful when re-rendering — call cleanup before discarding the old
 *          DOM to avoid leaks.
 */
export function bindEvents(
  root: Element,
  handlers: Record<string, (e: Event) => void>,
): () => void {
  const cleanups: Array<() => void> = [];

  const candidates: Element[] = [];
  if (root.hasAttribute('data-action')) {
    candidates.push(root);
  }
  candidates.push(...Array.from(root.querySelectorAll('[data-action]')));

  for (const el of candidates) {
    const raw = el.getAttribute('data-action');
    if (!raw) continue;

    const { eventType, name } = parseActionAttr(raw);
    const handler = handlers[name];
    if (!handler) continue;

    el.addEventListener(eventType, handler);
    cleanups.push(() => el.removeEventListener(eventType, handler));
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Append a `DocumentFragment`'s children into `parent` in document order.
 *
 * Thin wrapper around `parent.appendChild(fragment)` that gives call sites a
 * verb that pairs with `cloneTemplate`. After this call the fragment is empty
 * — its children have been moved (not cloned) into `parent`, matching native
 * `appendChild` semantics for `DocumentFragment`.
 */
export function mount(parent: Node, fragment: DocumentFragment): void {
  parent.appendChild(fragment);
}

/**
 * Subscribe a DOM update to a `Signal<T>`. Whenever the signal fires (including
 * the immediate initial fire from `subscribe`) `updater(host, value)` runs.
 *
 * Returns the unsubscribe function from the underlying signal so callers can
 * tear the binding down when the host element is removed from the DOM (or when
 * a screen unmounts and re-renders).
 *
 * The signal type is intentionally structural — any object exposing the same
 * `subscribe` shape as `@pinpoint/shared/signal` works, which keeps this
 * module independent of the shared package wiring.
 */
export function bind<T>(
  host: Element,
  signal: SignalLike<T>,
  updater: (host: Element, value: T) => void,
): () => void {
  return signal.subscribe((value) => updater(host, value));
}

/**
 * Set an element's text content. Identical to `node.textContent = value` but
 * gives call sites a uniform vocabulary alongside `attr`.
 */
export function text(node: Element, value: string): void {
  node.textContent = value;
}

/**
 * Set an attribute on an element. A thin wrapper around `setAttribute` that
 * matches the verb-style of `text` for legibility at call sites.
 */
export function attr(node: Element, name: string, value: string): void {
  node.setAttribute(name, value);
}

// ---------------------------------------------------------------------------
// template lookup helpers
// ---------------------------------------------------------------------------
//
// Pages and components share the same three lookup conventions:
//   - `data-section="name"` for top-level layout regions toggled by hidden
//   - `data-role="name"`    for refs the page wires up (inputs, buttons)
//   - `data-slot="name"`    for fillable slots (filled by `cloneTemplate`)
//
// These helpers throw a clear error when the expected attribute is missing
// instead of silently returning null. Centralised here so every page module
// gets the same message format and behaviour.

/**
 * Find a `[data-section="name"]` element under `root`. Throws when no such
 * element exists or when it is not an `HTMLElement`.
 */
export function requireSection(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector(`[data-section="${name}"]`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Template is missing the "${name}" section`);
  }
  return el;
}

/**
 * Find a `[data-role="name"]` element under `root`. Throws when no such
 * element exists or when it is not an `HTMLElement`.
 */
export function requireRole(root: ParentNode, role: string): HTMLElement {
  const el = root.querySelector(`[data-role="${role}"]`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Template is missing [data-role="${role}"]`);
  }
  return el;
}

/**
 * Find a `[data-slot="name"]` element under `root`. Throws when no such
 * element exists or when it is not an `HTMLElement`.
 */
export function requireSlot(root: ParentNode, slot: string): HTMLElement {
  const el = root.querySelector(`[data-slot="${slot}"]`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Template is missing [data-slot="${slot}"]`);
  }
  return el;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Structural shape `bind` accepts. Compatible with `Signal<T>` from
 * `@pinpoint/shared/signal` — `subscribe` fires once with the current
 * value and returns an unsubscribe function. Declared locally so the dashboard
 * does not need a build-time import path into the shared package.
 */
export interface SignalLike<T> {
  subscribe(listener: (value: T) => void): () => void;
}

function parseActionAttr(raw: string): { eventType: string; name: string } {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    return { eventType: 'click', name: raw };
  }
  return { eventType: raw.slice(0, colon), name: raw.slice(colon + 1) };
}

/**
 * Escape a value for safe interpolation inside a `[data-slot="..."]` selector.
 * Falls back to a manual escape when `CSS.escape` is unavailable so the helper
 * works in older test environments.
 */
function cssEscapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
