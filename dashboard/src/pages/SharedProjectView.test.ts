// @vitest-environment jsdom
/**
 * Unit tests for the vanilla-TS `SharedProjectView` page (Task 18.11).
 *
 * Covers:
 * - Initial render shows the password prompt.
 * - 200 OK response with annotations renders the read-only table; empty
 *   list renders the empty-state.
 * - 401 surfaces the inline error and decrements the remaining-attempts
 *   counter, honouring the server-supplied `attemptsRemaining` field.
 * - 423 switches to the locked screen and starts a `Retry-After`-driven
 *   countdown that returns to the prompt when it elapses.
 * - 404 switches to the not-found screen.
 * - The verify request encodes `linkId` and posts the password.
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '@pinpoint/shared';

import { mountSharedProjectView } from './SharedProjectView';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TEMPLATES = `
  <template id="tpl-shared-project-view">
    <div data-fl-shared-root>
      <section data-section="prompt">
        <form data-action="submit:verify">
          <input data-slot="password-input" type="password" />
          <p data-slot="prompt-error" hidden></p>
          <button type="submit" data-slot="submit-btn">Unlock</button>
        </form>
      </section>
      <section data-section="locked" hidden>
        <p data-slot="locked-message"></p>
      </section>
      <section data-section="not_found" hidden></section>
      <section data-section="authenticated" hidden>
        <p data-slot="empty-state" hidden>No annotations in this project.</p>
        <table data-slot="annotations-table" hidden>
          <tbody data-slot="annotations-tbody"></tbody>
        </table>
      </section>
    </div>
  </template>
  <template id="tpl-shared-project-view-row">
    <tr>
      <td data-slot="pin-number"></td>
      <td data-slot="type"></td>
      <td><span data-slot="severity"></span></td>
      <td data-slot="status"></td>
      <td data-slot="body"></td>
    </tr>
  </template>
`;

function makeRoot(): HTMLElement {
  document.body.innerHTML = TEMPLATES + '<div id="root"></div>';
  return document.getElementById('root') as HTMLElement;
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    projectId: 'proj-1',
    pageId: 'page-1',
    pinNumber: 1,
    type: 'note',
    severity: 'major',
    status: 'active',
    body: 'Something is off here.',
    target: { selector: 'body', xpath: '/html/body', textContent: '', framePath: [] },
    pageX: 100,
    pageY: 200,
    environment: {
      browserFamily: 'Chrome',
      browserVersion: '124',
      osFamily: 'macOS',
      osVersion: '14.5',
      deviceType: 'desktop',
      userAgentRaw: 'test',
    },
    authorId: 'user-1',
    createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    ...overrides,
  } as Annotation;
}

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Build a minimal stand-in for `Response` that resolves the same `body`
 * payload synchronously through `.json()`. We avoid the real `Response`
 * constructor here because its body-stream reader needs many microtask
 * ticks to settle under jsdom + fake timers, which makes the assertion
 * sequence in these tests brittle.
 */
function mockResponse(init: MockResponseInit): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  const body = init.body === undefined ? null : init.body;
  const fake = {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
  return fake as unknown as Response;
}

function getSection(name: string): HTMLElement {
  return document.querySelector(`[data-section="${name}"]`) as HTMLElement;
}

function isVisible(el: HTMLElement): boolean {
  return !el.hasAttribute('hidden');
}

async function flush(): Promise<void> {
  // Drain microtasks for fetch resolution and signal subscribers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe('SharedProjectView', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Only fake the timer APIs the lockout countdown uses; leaving microtask
    // resolution alone so awaited fetch/Response.json calls progress normally.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the password prompt on mount', () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });

    expect(isVisible(getSection('prompt'))).toBe(true);
    expect(isVisible(getSection('locked'))).toBe(false);
    expect(isVisible(getSection('not_found'))).toBe(false);
    expect(isVisible(getSection('authenticated'))).toBe(false);
  });

  it('disables the submit button until the password input is non-empty', () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    const btn = root.querySelector<HTMLButtonElement>('[data-slot="submit-btn"]')!;
    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;

    expect(btn.disabled).toBe(true);
    input.value = 'hunter2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled).toBe(false);
  });

  it('encodes the linkId and posts the password to the verify endpoint', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link with space' });
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: { annotations: [] } }));

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'pw';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/shared/link%20with%20space/verify');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe(JSON.stringify({ password: 'pw' }));
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('renders the annotations table on a 200 response', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 200,
        body: {
          annotations: [
            makeAnnotation({ id: 'a', pinNumber: 1, body: 'first' }),
            makeAnnotation({ id: 'b', pinNumber: 2, body: 'second', severity: 'critical' }),
          ],
        },
      }),
    );

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'pw';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();

    expect(isVisible(getSection('authenticated'))).toBe(true);
    expect(isVisible(getSection('prompt'))).toBe(false);
    const rows = document.querySelectorAll('[data-slot="annotations-tbody"] tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('[data-slot="pin-number"]')!.textContent).toBe('1');
    expect(rows[1].querySelector('[data-slot="body"]')!.textContent).toBe('second');
    expect(rows[1].querySelector('[data-slot="severity"]')!.textContent).toBe('critical');
  });

  it('shows the empty-state when 200 returns no annotations', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: { annotations: [] } }));

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'pw';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();

    expect(isVisible(getSection('authenticated'))).toBe(true);
    expect(isVisible(document.querySelector('[data-slot="empty-state"]') as HTMLElement)).toBe(true);
    expect(isVisible(document.querySelector('[data-slot="annotations-table"]') as HTMLElement)).toBe(false);
  });

  it('on 401 displays attempts-remaining from the server response', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 401,
        body: {
          error: {
            code: 'INVALID_PASSWORD',
            message: 'Incorrect password.',
            details: { attemptsRemaining: 2 },
          },
        },
      }),
    );

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'wrong';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();

    const errorEl = document.querySelector('[data-slot="prompt-error"]') as HTMLElement;
    expect(isVisible(errorEl)).toBe(true);
    expect(errorEl.textContent).toMatch(/Incorrect password\. 2 attempts remaining/);
    expect(isVisible(getSection('prompt'))).toBe(true);
  });

  it('on 401 falls back to a client-side counter when the server omits attemptsRemaining', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 401,
        body: { error: { code: 'INVALID_PASSWORD', message: 'Incorrect password.' } },
      }),
    );

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'wrong';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    const errorEl = document.querySelector('[data-slot="prompt-error"]') as HTMLElement;
    expect(errorEl.textContent).toMatch(/2 attempts remaining/);

    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(errorEl.textContent).toMatch(/1 attempt remaining/);
  });

  it('on 423 switches to the locked screen and shows minutes-remaining', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 423,
        headers: { 'Retry-After': String(15 * 60) },
        body: {
          error: { code: 'LOCKED', message: 'Locked', details: { lockedUntil: 'x' } },
        },
      }),
    );

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'wrong';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    expect(isVisible(getSection('locked'))).toBe(true);
    expect(isVisible(getSection('prompt'))).toBe(false);
    const lockedMsg = document.querySelector('[data-slot="locked-message"]') as HTMLElement;
    expect(lockedMsg.textContent).toMatch(/15 minutes/);
  });

  it('counts the lockout down once per second and returns to the prompt at zero', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 423,
        headers: { 'Retry-After': '3' },
        body: { error: { code: 'LOCKED', message: 'Locked' } },
      }),
    );

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'wrong';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    expect(isVisible(getSection('locked'))).toBe(true);

    // 3 ticks reach zero and clear the lock.
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    await flush();

    expect(isVisible(getSection('locked'))).toBe(false);
    expect(isVisible(getSection('prompt'))).toBe(true);
  });

  it('on 404 switches to the not-found screen', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'missing' });
    fetchMock.mockResolvedValue(
      mockResponse({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } }),
    );

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'pw';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    expect(isVisible(getSection('not_found'))).toBe(true);
    expect(isVisible(getSection('prompt'))).toBe(false);
  });

  it('surfaces a network-error message when fetch rejects', async () => {
    const root = makeRoot();
    mountSharedProjectView(root, { linkId: 'link-1' });
    fetchMock.mockRejectedValue(new TypeError('NetworkError'));

    const input = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
    input.value = 'pw';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    const errorEl = document.querySelector('[data-slot="prompt-error"]') as HTMLElement;
    expect(isVisible(errorEl)).toBe(true);
    expect(errorEl.textContent).toMatch(/Network error/);
  });
});
