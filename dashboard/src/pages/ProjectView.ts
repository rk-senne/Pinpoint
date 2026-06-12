/**
 * ProjectView — vanilla-TS page for the per-project dashboard surface.
 *
 * Migration of `dashboard/src/pages/ProjectView.tsx` per task 18.8. Uses the
 * shared `<template>` markup in `index.html`, the render helpers in
 * `lib/render.ts`, signal-based stores in `lib/stores.ts`, and the existing
 * socket helpers in `lib/socket.ts`. No React.
 *
 * Surfaces preserved from the React component:
 *   - Project title and a reconnecting banner (Reqs 6.7).
 *   - Analytics panel: severity / type / status / **byBrowser** breakdowns
 *     (Reqs 16.1, 16.2, 16.3, 16.4, 16.5).
 *   - View toggle between list and kanban.
 *   - Annotation list with click-to-select.
 *   - Kanban board with HTML5 drag-and-drop status changes (Req 16.3).
 *   - Annotation detail view: pin number, type, severity, status, body,
 *     page url, environment metadata expandable details, bug-report
 *     assignee dropdown + due date (Reqs 8.3, 8.4, 17.3, 17.4, 22.6).
 *   - Co-viewer indicator with avatars/initials, tooltips and +N overflow
 *     (Reqs 6.6, 6.7).
 *   - Real-time updates via `onSocketEvent` for `annotation:created`,
 *     `annotation:updated`, `annotation:status`, `annotation:viewers`.
 *   - `emitAnnotationOpen` / `emitAnnotationClose` on annotation selection
 *     (Reqs 6.6, 6.7).
 *
 * Mounting model mirrors the other vanilla pages: the function takes the
 * route root, builds the page DOM into a content node, hands that node to
 * `mountAppLayout`, and returns a teardown that detaches every listener,
 * subscription and socket handler.
 */

import { signal, type Signal } from '@pinpoint/shared';
import type {
  Annotation,
  AnnotationStatus,
  CapturedConsoleEntry,
  CapturedNetworkEntry,
  EnvironmentMetadata,
  MarkupDocument,
  User,
} from '@pinpoint/shared';
import { SEVERITY_COLORS, STATUS_LABELS, renderMarkupSvg } from '@pinpoint/shared';

import { mountAppLayout } from '../components/AppLayout';
import { mountReplayPlayer } from '../components/ReplayPlayer';
import { mountHeatmapOverlay } from '../components/HeatmapOverlay';
import { apiFetch as defaultApiFetch } from '../lib/api';
import {
  attr,
  bindEvents,
  cloneTemplate,
  requireSection,
  text,
} from '../lib/render';
import {
  currentAnnotationsStore,
  membersStore,
  setAnnotations,
  setMembers,
  type ProjectMember,
} from '../lib/stores';
import {
  emitAnnotationClose,
  emitAnnotationOpen,
  joinProject,
  leaveProject,
  onReconnectStateChange,
  onSocketEvent,
} from '../lib/socket';

// --- Types ----------------------------------------------------------------

type SeverityKey = keyof typeof SEVERITY_COLORS;
type StatusKey = keyof typeof STATUS_LABELS;

type BrowserFamily =
  | 'Chrome'
  | 'Edge'
  | 'Safari'
  | 'Firefox'
  | 'Opera'
  | 'Brave'
  | 'Arc'
  | 'Other'
  | 'unknown';

interface Analytics {
  total: number;
  bySeverity: Record<'critical' | 'major' | 'minor' | 'informational', number>;
  byType: Record<'note' | 'suggestion' | 'guideline', number>;
  byStatus: Record<'active' | 'in_progress' | 'resolved', number>;
  /**
   * `byBrowser` is the closed `BrowserFamily` enum aggregation produced by
   * `GET /api/v1/projects/:id/analytics` (Reqs 16.1, 17.5). All nine enum
   * keys are always present — empty projects start every count at zero.
   */
  byBrowser: Record<BrowserFamily, number>;
}

type ViewMode = 'list' | 'kanban';

const KANBAN_COLUMNS: AnnotationStatus[] = ['active', 'in_progress', 'resolved'];

const MAX_COVIEWER_AVATARS = 4;

// --- Public entry point ---------------------------------------------------

export interface MountProjectViewOptions {
  /** Fetch shim — defaults to the production `apiFetch`. Tests inject fakes. */
  apiFetch?: typeof defaultApiFetch;
}

/**
 * Mount the project view inside `rootEl` for the project id encoded in the
 * route params. Designed to be passed to
 * `defineRoute('/projects/:id', mountProjectView)`.
 *
 * Returns a teardown that detaches every event listener, signal
 * subscription and socket handler, and removes the page DOM. The router
 * invokes this teardown before mounting the next route, so the page stays
 * self-cleaning.
 */
export function mountProjectView(
  rootEl: HTMLElement,
  params: Record<string, string>,
  options: MountProjectViewOptions = {},
): () => void {
  const apiFetch = options.apiFetch ?? defaultApiFetch;
  const projectId = params.id ?? '';

  // --- View signals ------------------------------------------------------
  const loading: Signal<boolean> = signal<boolean>(true);
  const errorMessage: Signal<string | null> = signal<string | null>(null);
  const reconnecting: Signal<boolean> = signal<boolean>(false);
  const viewMode: Signal<ViewMode> = signal<ViewMode>('list');
  const analytics: Signal<Analytics | null> = signal<Analytics | null>(null);
  const selectedAnnotationId: Signal<string | null> = signal<string | null>(null);
  const currentUserId: Signal<string | null> = signal<string | null>(null);
  /**
   * Co-viewer presence (Reqs 6.6, 6.7). Keyed by annotation id; the value
   * is the list of user ids that the server has reported as currently
   * viewing that annotation. Updated by `annotation:viewers` socket
   * broadcasts emitted from `server/src/websocket.ts`.
   */
  const viewersByAnnotation: Signal<Record<string, string[]>> = signal<
    Record<string, string[]>
  >({});

  // --- Build the page DOM and mount inside the layout shell --------------
  const fragment = cloneTemplate('tpl-project-view');
  const contentRootCandidate = fragment.firstElementChild as HTMLElement | null;
  if (!contentRootCandidate) {
    throw new Error('mountProjectView: #tpl-project-view template is empty');
  }
  const contentRoot: HTMLElement = contentRootCandidate;

  // Hand the page contents to the AppLayout shell. The layout owns the
  // chrome (header, sidebar); we own everything below.
  const teardownLayout = mountAppLayout(rootEl, contentRoot);

  // --- DOM references ----------------------------------------------------
  const reconnectingBanner = requireSection(contentRoot, 'reconnecting');
  const loadingSection = requireSection(contentRoot, 'loading');
  const errorSection = requireSection(contentRoot, 'error');
  const errorMessageEl = contentRoot.querySelector<HTMLElement>(
    '[data-slot="error-message"]',
  )!;
  const contentSection = requireSection(contentRoot, 'content');
  const projectTitleEl = contentRoot.querySelector<HTMLElement>(
    '[data-slot="project-title"]',
  )!;

  const toggleListBtn = contentRoot.querySelector<HTMLButtonElement>(
    '[data-role="toggle-list"]',
  )!;
  const toggleKanbanBtn = contentRoot.querySelector<HTMLButtonElement>(
    '[data-role="toggle-kanban"]',
  )!;

  const analyticsRoot = contentRoot.querySelector<HTMLElement>(
    '[data-role="analytics"]',
  )!;
  const listSection = requireSection(contentRoot, 'list');
  const listEmpty = contentRoot.querySelector<HTMLElement>('[data-role="list-empty"]')!;
  const listTable = contentRoot.querySelector<HTMLElement>('[data-role="list-table"]')!;
  const listBody = contentRoot.querySelector<HTMLElement>('[data-role="list-body"]')!;
  const kanbanSection = requireSection(contentRoot, 'kanban');
  const detailSection = requireSection(contentRoot, 'detail');

  // Per-render row listener cleanups. Cleared on every rerender so detached
  // rows can be GC'd; otherwise the closures capturing each row would keep
  // the detached DOM alive for the page's lifetime.
  let rowCleanups: Array<() => void> = [];
  let replayTeardown: (() => void) | null = null;

  // --- Page-level event wiring ------------------------------------------
  const cleanupEvents = bindEvents(contentRoot, {
    'select-list': () => viewMode.set('list'),
    'select-kanban': () => viewMode.set('kanban'),
    back: () => {
      selectedAnnotationId.set(null);
    },
    'toggle-env': () => {
      envExpanded.set(!envExpanded.get());
    },
    'toggle-ua': () => {
      envUaExpanded.set(!envUaExpanded.get());
    },
    'save-assignment': () => {
      const id = selectedAnnotationId.get();
      if (!id) return;
      const select = detailSection.querySelector<HTMLSelectElement>(
        '[data-role="assignee-select"]',
      );
      const dueInput = detailSection.querySelector<HTMLInputElement>(
        '[data-role="due-date"]',
      );
      const assigneeId = select?.value ? select.value : null;
      const dueDate = dueInput?.value
        ? new Date(dueInput.value).toISOString()
        : null;
      void saveAssignment(id, assigneeId, dueDate);
    },
    'toggle-heatmap': () => {
      const heatmapContainer = contentRoot.querySelector<HTMLElement>('[data-role="heatmap-container"]');
      if (!heatmapContainer) return;
      const isHidden = heatmapContainer.hasAttribute('hidden');
      if (isHidden) {
        heatmapContainer.removeAttribute('hidden');
        mountHeatmapOverlay(heatmapContainer, projectId);
      } else {
        heatmapContainer.setAttribute('hidden', '');
        heatmapContainer.replaceChildren();
      }
    },
  });

  // Whether the environment-metadata details panel is expanded. Reset
  // whenever the selected annotation changes.
  const envExpanded: Signal<boolean> = signal<boolean>(false);
  // The raw User-Agent string is collapsible inside the details panel
  // (Req 17.4 — "raw UA expandable"); UAs can be very long and we keep
  // them out of the way until the viewer asks for them.
  const envUaExpanded: Signal<boolean> = signal<boolean>(false);

  // --- Reactive bindings ------------------------------------------------
  const unsubs: Array<() => void> = [];

  // Top-level loading / error / content gating.
  unsubs.push(
    loading.subscribe((isLoading) => {
      toggleHidden(loadingSection, !isLoading);
      if (isLoading) {
        toggleHidden(errorSection, true);
        toggleHidden(contentSection, true);
      } else if (errorMessage.get()) {
        toggleHidden(errorSection, false);
        toggleHidden(contentSection, true);
      } else {
        toggleHidden(errorSection, true);
        toggleHidden(contentSection, false);
      }
    }),
  );

  unsubs.push(
    errorMessage.subscribe((msg) => {
      if (msg) {
        text(errorMessageEl, msg);
        toggleHidden(errorSection, false);
        toggleHidden(contentSection, true);
        toggleHidden(loadingSection, true);
      } else if (!loading.get()) {
        toggleHidden(errorSection, true);
        toggleHidden(contentSection, false);
      }
    }),
  );

  unsubs.push(
    reconnecting.subscribe((isReconnecting) => {
      toggleHidden(reconnectingBanner, !isReconnecting);
    }),
  );

  // Project title — the route only carries the id; the React component
  // showed `Project: <id>` and that is preserved here pending a richer
  // project lookup.
  text(projectTitleEl, projectId ? `Project: ${projectId}` : 'Project');

  // View-toggle button styling.
  unsubs.push(
    viewMode.subscribe((mode) => {
      paintToggle(toggleListBtn, mode === 'list', 'left');
      paintToggle(toggleKanbanBtn, mode === 'kanban', 'right');
      // The list / kanban subviews are mutually exclusive when no
      // annotation is selected. The selection subscription owns the
      // detail-vs-list/kanban gating; here we only swap between list and
      // kanban while staying inside the non-detail surface.
      if (selectedAnnotationId.get() === null) {
        toggleHidden(listSection, mode !== 'list');
        toggleHidden(kanbanSection, mode !== 'kanban');
      }
    }),
  );

  // Detail subview gating. Showing the detail panel hides both list and
  // kanban; clearing the selection restores the active view-mode subview.
  let lastSelectedId: string | null = null;
  unsubs.push(
    selectedAnnotationId.subscribe((id) => {
      // Track the previous selection so we emit `annotation:close` for it
      // whenever the selection changes — including back navigation
      // (id===null) and switching directly between annotations.
      if (lastSelectedId && lastSelectedId !== id) {
        emitAnnotationClose(lastSelectedId);
      }
      lastSelectedId = id;

      if (id) {
        toggleHidden(detailSection, false);
        toggleHidden(listSection, true);
        toggleHidden(kanbanSection, true);
        toggleHidden(analyticsRoot, true);
        envExpanded.set(false);
        envUaExpanded.set(false);
        emitAnnotationOpen(id);
      } else {
        toggleHidden(detailSection, true);
        toggleHidden(analyticsRoot, analytics.get() === null);
        const mode = viewMode.get();
        toggleHidden(listSection, mode !== 'list');
        toggleHidden(kanbanSection, mode !== 'kanban');
      }
      renderDetail();
    }),
  );

  // Analytics panel — re-render when analytics or members change.
  unsubs.push(
    analytics.subscribe((value) => {
      if (value === null) {
        toggleHidden(analyticsRoot, true);
        return;
      }
      // Detail view hides the panel; otherwise show it.
      toggleHidden(analyticsRoot, selectedAnnotationId.get() !== null);
      renderAnalytics(value);
    }),
  );

  // Annotation list and kanban — re-render whenever the source list
  // changes. The store is the canonical source of truth for both subviews.
  unsubs.push(
    currentAnnotationsStore.list.subscribe(() => {
      rerenderList();
      rerenderKanban();
      // Detail view rebinds against whatever the freshest annotation row
      // is, in case a socket update arrived while the detail panel was
      // open.
      renderDetail();
    }),
  );

  // Members + co-viewer presence + current-user id changes all repaint
  // the detail panel header.
  unsubs.push(
    membersStore.list.subscribe(() => {
      renderDetail();
    }),
  );
  unsubs.push(
    viewersByAnnotation.subscribe(() => {
      renderCoViewers();
    }),
  );
  unsubs.push(
    currentUserId.subscribe(() => {
      renderCoViewers();
    }),
  );
  unsubs.push(
    envExpanded.subscribe((expanded) => {
      const arrow = detailSection.querySelector<HTMLElement>('[data-slot="env-arrow"]');
      if (arrow) text(arrow, expanded ? '▾' : '▸');
      const details = detailSection.querySelector<HTMLElement>('[data-role="env-details"]');
      if (details) toggleHidden(details, !expanded);
      const toggle = detailSection.querySelector<HTMLElement>('[data-role="env-toggle"]');
      if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
    }),
  );
  unsubs.push(
    envUaExpanded.subscribe((expanded) => {
      const arrow = detailSection.querySelector<HTMLElement>('[data-slot="env-ua-arrow"]');
      if (arrow) text(arrow, expanded ? '▾' : '▸');
      const value = detailSection.querySelector<HTMLElement>('[data-role="env-ua-value"]');
      if (value) toggleHidden(value, !expanded);
      const toggle = detailSection.querySelector<HTMLElement>(
        '[data-role="env-ua-toggle"]',
      );
      if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
    }),
  );

  // --- Real-time + initial fetch ----------------------------------------
  let unsubReconnect: (() => void) | null = null;
  let socketUnsubs: Array<() => void> = [];

  function attachSocket(): void {
    if (!projectId) return;
    try {
      joinProject(projectId);
    } catch {
      // Not authenticated or socket error — REST data is already loaded.
    }

    socketUnsubs.push(
      onSocketEvent('annotation:created', (annotation) => {
        const list = currentAnnotationsStore.list.get();
        if (list.some((a) => a.id === annotation.id)) return;
        setAnnotations([...list, annotation]);
        updateAnalyticsForNewAnnotation(annotation);
      }),
    );

    socketUnsubs.push(
      onSocketEvent('annotation:updated', (annotation) => {
        const list = currentAnnotationsStore.list.get();
        setAnnotations(list.map((a) => (a.id === annotation.id ? annotation : a)));
      }),
    );

    socketUnsubs.push(
      onSocketEvent('annotation:status', (data) => {
        const list = currentAnnotationsStore.list.get();
        setAnnotations(
          list.map((a) =>
            a.id === data.id ? { ...a, status: data.status as AnnotationStatus } : a,
          ),
        );
        void refetchAnalytics();
      }),
    );

    socketUnsubs.push(
      onSocketEvent('annotation:viewers', (data) => {
        const next = { ...viewersByAnnotation.get(), [data.id]: data.userIds };
        viewersByAnnotation.set(next);
      }),
    );

    unsubReconnect = onReconnectStateChange((value) => reconnecting.set(value));
  }

  void fetchData();
  attachSocket();

  // --- Cleanup ----------------------------------------------------------
  let torndown = false;

  function teardown(): void {
    if (torndown) return;
    torndown = true;
    const id = selectedAnnotationId.get();
    if (id) emitAnnotationClose(id);
    for (const u of socketUnsubs) u();
    socketUnsubs = [];
    if (unsubReconnect) unsubReconnect();
    unsubReconnect = null;
    try {
      leaveProject();
    } catch {
      // best-effort
    }
    for (const u of unsubs) u();
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];
    if (replayTeardown) { replayTeardown(); replayTeardown = null; }
    cleanupEvents();
    teardownLayout();
    contentRoot.remove();
  }

  return teardown;

  // ----------------------------------------------------------------------
  // network calls
  // ----------------------------------------------------------------------

  async function fetchData(): Promise<void> {
    if (!projectId) {
      loading.set(false);
      errorMessage.set('Project id missing from route.');
      return;
    }
    try {
      const [annRes, anaRes, memRes, meRes] = await Promise.all([
        apiFetch<{ annotations: Annotation[] }>(`/projects/${projectId}/annotations`),
        apiFetch<{ analytics: Analytics }>(`/projects/${projectId}/analytics`),
        apiFetch<{ members: ProjectMember[] }>(`/projects/${projectId}/members`),
        apiFetch<User | { user: User }>(`/users/me`).catch(() => null),
      ]);
      setAnnotations(annRes.annotations);
      analytics.set(anaRes.analytics);
      setMembers(memRes.members);
      if (meRes) {
        const me = (meRes as { user?: User }).user ?? (meRes as User);
        currentUserId.set(me?.id ?? null);
      }
      errorMessage.set(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load project data';
      errorMessage.set(message);
    } finally {
      loading.set(false);
    }
  }

  async function refetchAnalytics(): Promise<void> {
    if (!projectId) return;
    try {
      const res = await apiFetch<{ analytics: Analytics }>(
        `/projects/${projectId}/analytics`,
      );
      analytics.set(res.analytics);
    } catch {
      // Ignore analytics refresh errors — preserve the last successful
      // snapshot rather than wipe the panel.
    }
  }

  async function handleStatusChange(
    annotationId: string,
    newStatus: AnnotationStatus,
  ): Promise<void> {
    const list = currentAnnotationsStore.list.get();
    const old = list.find((a) => a.id === annotationId);
    if (!old || old.status === newStatus) return;

    try {
      await apiFetch(`/annotations/${annotationId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      // Optimistic local update — the socket broadcast will reconcile if
      // the server's view differs.
      setAnnotations(
        currentAnnotationsStore.list
          .get()
          .map((a) => (a.id === annotationId ? { ...a, status: newStatus } : a)),
      );
      const current = analytics.get();
      if (current) {
        analytics.set({
          ...current,
          byStatus: {
            ...current.byStatus,
            [old.status]: current.byStatus[old.status] - 1,
            [newStatus]: current.byStatus[newStatus] + 1,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update status';
      errorMessage.set(message);
    }
  }

  async function saveAssignment(
    annotationId: string,
    assigneeId: string | null,
    dueDate: string | null,
  ): Promise<void> {
    try {
      await apiFetch(`/annotations/${annotationId}`, {
        method: 'PUT',
        body: JSON.stringify({ assigneeId, dueDate }),
      });
      const list = currentAnnotationsStore.list.get();
      setAnnotations(
        list.map((a) =>
          a.id === annotationId
            ? {
                ...a,
                assigneeId: assigneeId ?? undefined,
                dueDate: dueDate ?? undefined,
              }
            : a,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update annotation';
      errorMessage.set(message);
    }
  }

  function updateAnalyticsForNewAnnotation(annotation: Annotation): void {
    const current = analytics.get();
    if (!current) return;
    const sevKey = annotation.severity as keyof Analytics['bySeverity'];
    const typeKey = annotation.type as keyof Analytics['byType'];
    const statusKey = annotation.status as keyof Analytics['byStatus'];
    const browserKey = (annotation.environment?.browserFamily ?? 'unknown') as BrowserFamily;
    analytics.set({
      total: current.total + 1,
      bySeverity: {
        ...current.bySeverity,
        [sevKey]: (current.bySeverity[sevKey] ?? 0) + 1,
      },
      byType: {
        ...current.byType,
        [typeKey]: (current.byType[typeKey] ?? 0) + 1,
      },
      byStatus: {
        ...current.byStatus,
        [statusKey]: (current.byStatus[statusKey] ?? 0) + 1,
      },
      byBrowser: {
        ...current.byBrowser,
        [browserKey]: (current.byBrowser[browserKey] ?? 0) + 1,
      },
    });
  }

  // ----------------------------------------------------------------------
  // rendering
  // ----------------------------------------------------------------------

  function rerenderList(): void {
    listBody.replaceChildren();
    // List rows own click listeners; clear them when we discard the rows.
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];

    const annotations = currentAnnotationsStore.list.get();
    if (annotations.length === 0) {
      toggleHidden(listEmpty, false);
      toggleHidden(listTable, true);
      return;
    }
    toggleHidden(listEmpty, true);
    toggleHidden(listTable, false);

    for (const a of annotations) {
      const rowFragment = cloneTemplate('tpl-project-view-list-row', {
        'pin-number': String(a.pinNumber),
        type: a.type,
        severity: a.severity,
        status: STATUS_LABELS[a.status as StatusKey] ?? a.status,
        body: a.body ?? '',
      });
      const row = rowFragment.firstElementChild as HTMLElement;
      const sevSpan = row.querySelector<HTMLElement>('[data-slot="severity"]');
      if (sevSpan) {
        attr(
          sevSpan,
          'style',
          `font-weight: 500; color: ${SEVERITY_COLORS[a.severity as SeverityKey] ?? '#333'};`,
        );
      }
      const onClick = (): void => {
        selectedAnnotationId.set(a.id);
      };
      row.addEventListener('click', onClick);
      rowCleanups.push(() => row.removeEventListener('click', onClick));
      listBody.appendChild(row);
    }
  }

  function rerenderKanban(): void {
    const annotations = currentAnnotationsStore.list.get();
    const columns = kanbanSection.querySelectorAll<HTMLElement>(
      '[data-role="kanban-column"]',
    );
    for (const column of Array.from(columns)) {
      const status = column.getAttribute('data-status') as AnnotationStatus | null;
      if (!status) continue;
      const cards = column.querySelector<HTMLElement>('[data-role="kanban-cards"]');
      const header = column.querySelector<HTMLElement>('[data-slot="column-header"]');
      const colRows = annotations.filter((a) => a.status === status);
      if (header) {
        text(header, `${STATUS_LABELS[status]} (${colRows.length})`);
      }
      if (!cards) continue;
      cards.replaceChildren();

      // Drag-and-drop wiring (Req 16.3). Each column accepts drops; cards
      // fire `dragstart` carrying the annotation id. We rebind on every
      // render so handlers always reference the latest store state.
      bindKanbanColumn(column, status);

      for (const annotation of colRows) {
        cards.appendChild(renderKanbanCard(annotation));
      }
    }
  }

  function bindKanbanColumn(column: HTMLElement, status: AnnotationStatus): void {
    // Strip listeners attached on the previous render. The column element
    // itself is reused (it lives in the cloned template), so we keep the
    // previous handler refs on a private property rather than tracking
    // them through `rowCleanups`.
    const prev = (column as ColumnWithHandlers).__flKanbanHandlers;
    if (prev) {
      column.removeEventListener('dragover', prev.dragOver);
      column.removeEventListener('dragleave', prev.dragLeave);
      column.removeEventListener('drop', prev.drop);
    }

    const dragOver = (e: DragEvent): void => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      column.style.background = '#ebf8ff';
      column.style.border = '2px dashed #3182ce';
    };
    const dragLeave = (): void => {
      column.style.background = '#f7f7f7';
      column.style.border = '2px solid transparent';
    };
    const drop = (e: DragEvent): void => {
      e.preventDefault();
      column.style.background = '#f7f7f7';
      column.style.border = '2px solid transparent';
      const annotationId = e.dataTransfer?.getData('text/plain');
      if (annotationId) {
        void handleStatusChange(annotationId, status);
      }
    };

    column.addEventListener('dragover', dragOver);
    column.addEventListener('dragleave', dragLeave);
    column.addEventListener('drop', drop);
    (column as ColumnWithHandlers).__flKanbanHandlers = { dragOver, dragLeave, drop };
  }

  function renderKanbanCard(annotation: Annotation): HTMLElement {
    const cardFragment = cloneTemplate('tpl-project-view-kanban-card', {
      'pin-number': String(annotation.pinNumber),
      severity: annotation.severity,
      type: annotation.type,
      body: annotation.body ?? '',
    });
    const card = cardFragment.firstElementChild as HTMLElement;
    const sevSpan = card.querySelector<HTMLElement>('[data-slot="severity"]');
    if (sevSpan) {
      attr(
        sevSpan,
        'style',
        `font-size: 11px; font-weight: 500; color: ${
          SEVERITY_COLORS[annotation.severity as SeverityKey] ?? '#333'
        };`,
      );
    }
    const onDragStart = (e: DragEvent): void => {
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', annotation.id);
        e.dataTransfer.effectAllowed = 'move';
      }
    };
    card.addEventListener('dragstart', onDragStart);
    rowCleanups.push(() => card.removeEventListener('dragstart', onDragStart));
    const onClick = (): void => {
      selectedAnnotationId.set(annotation.id);
    };
    card.addEventListener('click', onClick);
    rowCleanups.push(() => card.removeEventListener('click', onClick));
    return card;
  }

  function renderAnalytics(value: Analytics): void {
    paintAnalyticsCard(
      'bySeverity',
      value.bySeverity as Record<string, number>,
      SEVERITY_COLORS as Record<string, string>,
    );
    paintAnalyticsCard('byType', value.byType as Record<string, number>);
    paintAnalyticsCard(
      'byStatus',
      value.byStatus as Record<string, number>,
      undefined,
      STATUS_LABELS as Record<string, string>,
    );
    paintAnalyticsCard('byBrowser', value.byBrowser as Record<string, number>);
  }

  function paintAnalyticsCard(
    dim: 'bySeverity' | 'byType' | 'byStatus' | 'byBrowser',
    data: Record<string, number>,
    colorMap?: Record<string, string>,
    labelMap?: Record<string, string>,
  ): void {
    const card = analyticsRoot.querySelector<HTMLElement>(
      `[data-role="analytics-card"][data-dim="${dim}"]`,
    );
    if (!card) return;
    const rows = card.querySelector<HTMLElement>('[data-role="rows"]');
    if (!rows) return;
    rows.replaceChildren();
    for (const [key, count] of Object.entries(data)) {
      const row = document.createElement('div');
      row.style.cssText =
        'display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;';
      const label = document.createElement('span');
      label.textContent = labelMap?.[key] ?? key;
      if (colorMap?.[key]) label.style.color = colorMap[key];
      const value = document.createElement('span');
      value.style.fontWeight = '600';
      value.textContent = String(count);
      row.appendChild(label);
      row.appendChild(value);
      rows.appendChild(row);
    }
  }

  function renderDetail(): void {
    const id = selectedAnnotationId.get();
    if (!id) return;
    const annotation = currentAnnotationsStore.list.get().find((a) => a.id === id);
    if (!annotation) return;

    const setSlot = (slot: string, value: string): void => {
      const el = detailSection.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      if (el) text(el, value);
    };

    setSlot('detail-pin', String(annotation.pinNumber));
    setSlot('detail-type', annotation.type);
    setSlot('detail-body', annotation.body ?? '');
    setSlot('detail-status', STATUS_LABELS[annotation.status as StatusKey] ?? annotation.status);
    setSlot('detail-page-url', (annotation as { pageUrl?: string }).pageUrl ?? '');

    const severityEl = detailSection.querySelector<HTMLElement>(
      '[data-slot="detail-severity"]',
    );
    if (severityEl) {
      text(severityEl, annotation.severity);
      severityEl.style.color = SEVERITY_COLORS[annotation.severity as SeverityKey] ?? '#333';
    }

    const isBug = isBugReport(annotation);
    const bugBadge = detailSection.querySelector<HTMLElement>('[data-role="bug-badge"]');
    if (bugBadge) toggleHidden(bugBadge, !isBug);
    const assignmentPanel = detailSection.querySelector<HTMLElement>(
      '[data-role="assignment-panel"]',
    );
    if (assignmentPanel) toggleHidden(assignmentPanel, !isBug);

    if (isBug) {
      const select = detailSection.querySelector<HTMLSelectElement>(
        '[data-role="assignee-select"]',
      );
      if (select) {
        // Rebuild options from `membersStore` so a freshly-fetched member
        // list flows in. Preserve the current annotation's assignee
        // selection.
        select.replaceChildren();
        const unassigned = document.createElement('option');
        unassigned.value = '';
        unassigned.textContent = 'Unassigned';
        select.appendChild(unassigned);
        for (const member of membersStore.list.get()) {
          const option = document.createElement('option');
          option.value = member.userId;
          option.textContent = `${member.name} (${member.email})`;
          select.appendChild(option);
        }
        select.value = annotation.assigneeId ?? '';
      }
      const dueInput = detailSection.querySelector<HTMLInputElement>(
        '[data-role="due-date"]',
      );
      if (dueInput) {
        dueInput.value = annotation.dueDate ? annotation.dueDate.split('T')[0] : '';
      }
    }

    // Environment metadata.
    const envPanel = detailSection.querySelector<HTMLElement>('[data-role="env-panel"]');
    if (envPanel) {
      if (annotation.environment) {
        toggleHidden(envPanel, false);
        renderEnvironment(annotation.environment);
      } else {
        toggleHidden(envPanel, true);
      }
    }

    renderCaptureBuffers(annotation);
    renderScreenshot(annotation);
    renderReplayButton(annotation);
    renderCoViewers();
  }

  /**
   * Render the captured Console / Network sections (Req 36.3, task 27.4).
   * Both are populated from `annotation.capturedConsole` /
   * `annotation.capturedNetwork`. Hidden when the buffer is null/empty so
   * non-bug-report annotations do not show empty panels. Entries render
   * in insertion order (timeline read top-down).
   */
  function renderCaptureBuffers(annotation: Annotation): void {
    const consolePanel = detailSection.querySelector<HTMLElement>(
      '[data-role="console-panel"]',
    );
    const consoleList = detailSection.querySelector<HTMLElement>(
      '[data-role="console-list"]',
    );
    const consoleCount = detailSection.querySelector<HTMLElement>(
      '[data-slot="console-count"]',
    );
    const consoleEntries = annotation.capturedConsole ?? null;
    if (consolePanel && consoleList) {
      if (!consoleEntries || consoleEntries.length === 0) {
        toggleHidden(consolePanel, true);
        consoleList.replaceChildren();
        if (consoleCount) text(consoleCount, '0');
      } else {
        toggleHidden(consolePanel, false);
        if (consoleCount) text(consoleCount, String(consoleEntries.length));
        consoleList.replaceChildren(
          ...consoleEntries.map((entry) => buildConsoleRow(entry)),
        );
      }
    }

    const networkPanel = detailSection.querySelector<HTMLElement>(
      '[data-role="network-panel"]',
    );
    const networkList = detailSection.querySelector<HTMLElement>(
      '[data-role="network-list"]',
    );
    const networkCount = detailSection.querySelector<HTMLElement>(
      '[data-slot="network-count"]',
    );
    const networkEntries = annotation.capturedNetwork ?? null;
    if (networkPanel && networkList) {
      if (!networkEntries || networkEntries.length === 0) {
        toggleHidden(networkPanel, true);
        networkList.replaceChildren();
        if (networkCount) text(networkCount, '0');
      } else {
        toggleHidden(networkPanel, false);
        if (networkCount) text(networkCount, String(networkEntries.length));
        networkList.replaceChildren(
          ...networkEntries.map((entry) => buildNetworkRow(entry)),
        );
      }
    }
  }

  /**
   * Render the screenshot bitmap with the persisted Markup_Document
   * overlay (Reqs 34.4, 35.2). The bitmap is fetched from
   * `/api/v1/annotations/:id/screenshot`; the markup is fetched from
   * `/api/v1/annotations/:id/markup` (best-effort — a missing markup
   * still shows the bare PNG). The SVG is composited absolutely over
   * the `<img>` so it scales with CSS layout while keeping its original
   * pixel coordinates via `viewBox`.
   */
  function renderScreenshot(annotation: Annotation): void {
    const panel = detailSection.querySelector<HTMLElement>(
      '[data-role="screenshot-panel"]',
    );
    if (!panel) return;
    const img = detailSection.querySelector<HTMLImageElement>(
      '[data-role="screenshot-img"]',
    );
    const overlay = detailSection.querySelector<HTMLElement>(
      '[data-role="screenshot-overlay"]',
    );
    if (!img || !overlay) return;

    if (!annotation.screenshotObjectKey) {
      panel.hidden = true;
      img.removeAttribute('src');
      overlay.replaceChildren();
      return;
    }

    panel.hidden = false;
    overlay.replaceChildren();

    const annotationId = annotation.id;
    img.removeAttribute('src');
    img.onload = (): void => {
      // Compute the markup viewBox from the natural bitmap size so the
      // overlay tracks the image's true pixel coordinates. We re-fetch
      // the markup here even though it was issued earlier — the request
      // is cheap and lets us guarantee we always paint against the
      // freshly loaded image dimensions.
      // (Note: the markup fetch is also issued below in parallel; the
      // load handler just paints whichever response arrives first.)
    };

    void apiFetch<{ screenshotUrl: string }>(
      `/annotations/${encodeURIComponent(annotationId)}/screenshot`,
    )
      .then((res) => {
        if (selectedAnnotationId.get() !== annotationId) return;
        if (res?.screenshotUrl) img.src = res.screenshotUrl;
      })
      .catch(() => {
        /* Best-effort — leave the panel without a bitmap. */
      });

    void apiFetch<{ markupDocument: MarkupDocument }>(
      `/annotations/${encodeURIComponent(annotationId)}/markup`,
    )
      .then((res) => {
        if (selectedAnnotationId.get() !== annotationId) return;
        const doc = res?.markupDocument;
        if (!doc) {
          overlay.replaceChildren();
          return;
        }
        // Use the bitmap's natural size when available, falling back to
        // the rendered size before the image has settled.
        const w = img.naturalWidth || img.clientWidth || 0;
        const h = img.naturalHeight || img.clientHeight || 0;
        if (w === 0 || h === 0) {
          // Defer the paint until the image has dimensions.
          img.addEventListener(
            'load',
            () => {
              if (selectedAnnotationId.get() !== annotationId) return;
              overlay.innerHTML = renderMarkupSvg(
                doc,
                img.naturalWidth || img.clientWidth || 0,
                img.naturalHeight || img.clientHeight || 0,
              );
            },
            { once: true },
          );
          return;
        }
        overlay.innerHTML = renderMarkupSvg(doc, w, h);
      })
      .catch(() => {
        /* No markup or fetch failed — leave the bitmap alone (Req 35.2 best-effort). */
      });
  }

  /** Show a "View Replay" button if the annotation has session replay data. */
  function renderReplayButton(annotation: Annotation): void {
    // Clean up any previous replay player
    if (replayTeardown) { replayTeardown(); replayTeardown = null; }
    // Remove previous button/container
    detailSection.querySelector('[data-role="replay-btn"]')?.remove();
    detailSection.querySelector('[data-role="replay-container"]')?.remove();

    if (!annotation.sessionReplay || annotation.sessionReplay.length === 0) return;

    const btn = document.createElement('button');
    btn.setAttribute('data-role', 'replay-btn');
    btn.textContent = '▶ View Replay';
    btn.style.cssText = 'margin-top:8px;padding:6px 14px;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
    const replayContainer = document.createElement('div');
    replayContainer.setAttribute('data-role', 'replay-container');

    const envPanel = detailSection.querySelector<HTMLElement>('[data-role="env-panel"]');
    const insertBefore = envPanel ?? detailSection.querySelector('[data-role="assignment-panel"]');
    if (insertBefore) {
      insertBefore.parentElement!.insertBefore(replayContainer, insertBefore);
      insertBefore.parentElement!.insertBefore(btn, replayContainer);
    } else {
      detailSection.appendChild(btn);
      detailSection.appendChild(replayContainer);
    }

    btn.addEventListener('click', () => {
      if (replayTeardown) { replayTeardown(); replayTeardown = null; }
      btn.hidden = true;
      replayTeardown = mountReplayPlayer(replayContainer, annotation.sessionReplay!);
    });
  }

  function renderEnvironment(env: EnvironmentMetadata): void {
    const setSlot = (slot: string, value: string): void => {
      const el = detailSection.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      if (el) text(el, value);
    };
    setSlot('env-summary', formatEnvironmentSummary(env));
    const browserText = `${env.browserFamily}${env.browserVersion ? ` ${env.browserVersion}` : ''}`;
    const osText = `${env.osFamily}${env.osVersion ? ` ${env.osVersion}` : ''}`;
    setSlot('env-browser', browserText);
    setSlot('env-os', osText);
    setSlot('env-device', env.deviceType);
    setSlot('env-ua', env.userAgentRaw);

    const viewportRow = detailSection.querySelector<HTMLElement>(
      '[data-role="env-viewport-row"]',
    );
    if (viewportRow) {
      if (env.viewportWidth !== undefined && env.viewportHeight !== undefined) {
        toggleHidden(viewportRow, false);
        setSlot('env-viewport', `${env.viewportWidth} × ${env.viewportHeight}`);
      } else {
        toggleHidden(viewportRow, true);
      }
    }

    const dprRow = detailSection.querySelector<HTMLElement>('[data-role="env-dpr-row"]');
    if (dprRow) {
      if (env.devicePixelRatio !== undefined) {
        toggleHidden(dprRow, false);
        setSlot('env-dpr', String(env.devicePixelRatio));
      } else {
        toggleHidden(dprRow, true);
      }
    }

    // The User-Agent row is always present (every annotation carries a
    // raw UA per Req 17.1/17.2); empty strings still render the row so
    // the toggle stays affordant.
    const uaRow = detailSection.querySelector<HTMLElement>('[data-role="env-ua-row"]');
    if (uaRow) toggleHidden(uaRow, false);
  }

  function renderCoViewers(): void {
    const id = selectedAnnotationId.get();
    if (!id) return;
    const container = detailSection.querySelector<HTMLElement>('[data-role="co-viewers"]');
    if (!container) return;
    container.replaceChildren();
    const all = viewersByAnnotation.get()[id] ?? [];
    const me = currentUserId.get();
    const others = all.filter((uid) => uid !== me);
    if (others.length === 0) return;

    const memberById = new Map(membersStore.list.get().map((m) => [m.userId, m]));
    const visible = others.slice(0, MAX_COVIEWER_AVATARS);
    const overflow = others.length - visible.length;

    for (const uid of visible) {
      const member = memberById.get(uid);
      const label = member?.name || member?.email || 'Viewer';
      container.appendChild(renderAvatar(label, member?.avatarUrl ?? null));
    }
    if (overflow > 0) {
      const pill = document.createElement('span');
      const word = overflow === 1 ? 'viewer' : 'viewers';
      pill.setAttribute('aria-label', `${overflow} more ${word}`);
      pill.setAttribute('title', `${overflow} more ${word}`);
      pill.style.cssText =
        'display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: #e2e8f0; color: #2d3748; font-size: 11px; font-weight: 600;';
      pill.textContent = `+${overflow}`;
      container.appendChild(pill);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ColumnHandlers {
  dragOver: (e: DragEvent) => void;
  dragLeave: (e: DragEvent) => void;
  drop: (e: DragEvent) => void;
}
type ColumnWithHandlers = HTMLElement & { __flKanbanHandlers?: ColumnHandlers };

function isBugReport(annotation: Annotation): boolean {
  return (
    annotation.type === 'note' &&
    (annotation.severity === 'critical' || annotation.severity === 'major')
  );
}

/**
 * Build the single-line environment summary that the dashboard annotation
 * detail view displays at the top of the env panel (Reqs 8.3, 17.4).
 *
 * Mirrors the wording produced by the Extension popover summary
 * (`<fl-popover>` view-mode header) so the same text is shown wherever an
 * annotation is read. Format: `"Reported on <browser>[ <version>] on
 * <os>[ <version>]"`. The `unknown` family sentinels and `null` versions
 * collapse so we never emit dangling whitespace or the literal word
 * "unknown" inside the sentence.
 */
function formatEnvironmentSummary(env: EnvironmentMetadata): string {
  const browser = formatFamily(env.browserFamily, env.browserVersion);
  const os = formatFamily(env.osFamily, env.osVersion);
  if (browser && os) return `Reported on ${browser} on ${os}`;
  if (browser) return `Reported on ${browser}`;
  if (os) return `Reported on ${os}`;
  return 'Reported on an unknown environment';
}

function formatFamily(family: string, version: string | null | undefined): string {
  if (!family || family === 'unknown') return '';
  return version ? `${family} ${version}` : family;
}

/**
 * Build one `<li>` row for the captured console panel (Req 36.3,
 * task 27.4). Format: `[level] timestamp — message` with the optional
 * stack folded into a nested `<details>` so a long trace does not
 * dominate the detail view.
 */
function buildConsoleRow(entry: CapturedConsoleEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.style.cssText =
    'padding: 2px 4px; border-bottom: 1px solid #f5f5f5; word-break: break-word;';

  const level = document.createElement('span');
  level.dataset.level = entry.level;
  level.style.cssText = consoleLevelStyle(entry.level);
  level.textContent = entry.level;

  const time = document.createElement('span');
  time.style.cssText = 'color: #888; margin-right: 6px;';
  time.textContent = entry.timestamp;

  const message = document.createElement('span');
  message.textContent = ` — ${entry.message}`;

  li.appendChild(level);
  li.appendChild(time);
  li.appendChild(message);

  if (entry.stack && entry.stack.length > 0) {
    const stackDetails = document.createElement('details');
    stackDetails.style.cssText = 'margin: 4px 0 0;';
    const summary = document.createElement('summary');
    summary.textContent = 'stack';
    summary.style.cssText = 'cursor: pointer; font-size: 10px; color: #666;';
    const pre = document.createElement('pre');
    pre.textContent = entry.stack;
    pre.style.cssText =
      'margin: 4px 0 0; padding: 4px 6px; background: #f7fafc; border-radius: 3px; font-size: 10px; white-space: pre-wrap;';
    stackDetails.appendChild(summary);
    stackDetails.appendChild(pre);
    li.appendChild(stackDetails);
  }
  return li;
}

function consoleLevelStyle(level: 'log' | 'warn' | 'error'): string {
  const bg =
    level === 'error' ? '#c53030' : level === 'warn' ? '#d97706' : '#555';
  return [
    'display: inline-block',
    'min-width: 36px',
    'padding: 0 4px',
    'margin-right: 6px',
    'border-radius: 3px',
    'text-transform: uppercase',
    'font-weight: 600',
    'font-size: 10px',
    'color: #fff',
    `background: ${bg}`,
  ].join('; ');
}

/**
 * Build one `<li>` row for the captured network panel (Req 36.3,
 * task 27.4). Format: `method? name (status, duration ms)` — `method`
 * is omitted when not surfaced by `PerformanceObserver`. 4xx/5xx
 * responses get visual emphasis via `data-bad="true"`.
 */
function buildNetworkRow(entry: CapturedNetworkEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.style.cssText =
    'padding: 2px 4px; border-bottom: 1px solid #f5f5f5; word-break: break-word;';

  const method = (entry as { method?: string }).method;
  if (method) {
    const methodEl = document.createElement('span');
    methodEl.style.cssText =
      'display: inline-block; min-width: 36px; margin-right: 6px; font-weight: 600; color: #2c5282;';
    methodEl.textContent = method;
    li.appendChild(methodEl);
  }

  const name = document.createElement('span');
  name.textContent = entry.name;
  li.appendChild(name);

  const meta = document.createElement('span');
  const statusText =
    typeof entry.responseStatus === 'number' ? String(entry.responseStatus) : '—';
  if (typeof entry.responseStatus === 'number' && entry.responseStatus >= 400) {
    meta.dataset.bad = 'true';
    meta.style.cssText = 'color: #c53030; font-weight: 600;';
  } else {
    meta.style.cssText = 'color: #555;';
  }
  meta.textContent = ` (${statusText}, ${Math.round(entry.duration)} ms)`;
  li.appendChild(meta);

  return li;
}

function renderAvatar(label: string, avatarUrl: string | null): HTMLElement {
  const initials = computeInitials(label);
  const common =
    'display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; font-size: 11px; font-weight: 600; color: #fff; background: #3182ce; overflow: hidden;';
  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = label;
    img.setAttribute('title', label);
    img.style.cssText = `${common} object-fit: cover;`;
    return img;
  }
  const span = document.createElement('span');
  span.setAttribute('aria-label', label);
  span.setAttribute('title', label);
  span.style.cssText = common;
  span.textContent = initials;
  return span;
}

function computeInitials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function paintToggle(button: HTMLButtonElement, active: boolean, side: 'left' | 'right'): void {
  const radius = side === 'left' ? '4px 0 0 4px' : '0 4px 4px 0';
  const borderLeft = side === 'right' ? 'none' : '1px solid #ccc';
  button.style.cssText = [
    'padding: 6px 14px',
    'border: 1px solid #ccc',
    `border-left: ${borderLeft}`,
    'cursor: pointer',
    'font-size: 13px',
    `border-radius: ${radius}`,
    `background: ${active ? '#3182ce' : '#fff'}`,
    `color: ${active ? '#fff' : '#333'}`,
  ].join('; ');
}

function toggleHidden(el: HTMLElement, hidden: boolean): void {
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}
