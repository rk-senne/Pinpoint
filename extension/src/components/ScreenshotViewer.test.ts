// @vitest-environment jsdom
/**
 * Unit tests for `<fl-screenshot-viewer>` / `<pp-screenshot-viewer>`
 * (GAP 2 — UI coverage).
 *
 * NOTE on the GAP-2 brief: it lists "open/close/keyboard Escape" for this
 * module, but the shipped `FlScreenshotViewer` is a *read-only* viewer with
 * no open/close or Escape handling — it renders a bitmap, composites an SVG
 * markup overlay, and dispatches an `edit-request` CustomEvent on click. These
 * tests cover what the component actually does: mount/render into the Shadow
 * Root, the primary interaction (image `src` set safely + the click →
 * `edit-request` event), markup fetch on `annotationId`, and the empty/error
 * state (no image / failed markup fetch render the bitmap alone, no throw).
 *
 * We DON'T `vi.mock('../lib/api')` here: mocking that module disrupts the
 * side-effect custom-element registration at the bottom of
 * `ScreenshotViewer.ts` (the define never runs, so the element stays an
 * un-upgraded `HTMLElement`). Instead we import the module for its
 * registration side effect and `vi.spyOn` the real `apiFetch` export — ESM
 * live bindings mean the viewer calls the spy.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarkupDocument } from '@pinpoint/shared';

// Side-effect import registers the custom element; the named import gives us
// the class + detail type.
import './ScreenshotViewer';
import { FlScreenshotViewer, type ScreenshotEditRequestDetail } from './ScreenshotViewer';
import * as api from '../lib/api';

function makeMarkup(): MarkupDocument {
  return {
    version: 1,
    shapes: [
      { type: 'rect', x: 1, y: 2, width: 10, height: 20, color: '#ef4444', strokeWidth: 2 },
    ],
  };
}

function create(): FlScreenshotViewer {
  return document.createElement('pp-screenshot-viewer') as FlScreenshotViewer;
}

/** Spy on the markup fetch. Returns the spy for per-test configuration. */
function spyApiFetch() {
  return vi.spyOn(api, 'apiFetch');
}

beforeAll(() => {
  // Registration is a side effect of the import above.
  expect(customElements.get('pp-screenshot-viewer')).toBeDefined();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('<fl-screenshot-viewer>', () => {
  describe('mount / render', () => {
    it('is a Custom Element subclass of HTMLElement with an open Shadow Root and stage parts', () => {
      const viewer = create();
      expect(viewer).toBeInstanceOf(HTMLElement);
      expect(viewer.shadowRoot).not.toBeNull();
      expect(viewer.shadowRoot?.mode).toBe('open');

      const root = viewer.shadowRoot!;
      expect(root.querySelector('.fl-screenshot-stage')).not.toBeNull();
      expect(root.querySelector('img.fl-screenshot-img')).not.toBeNull();
      expect(root.querySelector('.fl-screenshot-overlay')).not.toBeNull();
    });

    it('registers the legacy fl- alias tag', () => {
      expect(customElements.get('fl-screenshot-viewer')).toBeDefined();
    });
  });

  describe('image source (primary interaction) — set safely', () => {
    it('sets the <img> src from imageUrl and reveals the stage', () => {
      const viewer = create();
      document.body.appendChild(viewer);

      viewer.imageUrl = 'https://cdn.example.test/shot.png';

      const img = viewer.shadowRoot!.querySelector('img.fl-screenshot-img') as HTMLImageElement;
      const stage = viewer.shadowRoot!.querySelector('.fl-screenshot-stage') as HTMLElement;
      // `src` is applied via the property setter, not innerHTML — the element
      // is created by the viewer and only its `.src` is assigned.
      expect(img.getAttribute('src')).toBe('https://cdn.example.test/shot.png');
      expect(viewer.imageUrl).toBe('https://cdn.example.test/shot.png');
      expect(stage.hidden).toBe(false);
    });

    it('clears the src and hides the stage when imageUrl is set to null', () => {
      const viewer = create();
      document.body.appendChild(viewer);
      viewer.imageUrl = 'https://cdn.example.test/shot.png';

      viewer.imageUrl = null;

      const img = viewer.shadowRoot!.querySelector('img.fl-screenshot-img') as HTMLImageElement;
      const stage = viewer.shadowRoot!.querySelector('.fl-screenshot-stage') as HTMLElement;
      expect(img.hasAttribute('src')).toBe(false);
      expect(stage.hidden).toBe(true);
    });

    it('dispatches a bubbling, composed edit-request CustomEvent on stage click', () => {
      const viewer = create();
      viewer.imageUrl = 'https://cdn.example.test/shot.png';
      document.body.appendChild(viewer);

      const events: CustomEvent<ScreenshotEditRequestDetail>[] = [];
      document.body.addEventListener('edit-request', (e) => {
        events.push(e as CustomEvent<ScreenshotEditRequestDetail>);
      });

      const stage = viewer.shadowRoot!.querySelector('.fl-screenshot-stage') as HTMLElement;
      stage.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
      expect(events[0].detail.imageUrl).toBe('https://cdn.example.test/shot.png');
      expect(events[0].detail.annotationId).toBeNull();

      viewer.remove();
    });
  });

  describe('markup fetch on annotationId', () => {
    it('fetches the sibling markup over the auth gate when annotationId is set', async () => {
      const spy = spyApiFetch().mockResolvedValue({ markupDocument: makeMarkup() });
      const viewer = create();
      document.body.appendChild(viewer);

      viewer.annotationId = 'ann-123';
      await Promise.resolve();
      await Promise.resolve();

      expect(spy).toHaveBeenCalledWith('/annotations/ann-123/markup');
      expect(viewer.annotationId).toBe('ann-123');
      expect(viewer.markupDocument).toEqual(makeMarkup());
    });

    it('skips the fetch when markupDocument is provided directly', () => {
      const spy = spyApiFetch();
      const viewer = create();
      document.body.appendChild(viewer);

      viewer.markupDocument = makeMarkup();

      expect(spy).not.toHaveBeenCalled();
      expect(viewer.markupDocument).toEqual(makeMarkup());
    });
  });

  describe('empty / error state', () => {
    it('renders the bitmap alone (empty overlay, no throw) when the markup fetch rejects', async () => {
      spyApiFetch().mockRejectedValue(new Error('404'));
      const viewer = create();
      document.body.appendChild(viewer);

      viewer.imageUrl = 'https://cdn.example.test/shot.png';
      viewer.annotationId = 'missing';
      await Promise.resolve();
      await Promise.resolve();

      // Fetch failure is swallowed; markup is cleared and the overlay stays
      // empty, but the bitmap src is intact.
      expect(viewer.markupDocument).toBeNull();
      const overlay = viewer.shadowRoot!.querySelector('.fl-screenshot-overlay') as HTMLElement;
      expect(overlay.children.length).toBe(0);
      const img = viewer.shadowRoot!.querySelector('img.fl-screenshot-img') as HTMLImageElement;
      expect(img.getAttribute('src')).toBe('https://cdn.example.test/shot.png');
    });

    it('clears any markup when annotationId is set to null', async () => {
      spyApiFetch().mockResolvedValue({ markupDocument: makeMarkup() });
      const viewer = create();
      document.body.appendChild(viewer);
      viewer.annotationId = 'ann-1';
      await Promise.resolve();
      await Promise.resolve();
      expect(viewer.markupDocument).toEqual(makeMarkup());

      viewer.annotationId = null;
      await Promise.resolve();

      expect(viewer.markupDocument).toBeNull();
      const overlay = viewer.shadowRoot!.querySelector('.fl-screenshot-overlay') as HTMLElement;
      expect(overlay.children.length).toBe(0);
    });

    it('keeps the overlay empty while natural dimensions are unknown even with markup set', () => {
      const viewer = create();
      document.body.appendChild(viewer);

      // No image has loaded (naturalWidth/Height are 0 in jsdom), so the
      // overlay guard keeps it empty rather than painting an unscaled SVG.
      viewer.markupDocument = makeMarkup();

      const overlay = viewer.shadowRoot!.querySelector('.fl-screenshot-overlay') as HTMLElement;
      expect(overlay.children.length).toBe(0);
    });
  });
});
