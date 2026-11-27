// @pinpoint/shared — safe DOM construction helpers (Mission B1).
//
// Untrusted text — guest/widget feedback, team member emails, workflow
// rule names, portal titles, integration config keys — must never flow
// into `innerHTML`. These helpers build DOM imperatively so the browser
// treats every value as text or as an allow-listed attribute, never as
// markup. A payload such as `<img src=x onerror=alert(1)>` or
// `<script>…</script>` lands in the document as inert, visible text.
//
// Three entry points:
//   - `setText(el, value)`  — the one true way to write user text.
//   - `el(tag, attrs, children)` — a tiny hyperscript that only ever uses
//     `document.createElement` + `setAttribute` with an attribute
//     allow-list, and `textContent` / child nodes for content.
//   - `escapeHtml(value)` — the escape hatch for the rare case where a
//     string template is genuinely required (e.g. building a string that
//     is handed to a non-DOM sink). Prefer `el`/`setText` over this.

/**
 * Attributes that are safe to set from (potentially) untrusted callers.
 *
 * The list is deliberately conservative. It excludes every event handler
 * (`on*`), `style` (CSS-injection / `expression()` vectors), and URL-bearing
 * attributes that accept the `javascript:` scheme without scheme validation.
 * URL attributes (`href`, `src`) are handled specially below: they are
 * allowed but run through {@link isSafeUrl} first.
 */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  'id',
  'class',
  'title',
  'role',
  'tabindex',
  'type',
  'value',
  'name',
  'placeholder',
  'for',
  'hidden',
  'disabled',
  'checked',
  'selected',
  'required',
  'readonly',
  'maxlength',
  'minlength',
  'min',
  'max',
  'step',
  'pattern',
  // Form/IME hints (inert): password-manager + OTP autofill, `novalidate` on <form>.
  'autocomplete',
  'inputmode',
  'novalidate',
  'alt',
  'width',
  'height',
  'colspan',
  'rowspan',
  'aria-label',
  'aria-hidden',
  'aria-live',
  'aria-expanded',
  'aria-current',
  'aria-describedby',
  'aria-labelledby',
  'data-role',
  'data-slot',
  'data-section',
  'data-action',
  'data-level',
  'href',
  'src',
]);

/** URL-bearing attributes that must pass {@link isSafeUrl}. */
const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src']);

/**
 * A child of {@link el}. `null`/`undefined`/`false` are skipped so callers can
 * write `condition && el('span', …)`. Strings become text nodes.
 */
export type Child = Node | string | null | undefined | false;

/** Attribute map accepted by {@link el}. `false`/`null`/`undefined` skip. */
export type Attrs = Record<string, string | number | boolean | null | undefined>;

/**
 * Set an element's visible text. Thin, intentional wrapper around
 * `textContent` so call sites read as "this is user text" and never reach
 * for `innerHTML`. Any `<`, `>`, `&`, quotes in `value` render literally.
 */
export function setText(target: Element, value: string | number): void {
  target.textContent = String(value);
}

/**
 * Build an element with allow-listed attributes and DOM children.
 *
 * - Attributes not in {@link ALLOWED_ATTRS} are ignored (never set), so an
 *   `onerror`/`onclick`/`style` key supplied from untrusted data is dropped.
 * - `href`/`src` values are validated by {@link isSafeUrl}; a
 *   `javascript:`/`data:` URL is dropped.
 * - Boolean attribute values set the attribute presence (`true`) or omit it
 *   (`false`).
 * - Children are appended as text nodes (strings) or as-is (Nodes). Falsy
 *   children are skipped.
 *
 * This never parses HTML, so string children containing `<script>` or
 * `<img onerror>` become inert text.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Child | Child[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (attrs) {
    for (const [rawName, rawValue] of Object.entries(attrs)) {
      if (rawValue == null || rawValue === false) continue;
      const name = rawName.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) continue;
      if (URL_ATTRS.has(name) && !isSafeUrl(String(rawValue))) continue;
      if (rawValue === true) {
        node.setAttribute(name, '');
      } else {
        node.setAttribute(name, String(rawValue));
      }
    }
  }

  if (children != null) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child == null || child === false) continue;
      node.appendChild(
        typeof child === 'string' ? document.createTextNode(child) : child,
      );
    }
  }

  return node;
}

/**
 * Escape the five HTML-significant characters so a string can be safely
 * interpolated into a string template bound for a non-DOM sink. Prefer
 * {@link el}/{@link setText}; reach for this only when a string result is
 * genuinely required.
 */
export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Allow only http(s), mailto, relative, and fragment URLs. Rejects
 * `javascript:`, `data:`, `vbscript:`, and anything whose scheme can't be
 * resolved to one of the safe schemes. Used to gate `href`/`src` in
 * {@link el}.
 */
export function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  // Relative paths, fragments, and query-only URLs have no scheme — safe.
  if (/^[/#?]/.test(trimmed)) return true;
  // A leading scheme-like token must be an allowed scheme.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return true; // scheme-less (e.g. "example.com/path")
  const scheme = schemeMatch[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}
