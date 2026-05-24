// @vitest-environment jsdom
/**
 * Unit tests for the vanilla `mountProjectView` page (task 18.8).
 *
 * Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 17.4, 22.6, 8.3, 8.4, 6.6, 6.7
 *
 * Covers:
 * - Initial fetch resolves loading -> content with the analytics panel,
 *   list view, and the project title.
 * - The four analytics dimensions render (severity, type, status,
 *   byBrowser); the byBrowser card lists each closed BrowserFamily key
 *   present in the response.
 * - List rows are clickable and reveal the detail panel.
 * - The view toggle swaps between list and kanban subviews.
 * - Kanban drag-and-drop posts a status update and updates the local
 *   list optimistically.
 * - Detail view shows the bug-report assignee dropdown populated from
 *   the members fetch and saves assignment + due date.
 * - Real-time `annotation:created` updates the list and analytics totals.
 * - Real-time `annotation:viewers` repaints the co-viewer indicator with
 *   avatars or initials, suppressing the local user.
 * - Reconnecting banner toggles when the socket reports a state change.
 * - Teardown disconnects subscriptions and removes the page DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '@pinpoint/shared';

// ---------------------------------------------------------------------------
// Socket mock — captured before importing the page module so the module
// resolves the mocked exports.
// ---------------------------------------------------------------------------

type SocketHandler = (...args: any[]) => void;
const socketHandlers = new Map<string, SocketHandler>();
let reconnectHandler: ((value: boolean) => void) | null = null;
const socketCalls = {
  joinProject: vi.fn<(id: string) => void>(),
  leaveProject: vi.fn<() => void>(),
  emitAnnotationOpen: vi.fn<(id: string) => void>(),
  emitAnnotationClose: vi.fn<(id: string) => void>(),
};

vi.mock('../lib/socket', () => ({
  joinProject: (id: string) => socketCalls.joinProject(id),
  leaveProject: () => socketCalls.leaveProject(),
  emitAnnotationOpen: (id: string) => socketCalls.emitAnnotationOpen(id),
  emitAnnotationClose: (id: string) => socketCalls.emitAnnotationClose(id),
  onSocketEvent: (event: string, handler: SocketHandler) => {
    socketHandlers.set(event, handler);
    return () => {
      if (socketHandlers.get(event) === handler) socketHandlers.delete(event);
    };
  },
  onReconnectStateChange: (handler: (value: boolean) => void) => {
    reconnectHandler = handler;
    return () => {
      if (reconnectHandler === handler) reconnectHandler = null;
    };
  },
}));

// AppLayout is exercised separately; here we replace it with a minimal stub
// that just appends the content node so the project view DOM is observable.
vi.mock('../components/AppLayout', () => ({
  mountAppLayout: (rootEl: Element, contentNode: Node) => {
    rootEl.appendChild(contentNode);
    return () => {
      if (contentNode.parentNode === rootEl) {
        rootEl.removeChild(contentNode);
      }
    };
  },
}));

// Auth library reads localStorage on import; stub the export the api module
// pulls in so a token is always present.
vi.mock('../lib/auth', () => ({
  getToken: () => 'fake-token',
  // Task 7.4: `lib/api.ts` reads the CSRF token via `getCsrfToken` to
  // attach the `X-CSRF-Token` header on mutating requests. Tests do not
  // need real CSRF semantics, so we stub a constant token.
  getCsrfToken: () => 'fake-csrf',
  setCsrfToken: () => {},
  clearAuth: () => {},
  getIsAuthed: () => true,
}));

import { mountProjectView } from './ProjectView';
import { resetStores } from '../lib/stores';

// ---------------------------------------------------------------------------
// Template fixtures — mirror the production templates in `index.html` but
// strip the inline styles. The page module operates on `data-section`,
// `data-role`, and `data-slot` selectors, so the structural shape is what
// matters for the tests.
// ---------------------------------------------------------------------------

const TEMPLATES: Record<string, string> = {
  'tpl-project-view': `
    <div data-fl-project-root>
      <div data-section="reconnecting" hidden>
        <span data-role="reconnect-msg">Reconnecting to real-time updates…</span>
      </div>
      <div data-section="loading">Loading…</div>
      <div data-section="error" hidden>
        Error: <span data-slot="error-message"></span>
      </div>
      <div data-section="content" hidden>
        <header>
          <h1 data-slot="project-title"></h1>
          <div data-role="view-toggle">
            <button type="button" data-action="select-list" data-role="toggle-list">List</button>
            <button type="button" data-action="select-kanban" data-role="toggle-kanban">Kanban</button>
          </div>
        </header>
        <div data-role="analytics" hidden>
          <div data-role="analytics-card" data-dim="bySeverity">
            <div>By Severity</div>
            <div data-role="rows"></div>
          </div>
          <div data-role="analytics-card" data-dim="byType">
            <div>By Type</div>
            <div data-role="rows"></div>
          </div>
          <div data-role="analytics-card" data-dim="byStatus">
            <div>By Status</div>
            <div data-role="rows"></div>
          </div>
          <div data-role="analytics-card" data-dim="byBrowser">
            <div>By Browser</div>
            <div data-role="rows"></div>
          </div>
        </div>
        <section data-section="list" hidden>
          <p data-role="list-empty" hidden>No annotations yet.</p>
          <table data-role="list-table" hidden>
            <tbody data-role="list-body"></tbody>
          </table>
        </section>
        <section data-section="kanban" hidden>
          <div data-role="kanban-column" data-status="active">
            <div data-slot="column-header"></div>
            <div data-role="kanban-cards"></div>
          </div>
          <div data-role="kanban-column" data-status="in_progress">
            <div data-slot="column-header"></div>
            <div data-role="kanban-cards"></div>
          </div>
          <div data-role="kanban-column" data-status="resolved">
            <div data-slot="column-header"></div>
            <div data-role="kanban-cards"></div>
          </div>
        </section>
        <section data-section="detail" hidden>
          <button type="button" data-action="back">← Back to list</button>
          <div>
            <div>
              <h2>
                #<span data-slot="detail-pin"></span> — <span data-slot="detail-type"></span>
                <span data-role="bug-badge" hidden>Bug Report</span>
              </h2>
              <div>
                <div data-role="co-viewers" role="group" aria-label="Co-viewers" data-co-viewers></div>
                <span data-slot="detail-severity"></span>
              </div>
            </div>
            <div data-slot="detail-body"></div>
            <div data-role="screenshot-panel" hidden>
              <img data-role="screenshot-img" alt="Annotation screenshot" />
              <div data-role="screenshot-overlay" aria-hidden="true"></div>
            </div>
            <div>
              Status: <span data-slot="detail-status"></span>
              · Page: <span data-slot="detail-page-url"></span>
            </div>
            <div data-role="env-panel" hidden>
              <div data-role="env-summary" data-slot="env-summary"></div>
              <button type="button" data-action="toggle-env" data-role="env-toggle" aria-expanded="false">
                <span data-slot="env-arrow">▸</span> Environment details
              </button>
              <div data-role="env-details" hidden>
                <div>Browser: <span data-slot="env-browser"></span></div>
                <div>OS: <span data-slot="env-os"></span></div>
                <div>Device: <span data-slot="env-device"></span></div>
                <div data-role="env-viewport-row" hidden>
                  Viewport: <span data-slot="env-viewport"></span>
                </div>
                <div data-role="env-dpr-row" hidden>
                  DPR: <span data-slot="env-dpr"></span>
                </div>
                <div data-role="env-ua-row">
                  <button type="button" data-action="toggle-ua" data-role="env-ua-toggle" aria-expanded="false">
                    <span data-slot="env-ua-arrow">▸</span> User Agent
                  </button>
                  <div data-role="env-ua-value" data-slot="env-ua" hidden></div>
                </div>
              </div>
            </div>
            <details data-role="console-panel" hidden>
              <summary>Console (<span data-slot="console-count">0</span>)</summary>
              <ul data-role="console-list"></ul>
            </details>
            <details data-role="network-panel" hidden>
              <summary>Network (<span data-slot="network-count">0</span>)</summary>
              <ul data-role="network-list"></ul>
            </details>
            <div data-role="assignment-panel" hidden>
              <div>Assignment</div>
              <div>
                <select data-role="assignee-select"><option value="">Unassigned</option></select>
                <input type="date" data-role="due-date" />
                <button type="button" data-action="save-assignment">Save</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  `,
  'tpl-project-view-list-row': `
    <tr>
      <td data-slot="pin-number"></td>
      <td data-slot="type"></td>
      <td><span data-slot="severity"></span></td>
      <td data-slot="status"></td>
      <td data-slot="body"></td>
    </tr>
  `,
  'tpl-project-view-kanban-card': `
    <div draggable="true">
      <div>
        <span>#<span data-slot="pin-number"></span></span>
        <span data-slot="severity"></span>
      </div>
      <div data-slot="type"></div>
      <div data-slot="body"></div>
    </div>
  `,
};

function installTemplates(): void {
  for (const [id, html] of Object.entries(TEMPLATES)) {
    const tpl = document.createElement('template');
    tpl.id = id;
    tpl.innerHTML = html;
    document.body.appendChild(tpl);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

interface AnalyticsResponse {
  total: number;
  bySeverity: { critical: number; major: number; minor: number; informational: number };
  byType: { note: number; suggestion: number; guideline: number };
  byStatus: { active: number; in_progress: number; resolved: number };
  byBrowser: Record<string, number>;
}

function makeAnalytics(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return {
    total: overrides.total ?? 1,
    bySeverity: overrides.bySeverity ?? { critical: 0, major: 1, minor: 0, informational: 0 },
    byType: overrides.byType ?? { note: 1, suggestion: 0, guideline: 0 },
    byStatus: overrides.byStatus ?? { active: 1, in_progress: 0, resolved: 0 },
    byBrowser: overrides.byBrowser ?? {
      Chrome: 1,
      Edge: 0,
      Safari: 0,
      Firefox: 0,
      Opera: 0,
      Brave: 0,
      Arc: 0,
      Other: 0,
      unknown: 0,
    },
  };
}

interface FakeFetchPlan {
  annotations?: Annotation[];
  analytics?: AnalyticsResponse;
  members?: Array<{
    userId: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
  }>;
  me?: { id: string; email: string; name: string };
  recordedRequests?: Array<{ url: string; init: RequestInit | undefined }>;
}

function makeFetch(plan: FakeFetchPlan): ReturnType<typeof vi.fn> {
  const recorded = plan.recordedRequests ?? [];
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    recorded.push({ url, init });
    if (url.endsWith('/annotations') && (!init || init.method === undefined)) {
      return jsonResponse({ annotations: plan.annotations ?? [] });
    }
    if (url.endsWith('/analytics')) {
      return jsonResponse({ analytics: plan.analytics ?? makeAnalytics() });
    }
    if (url.endsWith('/members')) {
      return jsonResponse({ members: plan.members ?? [] });
    }
    if (url.endsWith('/users/me')) {
      return jsonResponse(plan.me ?? { id: 'user-1', email: 'me@x', name: 'Me' });
    }
    if (url.includes('/annotations/') && (init?.method === 'PUT')) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({});
  });
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mountProjectView', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installTemplates();
    resetStores();
    socketHandlers.clear();
    reconnectHandler = null;
    socketCalls.joinProject.mockReset();
    socketCalls.leaveProject.mockReset();
    socketCalls.emitAnnotationOpen.mockReset();
    socketCalls.emitAnnotationClose.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetStores();
    document.body.innerHTML = '';
  });

  it('renders loading then the analytics panel and list once fetches resolve', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [makeAnnotation({ id: 'a1', body: 'first' })],
        analytics: makeAnalytics(),
      }),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountProjectView(root, { id: 'proj-1' });
    expect(getSection('loading').hidden).toBe(false);

    await flush();

    expect(getSection('loading').hidden).toBe(true);
    expect(getSection('content').hidden).toBe(false);
    expect(getProjectTitle().textContent).toBe('Project: proj-1');

    // Analytics panel visible with all four cards populated.
    const analytics = root.querySelector<HTMLElement>('[data-role="analytics"]')!;
    expect(analytics.hidden).toBe(false);
    expect(rowsForCard(analytics, 'bySeverity').length).toBe(4);
    expect(rowsForCard(analytics, 'byType').length).toBe(3);
    expect(rowsForCard(analytics, 'byStatus').length).toBe(3);
    expect(rowsForCard(analytics, 'byBrowser').length).toBe(9);

    // List visible with the row.
    const tableRows = root.querySelectorAll('[data-role="list-body"] tr');
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0].querySelector('[data-slot="body"]')!.textContent).toBe('first');
  });

  it('renders every closed BrowserFamily enum key with its count in the byBrowser card (Req 17.5)', async () => {
    // The closed BrowserFamily enum from `shared/src/types.ts` has 9
    // members. The dashboard analytics panel must surface all of them as
    // the response payload provides — including the explicit `unknown`
    // bucket — so that empty buckets remain visible to the user.
    const browserCounts: Record<string, number> = {
      Chrome: 5,
      Edge: 4,
      Safari: 3,
      Firefox: 2,
      Opera: 1,
      Brave: 6,
      Arc: 7,
      Other: 8,
      unknown: 9,
    };
    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [],
        analytics: makeAnalytics({
          total: Object.values(browserCounts).reduce((a, b) => a + b, 0),
          byBrowser: browserCounts,
        }),
      }),
    );

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    const analytics = root.querySelector<HTMLElement>('[data-role="analytics"]')!;
    const browserRows = rowsForCard(analytics, 'byBrowser');
    expect(browserRows).toHaveLength(9);

    // Each row is rendered as `<div><span>{label}</span><span>{count}</span></div>`.
    // Build a label -> count map so order-independence is preserved.
    const rendered = new Map<string, string>();
    for (const row of browserRows) {
      const label = row.firstChild?.textContent ?? '';
      const value = row.lastChild?.textContent ?? '';
      rendered.set(label, value);
    }

    const expectedKeys = [
      'Chrome',
      'Edge',
      'Safari',
      'Firefox',
      'Opera',
      'Brave',
      'Arc',
      'Other',
      'unknown',
    ] as const;
    for (const key of expectedKeys) {
      expect(rendered.has(key)).toBe(true);
      expect(rendered.get(key)).toBe(String(browserCounts[key]));
    }
  });

  it('toggles between list and kanban subviews', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ annotations: [makeAnnotation({ id: 'a1' })] }),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountProjectView(root, { id: 'proj-1' });
    await flush();

    expect(getSection('list').hidden).toBe(false);
    expect(getSection('kanban').hidden).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-role="toggle-kanban"]')!.click();
    expect(getSection('list').hidden).toBe(true);
    expect(getSection('kanban').hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-role="toggle-list"]')!.click();
    expect(getSection('list').hidden).toBe(false);
    expect(getSection('kanban').hidden).toBe(true);
  });

  it('selecting a list row reveals the detail panel and emits annotation:open', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [
          makeAnnotation({
            id: 'a1',
            pinNumber: 7,
            body: 'detail body',
            severity: 'critical',
            status: 'in_progress',
          }),
        ],
      }),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountProjectView(root, { id: 'proj-1' });
    await flush();

    const row = root.querySelector('[data-role="list-body"] tr') as HTMLElement;
    row.click();

    expect(getSection('detail').hidden).toBe(false);
    expect(getSection('list').hidden).toBe(true);
    expect(root.querySelector('[data-slot="detail-pin"]')!.textContent).toBe('7');
    expect(root.querySelector('[data-slot="detail-body"]')!.textContent).toBe('detail body');
    expect(root.querySelector('[data-slot="detail-severity"]')!.textContent).toBe('critical');
    expect(socketCalls.emitAnnotationOpen).toHaveBeenCalledWith('a1');

    // Bug-report badge shown for critical notes (Req 8.4).
    const badge = root.querySelector<HTMLElement>('[data-role="bug-badge"]')!;
    expect(badge.hidden).toBe(false);
  });

  it('back navigation hides the detail panel and emits annotation:close', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ annotations: [makeAnnotation({ id: 'a1', severity: 'critical' })] }),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();
    expect(getSection('detail').hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-action="back"]')!.click();
    expect(getSection('detail').hidden).toBe(true);
    expect(getSection('list').hidden).toBe(false);
    expect(socketCalls.emitAnnotationClose).toHaveBeenCalledWith('a1');
  });

  it('renders the assignee dropdown from members and posts assignment changes', async () => {
    const recorded: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = makeFetch({
      annotations: [makeAnnotation({ id: 'a1', severity: 'critical' })],
      members: [
        { userId: 'm1', name: 'Mira', email: 'mira@x', avatarUrl: null, role: 'admin' },
        { userId: 'm2', name: 'Nico', email: 'nico@x', avatarUrl: null, role: 'viewer' },
      ],
      recordedRequests: recorded,
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();

    const select = root.querySelector<HTMLSelectElement>('[data-role="assignee-select"]')!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'm1', 'm2']);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Unassigned',
      'Mira (mira@x)',
      'Nico (nico@x)',
    ]);

    select.value = 'm2';
    const due = root.querySelector<HTMLInputElement>('[data-role="due-date"]')!;
    due.value = '2025-06-15';

    root.querySelector<HTMLButtonElement>('[data-action="save-assignment"]')!.click();
    await flush();

    const putCall = recorded.find(
      (r) => r.url.endsWith('/annotations/a1') && r.init?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall!.init!.body as string);
    expect(body.assigneeId).toBe('m2');
    expect(body.dueDate).toMatch(/^2025-06-15T/);
  });

  it('expands the environment metadata panel on toggle', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [
          makeAnnotation({
            id: 'a1',
            environment: {
              browserFamily: 'Firefox',
              browserVersion: '125',
              osFamily: 'Linux',
              osVersion: '6.5',
              deviceType: 'desktop',
              userAgentRaw: 'mock-ua',
              viewportWidth: 1280,
              viewportHeight: 720,
              devicePixelRatio: 2,
            },
          }),
        ],
      }),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();

    // The single-line summary (Reqs 8.3, 17.4) is rendered above the toggle
    // even when the details panel is collapsed.
    expect(root.querySelector('[data-slot="env-summary"]')!.textContent).toBe(
      'Reported on Firefox 125 on Linux 6.5',
    );

    const details = root.querySelector<HTMLElement>('[data-role="env-details"]')!;
    const envToggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-env"]',
    )!;
    expect(details.hidden).toBe(true);
    expect(envToggle.getAttribute('aria-expanded')).toBe('false');
    envToggle.click();
    expect(details.hidden).toBe(false);
    expect(envToggle.getAttribute('aria-expanded')).toBe('true');

    expect(root.querySelector('[data-slot="env-browser"]')!.textContent).toBe('Firefox 125');
    expect(root.querySelector('[data-slot="env-os"]')!.textContent).toBe('Linux 6.5');
    expect(root.querySelector('[data-slot="env-device"]')!.textContent).toBe('desktop');
    expect(root.querySelector('[data-slot="env-viewport"]')!.textContent).toBe('1280 × 720');
    expect(root.querySelector('[data-slot="env-dpr"]')!.textContent).toBe('2');

    // Raw UA stays collapsed under its own toggle; expanding it reveals
    // the full string (Req 17.4 — "raw UA expandable").
    const uaValue = root.querySelector<HTMLElement>('[data-role="env-ua-value"]')!;
    const uaToggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-ua"]',
    )!;
    expect(uaValue.hidden).toBe(true);
    expect(uaToggle.getAttribute('aria-expanded')).toBe('false');
    uaToggle.click();
    expect(uaValue.hidden).toBe(false);
    expect(uaToggle.getAttribute('aria-expanded')).toBe('true');
    expect(uaValue.textContent).toBe('mock-ua');
  });

  it('summary collapses unknown families and missing versions', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [
          makeAnnotation({
            id: 'a1',
            environment: {
              browserFamily: 'unknown',
              browserVersion: null,
              osFamily: 'Windows',
              osVersion: null,
              deviceType: 'mobile',
              userAgentRaw: 'noversion-ua',
            },
          }),
        ],
      }),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();

    expect(root.querySelector('[data-slot="env-summary"]')!.textContent).toBe(
      'Reported on Windows',
    );

    // Viewport / DPR rows stay hidden when the optional fields are
    // absent; the UA row is always visible because every annotation
    // carries a raw UA string.
    expect(
      root.querySelector<HTMLElement>('[data-role="env-viewport-row"]')!.hidden,
    ).toBe(true);
    expect(
      root.querySelector<HTMLElement>('[data-role="env-dpr-row"]')!.hidden,
    ).toBe(true);
    expect(
      root.querySelector<HTMLElement>('[data-role="env-ua-row"]')!.hidden,
    ).toBe(false);
    expect(root.querySelector('[data-slot="env-device"]')!.textContent).toBe('mobile');
  });

  it('kanban drag-and-drop posts a status change and updates the column locally', async () => {
    const recorded: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = makeFetch({
      annotations: [
        makeAnnotation({ id: 'a1', status: 'active', pinNumber: 1 }),
      ],
      recordedRequests: recorded,
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    root.querySelector<HTMLButtonElement>('[data-role="toggle-kanban"]')!.click();

    const card = root.querySelector(
      '[data-role="kanban-column"][data-status="active"] [data-role="kanban-cards"] > div',
    ) as HTMLElement;
    expect(card).not.toBeNull();

    const target = root.querySelector(
      '[data-role="kanban-column"][data-status="resolved"]',
    ) as HTMLElement;

    // jsdom does not implement `DragEvent` or `DataTransfer`; synthesize
    // both with the minimum surface the page module touches (`getData`,
    // `setData`, `preventDefault`).
    const dt = makeDataTransferStub();
    card.dispatchEvent(makeDragEvent('dragstart', dt));
    target.dispatchEvent(makeDragEvent('dragover', dt));
    target.dispatchEvent(makeDragEvent('drop', dt));

    await flush();

    const putCall = recorded.find(
      (r) => r.url.endsWith('/annotations/a1/status') && r.init?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(putCall!.init!.body as string)).toEqual({ status: 'resolved' });

    // After the optimistic update the card should now be in the resolved
    // column.
    const resolvedCards = target.querySelectorAll('[data-role="kanban-cards"] > div');
    expect(resolvedCards).toHaveLength(1);
  });

  it('reconnecting banner toggles when the socket reports state changes', async () => {
    vi.stubGlobal('fetch', makeFetch({ annotations: [] }));
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    expect(getSection('reconnecting').hidden).toBe(true);
    expect(reconnectHandler).not.toBeNull();
    reconnectHandler!(true);
    expect(getSection('reconnecting').hidden).toBe(false);
    reconnectHandler!(false);
    expect(getSection('reconnecting').hidden).toBe(true);
  });

  it('annotation:created broadcast appends to the list and bumps analytics totals', async () => {
    vi.stubGlobal('fetch', makeFetch({ annotations: [], analytics: makeAnalytics({
      total: 0,
      bySeverity: { critical: 0, major: 0, minor: 0, informational: 0 },
      byType: { note: 0, suggestion: 0, guideline: 0 },
      byStatus: { active: 0, in_progress: 0, resolved: 0 },
      byBrowser: { Chrome: 0, Edge: 0, Safari: 0, Firefox: 0, Opera: 0, Brave: 0, Arc: 0, Other: 0, unknown: 0 },
    }) }));

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    const handler = socketHandlers.get('annotation:created');
    expect(handler).toBeDefined();
    handler!(makeAnnotation({ id: 'b1', body: 'realtime row', severity: 'major', status: 'active' }));

    const rows = root.querySelectorAll('[data-role="list-body"] tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('[data-slot="body"]')!.textContent).toBe('realtime row');

    // Analytics severity row for `major` ticked from 0 to 1.
    const analytics = root.querySelector<HTMLElement>('[data-role="analytics"]')!;
    const sevRows = rowsForCard(analytics, 'bySeverity');
    const major = sevRows.find((row) => row.firstChild?.textContent === 'major')!;
    expect(major.lastChild!.textContent).toBe('1');
  });

  it('annotation:viewers broadcast paints avatars and suppresses the local user', async () => {
    vi.stubGlobal('fetch', makeFetch({
      annotations: [makeAnnotation({ id: 'a1', severity: 'critical' })],
      members: [
        { userId: 'me', name: 'Me', email: 'me@x', avatarUrl: null, role: 'admin' },
        { userId: 'them', name: 'Other Person', email: 'them@x', avatarUrl: null, role: 'viewer' },
        { userId: 'extra', name: 'Extra Body', email: 'e@x', avatarUrl: 'https://x/y.png', role: 'viewer' },
      ],
      me: { id: 'me', email: 'me@x', name: 'Me' },
    }));

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();

    const handler = socketHandlers.get('annotation:viewers');
    expect(handler).toBeDefined();
    handler!({ id: 'a1', userIds: ['me', 'them', 'extra'] });

    const container = root.querySelector<HTMLElement>('[data-role="co-viewers"]')!;
    expect(container.children).toHaveLength(2);
    // One avatar is an `img` (because `extra` has avatarUrl), the other is
    // a `span` carrying initials.
    const tags = Array.from(container.children).map((c) => c.tagName);
    expect(tags.sort()).toEqual(['IMG', 'SPAN']);
  });

  it('on fetch failure renders the error state', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/annotations')) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: { message: 'forbidden' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    expect(getSection('loading').hidden).toBe(true);
    expect(getSection('error').hidden).toBe(false);
    expect(root.querySelector('[data-slot="error-message"]')!.textContent).toBe('forbidden');
  });

  it('teardown disconnects the socket and removes the page DOM', async () => {
    vi.stubGlobal('fetch', makeFetch({ annotations: [] }));
    const root = document.createElement('div');
    document.body.appendChild(root);
    const teardown = mountProjectView(root, { id: 'proj-1' });
    await flush();

    expect(socketCalls.joinProject).toHaveBeenCalledWith('proj-1');
    teardown();
    expect(socketCalls.leaveProject).toHaveBeenCalled();
    expect(root.querySelector('[data-fl-project-root]')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Inline screenshot rendering in the detail panel (Req 34.4 / Task 25.6).
  // -------------------------------------------------------------------------

  it('reveals the screenshot panel and requests the bitmap when annotation.screenshotObjectKey is set', async () => {
    const recorded: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      recorded.push({ url, init });
      if (url.endsWith('/annotations') && (!init || init.method === undefined)) {
        return jsonResponse({
          annotations: [
            makeAnnotation({
              id: 'a1',
              severity: 'critical',
              screenshotObjectKey: 'projects/proj-1/annotations/a1/screenshot.png',
            }),
          ],
        });
      }
      if (url.endsWith('/analytics')) return jsonResponse({ analytics: makeAnalytics() });
      if (url.endsWith('/members')) return jsonResponse({ members: [] });
      if (url.endsWith('/users/me')) {
        return jsonResponse({ id: 'user-1', email: 'me@x', name: 'Me' });
      }
      if (url.endsWith('/annotations/a1/screenshot')) {
        return jsonResponse({
          screenshotObjectKey: 'projects/proj-1/annotations/a1/screenshot.png',
          screenshotUrl: 'https://cdn.example.test/shot.png',
        });
      }
      if (url.endsWith('/annotations/a1/markup')) {
        // Best-effort: respond with no markup so the overlay path runs
        // but stays empty. The visibility test does not depend on the
        // SVG being painted.
        return jsonResponse({ markupDocument: null });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();
    await flush();

    const panel = root.querySelector<HTMLElement>('[data-role="screenshot-panel"]')!;
    expect(panel.hidden).toBe(false);

    const screenshotCalls = recorded.filter((r) =>
      r.url.endsWith('/annotations/a1/screenshot'),
    );
    expect(screenshotCalls.length).toBeGreaterThanOrEqual(1);

    const img = root.querySelector<HTMLImageElement>('[data-role="screenshot-img"]')!;
    // After the fetch resolves the page assigns the screenshot URL to
    // the `<img>` so the bitmap loads inline.
    expect(img.getAttribute('src')).toBe('https://cdn.example.test/shot.png');
  });

  it('hides the screenshot panel and never issues a screenshot fetch when screenshotObjectKey is missing', async () => {
    const recorded: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = makeFetch({
      annotations: [makeAnnotation({ id: 'a1', severity: 'critical' })],
      recordedRequests: recorded,
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();
    await flush();

    const panel = root.querySelector<HTMLElement>('[data-role="screenshot-panel"]')!;
    expect(panel.hidden).toBe(true);

    const img = root.querySelector<HTMLImageElement>('[data-role="screenshot-img"]')!;
    expect(img.hasAttribute('src')).toBe(false);

    const overlay = root.querySelector<HTMLElement>('[data-role="screenshot-overlay"]')!;
    expect(overlay.children).toHaveLength(0);

    // No screenshot or markup fetch should be triggered for an
    // annotation without a stored screenshot.
    const screenshotCalls = recorded.filter(
      (r) =>
        r.url.endsWith('/annotations/a1/screenshot') ||
        r.url.endsWith('/annotations/a1/markup'),
    );
    expect(screenshotCalls).toHaveLength(0);
  });

  it('throws a clear error when the project view template is missing', () => {
    document.getElementById('tpl-project-view')!.remove();
    const root = document.createElement('div');
    document.body.appendChild(root);
    expect(() => mountProjectView(root, { id: 'proj-1' })).toThrow(
      /no <template> element found with id "tpl-project-view"/,
    );
  });

  // -------------------------------------------------------------------------
  // Captured Console / Network sections (Req 36.3, task 27.4)
  // -------------------------------------------------------------------------

  it('hides the console and network panels when the buffers are absent or empty', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [
          makeAnnotation({
            id: 'a1',
            severity: 'critical',
            capturedConsole: null,
            capturedNetwork: [],
          } as Partial<Annotation>),
        ],
      }),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();

    const consolePanel = root.querySelector<HTMLElement>(
      '[data-role="console-panel"]',
    )!;
    const networkPanel = root.querySelector<HTMLElement>(
      '[data-role="network-panel"]',
    )!;
    expect(consolePanel.hidden).toBe(true);
    expect(networkPanel.hidden).toBe(true);
  });

  it('renders captured console and network entries in order with the correct counts', async () => {
    const consoleBuffer = [
      {
        level: 'log',
        message: 'first log',
        timestamp: '2024-05-01T10:00:00.000Z',
      },
      {
        level: 'warn',
        message: 'a warning',
        timestamp: '2024-05-01T10:00:01.000Z',
      },
      {
        level: 'error',
        message: 'boom',
        timestamp: '2024-05-01T10:00:02.000Z',
        stack: 'Error: boom\n  at foo:1:1',
      },
    ];
    const networkBuffer = [
      {
        name: 'https://api.example.com/users',
        initiatorType: 'fetch',
        startTime: 100,
        duration: 42.7,
        responseStatus: 200,
      },
      {
        name: 'https://api.example.com/missing',
        initiatorType: 'fetch',
        startTime: 200,
        duration: 12.1,
        responseStatus: 404,
      },
      {
        name: 'https://cdn.example.com/script.js',
        initiatorType: 'script',
        startTime: 300,
        duration: 5.5,
      },
    ];

    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [
          makeAnnotation({
            id: 'a1',
            severity: 'critical',
            capturedConsole: consoleBuffer,
            capturedNetwork: networkBuffer,
          } as Partial<Annotation>),
        ],
      }),
    );

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    (root.querySelector('[data-role="list-body"] tr') as HTMLElement).click();

    const consolePanel = root.querySelector<HTMLElement>(
      '[data-role="console-panel"]',
    )!;
    const networkPanel = root.querySelector<HTMLElement>(
      '[data-role="network-panel"]',
    )!;
    expect(consolePanel.hidden).toBe(false);
    expect(networkPanel.hidden).toBe(false);
    expect(
      consolePanel.querySelector('[data-slot="console-count"]')!.textContent,
    ).toBe('3');
    expect(
      networkPanel.querySelector('[data-slot="network-count"]')!.textContent,
    ).toBe('3');

    const consoleRows = Array.from(
      root.querySelectorAll<HTMLLIElement>('[data-role="console-list"] > li'),
    );
    expect(consoleRows).toHaveLength(3);
    expect(consoleRows[0].textContent).toContain('log');
    expect(consoleRows[0].textContent).toContain('first log');
    expect(consoleRows[0].textContent).toContain('2024-05-01T10:00:00.000Z');
    expect(consoleRows[2].textContent).toContain('error');
    // Stack is folded into a nested <details>.
    const stack = consoleRows[2].querySelector('details');
    expect(stack).not.toBeNull();
    expect(stack!.querySelector('pre')!.textContent).toContain('Error: boom');

    const networkRows = Array.from(
      root.querySelectorAll<HTMLLIElement>('[data-role="network-list"] > li'),
    );
    expect(networkRows).toHaveLength(3);
    expect(networkRows[0].textContent).toContain('https://api.example.com/users');
    expect(networkRows[0].textContent).toContain('200');
    expect(networkRows[0].textContent).toContain('43 ms');
    // 4xx flagged with data-bad="true"
    expect(networkRows[1].querySelector('[data-bad="true"]')).not.toBeNull();
    // No responseStatus → em dash placeholder.
    expect(networkRows[2].textContent).toContain('—');
    expect(networkRows[2].textContent).toContain('script.js');
  });

  it('rerenders the console / network panels when the selected annotation changes', async () => {
    const firstConsole = [
      {
        level: 'log',
        message: 'one',
        timestamp: '2024-05-01T10:00:00.000Z',
      },
    ];
    const secondConsole = [
      { level: 'log', message: 'a', timestamp: '2024-05-02T10:00:00.000Z' },
      { level: 'error', message: 'b', timestamp: '2024-05-02T10:00:01.000Z' },
    ];

    vi.stubGlobal(
      'fetch',
      makeFetch({
        annotations: [
          makeAnnotation({
            id: 'a1',
            severity: 'critical',
            capturedConsole: firstConsole,
            capturedNetwork: null,
          } as Partial<Annotation>),
          makeAnnotation({
            id: 'a2',
            pinNumber: 2,
            severity: 'critical',
            capturedConsole: secondConsole,
            capturedNetwork: null,
          } as Partial<Annotation>),
        ],
      }),
    );

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountProjectView(root, { id: 'proj-1' });
    await flush();

    const rows = root.querySelectorAll<HTMLElement>('[data-role="list-body"] tr');
    rows[0].click();
    expect(
      root.querySelectorAll('[data-role="console-list"] > li'),
    ).toHaveLength(1);

    // Navigate back, then open the second annotation.
    root.querySelector<HTMLButtonElement>('[data-action="back"]')!.click();
    rows[1].click();
    const updated = root.querySelectorAll<HTMLLIElement>(
      '[data-role="console-list"] > li',
    );
    expect(updated).toHaveLength(2);
    expect(updated[0].textContent).toContain('a');
    expect(updated[1].textContent).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getSection(name: string): HTMLElement {
  return document.querySelector(`[data-section="${name}"]`) as HTMLElement;
}

function getProjectTitle(): HTMLElement {
  return document.querySelector('[data-slot="project-title"]') as HTMLElement;
}

function rowsForCard(analytics: HTMLElement, dim: string): HTMLElement[] {
  return Array.from(
    analytics.querySelectorAll<HTMLElement>(
      `[data-role="analytics-card"][data-dim="${dim}"] [data-role="rows"] > div`,
    ),
  );
}

interface DataTransferStub {
  getData: (key: string) => string;
  setData: (key: string, value: string) => void;
  dropEffect: string;
  effectAllowed: string;
}

function makeDataTransferStub(): DataTransferStub {
  const store = new Map<string, string>();
  return {
    getData: (key: string) => store.get(key) ?? '',
    setData: (key: string, value: string) => {
      store.set(key, value);
    },
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

/**
 * Build a synthetic drag event. jsdom does not ship `DragEvent`, so we
 * fall back to a generic `Event` with a `dataTransfer` property attached
 * via `Object.defineProperty` (the property is read-only on the real
 * `DragEvent`).
 */
function makeDragEvent(type: string, dataTransfer: DataTransferStub): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
    writable: false,
  });
  return event;
}
