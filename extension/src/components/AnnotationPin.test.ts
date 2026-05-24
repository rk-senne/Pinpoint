// @vitest-environment jsdom
/**
 * Unit tests for `<fl-annotation-pin>`.
 *
 * Validates Requirements 31.2, 31.3:
 *   - Per-pin Custom Element extending HTMLElement with an open Shadow Root
 *   - `annotation` property setter updates the rendered pin number and the
 *     `data-severity` attribute that drives the severity background via the
 *     shared `--fl-severity-*` CSS Custom Properties
 *   - Click on the host element emits a bubbling, composed `pin-click`
 *     CustomEvent whose `detail.annotationId` matches the current annotation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import './AnnotationPin';
import type { AnnotationPin } from './AnnotationPin';
import type { Annotation, Severity } from '@pinpoint/shared';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? 'a1',
    projectId: 'p1',
    pageId: 'page1',
    type: 'note',
    severity: overrides.severity ?? 'critical',
    status: 'active',
    body: 'hello',
    authorId: 'u1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    target: {
      cssSelector: 'body',
      xpath: '/html/body',
      pageX: 10,
      pageY: 20,
      tagName: 'BODY',
      textSnippet: '',
    },
    environment: {
      browserFamily: 'Chrome',
      browserVersion: '124',
      osFamily: 'macOS',
      osVersion: '14',
      deviceType: 'desktop',
      userAgentRaw: 'test-ua',
    },
    pinNumber: overrides.pinNumber ?? 7,
    ...overrides,
  };
}

beforeAll(() => {
  // The custom-element registration happens as a side effect of the import
  // above; assert the global was wired so subsequent tests can rely on it.
  expect(customElements.get('fl-annotation-pin')).toBeDefined();
});

describe('<fl-annotation-pin>', () => {
  it('is a Custom Element subclass of HTMLElement with an open Shadow Root', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    expect(pin).toBeInstanceOf(HTMLElement);
    expect(pin.shadowRoot).not.toBeNull();
    expect(pin.shadowRoot?.mode).toBe('open');
  });

  it('renders the pin number into the Shadow Root when annotation is set', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    pin.annotation = makeAnnotation({ pinNumber: 42 });

    const numberEl = pin.shadowRoot?.querySelector('.pin-number');
    expect(numberEl?.textContent).toBe('42');
  });

  it('updates the rendered number when the annotation property is reassigned', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    pin.annotation = makeAnnotation({ pinNumber: 1 });
    expect(pin.shadowRoot?.querySelector('.pin-number')?.textContent).toBe('1');

    pin.annotation = makeAnnotation({ id: 'a1', pinNumber: 9 });
    expect(pin.shadowRoot?.querySelector('.pin-number')?.textContent).toBe('9');
  });

  it.each<Severity>(['critical', 'major', 'minor', 'informational'])(
    'mirrors the annotation severity onto data-severity ("%s") so the host picks up --fl-severity-<severity>',
    (severity) => {
      const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
      pin.annotation = makeAnnotation({ severity });

      // The `data-severity` host attribute is what the `:host([data-severity=…])`
      // rules in the shared stylesheet hook into. Asserting on the attribute
      // (not on `getComputedStyle`) keeps the test deterministic in jsdom,
      // which does not resolve CSS Custom Properties through `:host` selectors.
      expect(pin.dataset.severity).toBe(severity);
      expect(pin.getAttribute('data-severity')).toBe(severity);
    },
  );

  it('exposes the annotation id via data-annotation-id for delegation', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    pin.annotation = makeAnnotation({ id: 'abc123' });
    expect(pin.dataset.annotationId).toBe('abc123');
  });

  it('clears rendered state when annotation is set to null', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    pin.annotation = makeAnnotation({ pinNumber: 5, severity: 'major' });
    expect(pin.shadowRoot?.querySelector('.pin-number')?.textContent).toBe('5');
    expect(pin.dataset.severity).toBe('major');

    pin.annotation = null;
    expect(pin.shadowRoot?.querySelector('.pin-number')?.textContent).toBe('');
    expect(pin.dataset.severity).toBeUndefined();
  });

  it('sets role="button" and an accessible aria-label derived from the pin number', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    pin.annotation = makeAnnotation({ pinNumber: 3 });
    document.body.appendChild(pin);

    expect(pin.getAttribute('role')).toBe('button');
    expect(pin.getAttribute('aria-label')).toBe('Annotation pin 3');

    pin.remove();
  });

  it('emits a bubbling, composed pin-click CustomEvent on click with the annotation id', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    pin.annotation = makeAnnotation({ id: 'annotation-7' });
    document.body.appendChild(pin);

    const events: CustomEvent<{ annotationId: string }>[] = [];
    document.body.addEventListener('pin-click', (e) => {
      events.push(e as CustomEvent<{ annotationId: string }>);
    });

    pin.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.detail).toEqual({ annotationId: 'annotation-7' });
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);

    pin.remove();
  });

  it('does not emit pin-click when no annotation has been assigned', () => {
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    document.body.appendChild(pin);

    let count = 0;
    document.body.addEventListener('pin-click', () => {
      count += 1;
    });

    pin.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(count).toBe(0);
    pin.remove();
  });

  it('stops the click event from bubbling to the underlying page', () => {
    // Req 31.3: the pin owns the click; the Extension overlay's
    // host-page click handler (which would otherwise interpret the click
    // as "place a new annotation") MUST NOT see it.
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    pin.annotation = makeAnnotation();
    document.body.appendChild(pin);

    let bubbledClicks = 0;
    document.addEventListener('click', () => {
      bubbledClicks += 1;
    });

    pin.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(bubbledClicks).toBe(0);
    pin.remove();
  });

  it('adopts the shared stylesheet (or falls back to a <style> tag) so theme variables are in scope', () => {
    // In environments without constructable CSSStyleSheet (jsdom historically
    // lacks `replaceSync`), `adoptStyles()` appends a `<style>` element.
    // Either path leaves the Shadow Root with theme styles available.
    const pin = document.createElement('fl-annotation-pin') as AnnotationPin;
    const root = pin.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });
});
