/**
 * `<fl-disclosure-modal>` — one-time "what gets sent" disclosure (task 39.1,
 * Requirement 47.1).
 *
 * Renders a self-contained `<dialog>` listing every category of data the
 * extension transmits when the user submits an annotation:
 *
 *   - DOM target selectors
 *   - Screenshot of the visible viewport (when capture is enabled)
 *   - Console buffer (when capture is enabled)
 *   - Network buffer (when capture is enabled)
 *   - Browser / OS metadata
 *   - Page URL
 *   - Redacted PII rectangles
 *
 * The modal exposes two actions:
 *
 *   - **Acknowledge** — emits a bubbling, composed `acknowledge` `CustomEvent`.
 *     The popover open flow listens for this so it can persist the
 *     `disclosure-seen-${host}` flag (task 39.2) and continue to the
 *     popover content.
 *   - **Open Settings** — emits a bubbling, composed `open-settings`
 *     `CustomEvent` and, when the extension runtime is available, calls
 *     `chrome.runtime.openOptionsPage()` so the user lands on the
 *     options surface immediately (task 39.3, Req 47.2). The event is
 *     still dispatched in both cases so consumers (the popover host)
 *     can react regardless of whether the runtime API is reachable.
 *
 * The body also renders a "Privacy policy" link (task 39.3, Req 47.2)
 * pointed at the placeholder URL `PRIVACY_POLICY_URL`. The placeholder
 * is intentional for V1 — the real URL lives on the marketing site
 * shipped alongside the Chrome Web Store listing — and will be
 * swapped in via the Web Store listing artifact bundle (Req 50.1)
 * when that ships. Centralising the URL in a single constant means
 * the swap is a one-line change rather than a template hunt.
 *
 * Both events `composed: true` so they cross the Shadow Root boundary into
 * the popover (which composes `<fl-disclosure-modal>` directly into its
 * own Shadow DOM the same way it composes `<fl-mention-autocomplete>` and
 * `<fl-comment-thread>` rather than slotting them).
 *
 * Lifecycle:
 *   - The constructor only attaches the shadow root, adopts shared styles,
 *     stamps the template clone, and binds button click listeners.
 *     Per the Custom Elements spec, custom-element constructors must not
 *     mutate the host element's attributes or descendants — that work
 *     happens in `connectedCallback`.
 *   - Calling `open()` flips the dialog open via `showModal()` (with a
 *     legacy `setAttribute('open', '')` fallback for jsdom and older
 *     engines that do not implement the dialog API).
 *   - Calling `close()` closes the dialog. The user clicking either action
 *     button also closes the dialog before the corresponding event fires
 *     so the popover open flow can immediately render its own content.
 *
 * Implements: Requirement 47.1 (partially — task 39.1 covers the modal UI;
 * task 39.2 covers the seen-flag persistence; task 39.3 covers the
 * privacy-policy link and the "open settings" action — Req 47.2).
 */
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';

/**
 * URL of the Pinpoint privacy policy linked from the disclosure
 * body (task 39.3, Req 47.2). Placeholder for V1: the real URL lives on
 * the marketing site shipped alongside the Chrome Web Store listing
 * artifact bundle (Req 50.1) and will be swapped in once that copy
 * lands. Keeping the URL in a single exported constant means the
 * eventual swap is a one-line change here rather than a template hunt
 * across the codebase, and tests can assert the rendered `<a>` against
 * this constant directly so a copy edit on the URL does not require
 * a parallel test edit.
 */
export const PRIVACY_POLICY_URL = 'https://pinpoint.example/privacy';

/**
 * Stable identifier for one category of data the extension transmits.
 * Each entry maps to a row in the rendered list. Kept as a discrete type
 * so the test suite can iterate over the canonical set without parsing
 * the rendered DOM (`DATA_CATEGORIES` below is the single source of
 * truth — tests reuse it directly).
 */
export interface DisclosureDataCategory {
  /** Stable id used as the `<li data-category>` attribute. */
  id: string;
  /** Short label rendered as the bullet headline. */
  label: string;
  /** One-sentence explanation rendered after the label. */
  description: string;
}

/**
 * Canonical list of every data category sent on annotation submission.
 * Mirrors Requirement 47.1's acceptance criterion list:
 *
 *   "the Extension SHALL display a one-time disclosure listing every
 *    category of data that will be sent on submission: annotation body,
 *    screenshot, console buffer, network buffer, environment metadata,
 *    page URL, target selector."
 *
 * Exported so tests (and the future settings page) can render the same
 * set without re-deriving it from a rendered DOM.
 */
export const DATA_CATEGORIES: ReadonlyArray<DisclosureDataCategory> = [
  {
    id: 'dom-target',
    label: 'DOM target selectors',
    description:
      'CSS selector and XPath of the element you click, plus its tag name and a short text snippet so the pin can be re-anchored later.',
  },
  {
    id: 'screenshot',
    label: 'Screenshot (when capture is enabled)',
    description:
      'A PNG of the visible viewport at the moment of submission. Disabled by un-checking "Attach screenshot" in the popover.',
  },
  {
    id: 'console',
    label: 'Console buffer (when capture is enabled)',
    description:
      'Recent log / warn / error entries from the page console, captured for critical or major bug reports.',
  },
  {
    id: 'network',
    label: 'Network buffer (when capture is enabled)',
    description:
      'Recent network requests (URL, method, status, duration), captured for critical or major bug reports.',
  },
  {
    id: 'environment',
    label: 'Browser / OS metadata',
    description:
      'Browser family and version, OS family and version, and device type, derived from your user-agent string.',
  },
  {
    id: 'page-url',
    label: 'Page URL',
    description:
      'The URL of the page you annotated, used to look up the matching project and to re-open the annotation later.',
  },
  {
    id: 'pii-rects',
    label: 'Redacted PII rectangles',
    description:
      'Coordinates of regions our PII detector has masked in the screenshot, so the dashboard can re-render the redaction overlay.',
  },
];

const DISCLOSURE_CSS = `
:host { display: contents; }
dialog.fl-disclosure-modal {
  border: none;
  background: #fff;
  padding: 20px;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  max-width: 480px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #1a1a1a;
  font-size: 14px;
  line-height: 1.4;
  /* Defeat any host-page rule that would push the dialog off-center. */
  margin: auto;
}
dialog.fl-disclosure-modal[open] { display: block; }
dialog.fl-disclosure-modal::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.fl-disclosure-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
}
.fl-disclosure-intro {
  margin: 0 0 12px;
  color: #444;
  font-size: 13px;
}
.fl-disclosure-list {
  list-style: disc;
  margin: 0 0 16px 20px;
  padding: 0;
}
.fl-disclosure-list li {
  margin-bottom: 6px;
}
.fl-disclosure-list li strong {
  font-weight: 600;
  color: #1a1a1a;
}
.fl-disclosure-list li span {
  display: block;
  color: #555;
  font-size: 12px;
}
.fl-disclosure-privacy {
  margin: 0 0 16px;
  font-size: 12px;
  color: #555;
}
.fl-disclosure-privacy a {
  color: #1a1a1a;
  text-decoration: underline;
}
.fl-disclosure-privacy a:focus-visible {
  outline: 2px solid #1a1a1a;
  outline-offset: 2px;
  border-radius: 2px;
}
.fl-disclosure-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.fl-disclosure-actions .fl-btn {
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.fl-disclosure-actions .fl-btn-secondary {
  background: #f5f5f5;
  color: #333;
}
.fl-disclosure-actions .fl-btn-primary {
  background: #1a1a1a;
  color: #fff;
}
`;

const TEMPLATE = (() => {
  const t = document.createElement('template');
  // Render the list into a static wrapper. Categories are stamped from
  // `DATA_CATEGORIES` in the constructor so the test suite can drive
  // the canonical set off the exported constant rather than reading
  // rendered HTML.
  t.innerHTML = `
    <style>${DISCLOSURE_CSS}</style>
    <dialog class="fl-disclosure-modal" part="dialog" role="dialog" aria-modal="true" aria-labelledby="fl-disclosure-title">
      <h2 id="fl-disclosure-title" class="fl-disclosure-title">Before you submit</h2>
      <p class="fl-disclosure-intro">
        Pinpoint will transmit the following data categories when you
        submit an annotation:
      </p>
      <ul class="fl-disclosure-list" part="list"></ul>
      <p class="fl-disclosure-privacy" part="privacy">
        Read the
        <a
          class="fl-disclosure-privacy-link"
          href="${PRIVACY_POLICY_URL}"
          target="_blank"
          rel="noopener noreferrer"
        >Privacy policy</a>
        for details on how this data is stored and used.
      </p>
      <div class="fl-disclosure-actions">
        <button
          type="button"
          class="fl-btn fl-btn-secondary"
          data-action="open-settings"
        >Open Settings</button>
        <button
          type="button"
          class="fl-btn fl-btn-primary"
          data-action="acknowledge"
        >Acknowledge</button>
      </div>
    </dialog>
  `;
  return t;
})();

/**
 * `<fl-disclosure-modal>` Custom Element. Self-contained dialog rendered
 * the first time the popover opens on a given host (or after a
 * settings change resets the seen-flag — task 39.2).
 */
export class FlDisclosureModal extends HTMLElement {
  static readonly tagName = 'fl-disclosure-modal';

  #dialog!: HTMLDialogElement;
  #list!: HTMLUListElement;
  #acknowledgeBtn!: HTMLButtonElement;
  #openSettingsBtn!: HTMLButtonElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#dialog = root.querySelector('dialog.fl-disclosure-modal') as HTMLDialogElement;
    this.#list = root.querySelector('ul.fl-disclosure-list') as HTMLUListElement;
    this.#acknowledgeBtn = root.querySelector(
      'button[data-action="acknowledge"]',
    ) as HTMLButtonElement;
    this.#openSettingsBtn = root.querySelector(
      'button[data-action="open-settings"]',
    ) as HTMLButtonElement;

    // Stamp every canonical category into the list. The static
    // `DATA_CATEGORIES` array is the single source of truth — the
    // unit tests assert the rendered set against that constant.
    for (const category of DATA_CATEGORIES) {
      const li = document.createElement('li');
      li.dataset.category = category.id;
      const name = document.createElement('strong');
      name.textContent = category.label;
      const desc = document.createElement('span');
      desc.textContent = category.description;
      li.appendChild(name);
      li.appendChild(desc);
      this.#list.appendChild(li);
    }
  }

  connectedCallback(): void {
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'disclosure-modal');
    }
    this.#acknowledgeBtn.addEventListener('click', this.#onAcknowledge);
    this.#openSettingsBtn.addEventListener('click', this.#onOpenSettings);
  }

  disconnectedCallback(): void {
    this.#acknowledgeBtn.removeEventListener('click', this.#onAcknowledge);
    this.#openSettingsBtn.removeEventListener('click', this.#onOpenSettings);
  }

  /** Whether the dialog is currently open. */
  get open(): boolean {
    return this.#dialog.open;
  }

  /**
   * Render and open the dialog. Prefers `showModal()` (so we get a
   * native focus-trap + Escape-closes-dialog) and falls back to the
   * `open` attribute on jsdom and older engines that do not implement
   * the dialog API.
   */
  open_(): void {
    if (this.#dialog.open) return;
    if (typeof this.#dialog.showModal === 'function') {
      try {
        this.#dialog.showModal();
        return;
      } catch {
        /* fall through to attribute fallback */
      }
    }
    this.#dialog.setAttribute('open', '');
  }

  /**
   * Public alias for `open_()`. The trailing-underscore form exists so
   * the property does not shadow the read-only `open` getter on
   * `HTMLDialogElement`-style consumers; callers should prefer
   * `show()` for clarity.
   */
  show(): void {
    this.open_();
  }

  /** Close the dialog without dispatching any user-action event. */
  close(): void {
    if (!this.#dialog.open) return;
    try {
      this.#dialog.close();
    } catch {
      this.#dialog.removeAttribute('open');
    }
  }

  #onAcknowledge = (): void => {
    // Close the dialog first so the popover open flow sees a clean
    // surface when it renders next.
    this.close();
    this.dispatchEvent(
      new CustomEvent<Record<string, never>>('acknowledge', {
        detail: {},
        bubbles: true,
        composed: true,
      }),
    );
  };

  #onOpenSettings = (): void => {
    // Best-effort: when running inside the extension the runtime API is
    // available and `openOptionsPage()` is the canonical way to land
    // the user on the options surface (task 39.3, Req 47.2). The
    // method is `void`-returning in MV3 but historically accepted an
    // optional callback; both shapes are safe to call without
    // arguments. A `try/catch` shields the popover open path from any
    // surprise throws (e.g. an extension reload mid-click that
    // invalidates the runtime context — Chrome surfaces "Extension
    // context invalidated" as a thrown error). Outside the extension
    // (jsdom unit tests, the dashboard host where the disclosure is
    // not currently rendered) `chrome.runtime.openOptionsPage` is
    // undefined and we fall through to the event-only path so a
    // listener can still react.
    const runtime = (
      globalThis as unknown as {
        chrome?: { runtime?: { openOptionsPage?: () => void } };
      }
    ).chrome?.runtime;
    if (runtime && typeof runtime.openOptionsPage === 'function') {
      try {
        runtime.openOptionsPage();
      } catch {
        /* swallow — the dispatched event below lets the host recover. */
      }
    }
    // Do NOT close the dialog here — the host (task 39.3) decides
    // whether to swap to the options page or keep the modal up while
    // the user reviews settings. Emitting the event without closing
    // keeps the disclosure visible if the host opens settings in a
    // new tab.
    this.dispatchEvent(
      new CustomEvent<Record<string, never>>('open-settings', {
        detail: {},
        bubbles: true,
        composed: true,
      }),
    );
  };
}

if (
  typeof customElements !== 'undefined' &&
  !customElements.get('fl-disclosure-modal')
) {
  withBoundary(FlDisclosureModal.prototype, 'connectedCallback');
  withBoundary(FlDisclosureModal.prototype, 'disconnectedCallback');
  customElements.define('fl-disclosure-modal', FlDisclosureModal);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-disclosure-modal': FlDisclosureModal;
  }
  interface HTMLElementEventMap {
    acknowledge: CustomEvent<Record<string, never>>;
    'open-settings': CustomEvent<Record<string, never>>;
  }
}
