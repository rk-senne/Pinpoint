// @vitest-environment jsdom
/**
 * Unit tests for the vanilla-TS `ReviewLinkPage` (Mission C1).
 *
 * Covers:
 * - Initial render points the sandboxed iframe at the server-side proxy
 *   (`/review/:linkId`) and shows the loading status + honest limitations
 *   notice.
 * - `load` / `error` iframe events update the status text.
 * - A missing linkId renders a clear error and does not set an iframe src.
 * - Teardown removes the mounted DOM.
 */

import reviewTemplatesHtml from './ReviewLinkPage.templates.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({ apiFetch: apiFetchMock }));

import {
  MAX_FEEDBACK_MESSAGE_BYTES,
  mountReviewLinkPage,
  parseFeedbackMessage,
} from './ReviewLinkPage';

const TEMPLATES = `
  <template id="tpl-review-link-page">
    <div data-fl-review-root>
      <aside>
        <p data-slot="status"></p>
        <div data-slot="notice" hidden></div>
      </aside>
      <main>
        <iframe data-slot="frame" sandbox="allow-forms allow-scripts allow-popups"></iframe>
      </main>
    </div>
  </template>
`;

function makeRoot(): HTMLElement {
  document.body.innerHTML = TEMPLATES + '<div id="root"></div>';
  return document.getElementById('root') as HTMLElement;
}

describe('ReviewLinkPage', () => {
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('frames the server-side proxy for the linkId', () => {
    const root = makeRoot();
    teardown = mountReviewLinkPage(root, { linkId: 'tok 123/weird' });

    const frame = root.querySelector<HTMLIFrameElement>('[data-slot="frame"]')!;
    // /review/:linkId is this SPA page itself; the proxied document is /frame.
    expect(frame.getAttribute('src')).toBe('/review/tok%20123%2Fweird/frame');
    // Sandbox attribute is present (defence-in-depth against the framed page).
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
  });

  it('shows the loading status and the limitations notice', () => {
    const root = makeRoot();
    teardown = mountReviewLinkPage(root, { linkId: 'abc' });

    const status = root.querySelector('[data-slot="status"]')!;
    const notice = root.querySelector('[data-slot="notice"]')!;
    expect(status.textContent).toMatch(/loading/i);
    expect(notice.hasAttribute('hidden')).toBe(false);
    expect(notice.textContent).toMatch(/block framing|frame-ancestors/i);
  });

  it('updates the status on iframe load and error', () => {
    const root = makeRoot();
    teardown = mountReviewLinkPage(root, { linkId: 'abc' });
    const frame = root.querySelector<HTMLIFrameElement>('[data-slot="frame"]')!;
    const status = root.querySelector('[data-slot="status"]')!;

    frame.dispatchEvent(new Event('load'));
    expect(status.textContent).toMatch(/send feedback/i);

    frame.dispatchEvent(new Event('error'));
    expect(status.textContent).toMatch(/could not be previewed/i);
  });

  it('renders an error and no iframe src when linkId is missing', () => {
    const root = makeRoot();
    teardown = mountReviewLinkPage(root, {});
    const frame = root.querySelector<HTMLIFrameElement>('[data-slot="frame"]')!;
    const status = root.querySelector('[data-slot="status"]')!;
    expect(frame.getAttribute('src')).toBeNull();
    expect(status.textContent).toMatch(/missing/i);
  });

  it('teardown removes the mounted DOM', () => {
    const root = makeRoot();
    teardown = mountReviewLinkPage(root, { linkId: 'abc' });
    expect(root.querySelector('[data-fl-review-root]')).not.toBeNull();
    teardown();
    teardown = undefined;
    expect(root.querySelector('[data-fl-review-root]')).toBeNull();
  });
});

describe('ReviewLinkPage — sandbox', () => {
  it('real template iframe sandbox has no allow-same-origin', () => {
    // The real shipped template, imported the same way the page loads it.
    const html = reviewTemplatesHtml;
    const m = /<iframe[^>]*sandbox="([^"]*)"/s.exec(html);
    expect(m).not.toBeNull();
    const tokens = m![1]!.split(/\s+/);
    expect(tokens).not.toContain('allow-same-origin');
    expect(tokens).not.toContain('allow-top-navigation');
    expect(tokens).toEqual(expect.arrayContaining(['allow-scripts', 'allow-forms', 'allow-popups']));
  });
});

describe('ReviewLinkPage — feedback postMessage relay', () => {
  const good = {
    type: 'pinpoint:review-feedback',
    id: 'req-1',
    payload: { name: 'Ann', description: 'Broken', severity: 'major', pageUrl: 'https://app.test/review/x/frame' },
  };
  let teardown: (() => void) | undefined;
  let root: HTMLElement;
  let frame: HTMLIFrameElement;
  let framePost: ReturnType<typeof vi.fn>;

  function send(data: unknown, opts: { source?: unknown; origin?: string } = {}): void {
    const ev = new MessageEvent('message', {
      data,
      origin: opts.origin ?? 'null',
      source: (opts.source ?? frame.contentWindow) as MessageEventSource | null,
    });
    window.dispatchEvent(ev);
  }

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({});
    document.body.innerHTML = TEMPLATES + '<div id="root"></div>';
    root = document.getElementById('root') as HTMLElement;
    teardown = mountReviewLinkPage(root, { linkId: 'link/1' });
    frame = root.querySelector<HTMLIFrameElement>('[data-slot="frame"]')!;
    framePost = vi.fn();
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: framePost },
    });
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('relays valid feedback from the frame using the PAGE linkId and replies ok', async () => {
    send(good);
    await vi.waitFor(() => expect(framePost).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0]!;
    expect(path).toBe('/shared/link%2F1/feedback');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(good.payload);
    expect(framePost).toHaveBeenCalledWith(
      { type: 'pinpoint:review-feedback-result', id: 'req-1', ok: true },
      '*',
    );
  });

  it('replies ok:false when the API call fails', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));
    send(good);
    await vi.waitFor(() => expect(framePost).toHaveBeenCalled());
    expect(framePost.mock.calls[0]![0]).toMatchObject({ ok: false, id: 'req-1' });
  });

  it('ignores messages from a different source window', () => {
    send(good, { source: window });
    send(good, { source: { postMessage: vi.fn() } });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('ignores messages whose origin is not the opaque "null" origin', () => {
    send(good, { origin: 'https://evil.test' });
    send(good, { origin: window.location.origin });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads', () => {
    const big = { ...good, payload: { ...good.payload, description: 'x'.repeat(MAX_FEEDBACK_MESSAGE_BYTES) } };
    send(big);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('stops listening after teardown', () => {
    teardown!();
    teardown = undefined;
    send(good);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('parseFeedbackMessage', () => {
  const base = { type: 'pinpoint:review-feedback', id: 'a', payload: { name: 'n', description: 'd', pageUrl: 'https://x.test/' } };
  it('accepts a minimal valid message and strips unknown keys', () => {
    const r = parseFeedbackMessage({ ...base, payload: { ...base.payload, linkId: 'evil', extra: 1 } });
    expect(r?.payload).toEqual(base.payload);
  });
  it.each([
    ['null', null],
    ['wrong type', { ...base, type: 'x' }],
    ['missing id', { ...base, id: undefined }],
    ['long id', { ...base, id: 'a'.repeat(65) }],
    ['empty name', { ...base, payload: { ...base.payload, name: '' } }],
    ['long name', { ...base, payload: { ...base.payload, name: 'n'.repeat(101) } }],
    ['long description', { ...base, payload: { ...base.payload, description: 'd'.repeat(5001) } }],
    ['bad severity', { ...base, payload: { ...base.payload, severity: 'huge' } }],
    ['javascript url', { ...base, payload: { ...base.payload, pageUrl: 'javascript:alert(1)' } }],
    ['non-string url', { ...base, payload: { ...base.payload, pageUrl: 5 } }],
  ])('rejects %s', (_n, msg) => {
    expect(parseFeedbackMessage(msg)).toBeNull();
  });
});
