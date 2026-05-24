// @vitest-environment jsdom
/**
 * Unit tests for `<fl-disclosure-modal>` (task 39.1, Req 47.1; task 39.3,
 * Req 47.2).
 *
 * Coverage:
 *   - Renders one `<li>` per canonical data category from
 *     `DATA_CATEGORIES` (the single source of truth re-used by the
 *     consumer popover).
 *   - Renders a "Privacy policy" `<a>` with `target="_blank"` and a
 *     `rel` containing `noopener` (task 39.3, Req 47.2).
 *   - Clicking the "Acknowledge" button emits a bubbling, composed
 *     `acknowledge` `CustomEvent` and closes the dialog.
 *   - Clicking the "Open Settings" button emits a bubbling, composed
 *     `open-settings` `CustomEvent`.
 *   - Clicking the "Open Settings" button calls
 *     `chrome.runtime.openOptionsPage` when the runtime API is
 *     available (task 39.3, Req 47.2).
 *   - When `chrome.runtime.openOptionsPage` is unavailable (jsdom
 *     default), the click still emits the `open-settings` event so
 *     the host can fall back.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './DisclosureModal';
import {
  DATA_CATEGORIES,
  FlDisclosureModal,
  PRIVACY_POLICY_URL,
} from './DisclosureModal';

beforeAll(() => {
  // The customElements registration runs as a side effect of the import
  // above. Confirm it landed so subsequent tests can rely on it.
  expect(customElements.get('fl-disclosure-modal')).toBeDefined();
});

function mount(): FlDisclosureModal {
  const el = document.createElement('fl-disclosure-modal') as FlDisclosureModal;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  // Reset the DOM between specs so a leaked element from a prior test
  // does not pollute the next assertion.
  document.body.innerHTML = '';
});

describe('<fl-disclosure-modal>', () => {
  it('is a Custom Element subclass of HTMLElement with an open Shadow Root', () => {
    const el = mount();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
  });

  it('renders one <li> per DATA_CATEGORIES entry, in the same order', () => {
    const el = mount();
    const items = Array.from(
      el.shadowRoot!.querySelectorAll<HTMLLIElement>('ul.fl-disclosure-list > li'),
    );
    expect(items).toHaveLength(DATA_CATEGORIES.length);
    for (let i = 0; i < DATA_CATEGORIES.length; i += 1) {
      const expected = DATA_CATEGORIES[i];
      const li = items[i];
      expect(li.dataset.category).toBe(expected.id);
      // The label appears in a `<strong>`; description in a `<span>`.
      // Assert against `textContent` so we are robust to whitespace
      // changes in the rendered template.
      const strong = li.querySelector('strong');
      const span = li.querySelector('span');
      expect(strong?.textContent).toBe(expected.label);
      expect(span?.textContent).toBe(expected.description);
    }
  });

  it('lists every required data category from Req 47.1', () => {
    // The acceptance criterion calls out: annotation body / target
    // selector, screenshot, console buffer, network buffer, environment
    // metadata, page URL, and (per task 39.1) PII redaction rectangles.
    // Asserting on the canonical id set keeps this test stable against
    // copy edits to the displayed labels.
    const ids = DATA_CATEGORIES.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        'console',
        'dom-target',
        'environment',
        'network',
        'page-url',
        'pii-rects',
        'screenshot',
      ].sort(),
    );
  });

  it('opens via show() — the dialog reflects the open state', () => {
    const el = mount();
    expect(el.open).toBe(false);
    el.show();
    expect(el.open).toBe(true);
  });

  it('emits a bubbling, composed acknowledge CustomEvent when the Acknowledge button is clicked', () => {
    const el = mount();
    el.show();

    const events: CustomEvent[] = [];
    document.body.addEventListener('acknowledge', (e) => {
      events.push(e as CustomEvent);
    });

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      'button[data-action="acknowledge"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();

    expect(events).toHaveLength(1);
    expect(events[0].bubbles).toBe(true);
    expect(events[0].composed).toBe(true);
    // Acknowledging closes the dialog so the popover open flow can
    // render its own content over the same surface.
    expect(el.open).toBe(false);
  });

  it('emits a bubbling, composed open-settings CustomEvent when the Open Settings button is clicked', () => {
    const el = mount();
    el.show();

    const events: CustomEvent[] = [];
    document.body.addEventListener('open-settings', (e) => {
      events.push(e as CustomEvent);
    });

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      'button[data-action="open-settings"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();

    expect(events).toHaveLength(1);
    expect(events[0].bubbles).toBe(true);
    expect(events[0].composed).toBe(true);
    // Open Settings does NOT close the dialog — the host (task 39.3)
    // decides whether to keep the disclosure visible alongside the
    // settings page.
    expect(el.open).toBe(true);
  });

  it('renders a Privacy policy <a> pointed at PRIVACY_POLICY_URL with rel="noopener noreferrer" and target="_blank"', () => {
    // Task 39.3 / Req 47.2 — the disclosure body must surface a link
    // to the Pinpoint privacy policy. The `target="_blank"` +
    // `rel="noopener noreferrer"` combo is the standard hardening for
    // cross-origin links opened in a new tab: it prevents the linked
    // page from getting a `window.opener` handle back to the host
    // page (reverse tabnabbing) and stops the Referer header from
    // leaking the host URL. We assert the URL against the exported
    // constant so a future swap of the placeholder URL only needs a
    // one-line change in the source, not a parallel test edit.
    const el = mount();
    const link = el.shadowRoot!.querySelector<HTMLAnchorElement>(
      'a.fl-disclosure-privacy-link',
    );
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(PRIVACY_POLICY_URL);
    expect(link!.getAttribute('target')).toBe('_blank');
    const rel = link!.getAttribute('rel') ?? '';
    // Use a token-set check rather than an exact string match so a
    // future addition of e.g. `external` does not break the test.
    const relTokens = rel.split(/\s+/).filter(Boolean);
    expect(relTokens).toContain('noopener');
    expect(relTokens).toContain('noreferrer');
    // The visible label should mention "Privacy policy" so the link is
    // recognisable; we lower-case to be robust to capitalization.
    expect((link!.textContent ?? '').toLowerCase()).toContain('privacy policy');
  });

  it('calls chrome.runtime.openOptionsPage when available, in addition to dispatching open-settings', () => {
    // Task 39.3 / Req 47.2 — when the extension runtime is reachable,
    // clicking "Open Settings" should land the user on the options
    // page directly. We mock just `chrome.runtime.openOptionsPage`
    // here (jsdom provides neither `chrome` nor any runtime APIs by
    // default) and clean it up after the assertion so a later test
    // can verify the no-runtime fallback.
    const openOptionsPage = vi.fn();
    const globalAny = globalThis as unknown as {
      chrome?: { runtime?: { openOptionsPage?: () => void } };
    };
    const previousChrome = globalAny.chrome;
    globalAny.chrome = { runtime: { openOptionsPage } };
    try {
      const el = mount();
      el.show();

      const events: CustomEvent[] = [];
      document.body.addEventListener('open-settings', (e) => {
        events.push(e as CustomEvent);
      });

      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(
        'button[data-action="open-settings"]',
      );
      btn!.click();

      // The runtime API is invoked exactly once with no arguments.
      expect(openOptionsPage).toHaveBeenCalledTimes(1);
      expect(openOptionsPage).toHaveBeenCalledWith();
      // The custom event still fires so consumers (the popover host)
      // can react regardless.
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('open-settings');
    } finally {
      if (previousChrome === undefined) {
        delete globalAny.chrome;
      } else {
        globalAny.chrome = previousChrome;
      }
    }
  });

  it('still dispatches open-settings when chrome.runtime.openOptionsPage is unavailable (jsdom default)', () => {
    // Task 39.3 / Req 47.2 — the no-runtime fallback. We do NOT install
    // a chrome stub; jsdom leaves `globalThis.chrome` undefined so
    // the optional-chaining guard inside the handler short-circuits
    // and the runtime call is skipped. The event must still fire so
    // the host (or, in tests, an arbitrary listener) can react.
    const globalAny = globalThis as unknown as {
      chrome?: { runtime?: { openOptionsPage?: () => void } };
    };
    expect(globalAny.chrome?.runtime?.openOptionsPage).toBeUndefined();

    const el = mount();
    el.show();

    const events: CustomEvent[] = [];
    document.body.addEventListener('open-settings', (e) => {
      events.push(e as CustomEvent);
    });

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      'button[data-action="open-settings"]',
    );
    expect(() => btn!.click()).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('open-settings');
  });

  it('survives a chrome.runtime.openOptionsPage that throws — the event still fires', () => {
    // Belt-and-braces: Chrome surfaces "Extension context invalidated"
    // as a thrown error when the user reloads the extension mid-click.
    // The handler swallows the throw so the popover open path is
    // never blocked, and the event still reaches the host.
    const openOptionsPage = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    const globalAny = globalThis as unknown as {
      chrome?: { runtime?: { openOptionsPage?: () => void } };
    };
    const previousChrome = globalAny.chrome;
    globalAny.chrome = { runtime: { openOptionsPage } };
    try {
      const el = mount();
      el.show();

      const events: CustomEvent[] = [];
      document.body.addEventListener('open-settings', (e) => {
        events.push(e as CustomEvent);
      });

      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(
        'button[data-action="open-settings"]',
      );
      expect(() => btn!.click()).not.toThrow();
      expect(openOptionsPage).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
    } finally {
      if (previousChrome === undefined) {
        delete globalAny.chrome;
      } else {
        globalAny.chrome = previousChrome;
      }
    }
  });

  it('does not double-open when show() is called while already open', () => {
    const el = mount();
    el.show();
    expect(el.open).toBe(true);
    // Second call should be a no-op rather than throwing
    // ("InvalidStateError: dialog already open" is what the spec would
    // otherwise raise). The `if (this.#dialog.open) return;` guard
    // covers this.
    expect(() => el.show()).not.toThrow();
    expect(el.open).toBe(true);
  });

  it('close() flips the dialog closed', () => {
    const el = mount();
    el.show();
    expect(el.open).toBe(true);
    el.close();
    expect(el.open).toBe(false);
  });

  it('adopts the shared stylesheet (or falls back to a <style> tag)', () => {
    const el = mount();
    const root = el.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });
});
