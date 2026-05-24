// @vitest-environment jsdom
/**
 * Unit tests for `<fl-project-picker>` (Requirement 39.1, task 30.1).
 *
 * Covers the contract called out in the task:
 *   1. The element is a Custom Element subclass of HTMLElement with an open
 *      Shadow Root and adopts the shared stylesheet (or its `<style>`
 *      fallback under jsdom).
 *   2. The `projects` property accepts an array of
 *      `{ id, name, lastUsedAt }` and renders one row per project.
 *   3. Rows are ordered by `lastUsedAt` descending (recent-first), the
 *      ordering rule from design §"Project Picker Fallback".
 *   4. Clicking a row dispatches a bubbling, composed `select`
 *      `CustomEvent` whose `detail.projectId` matches the chosen row.
 *   5. Re-assigning `projects` re-renders the list in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FlProjectPicker,
  sortProjectsByRecency,
  type PickerProject,
  type ProjectPickerSelectEventDetail,
} from './ProjectPicker';
import { PROJECT_MAPPING_STORAGE_KEY } from '../lib/projectMappingStore';

function makeProject(overrides: Partial<PickerProject> = {}): PickerProject {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? 'Example Project',
    lastUsedAt: overrides.lastUsedAt ?? new Date().toISOString(),
  };
}

function mount(): FlProjectPicker {
  const el = document.createElement('fl-project-picker') as FlProjectPicker;
  document.body.appendChild(el);
  return el;
}

function rows(el: FlProjectPicker): HTMLElement[] {
  return Array.from(
    el.shadowRoot!.querySelectorAll<HTMLElement>('li.fl-project-picker-item'),
  );
}

describe('<fl-project-picker>', () => {
  let chromeStore: Record<string, unknown>;

  beforeEach(() => {
    document.body.innerHTML = '';
    chromeStore = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => {
            if (key in chromeStore) return { [key]: chromeStore[key] };
            return {};
          }),
          set: vi.fn(async (entries: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(entries)) chromeStore[k] = v;
          }),
          remove: vi.fn(async (key: string) => {
            delete chromeStore[key];
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is registered as a Custom Element', () => {
    expect(customElements.get('fl-project-picker')).toBe(FlProjectPicker);
  });

  it('extends HTMLElement and attaches an open Shadow Root', () => {
    const el = mount();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
  });

  it('adopts the shared stylesheet (or its <style> fallback) so theme rules are in scope', () => {
    const el = mount();
    const root = el.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });

  it('renders an empty placeholder when there are no projects', () => {
    const el = mount();
    expect(rows(el)).toHaveLength(0);
    const empty = el.shadowRoot!.querySelector('.fl-project-picker-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/no projects/i);
  });

  it('renders one row per project with name + lastUsedAt meta', () => {
    const el = mount();
    el.projects = [
      makeProject({ id: 'p1', name: 'Alpha', lastUsedAt: '2024-01-01T00:00:00Z' }),
      makeProject({ id: 'p2', name: 'Beta', lastUsedAt: '2024-02-01T00:00:00Z' }),
    ];

    const rendered = rows(el);
    expect(rendered).toHaveLength(2);
    expect(
      rendered[0].querySelector('.fl-project-picker-name')!.textContent,
    ).not.toBe('');
    expect(rendered[0].querySelector('.fl-project-picker-meta')).not.toBeNull();
  });

  it('orders rows by lastUsedAt descending (recent-first)', () => {
    const el = mount();
    el.projects = [
      // Intentionally out of order — the picker must sort, not just render.
      makeProject({ id: 'oldest', name: 'Oldest', lastUsedAt: '2023-01-01T00:00:00Z' }),
      makeProject({ id: 'newest', name: 'Newest', lastUsedAt: '2024-06-01T00:00:00Z' }),
      makeProject({ id: 'middle', name: 'Middle', lastUsedAt: '2024-01-01T00:00:00Z' }),
    ];

    const ids = rows(el).map((r) => r.dataset.projectId);
    expect(ids).toEqual(['newest', 'middle', 'oldest']);
  });

  it('places projects with missing or unparseable lastUsedAt at the bottom', () => {
    const el = mount();
    el.projects = [
      makeProject({ id: 'unparseable', name: 'Unparseable', lastUsedAt: 'not-a-date' }),
      makeProject({ id: 'newest', name: 'Newest', lastUsedAt: '2024-06-01T00:00:00Z' }),
      makeProject({ id: 'missing', name: 'Missing', lastUsedAt: '' }),
    ];

    const ids = rows(el).map((r) => r.dataset.projectId);
    expect(ids[0]).toBe('newest');
    // Both unparseable and missing land at the bottom; their relative order
    // is unspecified but they must come after the dated entry.
    expect(ids.slice(1).sort()).toEqual(['missing', 'unparseable']);
  });

  it('exposes the sort rule via sortProjectsByRecency without mutating its input', () => {
    const input: PickerProject[] = [
      makeProject({ id: 'a', lastUsedAt: '2023-01-01T00:00:00Z' }),
      makeProject({ id: 'b', lastUsedAt: '2024-01-01T00:00:00Z' }),
    ];
    const snapshot = input.map((p) => p.id);
    const sorted = sortProjectsByRecency(input);
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a']);
    expect(input.map((p) => p.id)).toEqual(snapshot);
  });

  it('re-renders after every projects assignment', () => {
    const el = mount();
    el.projects = [makeProject({ id: 'p1', name: 'One' })];
    expect(rows(el)).toHaveLength(1);

    el.projects = [
      makeProject({ id: 'p1', name: 'One' }),
      makeProject({ id: 'p2', name: 'Two' }),
    ];
    expect(rows(el)).toHaveLength(2);

    el.projects = [];
    expect(rows(el)).toHaveLength(0);
    expect(
      el.shadowRoot!.querySelector('.fl-project-picker-empty'),
    ).not.toBeNull();
  });

  it('treats null / undefined projects as empty', () => {
    const el = mount();
    el.projects = [makeProject()];
    expect(rows(el)).toHaveLength(1);

    el.projects = null as unknown as readonly PickerProject[];
    expect(el.projects).toEqual([]);
    expect(rows(el)).toHaveLength(0);

    el.projects = undefined as unknown as readonly PickerProject[];
    expect(el.projects).toEqual([]);
  });

  it('reads back the assigned values via the projects getter', () => {
    const el = mount();
    const list = [
      makeProject({ id: 'a' }),
      makeProject({ id: 'b' }),
    ];
    el.projects = list;
    expect(el.projects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(el.visibleProjects.map((p) => p.id).length).toBe(2);
  });

  it('emits a bubbling, composed `select` CustomEvent with the chosen projectId on click', () => {
    const el = mount();
    el.projects = [
      makeProject({ id: 'p1', name: 'Alpha', lastUsedAt: '2024-01-01T00:00:00Z' }),
      makeProject({ id: 'p2', name: 'Beta', lastUsedAt: '2024-02-01T00:00:00Z' }),
    ];

    const seen: CustomEvent<ProjectPickerSelectEventDetail>[] = [];
    document.addEventListener('select', (e) => {
      seen.push(e as CustomEvent<ProjectPickerSelectEventDetail>);
    });

    // Rows are sorted recent-first, so 'p2' is at index 0.
    rows(el)[0].click();

    expect(seen).toHaveLength(1);
    const evt = seen[0];
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);
    expect(evt.detail).toEqual({ projectId: 'p2' });
  });

  it('resolves the clicked project via data-project-id even when the click hits an inner element', () => {
    const el = mount();
    el.projects = [
      makeProject({ id: 'p1', name: 'Alpha', lastUsedAt: '2024-01-01T00:00:00Z' }),
    ];

    let detail: ProjectPickerSelectEventDetail | undefined;
    el.addEventListener('select', (e) => {
      detail = (e as CustomEvent<ProjectPickerSelectEventDetail>).detail;
    });

    // Click the inner <span> rather than the row itself — the delegated
    // handler must walk up to the row.
    const inner = rows(el)[0].querySelector('.fl-project-picker-name') as HTMLElement;
    inner.click();

    expect(detail).toEqual({ projectId: 'p1' });
  });

  it('does not dispatch `select` when a click lands outside any row', () => {
    const el = mount();
    el.projects = [makeProject({ id: 'p1' })];

    let count = 0;
    el.addEventListener('select', () => count++);

    // Click the <ol> background between rows.
    const ol = el.shadowRoot!.querySelector(
      'ol.fl-project-picker-list',
    ) as HTMLOListElement;
    ol.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(count).toBe(0);
  });

  it('activates rows via Enter / Space keyboard input', () => {
    const el = mount();
    el.projects = [makeProject({ id: 'p1', name: 'Alpha' })];

    const seen: ProjectPickerSelectEventDetail[] = [];
    el.addEventListener('select', (e) => {
      seen.push((e as CustomEvent<ProjectPickerSelectEventDetail>).detail);
    });

    const row = rows(el)[0];
    row.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    row.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }),
    );

    expect(seen).toEqual([{ projectId: 'p1' }, { projectId: 'p1' }]);
  });

  it('persists the URL→Project mapping in chrome.storage.local on selection (Req 39.2)', async () => {
    const el = mount();
    el.projects = [
      makeProject({ id: 'p1', name: 'Alpha', lastUsedAt: '2024-01-01T00:00:00Z' }),
    ];

    rows(el)[0].click();

    // The picker fires-and-forgets the storage write — flush microtasks
    // so the awaited chrome.storage round-trip completes.
    await Promise.resolve();
    await Promise.resolve();

    const expectedKey = `${window.location.origin}${window.location.pathname}`;
    expect(chromeStore[PROJECT_MAPPING_STORAGE_KEY]).toEqual({
      [expectedKey]: 'p1',
    });
  });

  it('emits the public select event even when the storage write rejects', async () => {
    // Replace the chrome stub with one whose `set` rejects.
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {
            throw new Error('quota exceeded');
          }),
          remove: vi.fn(async () => {}),
        },
      },
    });

    const el = mount();
    el.projects = [makeProject({ id: 'p1' })];

    const seen: ProjectPickerSelectEventDetail[] = [];
    el.addEventListener('select', (e) => {
      seen.push((e as CustomEvent<ProjectPickerSelectEventDetail>).detail);
    });

    rows(el)[0].click();
    await Promise.resolve();

    expect(seen).toEqual([{ projectId: 'p1' }]);
  });
});
