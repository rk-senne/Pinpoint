// @vitest-environment jsdom
/**
 * Unit tests for the vanilla `mountVerifyEmailPage` page (task 18.12).
 *
 * Validates: Requirements 20.2, 20.3
 *
 * Covers:
 * - On mount, the page POSTs to `/api/v1/auth/verify-email/:token`.
 * - 2xx → shows the success section and a link to `/login`.
 * - non-2xx → shows the error section with the server's message.
 * - Network failure → shows a generic network error.
 * - Resend form POSTs to `/api/v1/auth/resend-verification` with the email
 *   and surfaces success / failure messaging.
 * - Empty email is rejected client-side without a network call.
 * - Teardown removes the page DOM and detaches event listeners.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountVerifyEmailPage } from './VerifyEmailPage';

// --- Test fixtures ---------------------------------------------------------

const VERIFY_EMAIL_TEMPLATE_HTML = `
  <div class="fl-verify-email">
    <section data-section="verifying">
      <p>Verifying your email…</p>
    </section>

    <section data-section="success" hidden>
      <h1>Email verified — you can now sign in</h1>
      <p>
        <a href="/login" data-route data-action="goLogin">Go to login</a>
      </p>
    </section>

    <section data-section="error" hidden>
      <h1>Verification failed</h1>
      <p data-slot="message"></p>

      <form data-action="submit:resend" data-form="resend" novalidate>
        <label>
          Email address
          <input type="email" data-input="email" autocomplete="email" required />
        </label>
        <button type="submit">Resend verification</button>
      </form>

      <p data-slot="resendStatus" role="status" aria-live="polite"></p>
    </section>
  </div>
`;

function installTemplate(): void {
  const tpl = document.createElement('template');
  tpl.id = 'verify-email-page';
  tpl.innerHTML = VERIFY_EMAIL_TEMPLATE_HTML;
  document.body.appendChild(tpl);
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Wait one microtask cycle so async fetch handlers have a chance to settle.
 * The page kicks off `verify()` immediately on mount and the test reads the
 * resulting DOM; without a flush the assertions race the promise.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplate();
  history.replaceState(null, '', '/verify-email/some-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

// --- Tests -----------------------------------------------------------------

describe('mountVerifyEmailPage', () => {
  it('POSTs to /api/v1/auth/verify-email/:token on mount', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(makeJsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok-abc' });
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/verify-email/tok-abc');
    expect(init.method).toBe('POST');
  });

  it('encodes special characters in the token', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(makeJsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'a/b c' });
    await flush();

    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe('/api/v1/auth/verify-email/a%2Fb%20c');
  });

  it('shows the verifying section while the request is in flight', () => {
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => pending));

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });

    const verifying = root.querySelector(
      '[data-section="verifying"]',
    ) as HTMLElement;
    const success = root.querySelector(
      '[data-section="success"]',
    ) as HTMLElement;
    const error = root.querySelector(
      '[data-section="error"]',
    ) as HTMLElement;

    expect(verifying.hidden).toBe(false);
    expect(success.hidden).toBe(true);
    expect(error.hidden).toBe(true);

    // Let the test settle so the spied fetch promise is consumed.
    resolveFetch(makeJsonResponse({ ok: true }));
  });

  it('shows the success section with the success message and login link on 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(makeJsonResponse({ ok: true }))),
    );

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const success = root.querySelector(
      '[data-section="success"]',
    ) as HTMLElement;
    const verifying = root.querySelector(
      '[data-section="verifying"]',
    ) as HTMLElement;
    const error = root.querySelector(
      '[data-section="error"]',
    ) as HTMLElement;

    expect(success.hidden).toBe(false);
    expect(verifying.hidden).toBe(true);
    expect(error.hidden).toBe(true);

    expect(success.textContent).toContain(
      'Email verified — you can now sign in',
    );

    const link = success.querySelector(
      'a[data-route][data-action="goLogin"]',
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/login');
  });

  it('navigates to /login when the success link is clicked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(makeJsonResponse({ ok: true }))),
    );

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const link = root.querySelector(
      'a[data-action="goLogin"]',
    ) as HTMLAnchorElement;
    link.click();

    expect(location.pathname).toBe('/login');
  });

  it('shows the error section with the server message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          makeJsonResponse(
            { error: { code: 'INVALID_TOKEN', message: 'Token is expired.' } },
            400,
          ),
        ),
      ),
    );

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const error = root.querySelector(
      '[data-section="error"]',
    ) as HTMLElement;
    expect(error.hidden).toBe(false);

    const message = error.querySelector('[data-slot="message"]') as HTMLElement;
    expect(message.textContent).toBe('Token is expired.');

    // The resend form is the recovery action — it must be present on the
    // error screen.
    expect(error.querySelector('form[data-form="resend"]')).not.toBeNull();
    expect(error.querySelector('input[data-input="email"]')).not.toBeNull();
  });

  it('falls back to a generic message when the error body has no message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 500 }))),
    );

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const message = root.querySelector(
      '[data-section="error"] [data-slot="message"]',
    ) as HTMLElement;
    expect(message.textContent).toBe('Verification failed (HTTP 500).');
  });

  it('shows a network error when the verify request itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))));

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const message = root.querySelector(
      '[data-section="error"] [data-slot="message"]',
    ) as HTMLElement;
    expect(message.textContent).toBe('Network error. Please try again.');
  });

  it('resends verification by POSTing to /api/v1/auth/resend-verification with the entered email', async () => {
    const fetchSpy = vi
      .fn()
      // First call: the verify request fails so the form is shown.
      .mockResolvedValueOnce(
        makeJsonResponse(
          { error: { code: 'INVALID_TOKEN', message: 'Token expired.' } },
          400,
        ),
      )
      // Second call: the resend request succeeds.
      .mockResolvedValueOnce(makeJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const input = root.querySelector(
      'input[data-input="email"]',
    ) as HTMLInputElement;
    input.value = 'alice@example.test';

    const form = root.querySelector(
      'form[data-form="resend"]',
    ) as HTMLFormElement;
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/resend-verification');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'alice@example.test',
    });

    const status = root.querySelector(
      '[data-slot="resendStatus"]',
    ) as HTMLElement;
    expect(status.textContent).toContain('Verification email sent');
  });

  it('rejects an empty email client-side and does not call the network', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(
          { error: { code: 'INVALID_TOKEN', message: 'Token expired.' } },
          400,
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const form = root.querySelector(
      'form[data-form="resend"]',
    ) as HTMLFormElement;
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    // Only the original verify call — no resend call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const status = root.querySelector(
      '[data-slot="resendStatus"]',
    ) as HTMLElement;
    expect(status.textContent).toBe(
      'Enter the email address you registered with.',
    );
  });

  it('surfaces a server-side error message on resend failure', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(
          { error: { code: 'INVALID_TOKEN', message: 'Token expired.' } },
          400,
        ),
      )
      .mockResolvedValueOnce(
        makeJsonResponse(
          { error: { code: 'RATE_LIMITED', message: 'Try again later.' } },
          429,
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);

    mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    const input = root.querySelector(
      'input[data-input="email"]',
    ) as HTMLInputElement;
    input.value = 'alice@example.test';

    (root.querySelector('form[data-form="resend"]') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    const status = root.querySelector(
      '[data-slot="resendStatus"]',
    ) as HTMLElement;
    expect(status.textContent).toBe('Try again later.');
  });

  it('teardown removes the page DOM and stops the resend handler from firing again', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(
          { error: { code: 'INVALID_TOKEN', message: 'Token expired.' } },
          400,
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountVerifyEmailPage(root, { token: 'tok' });
    await flush();

    expect(root.querySelector('.fl-verify-email')).not.toBeNull();
    teardown();
    expect(root.querySelector('.fl-verify-email')).toBeNull();
  });

  it('throws a clear error when the template is missing', () => {
    document.getElementById('verify-email-page')!.remove();
    const root = document.createElement('div');
    document.body.appendChild(root);

    expect(() => mountVerifyEmailPage(root, { token: 'tok' })).toThrow(
      /no <template> element found with id "verify-email-page"/,
    );
  });
});
