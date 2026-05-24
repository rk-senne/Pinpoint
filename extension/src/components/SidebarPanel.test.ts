// @vitest-environment jsdom
/**
 * Unit tests for `<fl-sidebar-panel>` (Requirement 31.3, task 17.6).
 *
 * Covers the four behaviors the task calls out:
 *   1. `annotations` property assignment renders the Active list (default
 *      tab) with one row per annotation whose `status` is `'active'` or
 *      `'in_progress'`.
 *   2. Clicking the Resolved tab swaps the visible list to annotations
 *      with `status === 'resolved'`. Tab counts in the button labels
 *      reflect the partition of the full annotations array.
 *   3. Clicking a list row dispatches a bubbling + composed
 *      `annotation-select` `CustomEvent` whose `detail.annotationId`
 *      matches the clicked row's annotation.
 *   4. Severity color is sourced from `--fl-severity-${severity}`: the
 *      severity dot's `data-severity` attribute carries the severity so
 *      the shared stylesheet's `.fl-severity-dot[data-severity=…]` rule
 *      can apply the CSS Custom Property. No hex codes are inlined.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import './SidebarPanel';
import { FlSidebarPanel, type AnnotationSelectEventDetail } from './SidebarPanel';
import type { Annotation, AnnotationStatus, Severity } from '@pinpoint/shared';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? `ann-${Math.random().toString(36).slice(2)}`,
    projectId: 'p1',
    pageId: 'page1',
    type: overrides.type ?? 'note',
    severity: overrides.severity ?? 'minor',
    status: overrides.status ?? 'active',
    body: overrides.body ?? 'a body',
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
    pinNumber: overrides.pinNumber ?? 1,
    ...overrides,
  };
}

function mount(): FlSidebarPanel {
  const el = document.createElement('fl-sidebar-panel') as FlSidebarPanel;
  document.body.appendChild(el);
  return el;
}

describe('<fl-sidebar-panel>', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is registered as a Custom Element with an open Shadow Root', () => {
    expect(customElements.get('fl-sidebar-panel')).toBe(FlSidebarPanel);
    const el = mount();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
  });

  it('defaults to the Active tab and renders both tab buttons with counts', () => {
    const el = mount();
    el.annotations = [
      makeAnnotation({ id: 'a1', status: 'active', pinNumber: 1 }),
      makeAnnotation({ id: 'a2', status: 'in_progress', pinNumber: 2 }),
      makeAnnotation({ id: 'a3', status: 'resolved', pinNumber: 3 }),
    ];

    expect(el.tab).toBe('active');

    const activeBtn = el.shadowRoot!.querySelector('button.fl-tab-active') as HTMLButtonElement;
    const resolvedBtn = el.shadowRoot!.querySelector('button.fl-tab-resolved') as HTMLButtonElement;
    expect(activeBtn.textContent).toBe('Active (2)');
    expect(resolvedBtn.textContent).toBe('Resolved (1)');
    expect(activeBtn.classList.contains('active')).toBe(true);
    expect(resolvedBtn.classList.contains('active')).toBe(false);
    expect(activeBtn.getAttribute('aria-selected')).toBe('true');
    expect(resolvedBtn.getAttribute('aria-selected')).toBe('false');
  });

  it('lists annotations whose status is active or in_progress under the Active tab', () => {
    const el = mount();
    el.annotations = [
      makeAnnotation({ id: 'a1', status: 'active', pinNumber: 1 }),
      makeAnnotation({ id: 'a2', status: 'in_progress', pinNumber: 2 }),
      makeAnnotation({ id: 'a3', status: 'resolved', pinNumber: 3 }),
    ];

    const ids = Array.from(
      el.shadowRoot!.querySelectorAll('li.fl-sidebar-item'),
    ).map((li) => (li as HTMLLIElement).dataset.annotationId);
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('switches to the Resolved tab and renders only resolved annotations on click', () => {
    const el = mount();
    el.annotations = [
      makeAnnotation({ id: 'a1', status: 'active' }),
      makeAnnotation({ id: 'a2', status: 'resolved' }),
      makeAnnotation({ id: 'a3', status: 'resolved' }),
    ];

    const resolvedBtn = el.shadowRoot!.querySelector('button.fl-tab-resolved') as HTMLButtonElement;
    resolvedBtn.click();

    expect(el.tab).toBe('resolved');
    expect(resolvedBtn.classList.contains('active')).toBe(true);
    expect(resolvedBtn.getAttribute('aria-selected')).toBe('true');

    const ids = Array.from(
      el.shadowRoot!.querySelectorAll('li.fl-sidebar-item'),
    ).map((li) => (li as HTMLLIElement).dataset.annotationId);
    expect(ids).toEqual(['a2', 'a3']);
  });

  it('renders pin number, type, and body inside each list row', () => {
    const el = mount();
    el.annotations = [
      makeAnnotation({
        id: 'a1',
        status: 'active',
        type: 'suggestion',
        pinNumber: 7,
        body: 'short body',
      }),
    ];

    const li = el.shadowRoot!.querySelector('li.fl-sidebar-item') as HTMLLIElement;
    expect(li.dataset.annotationId).toBe('a1');
    expect(li.querySelector('.fl-pin-number')!.textContent).toBe('#7');
    expect(li.querySelector('.fl-annotation-type')!.textContent).toBe('suggestion');
    expect(li.querySelector('.fl-annotation-body')!.textContent).toBe('short body');
  });

  it('truncates long bodies to 80 characters with an ellipsis', () => {
    const el = mount();
    const long = 'x'.repeat(120);
    el.annotations = [makeAnnotation({ id: 'a1', body: long })];
    const body = el.shadowRoot!.querySelector('.fl-annotation-body')!;
    expect(body.textContent).toBe(`${'x'.repeat(80)}…`);
  });

  it.each<Severity>(['critical', 'major', 'minor', 'informational'])(
    'mirrors the annotation severity onto the dot via data-severity ("%s") so --fl-severity-<severity> applies',
    (severity) => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1', severity })];
      const dot = el.shadowRoot!.querySelector('.fl-severity-dot') as HTMLSpanElement;
      expect(dot.dataset.severity).toBe(severity);
      expect(dot.getAttribute('data-severity')).toBe(severity);
    },
  );

  it('does not inline severity hex colors; the dot relies on CSS Custom Properties', () => {
    // Guard against a regression where someone reintroduces a SEVERITY_COLORS
    // map and assigns hex via inline `style`. The dot must rely on the shared
    // stylesheet's `--fl-severity-*` rules, not on `style.background`.
    const el = mount();
    el.annotations = [makeAnnotation({ id: 'a1', severity: 'critical' })];
    const dot = el.shadowRoot!.querySelector('.fl-severity-dot') as HTMLSpanElement;
    expect(dot.style.background).toBe('');
    expect(dot.style.backgroundColor).toBe('');
  });

  it('dispatches a bubbling + composed `annotation-select` event with the row id on click', () => {
    const el = mount();
    el.annotations = [
      makeAnnotation({ id: 'a1', status: 'active' }),
      makeAnnotation({ id: 'a2', status: 'active' }),
    ];

    const events: CustomEvent<AnnotationSelectEventDetail>[] = [];
    document.addEventListener('annotation-select', (e) => {
      events.push(e as CustomEvent<AnnotationSelectEventDetail>);
    });

    const rows = el.shadowRoot!.querySelectorAll('li.fl-sidebar-item');
    (rows[1] as HTMLLIElement).click();

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ annotationId: 'a2' });
    expect(events[0].bubbles).toBe(true);
    expect(events[0].composed).toBe(true);
  });

  it('dispatches `annotation-select` for clicks on inner row elements (delegation)', () => {
    const el = mount();
    el.annotations = [makeAnnotation({ id: 'a1', status: 'active' })];

    let received: AnnotationSelectEventDetail | null = null;
    el.addEventListener('annotation-select', (e) => {
      received = (e as CustomEvent<AnnotationSelectEventDetail>).detail;
    });

    const innerBody = el.shadowRoot!.querySelector('.fl-annotation-body') as HTMLDivElement;
    innerBody.click();

    expect(received).toEqual({ annotationId: 'a1' });
  });

  it('renders an empty placeholder when the active list is empty', () => {
    const el = mount();
    el.annotations = [makeAnnotation({ id: 'a1', status: 'resolved' })];
    const empty = el.shadowRoot!.querySelector('li.fl-sidebar-empty') as HTMLLIElement;
    expect(empty).toBeTruthy();
    expect(empty.textContent).toBe('No active annotations');
  });

  it('renders an empty placeholder when the resolved list is empty', () => {
    const el = mount();
    el.annotations = [makeAnnotation({ id: 'a1', status: 'active' })];
    const resolvedBtn = el.shadowRoot!.querySelector('button.fl-tab-resolved') as HTMLButtonElement;
    resolvedBtn.click();
    const empty = el.shadowRoot!.querySelector('li.fl-sidebar-empty') as HTMLLIElement;
    expect(empty.textContent).toBe('No resolved annotations');
  });

  it('treats null / undefined assignments to `annotations` as an empty list', () => {
    const el = mount();
    el.annotations = [makeAnnotation({ id: 'a1', status: 'active' })];
    el.annotations = null;
    expect(el.shadowRoot!.querySelectorAll('li.fl-sidebar-item').length).toBe(0);
    const activeBtn = el.shadowRoot!.querySelector('button.fl-tab-active') as HTMLButtonElement;
    expect(activeBtn.textContent).toBe('Active (0)');
  });

  it('reads back the assigned annotations via the property getter', () => {
    const el = mount();
    const a = makeAnnotation({ id: 'aX' });
    el.annotations = [a];
    expect(el.annotations.length).toBe(1);
    expect(el.annotations[0].id).toBe('aX');
  });

  it('emits a `close` CustomEvent when the close button is clicked', () => {
    const el = mount();
    let fired = 0;
    el.addEventListener('close', () => {
      fired += 1;
    });
    const closeBtn = el.shadowRoot!.querySelector('button.fl-close-btn') as HTMLButtonElement;
    closeBtn.click();
    expect(fired).toBe(1);
  });

  it('re-renders when annotations change after the initial assignment', () => {
    const el = mount();
    el.annotations = [makeAnnotation({ id: 'a1', status: 'active' })];
    expect(el.shadowRoot!.querySelectorAll('li.fl-sidebar-item').length).toBe(1);

    el.annotations = [
      makeAnnotation({ id: 'a1', status: 'active' }),
      makeAnnotation({ id: 'a2', status: 'active' }),
      makeAnnotation({ id: 'a3', status: 'resolved' }),
    ];
    expect(el.shadowRoot!.querySelectorAll('li.fl-sidebar-item').length).toBe(2);

    const activeBtn = el.shadowRoot!.querySelector('button.fl-tab-active') as HTMLButtonElement;
    const resolvedBtn = el.shadowRoot!.querySelector('button.fl-tab-resolved') as HTMLButtonElement;
    expect(activeBtn.textContent).toBe('Active (2)');
    expect(resolvedBtn.textContent).toBe('Resolved (1)');
  });

  it.each<AnnotationStatus>(['active', 'in_progress'])(
    'classifies status "%s" as Active',
    (status) => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1', status })];
      const ids = Array.from(
        el.shadowRoot!.querySelectorAll('li.fl-sidebar-item'),
      ).map((li) => (li as HTMLLIElement).dataset.annotationId);
      expect(ids).toEqual(['a1']);
    },
  );

  it('adopts the shared stylesheet (or falls back to a <style> tag)', () => {
    const el = mount();
    const root = el.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });

  describe('ARIA + keyboard navigation', () => {
    it('exposes role="listbox" on the inner <ol> with role="option" rows', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', status: 'active' }),
        makeAnnotation({ id: 'a2', status: 'active' }),
      ];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      expect(ol.getAttribute('role')).toBe('listbox');
      const items = el.shadowRoot!.querySelectorAll('li.fl-sidebar-item');
      expect(items).toHaveLength(2);
      for (const li of items) {
        expect(li.getAttribute('role')).toBe('option');
        expect((li as HTMLLIElement).id).toBeTruthy();
      }
    });

    it('highlights the first row by default and points aria-activedescendant at it', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', status: 'active' }),
        makeAnnotation({ id: 'a2', status: 'active' }),
      ];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      const items = el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-sidebar-item');
      expect(items[0].getAttribute('aria-selected')).toBe('true');
      expect(items[1].getAttribute('aria-selected')).toBe('false');
      expect(ol.getAttribute('aria-activedescendant')).toBe(items[0].id);
    });

    it('moves the highlight with ArrowDown / ArrowUp on the listbox', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', status: 'active' }),
        makeAnnotation({ id: 'a2', status: 'active' }),
        makeAnnotation({ id: 'a3', status: 'active' }),
      ];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      const items = () =>
        Array.from(
          el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-sidebar-item'),
        );

      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(items()[1].getAttribute('aria-selected')).toBe('true');
      expect(ol.getAttribute('aria-activedescendant')).toBe(items()[1].id);

      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(items()[2].getAttribute('aria-selected')).toBe('true');

      // Wrap past the end.
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(items()[0].getAttribute('aria-selected')).toBe('true');

      // Wrap before the start.
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(items()[2].getAttribute('aria-selected')).toBe('true');
    });

    it('Enter on the listbox dispatches `annotation-select` for the highlighted row', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', status: 'active' }),
        makeAnnotation({ id: 'a2', status: 'active' }),
      ];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      const events: AnnotationSelectEventDetail[] = [];
      el.addEventListener('annotation-select', (e) => {
        events.push((e as CustomEvent<AnnotationSelectEventDetail>).detail);
      });

      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(events).toEqual([{ annotationId: 'a2' }]);
    });

    it('Home / End jump the highlight to the first / last row', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', status: 'active' }),
        makeAnnotation({ id: 'a2', status: 'active' }),
        makeAnnotation({ id: 'a3', status: 'active' }),
      ];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      const items = () =>
        Array.from(
          el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-sidebar-item'),
        );

      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      expect(items()[2].getAttribute('aria-selected')).toBe('true');
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      expect(items()[0].getAttribute('aria-selected')).toBe('true');
    });

    it('clicking a row syncs the keyboard highlight before dispatching `annotation-select`', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', status: 'active' }),
        makeAnnotation({ id: 'a2', status: 'active' }),
      ];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      const items = el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-sidebar-item');
      items[1].click();

      expect(items[1].getAttribute('aria-selected')).toBe('true');
      expect(ol.getAttribute('aria-activedescendant')).toBe(items[1].id);
    });

    it('keydown on an empty list is a no-op', () => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1', status: 'resolved' })];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      const events: AnnotationSelectEventDetail[] = [];
      el.addEventListener('annotation-select', (e) => {
        events.push((e as CustomEvent<AnnotationSelectEventDetail>).detail);
      });
      // Active tab is empty.
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(events).toEqual([]);
    });

    it('rebuilding the list resets the highlight to the first surviving row', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', status: 'active' }),
        makeAnnotation({ id: 'a2', status: 'active' }),
        makeAnnotation({ id: 'a3', status: 'active' }),
      ];
      const ol = el.shadowRoot!.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      // Highlight is on a3.
      let items = el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-sidebar-item');
      expect(items[2].getAttribute('aria-selected')).toBe('true');

      // Switch to resolved tab — list rebuilds, highlight resets.
      el.annotations = [makeAnnotation({ id: 'r1', status: 'resolved' })];
      const resolvedBtn = el.shadowRoot!.querySelector(
        'button.fl-tab-resolved',
      ) as HTMLButtonElement;
      resolvedBtn.click();
      items = el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-sidebar-item');
      expect(items[0].getAttribute('aria-selected')).toBe('true');
    });
  });
});
