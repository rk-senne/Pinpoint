// @vitest-environment jsdom
/**
 * Unit tests for `<fl-cluster-pin>`.
 *
 * Validates Requirement 52.1 (the visual portion delivered by task 44.2):
 *   - Custom Element subclass of HTMLElement with an open Shadow Root
 *   - Adopts the shared stylesheet (or `<style>` fallback under jsdom)
 *   - `count`, `pinIds`, and `severity` property setters render the badge,
 *     reflect to host attributes, and drive the severity background color
 *     via `data-severity` → `--fl-severity-*`
 *   - `pin-ids` HTML attribute hydrates the property as a comma-separated
 *     list
 *   - Click on the host emits a bubbling, composed `cluster-click`
 *     CustomEvent whose `detail.pinIds` matches the current cluster
 */
import { describe, it, expect, beforeAll } from 'vitest';
import './ClusterPin';
import type { ClusterPin } from './ClusterPin';
import type { Severity } from '@pinpoint/shared';

beforeAll(() => {
  // Registration happens as a side effect of the import above; assert the
  // global was wired so subsequent tests can rely on it.
  expect(customElements.get('fl-cluster-pin')).toBeDefined();
});

describe('<fl-cluster-pin>', () => {
  it('is a Custom Element subclass of HTMLElement with an open Shadow Root', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    expect(cluster).toBeInstanceOf(HTMLElement);
    expect(cluster.shadowRoot).not.toBeNull();
    expect(cluster.shadowRoot?.mode).toBe('open');
  });

  it('renders the count into the Shadow Root and reflects to data-count', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 3;

    const countEl = cluster.shadowRoot?.querySelector('.cluster-count');
    expect(countEl?.textContent).toBe('3');
    expect(cluster.dataset.count).toBe('3');
  });

  it('updates the rendered count when the property is reassigned', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 2;
    expect(cluster.shadowRoot?.querySelector('.cluster-count')?.textContent).toBe('2');

    cluster.count = 12;
    expect(cluster.shadowRoot?.querySelector('.cluster-count')?.textContent).toBe('12');
    expect(cluster.dataset.count).toBe('12');
  });

  it('clamps a negative or non-finite count to 0', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = -5;
    expect(cluster.count).toBe(0);
    cluster.count = Number.NaN;
    expect(cluster.count).toBe(0);
  });

  it('floors fractional counts to an integer (defensive against bad inputs)', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 4.7;
    expect(cluster.count).toBe(4);
    expect(cluster.shadowRoot?.querySelector('.cluster-count')?.textContent).toBe('4');
  });

  it.each<Severity>(['critical', 'major', 'minor', 'informational'])(
    'mirrors severity ("%s") onto data-severity so the host picks up --fl-severity-<severity>',
    (severity) => {
      const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
      cluster.severity = severity;

      // Asserting on the attribute (not on `getComputedStyle`) keeps the
      // test deterministic in jsdom, which does not resolve CSS Custom
      // Properties through `:host` selectors.
      expect(cluster.dataset.severity).toBe(severity);
      expect(cluster.getAttribute('data-severity')).toBe(severity);
    },
  );

  it('clears the severity attribute when severity is set to null', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.severity = 'critical';
    expect(cluster.dataset.severity).toBe('critical');

    cluster.severity = null;
    expect(cluster.dataset.severity).toBeUndefined();
    expect(cluster.hasAttribute('data-severity')).toBe(false);
  });

  it('ignores invalid severity values and falls back to no data-severity', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    // Force an invalid value past the type system to mirror what would
    // happen if a future caller wrote raw user data into the property.
    (cluster as unknown as { severity: unknown }).severity = 'extreme';
    expect(cluster.severity).toBeNull();
    expect(cluster.hasAttribute('data-severity')).toBe(false);
  });

  it('accepts pinIds as an array and reflects to the pin-ids attribute', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.pinIds = ['a1', 'a2', 'a3'];
    expect(cluster.pinIds).toEqual(['a1', 'a2', 'a3']);
    expect(cluster.getAttribute('pin-ids')).toBe('a1,a2,a3');
  });

  it('returns a defensive copy of pinIds so callers cannot mutate internals', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.pinIds = ['a1', 'a2'];
    const snapshot = cluster.pinIds;
    snapshot.push('a3');
    expect(cluster.pinIds).toEqual(['a1', 'a2']);
  });

  it('accepts a comma-separated string via the property setter', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.pinIds = 'a1, a2 ,a3';
    expect(cluster.pinIds).toEqual(['a1', 'a2', 'a3']);
  });

  it('hydrates pinIds from the pin-ids HTML attribute', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.setAttribute('pin-ids', 'x1,x2,x3');
    expect(cluster.pinIds).toEqual(['x1', 'x2', 'x3']);
  });

  it('clears the pin-ids attribute when pinIds is set to an empty array', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.pinIds = ['a1', 'a2'];
    cluster.pinIds = [];
    expect(cluster.hasAttribute('pin-ids')).toBe(false);
  });

  it('sets role="button" and an accessible aria-label derived from the count', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 5;
    document.body.appendChild(cluster);

    expect(cluster.getAttribute('role')).toBe('button');
    expect(cluster.getAttribute('aria-label')).toBe('Cluster of 5 annotations');

    cluster.remove();
  });

  it('emits a bubbling, composed cluster-click CustomEvent on click with the contained pin ids', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 2;
    cluster.pinIds = ['ann-1', 'ann-2'];
    document.body.appendChild(cluster);

    const events: CustomEvent<{ pinIds: string[] }>[] = [];
    document.body.addEventListener('cluster-click', (e) => {
      events.push(e as CustomEvent<{ pinIds: string[] }>);
    });

    cluster.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.detail).toEqual({ pinIds: ['ann-1', 'ann-2'] });
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);

    cluster.remove();
  });

  it('emits a fresh copy of pinIds in the event detail so listeners cannot mutate state', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.pinIds = ['a1', 'a2'];
    document.body.appendChild(cluster);

    let captured: string[] | null = null;
    document.body.addEventListener('cluster-click', (e) => {
      captured = (e as CustomEvent<{ pinIds: string[] }>).detail.pinIds;
    });

    cluster.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(captured).toEqual(['a1', 'a2']);
    captured!.push('a3');
    expect(cluster.pinIds).toEqual(['a1', 'a2']);

    cluster.remove();
  });

  it('stops the click event from bubbling to the underlying page', () => {
    // Mirrors `<fl-annotation-pin>`: the cluster owns the click; the page
    // beneath must not interpret it as "place a new annotation here".
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 2;
    cluster.pinIds = ['a1', 'a2'];
    document.body.appendChild(cluster);

    let bubbledClicks = 0;
    document.addEventListener('click', () => {
      bubbledClicks += 1;
    });

    cluster.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(bubbledClicks).toBe(0);
    cluster.remove();
  });

  it('adopts the shared stylesheet (or falls back to a <style> tag) so theme variables are in scope', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    const root = cluster.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });

  it('is keyboard-focusable by default (tabindex=0)', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    document.body.appendChild(cluster);
    expect(cluster.getAttribute('tabindex')).toBe('0');
    cluster.remove();
  });

  it('emits a cluster-click event when Enter is pressed on the focused pin', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 2;
    cluster.pinIds = ['ann-1', 'ann-2'];
    document.body.appendChild(cluster);

    const events: CustomEvent<{ pinIds: string[] }>[] = [];
    document.body.addEventListener('cluster-click', (e) => {
      events.push(e as CustomEvent<{ pinIds: string[] }>);
    });

    cluster.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].detail.pinIds).toEqual(['ann-1', 'ann-2']);

    cluster.remove();
  });

  it('emits a cluster-click event when Space is pressed and prevents default scroll', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.count = 2;
    cluster.pinIds = ['ann-1', 'ann-2'];
    document.body.appendChild(cluster);

    const events: CustomEvent[] = [];
    document.body.addEventListener('cluster-click', (e) => events.push(e as CustomEvent));

    const ev = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    cluster.dispatchEvent(ev);

    expect(events).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);

    cluster.remove();
  });

  it('does not emit cluster-click for keys other than Enter / Space', () => {
    const cluster = document.createElement('fl-cluster-pin') as ClusterPin;
    cluster.pinIds = ['ann-1'];
    document.body.appendChild(cluster);

    const events: CustomEvent[] = [];
    document.body.addEventListener('cluster-click', (e) => events.push(e as CustomEvent));

    cluster.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }),
    );
    cluster.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }),
    );

    expect(events).toHaveLength(0);
    cluster.remove();
  });
});
