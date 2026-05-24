// @vitest-environment jsdom
/**
 * Unit tests for `<fl-cluster-list-popover>` (Requirement 52.2, task 44.3).
 *
 * Covers the behaviors task 44.3 calls out:
 *   1. Custom Element with an open Shadow Root that adopts the shared
 *      stylesheet (or `<style>` fallback under jsdom).
 *   2. `annotations` property assignment renders one focusable row per
 *      annotation with pin number, severity color dot, and the first line
 *      of the body. The shared `--fl-severity-${severity}` palette is used
 *      via `data-severity` (no hex codes inlined).
 *   3. Setting `target` to a non-null value opens the dialog and anchors
 *      it at `(pageX, pageY + 30)` like `<fl-popover>` does. Setting
 *      `target` to `null` closes it without firing `close` again.
 *   4. Clicking a row dispatches a bubbling + composed
 *      `annotation-select` `CustomEvent` whose `detail.annotationId`
 *      matches the row.
 *   5. Pressing Enter or Space on a focused row dispatches the same event;
 *      ArrowDown / ArrowUp move focus between rows with wrapping; Home /
 *      End jump to the first / last row.
 *   6. The dialog's native `close` event is forwarded as a `close`
 *      `CustomEvent` (bubbling + composed). Programmatic `close()` does
 *      the same.
 *   7. A click outside the dialog panel closes it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import './ClusterListPopover';
import {
  FlClusterListPopover,
  popoverTargetFromRect,
  type ClusterListAnnotationSelectDetail,
} from './ClusterListPopover';
import type { Annotation, Severity } from '@pinpoint/shared';

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

function mount(): FlClusterListPopover {
  const el = document.createElement(
    'fl-cluster-list-popover',
  ) as FlClusterListPopover;
  document.body.appendChild(el);
  return el;
}

beforeAll(() => {
  expect(customElements.get('fl-cluster-list-popover')).toBe(FlClusterListPopover);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('<fl-cluster-list-popover>', () => {
  describe('shape', () => {
    it('is a Custom Element subclass of HTMLElement with an open Shadow Root', () => {
      const el = mount();
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el).toBeInstanceOf(FlClusterListPopover);
      expect(el.shadowRoot).not.toBeNull();
      expect(el.shadowRoot?.mode).toBe('open');
    });

    it('renders a <dialog> panel and an empty <ul> list inside the Shadow Root', () => {
      const el = mount();
      const dialog = el.shadowRoot!.querySelector('dialog.fl-cluster-list');
      const list = el.shadowRoot!.querySelector('ul.fl-cluster-list-list');
      expect(dialog).toBeTruthy();
      expect(list).toBeTruthy();
      expect(list?.children.length).toBe(0);
    });

    it('adopts the shared stylesheet (or a <style> fallback)', () => {
      const el = mount();
      const root = el.shadowRoot!;
      const hasAdopted =
        Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
      const hasFallbackStyle = root.querySelector('style') !== null;
      expect(hasAdopted || hasFallbackStyle).toBe(true);
    });
  });

  describe('rendering', () => {
    it('renders one focusable row per annotation with severity, pin number, and body preview', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', pinNumber: 1, severity: 'critical', body: 'hello world' }),
        makeAnnotation({ id: 'a2', pinNumber: 2, severity: 'major', body: 'second\nsecond line' }),
      ];

      const rows = el.shadowRoot!.querySelectorAll('li.fl-cluster-list-item');
      expect(rows).toHaveLength(2);

      const first = rows[0] as HTMLLIElement;
      expect(first.dataset.annotationId).toBe('a1');
      expect(first.tabIndex).toBe(0);
      expect(first.querySelector('.fl-cluster-list-pin-number')?.textContent).toBe('#1');
      expect(first.querySelector('.fl-cluster-list-body')?.textContent).toBe('hello world');
      const dot = first.querySelector('.fl-severity-dot') as HTMLSpanElement;
      expect(dot.dataset.severity).toBe('critical');

      const second = rows[1] as HTMLLIElement;
      expect(second.querySelector('.fl-cluster-list-body')?.textContent).toBe('second');
    });

    it('renders an empty-state row when annotations is set to []', () => {
      const el = mount();
      el.annotations = [];
      const empty = el.shadowRoot!.querySelector('.fl-cluster-list-empty');
      expect(empty).toBeTruthy();
      expect(empty?.textContent).toBe('No annotations');
    });

    it('replaces the rendered rows when annotations is reassigned', () => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1' }), makeAnnotation({ id: 'a2' })];
      expect(el.shadowRoot!.querySelectorAll('li.fl-cluster-list-item')).toHaveLength(2);

      el.annotations = [makeAnnotation({ id: 'a3' })];
      const rows = el.shadowRoot!.querySelectorAll('li.fl-cluster-list-item');
      expect(rows).toHaveLength(1);
      expect((rows[0] as HTMLLIElement).dataset.annotationId).toBe('a3');
    });

    it('returns a defensive copy of annotations so callers cannot mutate internal state', () => {
      const el = mount();
      const list = [makeAnnotation({ id: 'a1' })];
      el.annotations = list;
      list.push(makeAnnotation({ id: 'a2' }));
      expect(el.annotations).toHaveLength(1);
    });

    it.each<Severity>(['critical', 'major', 'minor', 'informational'])(
      'mirrors severity ("%s") onto the row dot data-severity for theme variable lookup',
      (severity) => {
        const el = mount();
        el.annotations = [makeAnnotation({ id: 'a1', severity })];
        const dot = el.shadowRoot!.querySelector('.fl-severity-dot') as HTMLSpanElement;
        expect(dot.dataset.severity).toBe(severity);
      },
    );
  });

  describe('positioning + open / close', () => {
    it('opens the dialog when target is set', () => {
      const el = mount();
      el.annotations = [makeAnnotation()];
      el.target = { pageX: 100, pageY: 200 };
      const dialog = el.shadowRoot!.querySelector('dialog.fl-cluster-list') as HTMLDialogElement;
      // jsdom may use the attribute fallback; either way the dialog should
      // report itself as open.
      expect(dialog.open || dialog.hasAttribute('open')).toBe(true);
    });

    it('positions the dialog at (pageX, pageY + 30) like <fl-popover> does', () => {
      const el = mount();
      el.target = { pageX: 100, pageY: 200 };
      const dialog = el.shadowRoot!.querySelector('dialog.fl-cluster-list') as HTMLDialogElement;
      expect(dialog.style.left).toBe('100px');
      expect(dialog.style.top).toBe('230px');
    });

    it('closes the dialog when target is set to null without firing a duplicate close event', async () => {
      const el = mount();
      el.target = { pageX: 0, pageY: 0 };
      let closeCount = 0;
      el.addEventListener('close', () => closeCount += 1);
      el.target = null;
      // close() detaches the dialog close listener for the duration of the
      // close call so we should NOT see a `close` event when target is
      // simply nulled out.
      expect(closeCount).toBe(0);
      const dialog = el.shadowRoot!.querySelector('dialog.fl-cluster-list') as HTMLDialogElement;
      expect(dialog.open).toBe(false);
    });

    it('calling close() emits a close CustomEvent that bubbles + composes', () => {
      const el = mount();
      el.target = { pageX: 0, pageY: 0 };

      const events: CustomEvent[] = [];
      document.body.addEventListener('close', (e) => {
        events.push(e as CustomEvent);
      });

      el.close();
      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
    });
  });

  describe('selection', () => {
    it('emits annotation-select on click with the row\'s annotationId', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1', pinNumber: 1 }),
        makeAnnotation({ id: 'a2', pinNumber: 2 }),
      ];
      el.target = { pageX: 0, pageY: 0 };

      const events: CustomEvent<ClusterListAnnotationSelectDetail>[] = [];
      document.body.addEventListener('annotation-select', (e) => {
        events.push(e as CustomEvent<ClusterListAnnotationSelectDetail>);
      });

      const rows = el.shadowRoot!.querySelectorAll('li.fl-cluster-list-item');
      (rows[1] as HTMLLIElement).click();

      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({ annotationId: 'a2' });
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
    });

    it('emits annotation-select when Enter is pressed on a focused row', () => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1' })];
      el.target = { pageX: 0, pageY: 0 };

      const events: CustomEvent<ClusterListAnnotationSelectDetail>[] = [];
      document.body.addEventListener('annotation-select', (e) => {
        events.push(e as CustomEvent<ClusterListAnnotationSelectDetail>);
      });

      const row = el.shadowRoot!.querySelector('li.fl-cluster-list-item') as HTMLLIElement;
      row.focus();
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
      );

      expect(events).toHaveLength(1);
      expect(events[0].detail.annotationId).toBe('a1');
    });

    it('emits annotation-select when Space is pressed on a focused row (and prevents default)', () => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1' })];
      el.target = { pageX: 0, pageY: 0 };

      const events: CustomEvent[] = [];
      document.body.addEventListener('annotation-select', (e) => {
        events.push(e as CustomEvent);
      });

      const row = el.shadowRoot!.querySelector('li.fl-cluster-list-item') as HTMLLIElement;
      const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true, cancelable: true });
      row.dispatchEvent(ev);

      expect(events).toHaveLength(1);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('does not emit annotation-select for other keys', () => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1' })];
      el.target = { pageX: 0, pageY: 0 };

      const events: CustomEvent[] = [];
      document.body.addEventListener('annotation-select', (e) => events.push(e as CustomEvent));

      const row = el.shadowRoot!.querySelector('li.fl-cluster-list-item') as HTMLLIElement;
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }),
      );

      expect(events).toHaveLength(0);
    });
  });

  describe('keyboard navigation', () => {
    it('ArrowDown moves focus to the next row, wrapping at the end', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
        makeAnnotation({ id: 'a3' }),
      ];
      el.target = { pageX: 0, pageY: 0 };

      const rows = Array.from(
        el.shadowRoot!.querySelectorAll('li.fl-cluster-list-item'),
      ) as HTMLLIElement[];

      rows[0].focus();
      rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
      expect(el.shadowRoot!.activeElement).toBe(rows[1]);

      rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
      expect(el.shadowRoot!.activeElement).toBe(rows[2]);

      // Wrap from last to first.
      rows[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
      expect(el.shadowRoot!.activeElement).toBe(rows[0]);
    });

    it('ArrowUp moves focus to the previous row, wrapping at the start', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
        makeAnnotation({ id: 'a3' }),
      ];
      el.target = { pageX: 0, pageY: 0 };

      const rows = Array.from(
        el.shadowRoot!.querySelectorAll('li.fl-cluster-list-item'),
      ) as HTMLLIElement[];

      rows[0].focus();
      rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, composed: true }));
      // Wrap from first to last.
      expect(el.shadowRoot!.activeElement).toBe(rows[2]);

      rows[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, composed: true }));
      expect(el.shadowRoot!.activeElement).toBe(rows[1]);
    });

    it('Home and End jump focus to the first and last rows', () => {
      const el = mount();
      el.annotations = [
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
        makeAnnotation({ id: 'a3' }),
      ];
      el.target = { pageX: 0, pageY: 0 };

      const rows = Array.from(
        el.shadowRoot!.querySelectorAll('li.fl-cluster-list-item'),
      ) as HTMLLIElement[];

      rows[1].focus();
      rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, composed: true }));
      expect(el.shadowRoot!.activeElement).toBe(rows[2]);

      rows[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, composed: true }));
      expect(el.shadowRoot!.activeElement).toBe(rows[0]);
    });
  });

  describe('close', () => {
    it('forwards the dialog\'s native close event as a bubbling + composed close CustomEvent', () => {
      const el = mount();
      el.target = { pageX: 0, pageY: 0 };

      const events: CustomEvent[] = [];
      document.body.addEventListener('close', (e) => events.push(e as CustomEvent));

      const dialog = el.shadowRoot!.querySelector('dialog.fl-cluster-list') as HTMLDialogElement;
      dialog.dispatchEvent(new Event('close'));

      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
    });

    it('a click outside the dialog panel closes it', async () => {
      const el = mount();
      el.target = { pageX: 0, pageY: 0 };

      // Wait two microtasks: one for the popover's deferred document-level
      // listener registration, one for the test to settle.
      await Promise.resolve();
      await Promise.resolve();

      const events: CustomEvent[] = [];
      document.body.addEventListener('close', (e) => events.push(e as CustomEvent));

      // Append a sibling outside the popover; clicking it should close.
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      outside.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

      expect(events).toHaveLength(1);
      const dialog = el.shadowRoot!.querySelector('dialog.fl-cluster-list') as HTMLDialogElement;
      expect(dialog.open).toBe(false);
    });

    it('clicking inside the dialog panel does not close it', async () => {
      const el = mount();
      el.annotations = [makeAnnotation({ id: 'a1' })];
      el.target = { pageX: 0, pageY: 0 };

      await Promise.resolve();
      await Promise.resolve();

      const events: CustomEvent[] = [];
      document.body.addEventListener('close', (e) => events.push(e as CustomEvent));

      const dialog = el.shadowRoot!.querySelector('dialog.fl-cluster-list') as HTMLDialogElement;
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

      expect(events).toHaveLength(0);
    });
  });
});

describe('popoverTargetFromRect', () => {
  it('adds page scroll offsets to the rect coordinates', () => {
    const target = popoverTargetFromRect(
      { left: 50, top: 75 },
      { x: 10, y: 20 },
    );
    expect(target).toEqual({ pageX: 60, pageY: 95 });
  });

  it('reads window.scrollX/Y by default', () => {
    const original = { x: window.scrollX, y: window.scrollY };
    Object.defineProperty(window, 'scrollX', { configurable: true, get: () => 5 });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 7 });
    try {
      const target = popoverTargetFromRect({ left: 0, top: 0 });
      expect(target).toEqual({ pageX: 5, pageY: 7 });
    } finally {
      Object.defineProperty(window, 'scrollX', { configurable: true, get: () => original.x });
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => original.y });
    }
  });
});
