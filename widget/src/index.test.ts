// @vitest-environment jsdom
/**
 * widget index.test.ts — Mission B1. Proves the embeddable widget builds its
 * form and status messages via DOM APIs (never innerHTML), so a hostile
 * server error message — e.g. `<img src=x onerror=alert(1)>` — renders as
 * inert text inside the Shadow Root.
 *
 * The production widget uses a *closed* Shadow Root, which is not inspectable
 * from outside. For the test we force `attachShadow` into `open` mode so the
 * assertions can read the rendered subtree; the DOM-construction code under
 * test is identical either way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Pinpoint, { resolveApiOrigin } from './index';

let realAttachShadow: typeof Element.prototype.attachShadow;
let openRoots: WeakMap<Element, ShadowRoot>;

beforeEach(() => {
  document.body.innerHTML = '';
  openRoots = new WeakMap();
  realAttachShadow = Element.prototype.attachShadow;
  // Force open mode and capture the root so the test can read it back.
  Element.prototype.attachShadow = function patched(
    this: Element,
    _init: ShadowRootInit,
  ): ShadowRoot {
    const root = realAttachShadow.call(this, { mode: 'open' });
    openRoots.set(this, root);
    return root;
  };
});

afterEach(() => {
  Element.prototype.attachShadow = realAttachShadow;
  Pinpoint.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function hostRoot(): ShadowRoot {
  const host = document.getElementById('pinpoint-widget-host')!;
  return openRoots.get(host)!;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('widget — mount + form', () => {
  it('mounts a host element and builds the form via DOM', () => {
    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://api.test' });
    const root = hostRoot();

    // Open the modal.
    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();

    expect(root.querySelector('#pinpoint-form')).not.toBeNull();
    expect(root.querySelector('#pinpoint-description')).not.toBeNull();
    expect(root.querySelectorAll('#pinpoint-severity option').length).toBe(4);
  });
});

describe('widget — showMessage XSS safety', () => {
  it('renders a hostile server error message as inert text', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: payload } }), { status: 400 }),
        ),
      ),
    );

    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://api.test' });
    const root = hostRoot();
    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();

    const textarea = root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!;
    textarea.value = 'something is broken';
    root.querySelector<HTMLFormElement>('#pinpoint-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    const message = root.querySelector('.pinpoint-message');
    expect(message).not.toBeNull();
    expect(message!.querySelector('img')).toBeNull();
    // The payload is present as text, not as a live element.
    expect(message!.textContent).toContain(payload);
  });

  it('shows a success message after a 2xx submit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://api.test' });
    const root = hostRoot();
    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();

    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = 'nice site';
    root.querySelector<HTMLFormElement>('#pinpoint-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    const message = root.querySelector('.pinpoint-message.success');
    expect(message).not.toBeNull();
    expect(message!.textContent).toContain('Thank you!');
    // The dialog stays named after the form is replaced (axe aria-dialog-name).
    const dialog = root.querySelector('[role="dialog"]')!;
    expect(root.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Thank you!');
    // Accessible success mark: decorative SVG + a real heading.
    const icon = message!.querySelector('svg.pinpoint-success-icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(message!.querySelector('h2')?.textContent).toBe('Thank you!');
  });
});

describe('widget — diagnostics capture (Mission C2)', () => {
  it('attaches scrubbed jsErrors to the submission payload', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: unknown) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://api.test' });
    const root = hostRoot();

    // Trigger an uncaught error the capture module records.
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom token=secret', filename: 'x.js', lineno: 1 }),
    );

    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();
    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = 'broken';
    root.querySelector<HTMLFormElement>('#pinpoint-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(Array.isArray(body.jsErrors)).toBe(true);
    expect(body.jsErrors.length).toBeGreaterThan(0);
    // Secret scrubbed before attach.
    expect(JSON.stringify(body.jsErrors)).not.toContain('secret');
  });

  it('does not capture when captureDiagnostics is false', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: unknown) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    Pinpoint.init({
      projectKey: 'pk_widget_test',
      apiUrl: 'https://api.test',
      captureDiagnostics: false,
    });
    const root = hostRoot();
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));

    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();
    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = 'hi';
    root.querySelector<HTMLFormElement>('#pinpoint-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.jsErrors).toBeUndefined();
    expect(body.consoleLogs).toBeUndefined();
  });
});

describe('resolveApiOrigin (F3)', () => {
  const page = 'https://customer.test';
  const docWith = (...srcs: string[]) => {
    document.body.innerHTML = srcs.map((s) => `<script src="${s}"></script>`).join('');
    return document;
  };

  it('prefers the load-time currentScript origin', () => {
    expect(
      resolveApiOrigin('https://api.pinpoint.test/widget/pinpoint-widget.js', docWith('https://evil.test/x.js'), page),
    ).toBe('https://api.pinpoint.test');
  });

  it('ignores look-alike scripts (substring "widget.js") when no load-time script', () => {
    expect(resolveApiOrigin(null, docWith('https://evil.test/chat-widget.js', 'https://evil.test/pinpoint-widget.js'), page)).toBe(page);
  });

  it('falls back to an exact /widget/pinpoint-widget.js pathname match', () => {
    expect(
      resolveApiOrigin(null, docWith('https://evil.test/widget.js', 'https://api.pinpoint.test/widget/pinpoint-widget.js?v=3'), page),
    ).toBe('https://api.pinpoint.test');
  });

  it('falls back to the page origin when nothing matches', () => {
    expect(resolveApiOrigin(null, docWith(), page)).toBe(page);
  });

  it('explicit apiUrl config wins over any script', async () => {
    docWith('https://other.test/widget/pinpoint-widget.js');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://configured.test' });
    const root = hostRoot();
    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();
    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = 'hi';
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://configured.test/api/v1/widget/feedback');
  });
});

describe('widget pageUrl sanitisation (F5)', () => {
  it('sends the page URL without fragment and with sensitive values redacted', async () => {
    window.history.replaceState({}, '', '/p?token=SECRETVAL&page=2#access_token=FRAGSECRET');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://api.test' });
    const root = hostRoot();
    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();
    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = 'hi';
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.pageUrl).toContain('token=REDACTED');
    expect(body.pageUrl).toContain('page=2');
    expect(body.pageUrl).not.toContain('SECRETVAL');
    expect(body.pageUrl).not.toContain('FRAGSECRET');
    expect(body.pageUrl).not.toContain('#');
  });
});

describe('widget — dialog accessibility + validation', () => {
  function openWidget(): ShadowRoot {
    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://api.test' });
    const root = hostRoot();
    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();
    return root;
  }

  it('is a labelled modal dialog and the trigger reflects aria-expanded', () => {
    const root = openWidget();
    const dialog = root.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(root.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Send feedback');
    expect(root.querySelector('.pinpoint-trigger')!.getAttribute('aria-expanded')).toBe('true');
    expect(root.activeElement?.id).toBe('pinpoint-description');
  });

  it('Escape closes the dialog and returns focus to the trigger', () => {
    const root = openWidget();
    root.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.pinpoint-overlay')).toBeNull();
    const trigger = root.querySelector('.pinpoint-trigger')!;
    expect(root.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Tab wraps from the last control back to the first (focus trap)', () => {
    const root = openWidget();
    const submit = root.querySelector<HTMLButtonElement>('#pinpoint-submit')!;
    submit.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    submit.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(root.activeElement?.id).toBe('pinpoint-description');
  });

  it('shows inline messages for an empty (whitespace) description and a bad email, without submitting', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const root = openWidget();
    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = '   ';
    root.querySelector<HTMLInputElement>('#pinpoint-email')!.value = 'not-an-email';
    root.querySelector<HTMLFormElement>('#pinpoint-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    const ta = root.querySelector('#pinpoint-description')!;
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    expect(root.getElementById(ta.getAttribute('aria-describedby')!)!.textContent).toMatch(/describe/i);
    const email = root.querySelector('#pinpoint-email')!;
    expect(root.getElementById(email.getAttribute('aria-describedby')!)!.textContent).toMatch(/valid email/i);
    expect(root.activeElement).toBe(ta);
  });

  it('keeps the form and the typed text when the API rejects, so the user can retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'Origin not allowed' } }), { status: 403 }))),
    );
    const root = openWidget();
    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = 'checkout button broken';
    root.querySelector<HTMLFormElement>('#pinpoint-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    const alert = root.querySelector('.pinpoint-message.error')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Origin not allowed');
    expect(root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value).toBe('checkout button broken');
    const submit = root.querySelector<HTMLButtonElement>('#pinpoint-submit')!;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Try again');
  });
});

describe('widget — network / CORS failure', () => {
  it('replaces the opaque "Failed to fetch" with a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    Pinpoint.init({ projectKey: 'pk_widget_test', apiUrl: 'https://api.test' });
    const root = hostRoot();
    root.querySelector<HTMLButtonElement>('.pinpoint-trigger')!.click();
    root.querySelector<HTMLTextAreaElement>('#pinpoint-description')!.value = 'x';
    root.querySelector<HTMLFormElement>('#pinpoint-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const text = root.querySelector('.pinpoint-message.error')!.textContent!;
    expect(text).toContain("couldn't reach the feedback service");
    expect(text).not.toContain('Failed to fetch');
  });
});
