/**
 * `<fl-floating-toolbar>` — Web Component conversion of the React
 * `FloatingToolbar` (extension/src/components/FloatingToolbar.tsx).
 *
 * Per task 17.2 of the pinpoint-app spec (Requirements 31.2, 31.3):
 *   1. HTMLElement subclass with an open Shadow Root.
 *   2. Adopts the shared stylesheet via `adoptStyles()` (`adoptedStyleSheets`
 *      in browsers, `<style>` fallback under jsdom/older engines).
 *   3. Single `<template>` (close, avatar, share, link buttons) cloned in
 *      the constructor — no per-render string concatenation, no React.
 *   4. `connectedCallback` wires button click handlers; `disconnectedCallback`
 *      removes them so the element can be moved between Shadow Roots without
 *      leaking listeners.
 *   5. Each button dispatches a bubbling, composed `CustomEvent`:
 *        - close button → `close`
 *        - avatar button → `avatar`
 *        - share button → `share`
 *        - link button → `link`
 *      so listeners on the host or the document (outside the Shadow DOM) can
 *      react the same way they did to the React `onClose` / `onShare` /
 *      `onLink` props.
 *   6. `avatarUrl` is exposed as a property (and as a `data-avatar-url` host
 *      attribute) so consumers can mirror the legacy `avatarUrl` prop without
 *      worrying about reflective attribute parsing.
 *
 * Mirrors the shape of `<fl-annotation-pin>` and `<fl-mention-autocomplete>`:
 * `#`-private fields, idempotent `customElements.define()` guard so repeated
 * imports / HMR / test bootstraps do not throw "this name has already been
 * used".
 *
 * Implements: Requirements 31.2, 31.3.
 */
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';

/**
 * Single shared `<template>` cloned by every instance. The structural CSS
 * (the `.fl-toolbar` rules) lives in `sharedStyleSheet.ts` so the palette
 * comes from one place; this template only owns the markup.
 *
 * `role="toolbar"` and `aria-label="Pinpoint toolbar"` are set here
 * per design §28 "Accessibility" and the accompanying ARIA table in the
 * design doc:
 *   `<fl-floating-toolbar>` → role="toolbar"; Tab cycles buttons, Arrow
 *   keys move focus among buttons. Each child `<button>` carries its own
 *   `aria-label` so screen readers announce the action regardless of
 *   whether the icon glyph is read.
 *
 * Tabindex follows the **roving-tabindex** pattern (task 33.2 / Req 42.1):
 * exactly one button is in the tab order at any time (`tabindex="0"`), the
 * remainder hold `tabindex="-1"`. ArrowLeft / ArrowRight / Home / End move
 * focus and rotate the `0` to whichever button is active. The default tab
 * stop is the close button so a user landing on the toolbar via Tab can
 * reach the most common action with no extra keystrokes.
 */
const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <div
      class="fl-toolbar"
      part="toolbar"
      data-pinpoint="toolbar"
      role="toolbar"
      aria-label="Pinpoint toolbar"
    >
      <div
        class="fl-offline-banner"
        part="offline-banner"
        data-action="offline-banner"
        role="status"
        aria-live="polite"
        hidden
      >Offline — changes will sync when online</div>
      <button
        type="button"
        part="close"
        data-action="close"
        title="Close overlay"
        aria-label="Close overlay"
        tabindex="0"
      >✕</button>
      <button
        type="button"
        part="avatar"
        data-action="avatar"
        title="User"
        aria-label="User avatar"
        tabindex="-1"
      ><span class="fl-toolbar-avatar-fallback" aria-hidden="true">👤</span></button>
      <button
        type="button"
        part="share"
        data-action="share"
        title="Share"
        aria-label="Share project"
        tabindex="-1"
      >🔗</button>
      <button
        type="button"
        part="link"
        data-action="link"
        title="Copy link"
        aria-label="Copy page link"
        tabindex="-1"
      >📋</button>
    </div>
  `;
  return t;
})();

/**
 * The four button actions emitted as CustomEvent type names. Used both
 * as the runtime type of `#dispatch`'s argument and as a type-level union
 * documenting which event names this element produces.
 */
type FloatingToolbarAction = 'close' | 'avatar' | 'share' | 'link';

export class FlFloatingToolbar extends HTMLElement {
  static readonly tagName = 'fl-floating-toolbar';

  #avatarUrl: string | null = null;
  #isOffline: boolean = false;
  #closeBtn!: HTMLButtonElement;
  #avatarBtn!: HTMLButtonElement;
  #shareBtn!: HTMLButtonElement;
  #linkBtn!: HTMLButtonElement;
  #avatarBtnContent!: HTMLSpanElement;
  #offlineBanner!: HTMLElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#closeBtn = root.querySelector('button[data-action="close"]') as HTMLButtonElement;
    this.#avatarBtn = root.querySelector('button[data-action="avatar"]') as HTMLButtonElement;
    this.#shareBtn = root.querySelector('button[data-action="share"]') as HTMLButtonElement;
    this.#linkBtn = root.querySelector('button[data-action="link"]') as HTMLButtonElement;
    this.#avatarBtnContent = this.#avatarBtn.querySelector(
      '.fl-toolbar-avatar-fallback',
    ) as HTMLSpanElement;
    this.#offlineBanner = root.querySelector('.fl-offline-banner') as HTMLElement;
  }

  connectedCallback(): void {
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'toolbar-host');
    }
    this.#closeBtn.addEventListener('click', this.#onCloseClick);
    this.#avatarBtn.addEventListener('click', this.#onAvatarClick);
    this.#shareBtn.addEventListener('click', this.#onShareClick);
    this.#linkBtn.addEventListener('click', this.#onLinkClick);
    // Arrow-key navigation among the toolbar buttons (design §28 ARIA
    // table: "Arrow keys move focus among buttons"). Listened for on
    // the inner `.fl-toolbar` element so other host-level keystrokes
    // are unaffected.
    const toolbar = this.shadowRoot!.querySelector('.fl-toolbar') as HTMLElement;
    toolbar.addEventListener('keydown', this.#onToolbarKeydown);
  }

  disconnectedCallback(): void {
    this.#closeBtn.removeEventListener('click', this.#onCloseClick);
    this.#avatarBtn.removeEventListener('click', this.#onAvatarClick);
    this.#shareBtn.removeEventListener('click', this.#onShareClick);
    this.#linkBtn.removeEventListener('click', this.#onLinkClick);
    const toolbar = this.shadowRoot!.querySelector('.fl-toolbar') as HTMLElement;
    toolbar.removeEventListener('keydown', this.#onToolbarKeydown);
  }

  /**
   * Optional avatar image URL. When set, the avatar button renders an
   * `<img>` (24×24, circular) — preserving the legacy React behavior.
   * When `null` / `undefined` / empty, the 👤 emoji fallback is used.
   */
  get avatarUrl(): string | null {
    return this.#avatarUrl;
  }

  set avatarUrl(next: string | null | undefined) {
    const value = typeof next === 'string' && next.length > 0 ? next : null;
    this.#avatarUrl = value;
    this.#renderAvatar();
  }

  #renderAvatar(): void {
    // Reset the avatar button to the fallback span, then upgrade to <img>
    // when we have a URL. Done imperatively (not via innerHTML) so we keep
    // CSP-strict friendliness — design §35 "CSP-Strict Resilience".
    this.#avatarBtn.replaceChildren();
    if (this.#avatarUrl) {
      const img = document.createElement('img');
      img.src = this.#avatarUrl;
      img.alt = 'avatar';
      img.width = 24;
      img.height = 24;
      img.style.width = '24px';
      img.style.height = '24px';
      img.style.borderRadius = '50%';
      this.#avatarBtn.appendChild(img);
    } else {
      this.#avatarBtn.appendChild(this.#avatarBtnContent);
    }
  }

  /**
   * Whether the overlay is currently offline (Req 44.1, task 36.8).
   *
   * When `true`, the toolbar shows a small "Offline — changes will sync
   * when online" banner styled with the warning palette token from the
   * shared theme (`--fl-severity-major`). When `false`, the banner is
   * hidden via the `hidden` attribute. Driven by
   * `connectionMonitor.isOffline` (which combines `navigator.onLine`
   * with the `/api/v1/health` heartbeat) and assigned by
   * `<fl-overlay-host>` whenever the store slice changes.
   */
  get isOffline(): boolean {
    return this.#isOffline;
  }

  set isOffline(next: boolean | null | undefined) {
    const value = next === true;
    if (this.#isOffline === value) return;
    this.#isOffline = value;
    this.#renderOfflineBanner();
  }

  #renderOfflineBanner(): void {
    if (this.#isOffline) {
      this.#offlineBanner.hidden = false;
      this.#offlineBanner.removeAttribute('hidden');
    } else {
      this.#offlineBanner.hidden = true;
      this.#offlineBanner.setAttribute('hidden', '');
    }
  }

  #dispatch(action: FloatingToolbarAction): void {
    this.dispatchEvent(
      new CustomEvent(action, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  #onCloseClick = (e: MouseEvent): void => {
    // Stop the click from bubbling into the host page's click handler
    // (the overlay listens for clicks to anchor a new annotation).
    e.stopPropagation();
    this.#dispatch('close');
  };

  #onAvatarClick = (e: MouseEvent): void => {
    e.stopPropagation();
    this.#dispatch('avatar');
  };

  #onShareClick = (e: MouseEvent): void => {
    e.stopPropagation();
    this.#dispatch('share');
  };

  #onLinkClick = (e: MouseEvent): void => {
    e.stopPropagation();
    this.#dispatch('link');
  };

  /**
   * ArrowLeft / ArrowRight cycle focus among the four toolbar buttons
   * (design §28 ARIA table). Home/End jump to the first / last button.
   * Other keys (Tab, Enter, etc.) are left to the user agent so the
   * toolbar continues to participate in normal tab order.
   *
   * Implements the **roving-tabindex** pattern: as focus moves among the
   * buttons we set `tabindex="0"` on the focused one and `tabindex="-1"`
   * on the rest, so a subsequent Tab key exits the toolbar instead of
   * cycling internally.
   */
  #onToolbarKeydown = (event: KeyboardEvent): void => {
    const buttons: HTMLButtonElement[] = [
      this.#closeBtn,
      this.#avatarBtn,
      this.#shareBtn,
      this.#linkBtn,
    ];
    const root = this.shadowRoot!;
    const current = root.activeElement as HTMLButtonElement | null;
    const index = current ? buttons.indexOf(current) : -1;
    if (index === -1) return;
    let next = index;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % buttons.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + buttons.length) % buttons.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#setRovingTabindex(buttons, next);
    buttons[next].focus();
  };

  /**
   * Set `tabindex="0"` on `buttons[activeIndex]` and `tabindex="-1"` on
   * every other button. The active button is the single tab stop for
   * the toolbar; subsequent Tab presses leave the toolbar entirely.
   */
  #setRovingTabindex(buttons: HTMLButtonElement[], activeIndex: number): void {
    buttons.forEach((btn, idx) => {
      btn.tabIndex = idx === activeIndex ? 0 : -1;
    });
  }
}

// Idempotent registration. Guarded so a duplicate import (HMR or repeated
// test bootstrap) does not throw "this name has already been used".
if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlFloatingToolbar.tagName)
) {
  withBoundary(FlFloatingToolbar.prototype, 'connectedCallback');
  withBoundary(FlFloatingToolbar.prototype, 'disconnectedCallback');
  customElements.define(FlFloatingToolbar.tagName, FlFloatingToolbar);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-floating-toolbar': FlFloatingToolbar;
  }
}

// NOTE: We intentionally do NOT augment `HTMLElementEventMap` with the four
// action names because `close` (and `share` on certain `Window`/`Element`
// type maps) already exist in the standard lib.dom.d.ts type maps as plain
// `Event`. Re-declaring them as `CustomEvent<void>` would produce a
// "subsequent property declarations must have the same type" compile error.
// Consumers can still type-check by casting at the listener call site:
//
//     toolbar.addEventListener('close', (e) => { ... });
//
// The event objects are runtime `CustomEvent`s; this comment documents the
// type-augmentation choice for future maintainers.
