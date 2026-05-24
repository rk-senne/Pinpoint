// @vitest-environment jsdom
/**
 * Unit tests for `<fl-sync-conflict-tray>` (task 36.5, Req 44.4).
 *
 * Covers:
 *   1. The element is registered and renders nothing when there are no
 *      conflicts (the section is `hidden`).
 *   2. Assigning the `conflicts` property renders one row per conflict
 *      with the kind, HTTP status, and reason wording per the design
 *      table.
 *   3. Server message is rendered when present and hidden when absent.
 *   4. Retry / Edit / Discard buttons emit `conflict-retry`,
 *      `conflict-edit`, `conflict-discard` events with the right
 *      `detail.localUuid` (and the full conflict for Edit).
 *   5. The events bubble + cross the Shadow Root boundary
 *      (`composed: true`) so the host can listen at the document level.
 *   6. Subscribes to `chrome.storage.onChanged` for the
 *      `pinpoint_sync_conflicts` key and re-renders when it
 *      changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './SyncConflictTray';
import {
  FlSyncConflictTray,
  type ConflictActionEventDetail,
  type ConflictEditEventDetail,
} from './SyncConflictTray';
import {
  CONFLICT_STORAGE_KEY,
  type SyncConflict,
} from '../lib/SyncConflictTray';
import type { OutboxEntry } from '../lib/Outbox';

function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    localUuid: overrides.localUuid ?? 'uuid-default',
    kind: overrides.kind ?? 'create-annotation',
    payload: overrides.payload ?? { projectId: 'p1', body: 'hello' },
    pendingSync: true,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

function makeConflict(overrides: Partial<SyncConflict> = {}): SyncConflict {
  const entry = overrides.entry ?? makeEntry({ localUuid: overrides.localUuid });
  return {
    localUuid: overrides.localUuid ?? entry.localUuid,
    entry,
    httpStatus: overrides.httpStatus ?? 403,
    reason: overrides.reason ?? 'forbidden',
    serverMessage: overrides.serverMessage,
    attempts: overrides.attempts ?? 1,
    detectedAt: overrides.detectedAt ?? '2024-01-02T00:00:00.000Z',
  };
}

function mount(): FlSyncConflictTray {
  const el = document.createElement('fl-sync-conflict-tray') as FlSyncConflictTray;
  document.body.appendChild(el);
  return el;
}

interface ChromeStorageStub {
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
    onChanged: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    };
  };
}

let store: Record<string, unknown>;
let chromeListeners: Array<
  (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
>;

function buildChromeStub(): ChromeStorageStub {
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (key in store) return { [key]: store[key] };
          return {};
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) store[k] = v;
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
      onChanged: {
        addListener: vi.fn((listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => {
          chromeListeners.push(listener);
        }),
        removeListener: vi.fn((listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => {
          chromeListeners = chromeListeners.filter((l) => l !== listener);
        }),
      },
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  store = {};
  chromeListeners = [];
  vi.stubGlobal('chrome', buildChromeStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<fl-sync-conflict-tray>', () => {
  it('is registered as a Custom Element with an open Shadow Root', () => {
    expect(customElements.get('fl-sync-conflict-tray')).toBe(FlSyncConflictTray);
    const el = mount();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
  });

  it('hides the section entirely when there are no conflicts', () => {
    const el = mount();
    el.conflicts = [];
    const section = el.shadowRoot!.querySelector(
      'section.fl-conflict-tray',
    ) as HTMLElement;
    expect(section.hidden).toBe(true);
    expect(el.shadowRoot!.querySelectorAll('li.fl-conflict-row')).toHaveLength(0);
  });

  it('renders one row per conflict when conflicts are assigned', () => {
    const el = mount();
    el.conflicts = [
      makeConflict({ localUuid: 'uuid-A', httpStatus: 403, reason: 'forbidden' }),
      makeConflict({ localUuid: 'uuid-B', httpStatus: 404, reason: 'not_found' }),
      makeConflict({ localUuid: 'uuid-C', httpStatus: 409, reason: 'conflict' }),
    ];

    const rows = el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-conflict-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.dataset.localUuid).toBe('uuid-A');
    expect(rows[1]!.dataset.localUuid).toBe('uuid-B');
    expect(rows[2]!.dataset.localUuid).toBe('uuid-C');
  });

  it('renders the count in the section header', () => {
    const el = mount();
    el.conflicts = [
      makeConflict({ localUuid: 'uuid-A' }),
      makeConflict({ localUuid: 'uuid-B' }),
    ];
    const title = el.shadowRoot!.querySelector('.fl-conflict-tray-title') as HTMLElement;
    expect(title.textContent).toBe('Sync conflicts (2)');
  });

  it('renders the HTTP status, kind, and reason wording per row', () => {
    const el = mount();
    el.conflicts = [
      makeConflict({
        localUuid: 'uuid-A',
        httpStatus: 403,
        reason: 'forbidden',
        entry: makeEntry({ kind: 'create-annotation' }),
      }),
    ];
    const row = el.shadowRoot!.querySelector('li.fl-conflict-row') as HTMLLIElement;
    expect(row.querySelector('.fl-conflict-status')!.textContent).toBe('HTTP 403');
    expect(row.querySelector('.fl-conflict-kind')!.textContent).toBe(
      'create annotation',
    );
    expect(row.querySelector('.fl-conflict-reason')!.textContent).toBe(
      'You no longer have permission to make this change.',
    );
  });

  it('uses the design-table wording for each reason', () => {
    const el = mount();
    el.conflicts = [
      makeConflict({ localUuid: 'a', reason: 'not_found' }),
      makeConflict({ localUuid: 'b', reason: 'conflict' }),
      makeConflict({ localUuid: 'c', reason: 'validation' }),
      makeConflict({ localUuid: 'd', reason: 'unknown' }),
    ];
    const reasons = Array.from(
      el.shadowRoot!.querySelectorAll<HTMLElement>('.fl-conflict-reason'),
    ).map((e) => e.textContent);
    expect(reasons).toEqual([
      'The annotation or comment this refers to no longer exists on the server.',
      'Someone else updated this annotation while you were offline.',
      'The server rejected the contents — likely the body is too long or required fields are missing.',
      'Sync failed. We have kept your local copy.',
    ]);
  });

  it('shows the server message when present and hides it when absent', () => {
    const el = mount();
    el.conflicts = [
      makeConflict({
        localUuid: 'uuid-A',
        serverMessage: 'project archived',
      }),
      makeConflict({ localUuid: 'uuid-B' }),
    ];

    const rows = el.shadowRoot!.querySelectorAll<HTMLLIElement>('li.fl-conflict-row');
    const msgA = rows[0]!.querySelector('.fl-conflict-server-message') as HTMLElement;
    const msgB = rows[1]!.querySelector('.fl-conflict-server-message') as HTMLElement;
    expect(msgA.hidden).toBe(false);
    expect(msgA.textContent).toBe('Server: project archived');
    expect(msgB.hidden).toBe(true);
  });

  describe('action buttons', () => {
    it('emits `conflict-retry` with `detail.localUuid` when Retry is clicked', () => {
      const el = mount();
      el.conflicts = [
        makeConflict({ localUuid: 'uuid-A' }),
        makeConflict({ localUuid: 'uuid-B' }),
      ];

      const events: ConflictActionEventDetail[] = [];
      document.addEventListener('conflict-retry', (e) => {
        events.push((e as CustomEvent<ConflictActionEventDetail>).detail);
      });

      const row = el.shadowRoot!.querySelectorAll<HTMLLIElement>(
        'li.fl-conflict-row',
      )[1]!;
      const btn = row.querySelector(
        'button[data-action="retry"]',
      ) as HTMLButtonElement;
      btn.click();

      expect(events).toEqual([{ localUuid: 'uuid-B' }]);
    });

    it('emits `conflict-discard` with `detail.localUuid` when Discard is clicked', () => {
      const el = mount();
      el.conflicts = [makeConflict({ localUuid: 'uuid-A' })];

      let received: ConflictActionEventDetail | null = null;
      el.addEventListener('conflict-discard', (e) => {
        received = (e as CustomEvent<ConflictActionEventDetail>).detail;
      });

      const btn = el.shadowRoot!.querySelector(
        'button[data-action="discard"]',
      ) as HTMLButtonElement;
      btn.click();

      expect(received).toEqual({ localUuid: 'uuid-A' });
    });

    it('emits `conflict-edit` with the full conflict in detail when Edit is clicked', () => {
      const el = mount();
      const conflict = makeConflict({
        localUuid: 'uuid-A',
        serverMessage: 'sample',
      });
      el.conflicts = [conflict];

      let received: ConflictEditEventDetail | null = null;
      el.addEventListener('conflict-edit', (e) => {
        received = (e as CustomEvent<ConflictEditEventDetail>).detail;
      });

      const btn = el.shadowRoot!.querySelector(
        'button[data-action="edit"]',
      ) as HTMLButtonElement;
      btn.click();

      expect(received!.localUuid).toBe('uuid-A');
      expect(received!.conflict).toEqual(conflict);
    });

    it('events bubble out of the Shadow Root (`composed: true`)', () => {
      const el = mount();
      el.conflicts = [makeConflict({ localUuid: 'uuid-A' })];

      let event: CustomEvent<ConflictActionEventDetail> | null = null;
      document.addEventListener('conflict-retry', (e) => {
        event = e as CustomEvent<ConflictActionEventDetail>;
      });

      const btn = el.shadowRoot!.querySelector(
        'button[data-action="retry"]',
      ) as HTMLButtonElement;
      btn.click();

      expect(event).not.toBeNull();
      expect(event!.bubbles).toBe(true);
      expect(event!.composed).toBe(true);
    });
  });

  describe('chrome.storage subscription', () => {
    it('subscribes to chrome.storage.onChanged on connect', () => {
      mount();
      expect(chromeListeners).toHaveLength(1);
    });

    it('removes the listener on disconnect', () => {
      const el = mount();
      expect(chromeListeners).toHaveLength(1);
      el.remove();
      expect(chromeListeners).toHaveLength(0);
    });

    it('re-renders when the conflict storage key changes', async () => {
      const el = mount();
      // Initial render has no conflicts.
      const section = el.shadowRoot!.querySelector(
        'section.fl-conflict-tray',
      ) as HTMLElement;
      expect(section.hidden).toBe(true);

      // Simulate the Syncer writing a new conflict to storage.
      const conflict = makeConflict({ localUuid: 'uuid-NEW' });
      store[CONFLICT_STORAGE_KEY] = [conflict];
      for (const listener of chromeListeners) {
        listener(
          {
            [CONFLICT_STORAGE_KEY]: {
              newValue: [conflict],
              oldValue: undefined,
            } as chrome.storage.StorageChange,
          },
          'local',
        );
      }
      // Allow the async refresh to settle.
      await new Promise((r) => setTimeout(r, 0));

      expect(section.hidden).toBe(false);
      const rows = el.shadowRoot!.querySelectorAll('li.fl-conflict-row');
      expect(rows).toHaveLength(1);
      expect((rows[0] as HTMLLIElement).dataset.localUuid).toBe('uuid-NEW');
    });

    it('ignores changes to other storage keys', async () => {
      const el = mount();
      el.conflicts = [makeConflict({ localUuid: 'uuid-A' })];
      const initialRowCount = el.shadowRoot!.querySelectorAll(
        'li.fl-conflict-row',
      ).length;

      for (const listener of chromeListeners) {
        listener(
          {
            unrelated_key: {
              newValue: 'whatever',
              oldValue: undefined,
            } as chrome.storage.StorageChange,
          },
          'local',
        );
      }
      await new Promise((r) => setTimeout(r, 0));

      expect(
        el.shadowRoot!.querySelectorAll('li.fl-conflict-row').length,
      ).toBe(initialRowCount);
    });

    it('ignores changes to non-local storage areas', async () => {
      const el = mount();
      el.conflicts = [makeConflict({ localUuid: 'uuid-A' })];

      for (const listener of chromeListeners) {
        listener(
          {
            [CONFLICT_STORAGE_KEY]: {
              newValue: [],
              oldValue: undefined,
            } as chrome.storage.StorageChange,
          },
          'sync',
        );
      }
      await new Promise((r) => setTimeout(r, 0));

      expect(
        el.shadowRoot!.querySelectorAll('li.fl-conflict-row').length,
      ).toBe(1);
    });
  });
});
