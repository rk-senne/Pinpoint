// dashboard/src/components/ProjectListSidebar.ts
//
// Vanilla-TS port of the project-list sidebar (task 18.6, Requirement 31.1).
// Replaces the prior React component at the same path. UI conventions follow
// `dashboard/src/lib/render.ts`:
//   - HTML lives in `<template>` blocks in `index.html`.
//   - DOM is materialised through `cloneTemplate` + `mount`.
//   - Event wiring goes through `bindEvents`.
//   - Reactive slices come from `signal()` stores in `dashboard/src/lib/stores.ts`.
//
// Behaviour preserved from the React version:
//   - Active / Archived tabs (Requirement 2.2).
//   - Case-insensitive substring search (Requirement 2.3).
//   - Per-row context menu with rename, archive, delete, details, copy-link,
//     open, export, and a placeholder delete-page entry (Requirements 2.4–2.9).
//   - Create-project dialog accepting `name` + `urls[]` (Requirement 2.1).
//   - Export-project dialog asking the API for a download URL.
//
// The module exposes a single `mountProjectListSidebar(host, deps)` factory
// returning a `dispose()` cleanup. Callers pass a `navigate(path)` callback
// (so this module stays decoupled from the router during the React-removal
// migration) plus optional `apiFetch`, `confirmDelete`, etc. overrides for
// tests.

import type { Project } from '@pinpoint/shared';

import { apiFetch as defaultApiFetch } from '../lib/api';
import {
  attr,
  bind,
  bindEvents,
  cloneTemplate,
  mount,
} from '../lib/render';
import {
  loadProjects,
  projectsStore,
  setProjectListFilter,
  type ProjectListFilter,
} from '../lib/stores';

// --- Public API -------------------------------------------------------

export interface ProjectListSidebarDeps {
  /** Imperative navigation callback (e.g. wraps the dashboard router). */
  navigate: (path: string) => void;
  /** Fetch shim — defaults to the production `apiFetch`. Tests inject fakes. */
  apiFetch?: typeof defaultApiFetch;
  /** Confirm dialog — defaults to `window.confirm`. Tests inject fakes. */
  confirm?: (message: string) => boolean;
  /** Toast/alert handler — defaults to `window.alert`. */
  alert?: (message: string) => void;
  /** Clipboard writer — defaults to `navigator.clipboard.writeText`. */
  writeClipboard?: (text: string) => Promise<void>;
}

export interface ProjectListSidebarHandle {
  /** Tear down DOM listeners and store subscriptions. */
  dispose(): void;
  /** Re-pull the project list from the API. */
  refresh(): Promise<void>;
}

/**
 * Mount the project-list sidebar into `host`. Returns a handle whose
 * `dispose()` removes every subscription and listener registered by this
 * call so callers can re-render or unmount safely.
 */
export function mountProjectListSidebar(
  host: HTMLElement,
  deps: ProjectListSidebarDeps,
): ProjectListSidebarHandle {
  const apiFetch = deps.apiFetch ?? defaultApiFetch;
  const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));
  const alertFn = deps.alert ?? ((m: string) => window.alert(m));
  const writeClipboard =
    deps.writeClipboard ??
    ((value: string) => navigator.clipboard.writeText(value));

  // ---------- DOM scaffolding ----------------------------------------
  const fragment = cloneTemplate('tpl-project-list-sidebar');
  const root = fragment.firstElementChild as HTMLElement;
  mount(host, fragment);

  const tabActiveBtn = root.querySelector<HTMLButtonElement>('[data-role="tab-active"]')!;
  const tabArchivedBtn = root.querySelector<HTMLButtonElement>('[data-role="tab-archived"]')!;
  const searchInput = root.querySelector<HTMLInputElement>('[data-role="search"]')!;
  const listEl = root.querySelector<HTMLElement>('[data-role="list"]')!;

  const cleanups: Array<() => void> = [];
  // Per-row listener cleanups. Cleared on every rerender so detached rows
  // can be GC'd; otherwise the closures capturing each row would keep the
  // detached DOM alive for the sidebar's lifetime.
  let rowCleanups: Array<() => void> = [];

  // Volatile UI state local to this mount. Kept as plain values rather than
  // adding signals to the global store — it has no consumers outside this
  // component.
  let searchQuery = '';
  let renameId: string | null = null;

  // ---------- Sidebar events -----------------------------------------
  cleanups.push(
    bindEvents(root, {
      selectActive: () => setProjectListFilter('active'),
      selectArchived: () => setProjectListFilter('archived'),
      search: (e) => {
        searchQuery = (e.target as HTMLInputElement).value;
        rerenderList();
      },
      openCreate: () => openCreateDialog(),
    }),
  );

  // ---------- Reactive bindings --------------------------------------
  cleanups.push(
    bind(tabActiveBtn, projectsStore.filter, (el, value) => paintTab(el, value === 'active')),
    bind(tabArchivedBtn, projectsStore.filter, (el, value) => paintTab(el, value === 'archived')),
    bind(listEl, projectsStore.list, () => rerenderList()),
    bind(listEl, projectsStore.filter, () => rerenderList()),
  );

  // ---------- List rendering -----------------------------------------
  function rerenderList(): void {
    const filter = projectsStore.filter.get();
    const all = projectsStore.list.get();
    const needle = searchQuery.trim().toLowerCase();
    const filtered = all.filter((p) => {
      if (p.status !== filter) return false;
      if (!needle) return true;
      return p.name.toLowerCase().includes(needle);
    });

    // Tear down listeners attached to the previous batch of rows before we
    // detach them from the DOM.
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];

    listEl.replaceChildren();

    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.style.color = '#888';
      empty.style.fontSize = '13px';
      empty.textContent = 'No projects found.';
      listEl.appendChild(empty);
      return;
    }

    for (const project of filtered) {
      listEl.appendChild(renderRow(project));
    }
  }

  function renderRow(project: Project): HTMLElement {
    if (renameId === project.id) {
      return renderRenameRow(project);
    }

    const url = project.urls[0] ?? '';
    const fragment = cloneTemplate('tpl-project-list-item', {
      name: project.name,
      url,
    });
    const row = fragment.firstElementChild as HTMLElement;

    if (!url) {
      const urlEl = row.querySelector<HTMLElement>('[data-role="url"]')!;
      urlEl.style.display = 'none';
    }

    const menuButton = row.querySelector<HTMLButtonElement>('[data-role="menu-button"]')!;
    attr(menuButton, 'aria-label', `Actions for ${project.name}`);

    const rowCleanup = bindEvents(row, {
      menu: (e) => {
        e.stopPropagation();
        const ev = e as MouseEvent;
        openContextMenu(project, ev.clientX, ev.clientY);
      },
    });
    rowCleanups.push(rowCleanup);

    const onRowClick = (): void => {
      deps.navigate(`/projects/${project.id}`);
    };
    const onRowContext = (e: Event): void => {
      e.preventDefault();
      const ev = e as MouseEvent;
      openContextMenu(project, ev.clientX, ev.clientY);
    };
    const onRowEnter = (): void => {
      row.style.background = '#f3f4f6';
    };
    const onRowLeave = (): void => {
      row.style.background = 'transparent';
    };
    row.addEventListener('click', onRowClick);
    row.addEventListener('contextmenu', onRowContext);
    row.addEventListener('mouseenter', onRowEnter);
    row.addEventListener('mouseleave', onRowLeave);
    rowCleanups.push(() => {
      row.removeEventListener('click', onRowClick);
      row.removeEventListener('contextmenu', onRowContext);
      row.removeEventListener('mouseenter', onRowEnter);
      row.removeEventListener('mouseleave', onRowLeave);
    });

    return row;
  }

  function renderRenameRow(project: Project): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'padding: 8px; border-radius: 4px; display: flex; align-items: center; margin-bottom: 2px;';

    const input = document.createElement('input');
    input.value = project.name;
    input.style.cssText =
      'flex: 1; padding: 2px 4px; font-size: 13px; border: 1px solid #4f46e5; border-radius: 3px;';
    input.addEventListener('click', (e) => e.stopPropagation());

    const submit = async (): Promise<void> => {
      const trimmed = input.value.trim();
      if (trimmed && trimmed !== project.name) {
        await apiFetch(`/projects/${project.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: trimmed }),
        });
        await refresh();
      }
      renameId = null;
      rerenderList();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      } else if (e.key === 'Escape') {
        renameId = null;
        rerenderList();
      }
    });
    input.addEventListener('blur', () => {
      void submit();
    });

    wrapper.appendChild(input);

    queueMicrotask(() => input.focus());

    return wrapper;
  }

  function paintTab(el: Element, isActive: boolean): void {
    const button = el as HTMLButtonElement;
    button.style.borderBottom = isActive ? '2px solid #4f46e5' : '2px solid transparent';
    button.style.color = isActive ? '#4f46e5' : '#666';
    button.style.fontWeight = isActive ? '600' : '400';
  }

  // ---------- Context menu -------------------------------------------
  let openMenuCleanup: (() => void) | null = null;

  function closeContextMenu(): void {
    if (openMenuCleanup) {
      openMenuCleanup();
      openMenuCleanup = null;
    }
  }

  function openContextMenu(project: Project, x: number, y: number): void {
    closeContextMenu();

    const fragment = cloneTemplate('tpl-project-list-menu', {
      archiveLabel: project.status === 'active' ? 'Archive' : 'Unarchive',
    });
    const menu = fragment.firstElementChild as HTMLElement;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;

    const teardown = bindEvents(menu, {
      rename: () => {
        renameId = project.id;
        closeContextMenu();
        rerenderList();
      },
      archive: async () => {
        const newStatus: Project['status'] =
          project.status === 'active' ? 'archived' : 'active';
        closeContextMenu();
        await apiFetch(`/projects/${project.id}`, {
          method: 'PUT',
          body: JSON.stringify({ status: newStatus }),
        });
        await refresh();
      },
      delete: async () => {
        closeContextMenu();
        if (
          confirmFn(
            `Delete project "${project.name}"? This will permanently remove the project and all annotations.`,
          )
        ) {
          await apiFetch(`/projects/${project.id}`, { method: 'DELETE' });
          await refresh();
        }
      },
      'delete-page': () => {
        closeContextMenu();
        alertFn('Select a page to delete from the project view.');
      },
      details: () => {
        closeContextMenu();
        deps.navigate(`/projects/${project.id}`);
      },
      'copy-link': async () => {
        closeContextMenu();
        const url = `${window.location.origin}/projects/${project.id}`;
        await writeClipboard(url);
        alertFn('Project link copied to clipboard.');
      },
      open: () => {
        closeContextMenu();
        deps.navigate(`/projects/${project.id}`);
      },
      export: () => {
        closeContextMenu();
        openExportDialog(project);
      },
    });

    // Hover styles for menu buttons.
    const hoverHandlers: Array<() => void> = [];
    for (const button of menu.querySelectorAll<HTMLButtonElement>('button')) {
      const onEnter = () => (button.style.background = '#f3f4f6');
      const onLeave = () => (button.style.background = 'transparent');
      button.addEventListener('mouseenter', onEnter);
      button.addEventListener('mouseleave', onLeave);
      hoverHandlers.push(() => {
        button.removeEventListener('mouseenter', onEnter);
        button.removeEventListener('mouseleave', onLeave);
      });
    }

    document.body.appendChild(menu);

    const onOutsideClick = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    // Defer to the next event-loop turn so the click that opened the menu
    // does not immediately dismiss it.
    let mounted = false;
    const arm = (): void => {
      mounted = true;
      document.addEventListener('mousedown', onOutsideClick);
    };
    queueMicrotask(arm);

    openMenuCleanup = () => {
      teardown();
      for (const cleanup of hoverHandlers) cleanup();
      if (mounted) document.removeEventListener('mousedown', onOutsideClick);
      menu.remove();
    };
  }

  // ---------- Create-project dialog ----------------------------------
  let openDialogCleanup: (() => void) | null = null;

  function closeDialog(): void {
    if (openDialogCleanup) {
      openDialogCleanup();
      openDialogCleanup = null;
    }
  }

  function openCreateDialog(): void {
    closeDialog();
    const fragment = cloneTemplate('tpl-create-project-dialog');
    const overlay = fragment.firstElementChild as HTMLElement;
    const panel = overlay.querySelector<HTMLElement>('[data-role="panel"]')!;
    const nameInput = overlay.querySelector<HTMLInputElement>('[data-role="name"]')!;
    const urlInput = overlay.querySelector<HTMLInputElement>('[data-role="url"]')!;
    const errorEl = overlay.querySelector<HTMLElement>('[data-role="error"]')!;
    const submitBtn = overlay.querySelector<HTMLButtonElement>('[data-role="submit"]')!;
    let submitting = false;

    const setError = (message: string): void => {
      if (message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
      } else {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    };

    const setSubmitting = (value: boolean): void => {
      submitting = value;
      submitBtn.disabled = value;
      submitBtn.textContent = value ? 'Creating…' : 'Create';
      submitBtn.style.cursor = value ? 'not-allowed' : 'pointer';
    };

    panel.addEventListener('click', (e) => e.stopPropagation());

    const teardown = bindEvents(overlay, {
      closeOverlay: closeDialog,
      cancel: closeDialog,
      submit: async (e) => {
        e.preventDefault();
        if (submitting) return;
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        if (!name || !url) {
          setError('Name and URL are required.');
          return;
        }
        setSubmitting(true);
        setError('');
        try {
          await apiFetch('/projects', {
            method: 'POST',
            body: JSON.stringify({ name, urls: [url] }),
          });
          closeDialog();
          await refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create project.');
        } finally {
          setSubmitting(false);
        }
      },
    });

    document.body.appendChild(overlay);
    queueMicrotask(() => nameInput.focus());

    openDialogCleanup = () => {
      teardown();
      overlay.remove();
    };
  }

  // ---------- Export-project dialog ----------------------------------
  function openExportDialog(project: Project): void {
    closeDialog();
    const fragment = cloneTemplate('tpl-export-project-dialog', {
      projectName: project.name,
    });
    const overlay = fragment.firstElementChild as HTMLElement;
    const panel = overlay.querySelector<HTMLElement>('[data-role="panel"]')!;
    const pdfBtn = overlay.querySelector<HTMLButtonElement>('[data-role="format-pdf"]')!;
    const csvBtn = overlay.querySelector<HTMLButtonElement>('[data-role="format-csv"]')!;
    const errorEl = overlay.querySelector<HTMLElement>('[data-role="error"]')!;
    const downloadEl = overlay.querySelector<HTMLElement>('[data-role="download"]')!;
    const downloadLink = overlay.querySelector<HTMLAnchorElement>(
      '[data-role="download-link"]',
    )!;
    const exportBtn = overlay.querySelector<HTMLButtonElement>(
      '[data-role="export-button"]',
    )!;

    let format: 'pdf' | 'csv' = 'pdf';
    let exporting = false;

    const paintFormat = (): void => {
      const buttons = [
        { btn: pdfBtn, key: 'pdf' as const },
        { btn: csvBtn, key: 'csv' as const },
      ];
      for (const { btn, key } of buttons) {
        const active = format === key;
        btn.style.border = active ? '2px solid #4f46e5' : '1px solid #d1d5db';
        btn.style.background = active ? '#eef2ff' : '#fff';
        btn.style.color = active ? '#4f46e5' : '#333';
        btn.style.fontWeight = active ? '600' : '400';
      }
    };
    paintFormat();

    const setError = (message: string): void => {
      if (message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
      } else {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    };

    const setExporting = (value: boolean): void => {
      exporting = value;
      exportBtn.disabled = value;
      exportBtn.textContent = value ? 'Exporting…' : 'Export';
      exportBtn.style.cursor = value ? 'not-allowed' : 'pointer';
    };

    const showDownload = (url: string | null): void => {
      if (url) {
        downloadEl.hidden = false;
        downloadLink.href = url;
        downloadLink.textContent = `Download ${format.toUpperCase()} report`;
      } else {
        downloadEl.hidden = true;
        downloadLink.removeAttribute('href');
      }
    };

    panel.addEventListener('click', (e) => e.stopPropagation());

    const teardown = bindEvents(overlay, {
      closeOverlay: closeDialog,
      close: closeDialog,
      formatPdf: () => {
        format = 'pdf';
        showDownload(null);
        paintFormat();
      },
      formatCsv: () => {
        format = 'csv';
        showDownload(null);
        paintFormat();
      },
      export: async () => {
        if (exporting) return;
        setExporting(true);
        setError('');
        showDownload(null);
        try {
          const data = await apiFetch<{ downloadUrl: string }>(
            `/projects/${project.id}/export`,
            { method: 'POST', body: JSON.stringify({ format }) },
          );
          showDownload(data.downloadUrl);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Export failed.');
        } finally {
          setExporting(false);
        }
      },
    });

    document.body.appendChild(overlay);

    openDialogCleanup = () => {
      teardown();
      overlay.remove();
    };
  }

  // ---------- Data fetch ---------------------------------------------
  async function refresh(): Promise<void> {
    try {
      const data = await apiFetch<Project[]>('/projects');
      loadProjects(data);
    } catch {
      // Silently fail — caller may not be authenticated yet. Matches the
      // prior React component's behaviour.
    }
  }

  // Kick off the initial fetch. The promise is intentionally not awaited so
  // mount returns synchronously.
  void refresh();

  // ---------- Lifecycle ----------------------------------------------
  function dispose(): void {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];
    closeContextMenu();
    closeDialog();
    root.remove();
  }

  return { dispose, refresh };
}
