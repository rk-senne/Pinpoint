/**
 * Shared stylesheet for every Shadow Root rendered by the Pinpoint
 * extension's Custom Elements (Req 26.1, 31.2, 49.2).
 *
 * Combines two layers into a single source of truth:
 *
 *   1. `themeCss()` from `@pinpoint/shared/theme` — the canonical
 *      `--fl-severity-*` and `--fl-status-*` CSS Custom Properties (Req 26.1,
 *      design decision #11). Both Dashboard and Extension consume the same
 *      palette so colors and labels never drift.
 *   2. `OVERLAY_CSS` — the overlay's structural styles (toolbar, popover,
 *      pin, sidebar, mention dropdown, comment thread, reconnecting banner).
 *      These were previously inline in `extension/src/content.ts`'s
 *      `getBaseStyles()` and duplicated as JSX `style={…}` / inline color
 *      maps in `extension/src/components/SidebarPanel.tsx`. Consolidated here
 *      so this module is the single source consumed by every Custom Element
 *      via `adoptedStyleSheets` (design key decision #11, design §35
 *      "CSP-Strict Resilience").
 *
 * --------------------------------------------------------------------------
 * CSP-Strict styling contract (task 41.2, Requirement 49.2)
 * --------------------------------------------------------------------------
 * Two delivery paths exist, in priority order:
 *
 *   PRIMARY — Constructable `CSSStyleSheet` adopted via `adoptedStyleSheets`.
 *     This is the canonical CSP-clean path. Strict policies of the shape
 *     `default-src 'none'; script-src 'self'; style-src 'self'` block
 *     inline `<style>` text and inline `style="…"` attributes baked into
 *     HTML; constructable stylesheets installed through `adoptedStyleSheets`
 *     are NOT classified as inline by CSP (the rules live in a JS-owned
 *     `CSSStyleSheet` object, not in a parsed `<style>` element), so the
 *     overlay renders without any need for `'unsafe-inline'` or a per-load
 *     style nonce. Every Custom Element in the extension calls
 *     `adoptStyles(shadowRoot)` from its constructor; that helper installs
 *     the shared sheet on this path whenever the runtime exposes both
 *     `new CSSStyleSheet()` and a populated `adoptedStyleSheets` slot on
 *     `Document.prototype`.
 *
 *   FALLBACK — Static `<style>` element appended inside the Shadow Root.
 *     Older engines (legacy WebViews, embedded browsers) and Node test
 *     runners (jsdom builds without the CSSOM extension) lack the
 *     constructable-stylesheet API. `adoptStyles()` falls back to creating
 *     a `<style>` element with `SHARED_STYLE_FALLBACK_CSS` as its
 *     `textContent` and appending it to the Shadow Root. Because the
 *     `<style>` element lives inside a Shadow Root, host-page CSP does
 *     not inspect its contents (CSP scoping is per-document, and the
 *     extension's content script runs in its own isolated world); the
 *     fallback therefore continues to render even when the host's policy
 *     omits `'unsafe-inline'` for `style-src`. The fallback is documented
 *     here so reviewers see the runtime degrade path without having to
 *     re-derive it from the source.
 *
 * Both paths consume the same `SHARED_STYLE_FALLBACK_CSS` string so the
 * rendered styling is identical. New Custom Elements MUST call
 * `adoptStyles(root)` rather than building their own `<style>` element —
 * doing so keeps the primary/fallback split owned by this module and
 * preserves the single source of truth.
 * --------------------------------------------------------------------------
 */
import { themeCss } from '@pinpoint/shared';

/**
 * Overlay structural CSS — class selectors only, no theme values inlined.
 * Severity swatches reference `--fl-severity-*` so the palette comes from
 * `themeCss()` (the previous extension copy of the four severity hex codes
 * has been removed in favor of CSS Custom Properties).
 */
export const OVERLAY_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
#pinpoint-root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #1a1a1a;
}
.fl-toolbar {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  background: #1a1a1a; color: #fff; border-radius: 28px;
  padding: 8px 16px; pointer-events: auto; z-index: 2147483647;
  box-shadow: 0 4px 24px rgba(0,0,0,0.3);
}
.fl-toolbar button {
  background: none; border: none; color: #fff; cursor: pointer;
  width: 36px; height: 36px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 16px;
}
.fl-toolbar button:hover { background: rgba(255,255,255,0.15); }
/* Offline banner (Req 44.1 / task 36.8). Sits inside the floating toolbar
   so the warning never blocks the host page. The background uses the
   shared --fl-severity-major palette token (warning orange) so the
   color stays in sync with the overlay's other "warning" surfaces (the
   reconnecting banner, the fallback pin ring). When the [hidden]
   attribute is set, the rule below collapses the element; the visible
   state is defined here. */
.fl-offline-banner {
  display: inline-flex; align-items: center;
  background: var(--fl-severity-major); color: #fff;
  padding: 4px 12px; border-radius: 16px;
  font-size: 12px; font-weight: 500; line-height: 1.2;
  margin-right: 4px;
  pointer-events: none;
}
.fl-offline-banner[hidden] { display: none; }
.fl-popover {
  position: absolute; background: #fff; border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18); padding: 16px;
  min-width: 320px; pointer-events: auto; z-index: 2147483647;
}
.fl-popover-tabs { display: flex; gap: 4px; margin-bottom: 12px; }
.fl-popover-tabs button {
  padding: 6px 14px; border: 1px solid #ddd; border-radius: 6px;
  background: #f5f5f5; cursor: pointer; font-size: 13px;
}
.fl-popover-tabs button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
.fl-severity-selector { display: flex; gap: 6px; margin: 8px 0; }
.fl-severity-btn {
  width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent;
  cursor: pointer;
}
.fl-severity-btn.selected { border-color: #1a1a1a; transform: scale(1.15); }
.fl-severity-critical { background: var(--fl-severity-critical); }
.fl-severity-major { background: var(--fl-severity-major); }
.fl-severity-minor { background: var(--fl-severity-minor); }
.fl-severity-informational { background: var(--fl-severity-informational); }
.fl-textarea {
  width: 100%; min-height: 80px; border: 1px solid #ddd; border-radius: 8px;
  padding: 10px; font-size: 14px; resize: vertical; font-family: inherit;
}
.fl-btn-row { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
.fl-btn {
  padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
  font-size: 13px; font-weight: 500;
}
.fl-btn-primary { background: #1a1a1a; color: #fff; }
.fl-btn-secondary { background: #f5f5f5; color: #333; }
.fl-pin {
  position: absolute; top: 0; left: 0;
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 12px; font-weight: 700; cursor: pointer;
  pointer-events: auto; z-index: 2147483646;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  /* Position is set exclusively via transform: translate3d(x, y, 0)
     by PinPositioner (Req 14.2, 14.5). No top/left here. */
}
/* Fallback warning ring (Req 14.3, 14.6): rendered when PinPositioner
   could not resolve the stored selector to a live DOM element. The ring
   color comes from the shared theme palette so the React-based
   PinRenderer (which uses .fl-pin) and the new <fl-annotation-pin>
   Custom Element (which uses :host([data-fallback="true"])) display the
   same warning indicator. */
.fl-pin[data-fallback="true"] {
  outline: 2px solid var(--fl-severity-major);
  outline-offset: 2px;
}
.fl-sidebar {
  position: fixed; top: 0; right: 0; width: 340px; height: 100vh;
  background: #fff; box-shadow: -4px 0 24px rgba(0,0,0,0.1);
  pointer-events: auto; z-index: 2147483647; overflow-y: auto;
  display: flex; flex-direction: column;
}
.fl-sidebar-tabs { display: flex; border-bottom: 1px solid #eee; }
.fl-sidebar-tabs button {
  flex: 1; padding: 12px; border: none; background: none; cursor: pointer;
  font-size: 14px; font-weight: 500;
}
.fl-sidebar-tabs button.active { border-bottom: 2px solid #1a1a1a; }
.fl-sidebar-item {
  padding: 12px 16px; border-bottom: 1px solid #f0f0f0; cursor: pointer;
}
.fl-sidebar-item:hover { background: #f9f9f9; }
.fl-mention-dropdown {
  position: absolute; background: #fff; border: 1px solid #ddd;
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  max-height: 180px; overflow-y: auto; pointer-events: auto; z-index: 2147483647;
}
.fl-mention-item {
  padding: 8px 12px; cursor: pointer; font-size: 13px;
}
.fl-mention-item:hover { background: #f0f0f0; }
.fl-comment-thread { max-height: 300px; overflow-y: auto; margin: 8px 0; }
.fl-comment {
  padding: 8px; border-bottom: 1px solid #f0f0f0; font-size: 13px;
}
.fl-comment-author { font-weight: 600; margin-right: 6px; }
.fl-comment-time { color: #999; font-size: 11px; }
/* Comment body sits below the author/time row. The previous template
   carried a style="margin-top:4px;" attribute directly on the div, which
   is forbidden under strict CSP style-src (Req 49.1, task 41.1). Moved
   here so the spacing is class-driven instead of an inline attribute. */
.fl-comment-body { margin-top: 4px; }
/* Mention autocomplete row email annotation. Was previously
   a style="color:#999;margin-left:6px;" attribute on the span -
   moved here so the row markup is free of inline style attributes
   (Req 49.1, task 41.1). */
.fl-mention-email { color: #999; margin-left: 6px; }
.fl-reconnecting {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  background: var(--fl-severity-major); color: #fff; padding: 6px 16px; border-radius: 20px;
  font-size: 12px; pointer-events: auto; z-index: 2147483647;
}
/* Hover preview outline (Req 37.1, 37.2) — task 28.1.
   A single absolutely-positioned div lives inside the Shadow Root and is
   moved by HoverOutline via CSS transform/width/height on every rAF tick.
   pointer-events: none is mandatory: the host page must keep receiving
   clicks while the user previews their click target. */
.fl-hover-outline {
  position: fixed; top: 0; left: 0;
  pointer-events: none; box-sizing: border-box;
  border: 2px solid var(--fl-accent); border-radius: 2px;
  transition: transform 80ms ease-out, width 80ms ease-out, height 80ms ease-out;
  will-change: transform, width, height;
  z-index: 2147483646;
  display: none;
}
/* Project Picker fallback wrapper (Req 38.2 / Req 39.1, task 29.4).
   When the URL → Project resolution fails (cache miss + by-url 404),
   the overlay host reveals this wrapper centered above the floating
   toolbar so the user can manually pick a Project. The host hides every
   other overlay surface (sidebar, popover, pins) while the picker is
   visible — this wrapper just owns the layout.

   pointer-events: auto so the dropdown is interactive while the
   container itself does not block clicks on the host page. */
.fl-project-picker-fallback {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; z-index: 2147483647;
}
.fl-project-picker-fallback[hidden] { display: none; }
`;

/**
 * Combined CSS string: shared theme variables followed by overlay rules.
 * This is what gets fed into `replaceSync` and is also exported for the
 * `<style>` fallback path.
 */
export const SHARED_STYLE_FALLBACK_CSS = `${themeCss()}\n${OVERLAY_CSS}`;

/**
 * Constructable `CSSStyleSheet` containing theme variables + overlay rules.
 *
 * Every extension Custom Element should attach this via `adoptStyles()`
 * (which prefers `adoptedStyleSheets` and falls back to a `<style>`
 * element):
 *
 *     this.shadowRoot!.adoptedStyleSheets = [sharedStyleSheet];
 *
 * --------------------------------------------------------------------------
 * Why this is the *primary* path under strict CSP (Req 49.2, task 41.2)
 * --------------------------------------------------------------------------
 * A constructable `CSSStyleSheet` populated via `replaceSync(...)` and
 * installed through `Document.adoptedStyleSheets` (or a Shadow Root's
 * `adoptedStyleSheets` slot) does not produce an inline `<style>` element
 * and is not subject to the `'unsafe-inline'` requirement of `style-src`.
 * That makes it the canonical CSP-clean delivery channel for the overlay
 * UI: a host page running `default-src 'none'; script-src 'self'` (or any
 * other strict variant) will continue to render the overlay without
 * needing to relax `style-src`.
 *
 * In environments without constructable stylesheets (older browsers,
 * jsdom/happy-dom in tests) this is `undefined` — `adoptStyles()` falls
 * back to appending a `<style>` element built from `SHARED_STYLE_FALLBACK_CSS`
 * inside the Shadow Root. That fallback is the documented degrade path and
 * remains CSP-safe because the `<style>` is parented to a Shadow Root in
 * an extension-owned isolated world rather than the host document.
 */
export const sharedStyleSheet: CSSStyleSheet | undefined = (() => {
  try {
    if (typeof CSSStyleSheet === 'undefined') return undefined;
    const sheet = new CSSStyleSheet();
    if (typeof sheet.replaceSync !== 'function') return undefined;
    sheet.replaceSync(SHARED_STYLE_FALLBACK_CSS);
    return sheet;
  } catch {
    return undefined;
  }
})();

/**
 * Attaches the shared styles to a Shadow Root.
 *
 * Implements the two-tier delivery contract documented at the top of this
 * module (task 41.2, Req 49.2):
 *
 *   PRIMARY  — `root.adoptedStyleSheets = [sharedStyleSheet]` when a
 *              constructable `CSSStyleSheet` is available AND the runtime
 *              exposes the `adoptedStyleSheets` slot on `Document.prototype`.
 *              This path stays CSP-clean under strict `style-src` policies
 *              because the rules never materialise as an inline `<style>`
 *              element on the page.
 *   FALLBACK — A `<style>` element with `SHARED_STYLE_FALLBACK_CSS` as its
 *              `textContent` appended inside the Shadow Root. Used when
 *              the runtime lacks constructable stylesheets (legacy engines,
 *              some jsdom/happy-dom test setups). The element lives inside
 *              the Shadow Root rather than the host document, so host-page
 *              CSP does not block it.
 *
 * Mirrors the pattern in design §35 ("CSP-Strict Resilience").
 */
export function adoptStyles(root: ShadowRoot): void {
  if (sharedStyleSheet && 'adoptedStyleSheets' in Document.prototype) {
    root.adoptedStyleSheets = [sharedStyleSheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = SHARED_STYLE_FALLBACK_CSS;
  root.appendChild(style);
}

/**
 * Default export — the constructable stylesheet itself, so consumers can
 * write either:
 *
 *     import sharedStyleSheet from './styles/sharedStyleSheet';
 *     import { sharedStyleSheet, adoptStyles } from './styles/sharedStyleSheet';
 *
 * Both forms resolve to the same `CSSStyleSheet | undefined` value.
 */
export default sharedStyleSheet;
