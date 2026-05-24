// @vitest-environment jsdom
/**
 * Unit tests for `<fl-floating-toolbar>`.
 *
 * Validates Requirements 31.2, 31.3:
 *   - HTMLElement subclass with an open Shadow Root
 *   - Adopts the shared stylesheet (or appends a `<style>` fallback)
 *   - Renders the four toolbar buttons (close, avatar, share, link) from a
 *     single cloned `<template>`
 *   - Click on each button dispatches a bubbling, composed `CustomEvent`
 *     whose `type` matches the action name
 *   - `connectedCallback` wires the listeners and `disconnectedCallback`
 *     removes them so a disconnected element no longer reacts to clicks
 *   - `avatarUrl` property switches between an `<img>` and the emoji
 *     fallback (preserving the legacy React behavior)
 *   - Click events do not bubble to the underlying page
 */
import { describe, it, expect, beforeAll } from 'vitest';
import './FloatingToolbar';
import type { FlFloatingToolbar } from './FloatingToolbar';

beforeAll(() => {
  // Registration is a side effect of the import above; assert the global
  // was wired so subsequent tests can rely on `document.createElement`
  // returning the proper instance.
  expect(customElements.get('fl-floating-toolbar')).toBeDefined();
});

function makeToolbar(): FlFloatingToolbar {
  const t = document.createElement('fl-floating-toolbar') as FlFloatingToolbar;
  document.body.appendChild(t);
  return t;
}

describe('<fl-floating-toolbar>', () => {
  it('is a Custom Element subclass of HTMLElement with an open Shadow Root', () => {
    const t = document.createElement('fl-floating-toolbar') as FlFloatingToolbar;
    expect(t).toBeInstanceOf(HTMLElement);
    expect(t.shadowRoot).not.toBeNull();
    expect(t.shadowRoot?.mode).toBe('open');
  });

  it('renders the four toolbar buttons (close, avatar, share, link) from the template', () => {
    const t = makeToolbar();
    const root = t.shadowRoot!;
    expect(root.querySelector('button[data-action="close"]')).not.toBeNull();
    expect(root.querySelector('button[data-action="avatar"]')).not.toBeNull();
    expect(root.querySelector('button[data-action="share"]')).not.toBeNull();
    expect(root.querySelector('button[data-action="link"]')).not.toBeNull();
    t.remove();
  });

  it('exposes role="toolbar" on the inner toolbar element for accessibility', () => {
    const t = makeToolbar();
    const inner = t.shadowRoot!.querySelector('.fl-toolbar');
    expect(inner?.getAttribute('role')).toBe('toolbar');
    expect(inner?.getAttribute('aria-label')).toBe('Pinpoint toolbar');
    t.remove();
  });

  it('gives every button child an accessible name via aria-label', () => {
    const t = makeToolbar();
    const buttons = Array.from(
      t.shadowRoot!.querySelectorAll<HTMLButtonElement>('.fl-toolbar button'),
    );
    expect(buttons.length).toBe(4);
    for (const btn of buttons) {
      const name = btn.getAttribute('aria-label');
      expect(name).toBeTruthy();
      expect((name ?? '').length).toBeGreaterThan(0);
    }
    t.remove();
  });

  it('cycles focus among the toolbar buttons with ArrowRight / ArrowLeft', () => {
    const t = makeToolbar();
    const root = t.shadowRoot!;
    const close = root.querySelector('button[data-action="close"]') as HTMLButtonElement;
    const avatar = root.querySelector('button[data-action="avatar"]') as HTMLButtonElement;
    const share = root.querySelector('button[data-action="share"]') as HTMLButtonElement;
    const link = root.querySelector('button[data-action="link"]') as HTMLButtonElement;
    const toolbar = root.querySelector('.fl-toolbar') as HTMLElement;

    close.focus();
    expect(root.activeElement).toBe(close);

    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(root.activeElement).toBe(avatar);

    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(root.activeElement).toBe(share);

    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(root.activeElement).toBe(avatar);

    // Wrap-around at the ends.
    close.focus();
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(root.activeElement).toBe(link);

    link.focus();
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(root.activeElement).toBe(close);

    // Home / End jump to the extremes.
    avatar.focus();
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(root.activeElement).toBe(close);
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(root.activeElement).toBe(link);

    t.remove();
  });

  it('uses a roving-tabindex pattern: only one button has tabindex=0 at a time', () => {
    const t = makeToolbar();
    const root = t.shadowRoot!;
    const close = root.querySelector('button[data-action="close"]') as HTMLButtonElement;
    const avatar = root.querySelector('button[data-action="avatar"]') as HTMLButtonElement;
    const share = root.querySelector('button[data-action="share"]') as HTMLButtonElement;
    const link = root.querySelector('button[data-action="link"]') as HTMLButtonElement;
    const toolbar = root.querySelector('.fl-toolbar') as HTMLElement;
    const buttons = [close, avatar, share, link];

    const tabIndexes = (): number[] => buttons.map((b) => b.tabIndex);

    // Initial: only the first (close) button is tabbable.
    expect(tabIndexes()).toEqual([0, -1, -1, -1]);

    // ArrowRight rotates the active tabstop along with focus.
    close.focus();
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(root.activeElement).toBe(avatar);
    expect(tabIndexes()).toEqual([-1, 0, -1, -1]);

    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabIndexes()).toEqual([-1, -1, 0, -1]);

    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(tabIndexes()).toEqual([-1, -1, -1, 0]);

    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(tabIndexes()).toEqual([0, -1, -1, -1]);

    t.remove();
  });

  it.each<['close' | 'avatar' | 'share' | 'link']>([
    ['close'],
    ['avatar'],
    ['share'],
    ['link'],
  ])(
    'dispatches a bubbling, composed "%s" CustomEvent when the matching button is clicked',
    (action) => {
      const t = makeToolbar();
      const events: Event[] = [];
      document.body.addEventListener(action, (e) => {
        events.push(e);
      });

      const btn = t.shadowRoot!.querySelector(
        `button[data-action="${action}"]`,
      ) as HTMLButtonElement;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.type).toBe(action);
      expect(evt.bubbles).toBe(true);
      expect(evt.composed).toBe(true);

      t.remove();
    },
  );

  it('renders the emoji fallback in the avatar button by default', () => {
    const t = makeToolbar();
    const avatarBtn = t.shadowRoot!.querySelector(
      'button[data-action="avatar"]',
    ) as HTMLButtonElement;
    expect(avatarBtn.querySelector('img')).toBeNull();
    expect(avatarBtn.textContent?.trim()).toBe('👤');
    t.remove();
  });

  it('renders an <img> avatar when avatarUrl is set, and reverts to fallback when cleared', () => {
    const t = makeToolbar();
    t.avatarUrl = 'https://example.test/avatar.png';

    const avatarBtn = t.shadowRoot!.querySelector(
      'button[data-action="avatar"]',
    ) as HTMLButtonElement;
    const img = avatarBtn.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.src).toBe('https://example.test/avatar.png');
    expect(img!.alt).toBe('avatar');

    t.avatarUrl = null;
    expect(avatarBtn.querySelector('img')).toBeNull();
    expect(avatarBtn.textContent?.trim()).toBe('👤');

    t.remove();
  });

  it('treats an empty-string avatarUrl as "no avatar" and uses the fallback', () => {
    const t = makeToolbar();
    t.avatarUrl = '';
    const avatarBtn = t.shadowRoot!.querySelector(
      'button[data-action="avatar"]',
    ) as HTMLButtonElement;
    expect(avatarBtn.querySelector('img')).toBeNull();
    expect(t.avatarUrl).toBeNull();
    t.remove();
  });

  it('removes click listeners on disconnect so a disconnected element does not dispatch events', () => {
    const t = makeToolbar();
    const btn = t.shadowRoot!.querySelector(
      'button[data-action="close"]',
    ) as HTMLButtonElement;

    let count = 0;
    const listener = (): void => {
      count += 1;
    };
    document.body.addEventListener('close', listener);

    // Sanity: connected element dispatches.
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(count).toBe(1);

    // Detach. After disconnectedCallback runs, the click handler on the
    // button should be removed, so a synthetic click no longer dispatches
    // a `close` CustomEvent on the host.
    t.remove();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(count).toBe(1);

    document.body.removeEventListener('close', listener);
  });

  it('re-wires listeners when the element is reconnected to the DOM', () => {
    const t = makeToolbar();
    const closeBtn = t.shadowRoot!.querySelector(
      'button[data-action="close"]',
    ) as HTMLButtonElement;

    let count = 0;
    document.body.addEventListener('close', () => {
      count += 1;
    });

    // Disconnect, then reconnect. After reconnection the click listener
    // should be active again per `connectedCallback`.
    t.remove();
    document.body.appendChild(t);

    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(count).toBe(1);

    t.remove();
  });

  it('stops button clicks from bubbling to the document so the underlying page does not see them', () => {
    // Req 31.3: the toolbar owns the click; the Extension overlay's
    // host-page click handler (which would otherwise interpret the click
    // as "place a new annotation") MUST NOT see it.
    const t = makeToolbar();
    let documentClicks = 0;
    document.addEventListener('click', () => {
      documentClicks += 1;
    });

    const closeBtn = t.shadowRoot!.querySelector(
      'button[data-action="close"]',
    ) as HTMLButtonElement;
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(documentClicks).toBe(0);
    t.remove();
  });

  it('adopts the shared stylesheet (or falls back to a <style> tag) so theme variables are in scope', () => {
    const t = document.createElement('fl-floating-toolbar') as FlFloatingToolbar;
    const root = t.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });

  // ------------------------------------------------------------------ //
  // Offline banner (Req 44.1, task 36.8)                                //
  // ------------------------------------------------------------------ //

  describe('offline banner', () => {
    it('keeps the offline banner hidden by default (isOffline === false)', () => {
      const t = makeToolbar();
      const banner = t.shadowRoot!.querySelector(
        '.fl-offline-banner',
      ) as HTMLElement;
      expect(banner).not.toBeNull();
      expect(banner.hidden).toBe(true);
      expect(banner.hasAttribute('hidden')).toBe(true);
      expect(t.isOffline).toBe(false);
      t.remove();
    });

    it('shows the offline banner when isOffline=true and hides it when isOffline=false', () => {
      const t = makeToolbar();
      const banner = t.shadowRoot!.querySelector(
        '.fl-offline-banner',
      ) as HTMLElement;

      // Flip on.
      t.isOffline = true;
      expect(t.isOffline).toBe(true);
      expect(banner.hidden).toBe(false);
      expect(banner.hasAttribute('hidden')).toBe(false);
      // Banner copy mirrors design.md §"Offline behavior".
      expect(banner.textContent).toContain('Offline');

      // Flip off.
      t.isOffline = false;
      expect(t.isOffline).toBe(false);
      expect(banner.hidden).toBe(true);
      expect(banner.hasAttribute('hidden')).toBe(true);
      t.remove();
    });

    it('marks the banner as a polite live region (role="status", aria-live="polite") for assistive tech', () => {
      const t = makeToolbar();
      const banner = t.shadowRoot!.querySelector(
        '.fl-offline-banner',
      ) as HTMLElement;
      expect(banner.getAttribute('role')).toBe('status');
      expect(banner.getAttribute('aria-live')).toBe('polite');
      t.remove();
    });

    it('treats nullish values as "online" so an unset signal does not show the banner', () => {
      const t = makeToolbar();
      const banner = t.shadowRoot!.querySelector(
        '.fl-offline-banner',
      ) as HTMLElement;

      // Force visible, then assign nullish — should hide.
      t.isOffline = true;
      expect(banner.hidden).toBe(false);

      t.isOffline = null as unknown as boolean;
      expect(t.isOffline).toBe(false);
      expect(banner.hidden).toBe(true);

      t.isOffline = true;
      t.isOffline = undefined as unknown as boolean;
      expect(t.isOffline).toBe(false);
      expect(banner.hidden).toBe(true);
      t.remove();
    });
  });
});
