// @vitest-environment jsdom
/**
 * OnboardingWizard.test.ts — Mission B3 (onboarding stepper: project pick /
 * create, widget-key issuance, embed snippet + copy, live install verify).
 *
 * The wizard reads an injected fetcher from `container.__onboardingFetcher`
 * so these tests assert exact request bodies without stubbing globals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAND_COLORS } from '@pinpoint/shared';
import {
  mountOnboardingWizard,
  VERIFY_POLL_INTERVAL_MS,
  VERIFY_TIMEOUT_MS,
} from './OnboardingWizard';

const navigateMock = vi.fn();
vi.mock('../lib/router', () => ({
  navigate: (...args: unknown[]) => navigateMock(...args),
}));

type FetcherCall = { path: string; options?: RequestInit };

/** A fake apiFetch that records calls and resolves from a routing table. */
function makeFetcher(
  handler: (path: string, options?: RequestInit) => unknown,
): { fetcher: any; calls: FetcherCall[] } {
  const calls: FetcherCall[] = [];
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    calls.push({ path, options });
    return handler(path, options);
  });
  return { fetcher, calls };
}

function mount(fetcher: unknown): { container: HTMLElement; teardown: () => void } {
  const container = document.createElement('div');
  (container as any).__onboardingFetcher = fetcher;
  document.body.appendChild(container);
  const teardown = mountOnboardingWizard(container);
  return { container, teardown };
}

/** Flush pending microtasks so awaited fetches settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  navigateMock.mockClear();
  history.replaceState(null, '', '/onboarding');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('OnboardingWizard — render & accessibility', () => {
  it('renders step 1 with the step heading focused and an aria-live status', async () => {
    const { fetcher } = makeFetcher(() => ({ data: [] }));
    const { container, teardown } = mount(fetcher);
    await flush();

    const heading = container.querySelector('#onboarding-step-heading');
    expect(heading?.textContent).toContain('Choose a project');
    expect(heading).toBe(document.activeElement);

    const status = container.querySelector('.onboarding-status');
    expect(status?.getAttribute('aria-live')).toBe('polite');

    // Step indicator marks the current step with aria-current='step'.
    const current = container.querySelector('[aria-current="step"]');
    expect(current).not.toBeNull();
    teardown();
  });

  it('uses the brand token (never a bare hex) in the primary button fallback', async () => {
    const { fetcher } = makeFetcher(() => ({ data: [] }));
    const { container, teardown } = mount(fetcher);
    await flush();

    const createBtn = container.querySelector('.onboarding-create-project') as HTMLElement;
    expect(createBtn.style.cssText).toContain(`var(--color-primary,${BRAND_COLORS.primary})`);
    expect(container.innerHTML).not.toContain('background: #4f46e5');
    expect(container.innerHTML).not.toContain('background:#4f46e5');
    teardown();
  });

  it('redirects immediately when onboarding already complete', () => {
    localStorage.setItem('pinpoint_onboarding_complete', 'true');
    const container = document.createElement('div');
    document.body.appendChild(container);
    mountOnboardingWizard(container);
    expect(navigateMock).toHaveBeenCalledWith('/');
    expect(container.querySelector('.onboarding-wizard')).toBeNull();
  });
});

describe('OnboardingWizard — step 1 project selection', () => {
  it('lists existing projects and advances when one is chosen', async () => {
    const { fetcher } = makeFetcher((path) => {
      if (path === '/projects') return { data: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] };
      return {};
    });
    const { container, teardown } = mount(fetcher);
    await flush();

    const select = container.querySelector('.onboarding-project-select') as HTMLSelectElement;
    // placeholder + 2 projects
    expect(select.querySelectorAll('option').length).toBe(3);

    const useBtn = container.querySelector('.onboarding-use-existing') as HTMLButtonElement;
    expect(useBtn.disabled).toBe(true);

    select.value = 'p2';
    select.dispatchEvent(new Event('change'));
    expect(useBtn.disabled).toBe(false);

    useBtn.click();
    await flush();

    expect(container.querySelector('#onboarding-step-heading')?.textContent).toContain(
      'Create a widget key',
    );
    teardown();
  });

  it('creates a new project and advances', async () => {
    const { fetcher, calls } = makeFetcher((path, options) => {
      if (path === '/projects' && (options?.method ?? 'GET') === 'GET') return { data: [] };
      if (path === '/projects' && options?.method === 'POST') return { id: 'new-proj', name: 'Gamma' };
      return {};
    });
    const { container, teardown } = mount(fetcher);
    await flush();

    (container.querySelector('#onboarding-project-name') as HTMLInputElement).value = 'Gamma';
    (container.querySelector('#onboarding-project-url') as HTMLInputElement).value = 'https://g.example.com';
    (container.querySelector('.onboarding-create-project') as HTMLButtonElement).click();
    await flush();

    const post = calls.find((c) => c.path === '/projects' && c.options?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post!.options!.body as string)).toEqual({
      name: 'Gamma',
      urls: ['https://g.example.com'],
    });
    expect(container.querySelector('#onboarding-step-heading')?.textContent).toContain(
      'Create a widget key',
    );
    teardown();
  });
});

describe('OnboardingWizard — step 2 widget key issuance', () => {
  async function advanceToKeyStep(): Promise<{ container: HTMLElement; calls: FetcherCall[]; teardown: () => void }> {
    const { fetcher, calls } = makeFetcher((path, options) => {
      if (path === '/projects' && (options?.method ?? 'GET') === 'GET') return { data: [{ id: 'p1', name: 'Alpha' }] };
      if (path === '/api-keys') return { id: 'k1', rawKey: 'pk_widget_deadbeef' };
      return {};
    });
    const { container, teardown } = mount(fetcher);
    await flush();
    const select = container.querySelector('.onboarding-project-select') as HTMLSelectElement;
    select.value = 'p1';
    select.dispatchEvent(new Event('change'));
    (container.querySelector('.onboarding-use-existing') as HTMLButtonElement).click();
    await flush();
    return { container, calls, teardown };
  }

  it('posts keyType=widget with projectId and parsed allowedOrigins', async () => {
    const { container, calls, teardown } = await advanceToKeyStep();

    (container.querySelector('#onboarding-key-name') as HTMLInputElement).value = 'Prod widget';
    (container.querySelector('#onboarding-key-origins') as HTMLInputElement).value =
      ' https://a.com , https://b.com ';
    (container.querySelector('.onboarding-issue-key') as HTMLButtonElement).click();
    await flush();

    const post = calls.find((c) => c.path === '/api-keys');
    expect(post).toBeDefined();
    expect(post!.options!.method).toBe('POST');
    expect(JSON.parse(post!.options!.body as string)).toEqual({
      name: 'Prod widget',
      keyType: 'widget',
      projectId: 'p1',
      allowedOrigins: ['https://a.com', 'https://b.com'],
    });
    // Advances to the snippet step.
    expect(container.querySelector('#onboarding-step-heading')?.textContent).toContain(
      'Add the snippet',
    );
    teardown();
  });

  it('omits allowedOrigins when the field is blank', async () => {
    const { container, calls, teardown } = await advanceToKeyStep();
    (container.querySelector('.onboarding-issue-key') as HTMLButtonElement).click();
    await flush();
    const post = calls.find((c) => c.path === '/api-keys');
    const parsed = JSON.parse(post!.options!.body as string);
    expect(parsed).not.toHaveProperty('allowedOrigins');
    expect(parsed.keyType).toBe('widget');
    teardown();
  });

  it('shows an error state and stays on the key step when issuance fails', async () => {
    const { fetcher } = makeFetcher((path, options) => {
      if (path === '/projects' && (options?.method ?? 'GET') === 'GET') return { data: [{ id: 'p1', name: 'Alpha' }] };
      if (path === '/api-keys') throw new Error('boom');
      return {};
    });
    const { container, teardown } = mount(fetcher);
    await flush();
    const select = container.querySelector('.onboarding-project-select') as HTMLSelectElement;
    select.value = 'p1';
    select.dispatchEvent(new Event('change'));
    (container.querySelector('.onboarding-use-existing') as HTMLButtonElement).click();
    await flush();

    const issueBtn = container.querySelector('.onboarding-issue-key') as HTMLButtonElement;
    issueBtn.click();
    await flush();

    expect(container.querySelector('#onboarding-step-heading')?.textContent).toContain(
      'Create a widget key',
    );
    expect(container.querySelector('.onboarding-status')?.textContent).toContain('Could not issue');
    expect(issueBtn.disabled).toBe(false);
    teardown();
  });
});

describe('OnboardingWizard — step 3 snippet & copy', () => {
  async function advanceToSnippet(): Promise<{ container: HTMLElement; teardown: () => void }> {
    const { fetcher } = makeFetcher((path, options) => {
      if (path === '/projects' && (options?.method ?? 'GET') === 'GET') return { data: [{ id: 'p1', name: 'Alpha' }] };
      if (path === '/api-keys') return { id: 'k1', rawKey: 'pk_widget_abc123' };
      return {};
    });
    const { container, teardown } = mount(fetcher);
    await flush();
    const select = container.querySelector('.onboarding-project-select') as HTMLSelectElement;
    select.value = 'p1';
    select.dispatchEvent(new Event('change'));
    (container.querySelector('.onboarding-use-existing') as HTMLButtonElement).click();
    await flush();
    (container.querySelector('.onboarding-issue-key') as HTMLButtonElement).click();
    await flush();
    return { container, teardown };
  }

  it('renders the exact snippet with the issued key and editable apiUrl', async () => {
    const { container, teardown } = await advanceToSnippet();

    const apiInput = container.querySelector('#onboarding-api-url') as HTMLInputElement;
    expect(apiInput.value).toBe(window.location.origin);

    const snippet = container.querySelector('.onboarding-snippet') as HTMLTextAreaElement;
    expect(snippet.value).toContain(
      `<script src="${window.location.origin}/widget/pinpoint-widget.js"></script>`,
    );
    expect(snippet.value).toContain(
      `Pinpoint.init({ projectKey: 'pk_widget_abc123', apiUrl: '${window.location.origin}' });`,
    );

    // Editing the apiUrl re-renders the snippet with the new value.
    apiInput.value = 'https://api.example.com';
    apiInput.dispatchEvent(new Event('input'));
    expect(snippet.value).toContain('https://api.example.com/widget/pinpoint-widget.js');
    teardown();
  });

  it('copies the snippet and shows a Copied confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { container, teardown } = await advanceToSnippet();
    (container.querySelector('.onboarding-copy') as HTMLButtonElement).click();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('pinpoint-widget.js');
    const copyStatus = container.querySelector('.onboarding-copy-status');
    expect(copyStatus?.getAttribute('aria-live')).toBe('polite');
    expect(copyStatus?.textContent).toBe('Copied');
    teardown();
  });

  it('exposes Browser extension and Review link tabs', async () => {
    const { container, teardown } = await advanceToSnippet();
    expect(container.querySelector('.onboarding-tab-ext')).not.toBeNull();
    expect(container.querySelector('.onboarding-tab-review')).not.toBeNull();
    // Review panel starts hidden; clicking its tab reveals it.
    const reviewPanel = container.querySelector('#onboarding-tabpanel-review') as HTMLElement;
    expect(reviewPanel.hidden).toBe(true);
    (container.querySelector('.onboarding-tab-review') as HTMLButtonElement).click();
    expect(reviewPanel.hidden).toBe(false);
    teardown();
  });
});

describe('OnboardingWizard — step 4 verify install', () => {
  async function advanceToVerify(
    annotationsHandler: () => unknown,
  ): Promise<{ container: HTMLElement; teardown: () => void }> {
    const { fetcher } = makeFetcher((path, options) => {
      if (path === '/projects' && (options?.method ?? 'GET') === 'GET') return { data: [{ id: 'p1', name: 'Alpha' }] };
      if (path === '/api-keys') return { id: 'k1', rawKey: 'pk_widget_v' };
      if (path.startsWith('/projects/p1/annotations')) return annotationsHandler();
      return {};
    });
    const { container, teardown } = mount(fetcher);
    await flush();
    const select = container.querySelector('.onboarding-project-select') as HTMLSelectElement;
    select.value = 'p1';
    select.dispatchEvent(new Event('change'));
    (container.querySelector('.onboarding-use-existing') as HTMLButtonElement).click();
    await flush();
    (container.querySelector('.onboarding-issue-key') as HTMLButtonElement).click();
    await flush();
    (container.querySelector('.onboarding-verify-next') as HTMLButtonElement).click();
    await flush();
    return { container, teardown };
  }

  it('polls and reports success when a fresh annotation appears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    let hasFresh = false;
    const { container, teardown } = await advanceToVerify(() =>
      hasFresh ? { data: [{ id: 'a1', createdAt: '2026-01-01T00:00:10Z' }] } : { data: [] },
    );

    expect(container.querySelector('.onboarding-cancel')).not.toBeNull();

    // First poll fires at 3s — still empty.
    await vi.advanceTimersByTimeAsync(VERIFY_POLL_INTERVAL_MS);
    expect(container.querySelector('.onboarding-status')?.textContent).toContain('Waiting');

    // A fresh annotation lands; next poll detects it.
    hasFresh = true;
    await vi.advanceTimersByTimeAsync(VERIFY_POLL_INTERVAL_MS);

    expect(container.querySelector('.onboarding-status')?.textContent).toContain('working');
    expect(container.querySelector('.onboarding-verify-state')?.textContent).toContain('Success');
    teardown();
  });

  it('reports a timeout after 2 minutes with no fresh feedback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { container, teardown } = await advanceToVerify(() => ({ data: [] }));

    // Run well past the 2-minute ceiling.
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + VERIFY_POLL_INTERVAL_MS);

    expect(container.querySelector('.onboarding-status')?.textContent).toContain('No feedback yet');
    expect(container.querySelector('.onboarding-verify-state')?.textContent).toContain('Timed out');
    expect(container.querySelector('.onboarding-retry')).not.toBeNull();
    teardown();
  });

  it('cancel stops polling and completes onboarding', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { container, teardown } = await advanceToVerify(() => ({ data: [] }));
    (container.querySelector('.onboarding-cancel') as HTMLButtonElement).click();

    expect(localStorage.getItem('pinpoint_onboarding_complete')).toBe('true');
    expect(navigateMock).toHaveBeenCalledWith('/');
    teardown();
  });

  it('clears the poll timer on teardown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const pollCalls: number[] = [];
    const { fetcher } = makeFetcher((path, options) => {
      if (path === '/projects' && (options?.method ?? 'GET') === 'GET') return { data: [{ id: 'p1', name: 'Alpha' }] };
      if (path === '/api-keys') return { id: 'k1', rawKey: 'pk_widget_v' };
      if (path.startsWith('/projects/p1/annotations')) {
        pollCalls.push(Date.now());
        return { data: [] };
      }
      return {};
    });
    const container = document.createElement('div');
    (container as any).__onboardingFetcher = fetcher;
    document.body.appendChild(container);
    const teardown = mountOnboardingWizard(container);
    await flush();
    const select = container.querySelector('.onboarding-project-select') as HTMLSelectElement;
    select.value = 'p1';
    select.dispatchEvent(new Event('change'));
    (container.querySelector('.onboarding-use-existing') as HTMLButtonElement).click();
    await flush();
    (container.querySelector('.onboarding-issue-key') as HTMLButtonElement).click();
    await flush();
    (container.querySelector('.onboarding-verify-next') as HTMLButtonElement).click();
    await flush();

    await vi.advanceTimersByTimeAsync(VERIFY_POLL_INTERVAL_MS);
    const callsBefore = pollCalls.length;

    teardown();
    await vi.advanceTimersByTimeAsync(VERIFY_POLL_INTERVAL_MS * 3);
    expect(pollCalls.length).toBe(callsBefore);
  });
});
