/**
 * CommandPalette — global Ctrl+K / Cmd+K command palette (C3).
 *
 * A modal overlay providing quick search and navigation across projects
 * and actions. Sourced from projectsStore (active + archived) and a set
 * of static navigation actions.
 *
 * Keyboard controls:
 *   - Ctrl+K / Cmd+K → open
 *   - Escape → close
 *   - ↑/↓ → navigate results
 *   - Enter → execute selected item
 *   - Click backdrop → close
 */

import { cloneTemplate, requireRole } from '../lib/render';
import { navigate } from '../lib/router';
import { projectsStore } from '../lib/stores';
import type { Project } from '@pinpoint/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaletteItem {
  id: string;
  label: string;
  section: 'Projects' | 'Actions';
  icon?: string;
  action: () => void;
}

// ---------------------------------------------------------------------------
// Static actions
// ---------------------------------------------------------------------------

function getStaticActions(): PaletteItem[] {
  return [
    {
      id: 'action-create-project',
      label: 'Create Project',
      section: 'Actions',
      action: () => navigate('/'),
    },
    {
      id: 'action-settings',
      label: 'Settings',
      section: 'Actions',
      action: () => navigate('/settings'),
    },
    {
      id: 'action-integrations',
      label: 'Integrations',
      section: 'Actions',
      action: () => navigate('/integrations'),
    },
    {
      id: 'action-reporting',
      label: 'Reporting',
      section: 'Actions',
      action: () => navigate('/reports'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectToItem(project: Project): PaletteItem {
  return {
    id: `project-${project.id}`,
    label: project.name,
    section: 'Projects',
    action: () => navigate(`/projects/${project.id}`),
  };
}

function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items;
  const lower = query.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mount the command palette on `rootEl`. Listens globally for Ctrl+K / Cmd+K
 * to open the palette. Returns a teardown function that removes all listeners.
 */
export function mountCommandPalette(rootEl: Element): () => void {
  let overlay: HTMLElement | null = null;
  let selectedIndex = 0;
  let currentFiltered: PaletteItem[] = [];

  // Gather all items from store + static actions
  function getAllItems(): PaletteItem[] {
    const active = projectsStore.active.get().map(projectToItem);
    const archived = projectsStore.archived.get().map(projectToItem);
    const actions = getStaticActions();
    return [...active, ...archived, ...actions];
  }

  // Render the results list
  function renderResults(resultsEl: HTMLElement, items: PaletteItem[]): void {
    resultsEl.innerHTML = '';
    currentFiltered = items;

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText =
        'padding: 24px 16px; text-align: center; color: var(--pp-text-secondary, #6b7280); font-size: 14px;';
      empty.textContent = 'No results found';
      resultsEl.appendChild(empty);
      return;
    }

    // Group by section
    const grouped = new Map<string, PaletteItem[]>();
    for (const item of items) {
      const list = grouped.get(item.section) ?? [];
      list.push(item);
      grouped.set(item.section, list);
    }

    let globalIdx = 0;
    for (const [section, sectionItems] of grouped) {
      const sectionHeader = document.createElement('div');
      sectionHeader.style.cssText =
        'padding: 6px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pp-text-secondary, #6b7280);';
      sectionHeader.textContent = section;
      resultsEl.appendChild(sectionHeader);

      for (const item of sectionItems) {
        const row = document.createElement('div');
        row.setAttribute('data-palette-index', String(globalIdx));
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', globalIdx === selectedIndex ? 'true' : 'false');
        row.style.cssText =
          'padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 8px;';
        if (globalIdx === selectedIndex) {
          row.style.background = 'var(--pp-bg-hover, #f3f4f6)';
        }
        row.textContent = item.label;
        row.addEventListener('click', () => {
          item.action();
          close();
        });
        row.addEventListener('mouseenter', () => {
          selectedIndex = Number(row.getAttribute('data-palette-index'));
          highlightSelected(resultsEl);
        });
        resultsEl.appendChild(row);
        globalIdx++;
      }
    }
  }

  // Highlight the currently selected row
  function highlightSelected(resultsEl: HTMLElement): void {
    const rows = resultsEl.querySelectorAll<HTMLElement>('[data-palette-index]');
    for (const row of rows) {
      const idx = Number(row.getAttribute('data-palette-index'));
      const isSelected = idx === selectedIndex;
      row.setAttribute('aria-selected', String(isSelected));
      row.style.background = isSelected ? 'var(--pp-bg-hover, #f3f4f6)' : '';
    }
    // Scroll selected into view
    const selected = resultsEl.querySelector('[aria-selected="true"]');
    if (selected && typeof (selected as HTMLElement).scrollIntoView === 'function') {
      (selected as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }

  function open(): void {
    if (overlay) return;

    const fragment = cloneTemplate('tpl-command-palette');
    const root = fragment.firstElementChild as HTMLElement;
    if (!root) return;

    overlay = root;

    const searchInput = requireRole(root, 'search-input') as HTMLInputElement;
    const resultsEl = requireRole(root, 'results');
    // root itself is the backdrop (data-role="backdrop")
    const backdrop = root;

    selectedIndex = 0;
    const allItems = getAllItems();
    renderResults(resultsEl, allItems);

    // Filter on input
    searchInput.addEventListener('input', () => {
      selectedIndex = 0;
      const filtered = filterItems(allItems, searchInput.value);
      renderResults(resultsEl, filtered);
    });

    // Keyboard navigation
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentFiltered.length > 0) {
          selectedIndex = (selectedIndex + 1) % currentFiltered.length;
          highlightSelected(resultsEl);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentFiltered.length > 0) {
          selectedIndex = (selectedIndex - 1 + currentFiltered.length) % currentFiltered.length;
          highlightSelected(resultsEl);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (currentFiltered[selectedIndex]) {
          currentFiltered[selectedIndex].action();
          close();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    // Close on backdrop click
    backdrop.addEventListener('click', (e: MouseEvent) => {
      if (e.target === backdrop) {
        close();
      }
    });

    rootEl.appendChild(root);
    // Focus input after mounting
    requestAnimationFrame(() => searchInput.focus());
  }

  function close(): void {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  // Global keyboard shortcut
  function onGlobalKeydown(e: KeyboardEvent): void {
    // Accept either Ctrl+K or Cmd+K on any platform
    const modifier = e.metaKey || e.ctrlKey;
    if (modifier && e.key === 'k') {
      e.preventDefault();
      if (overlay) {
        close();
      } else {
        open();
      }
    }
    // Also close on Escape if palette is open (catch when focus is not on input)
    if (e.key === 'Escape' && overlay) {
      e.preventDefault();
      close();
    }
  }

  document.addEventListener('keydown', onGlobalKeydown);

  // Return teardown
  return () => {
    document.removeEventListener('keydown', onGlobalKeydown);
    close();
  };
}
