// @vitest-environment jsdom
/**
 * SendToMenu.test.ts — C4. Verifies the "Send to…" menu lists connected
 * providers, delivers via the deliver endpoint, renders the external link via
 * el()/setText (never innerHTML), and shows an inline retry + toast on error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSendToMenu } from './SendToMenu';

function makeApi(handlers: Record<string, (opts: RequestInit) => unknown>) {
  return vi.fn(async (path: string, opts: RequestInit = {}) => {
    const key = `${(opts.method ?? 'GET').toUpperCase()} ${path.split('?')[0]}`;
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (key.startsWith(pattern)) return fn(opts);
    }
    throw new Error(`no handler for ${key}`);
  }) as any;
}

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SendToMenu', () => {
  it('renders a Send to… button', () => {
    const teardown = mountSendToMenu(container, { annotationId: 'a1', apiFetch: makeApi({}), toast: vi.fn() });
    const button = container.querySelector('[data-role="send-to-button"]');
    expect(button).not.toBeNull();
    expect(button!.textContent).toBe('Send to…');
    teardown();
  });

  it('lists only connected, configured providers on open', async () => {
    const api = makeApi({
      'GET /integrations': () => ({
        integrations: [
          { provider: 'github', enabled: true },
          { provider: 'slack', enabled: true, config: {} }, // no channel picked yet — filtered out
          { provider: 'jira', enabled: false }, // disabled — filtered out
        ],
      }),
    });
    const teardown = mountSendToMenu(container, { annotationId: 'a1', apiFetch: api, toast: vi.fn() });

    (container.querySelector('[data-role="send-to-button"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const options = container.querySelectorAll('[data-role="send-to-option"]');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe('GitHub');
    teardown();
  });

  it('shows an empty-state when nothing is connected or configured', async () => {
    const api = makeApi({ 'GET /integrations': () => ({ integrations: [{ provider: 'slack', enabled: true, config: {} }] }) });
    const teardown = mountSendToMenu(container, { annotationId: 'a1', apiFetch: api, toast: vi.fn() });

    (container.querySelector('[data-role="send-to-button"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('[data-role="send-to-empty"]')).not.toBeNull();
    teardown();
  });

  it('delivers to a provider and renders the external link safely', async () => {
    const toast = vi.fn();
    const api = makeApi({
      'GET /integrations': () => ({ integrations: [{ provider: 'github', enabled: true }] }),
      'POST /annotations/a1/deliver': () => ({
        link: {
          provider: 'github',
          externalId: '42',
          externalUrl: 'https://github.com/acme/web/issues/42',
          status: 'delivered',
          lastError: null,
        },
      }),
    });
    const teardown = mountSendToMenu(container, { annotationId: 'a1', apiFetch: api, toast });

    (container.querySelector('[data-role="send-to-button"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    (container.querySelector('[data-role="send-to-option"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const link = container.querySelector('[data-role="send-to-link"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('https://github.com/acme/web/issues/42');
    expect(link.textContent).toBe('#42');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));

    // The deliver POST carried the provider in the body.
    const call = api.mock.calls.find((c: unknown[]) => String(c[0]).includes('/deliver'));
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ provider: 'github' });
    teardown();
  });

  it('renders an inline retry affordance when delivery fails', async () => {
    const toast = vi.fn();
    let attempts = 0;
    const api = makeApi({
      'GET /integrations': () => ({ integrations: [{ provider: 'github', enabled: true }] }),
      'POST /annotations/a1/deliver': () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Upstream responded with HTTP 503');
        return {
          link: {
            provider: 'github',
            externalId: '7',
            externalUrl: 'https://github.com/acme/web/issues/7',
            status: 'delivered',
            lastError: null,
          },
        };
      },
    });
    const teardown = mountSendToMenu(container, { annotationId: 'a1', apiFetch: api, toast });

    (container.querySelector('[data-role="send-to-button"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    (container.querySelector('[data-role="send-to-option"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const retry = container.querySelector('[data-role="send-to-retry"]') as HTMLElement;
    expect(retry).not.toBeNull();
    expect(container.querySelector('[data-role="send-to-error"]')!.textContent).toContain('503');

    // Retrying succeeds and swaps to a link.
    retry.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('[data-role="send-to-link"]')).not.toBeNull();
    teardown();
  });

  it('does not use innerHTML — a malicious external URL is dropped by isSafeUrl', async () => {
    const api = makeApi({
      'GET /integrations': () => ({ integrations: [{ provider: 'github', enabled: true }] }),
      'POST /annotations/a1/deliver': () => ({
        link: {
          provider: 'github',
          externalId: 'x',
          externalUrl: 'javascript:alert(1)',
          status: 'delivered',
          lastError: null,
        },
      }),
    });
    const teardown = mountSendToMenu(container, { annotationId: 'a1', apiFetch: api, toast: vi.fn() });

    (container.querySelector('[data-role="send-to-button"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    (container.querySelector('[data-role="send-to-option"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const link = container.querySelector('[data-role="send-to-link"]') as HTMLAnchorElement;
    // The href was dropped by el()'s isSafeUrl gate (javascript: scheme).
    expect(link.getAttribute('href')).toBeNull();
    teardown();
  });

  it('offers Slack once a channel is configured and delivers to it', async () => {
    const toast = vi.fn();
    const api = makeApi({
      'GET /integrations': () => ({
        integrations: [{ provider: 'slack', enabled: true, config: { channelId: 'C0123', channelName: 'feedback' } }],
      }),
      'POST /annotations/a1/deliver': () => ({
        link: {
          provider: 'slack',
          externalId: 'C0123:1700000000.000100',
          externalUrl: 'https://acme.slack.com/archives/C0123/p1700000000000100',
          status: 'delivered',
          lastError: null,
        },
      }),
    });
    const teardown = mountSendToMenu(container, { annotationId: 'a1', apiFetch: api, toast });

    (container.querySelector('[data-role="send-to-button"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    const options = container.querySelectorAll('[data-role="send-to-option"]');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe('Slack');
    (options[0] as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const link = container.querySelector('[data-role="send-to-link"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://acme.slack.com/archives/C0123/p1700000000000100');
    expect(link.textContent).toBe('View message');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Posted to Slack.', variant: 'success' }));
    teardown();
  });
});
