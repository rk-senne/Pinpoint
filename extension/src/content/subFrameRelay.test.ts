// @vitest-environment jsdom
/**
 * Unit tests for `installSubFrameRelay` (task 40.2, Requirement 48.2).
 *
 * jsdom does not implement the parent/child window relationship for
 * iframes the way a real browser does — `frameElement` is null even
 * when the document is loaded inside an `<iframe>`, and `window.parent`
 * always equals `window`. Rather than wire up a real iframe (which
 * jsdom does not navigate), the relay accepts an explicit
 * `SubFrameRelayDeps` object so tests can plug in a fake parent
 * `Window` and a fake `frameElement` and verify the wiring.
 *
 * Coverage:
 *   - Click triggers `parent.postMessage` with the expected
 *     `pinpoint:subframe-click` envelope and rect.
 *   - When `frameElement` is provided, the rect coordinates include the
 *     iframe's offset within the top frame.
 *   - When `frameElement` is null (cross-origin parent fallback /
 *     missing element), the local rect is posted unchanged.
 *   - Cross-origin parents (origin mismatch) skip installation entirely.
 *   - Top-frame invocation (`parent === window`) skips installation
 *     entirely.
 *   - The relay does NOT append any DOM to `document.body`.
 *   - The teardown handle removes the click listener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUBFRAME_CLICK_MESSAGE_TYPE,
  installSubFrameRelay,
  type SubFrameClickMessage,
} from './subFrameRelay';

interface FakeParent {
  postMessage: ReturnType<typeof vi.fn>;
  location: { origin: string };
}

function makeFakeParent(origin: string): FakeParent {
  return {
    postMessage: vi.fn(),
    location: { origin },
  };
}

/** Build a deterministic rect on an element so getBoundingClientRect is stable. */
function stubRect(
  el: Element,
  rect: { x: number; y: number; width: number; height: number },
): void {
  el.getBoundingClientRect = () =>
    ({
      x: rect.x,
      y: rect.y,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('installSubFrameRelay — task 40.2 / Req 48.2', () => {
  let teardown: () => void = () => {};

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    teardown();
    document.body.replaceChildren();
  });

  it('posts a pinpoint:subframe-click message with the click rect translated by the frame offset', () => {
    const parent = makeFakeParent('https://example.test');
    // Fake `frameElement` carrying the iframe's offset within the top
    // frame. The relay should add this offset to the click target's
    // local rect to produce coordinates in the top frame's viewport.
    const frameElement = document.createElement('iframe');
    stubRect(frameElement, { x: 100, y: 50, width: 800, height: 600 });

    const target = document.createElement('button');
    target.textContent = 'click me';
    stubRect(target, { x: 10, y: 20, width: 40, height: 30 });
    document.body.appendChild(target);

    teardown = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: parent as unknown as Window,
      frameElement,
    });

    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    const [payload, targetOrigin] = parent.postMessage.mock.calls[0];
    expect(targetOrigin).toBe('*');
    const message = payload as SubFrameClickMessage;
    expect(message.type).toBe(SUBFRAME_CLICK_MESSAGE_TYPE);
    expect(message.rect).toEqual({
      x: 110, // 10 (local) + 100 (frame x)
      y: 70, //  20 (local) +  50 (frame y)
      w: 40,
      h: 30,
    });
  });

  it('posts the local rect unchanged when no frameElement is available', () => {
    const parent = makeFakeParent('https://example.test');

    const target = document.createElement('div');
    stubRect(target, { x: 5, y: 6, width: 100, height: 200 });
    document.body.appendChild(target);

    teardown = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: parent as unknown as Window,
      frameElement: null,
    });

    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    const message = parent.postMessage.mock
      .calls[0][0] as SubFrameClickMessage;
    expect(message.rect).toEqual({ x: 5, y: 6, w: 100, h: 200 });
  });

  it('skips installation entirely when the parent is cross-origin', () => {
    const parent = makeFakeParent('https://other.test');

    const target = document.createElement('div');
    stubRect(target, { x: 5, y: 6, width: 100, height: 200 });
    document.body.appendChild(target);

    teardown = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: parent as unknown as Window,
      frameElement: null,
    });

    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Nothing posted because we never installed the listener.
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('skips installation entirely when accessing parent.location throws (cross-origin)', () => {
    const parent = {
      postMessage: vi.fn(),
      get location(): Location {
        throw new Error('SecurityError: cross-origin access');
      },
    };

    const target = document.createElement('div');
    stubRect(target, { x: 5, y: 6, width: 100, height: 200 });
    document.body.appendChild(target);

    teardown = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: parent as unknown as Window,
      frameElement: null,
    });

    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('skips installation when the relay is asked to run in the top frame (no parent)', () => {
    const target = document.createElement('div');
    stubRect(target, { x: 5, y: 6, width: 100, height: 200 });
    document.body.appendChild(target);

    teardown = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: null,
    });

    // No assertion on postMessage (there is no parent); we only care
    // that the click listener was never attached and dispatching a
    // click is a no-op.
    expect(() =>
      target.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    ).not.toThrow();
  });

  it('does NOT append any DOM to document.body', () => {
    const parent = makeFakeParent('https://example.test');
    const beforeCount = document.body.childNodes.length;

    teardown = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: parent as unknown as Window,
      frameElement: null,
    });

    // Dispatch a click to make sure the relay handler also does not
    // sneak any element insertion into the side effect.
    const target = document.createElement('span');
    stubRect(target, { x: 0, y: 0, width: 1, height: 1 });
    document.body.appendChild(target);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Only the test-added <span> should be present (1 extra child).
    expect(document.body.childNodes.length).toBe(beforeCount + 1);
    expect(document.body.querySelector('#pinpoint-shadow-host')).toBeNull();
    expect(document.body.querySelector('fl-overlay-host')).toBeNull();
  });

  it('teardown removes the click listener so further clicks do not relay', () => {
    const parent = makeFakeParent('https://example.test');
    const target = document.createElement('div');
    stubRect(target, { x: 0, y: 0, width: 10, height: 10 });
    document.body.appendChild(target);

    const dispose = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: parent as unknown as Window,
      frameElement: null,
    });

    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(parent.postMessage).toHaveBeenCalledTimes(1);

    dispose();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it('captures clicks even when a host handler stops propagation in the bubble phase', () => {
    const parent = makeFakeParent('https://example.test');
    const target = document.createElement('div');
    stubRect(target, { x: 0, y: 0, width: 10, height: 10 });
    document.body.appendChild(target);

    // A "host page" handler that swallows the click before it bubbles.
    target.addEventListener('click', (e) => e.stopPropagation());

    teardown = installSubFrameRelay({
      doc: document,
      ownWindow: {
        ...window,
        location: { origin: 'https://example.test' } as Location,
      } as unknown as Window,
      parentWindow: parent as unknown as Window,
      frameElement: null,
    });

    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Capture-phase listener still saw the click before bubbling started.
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });
});
