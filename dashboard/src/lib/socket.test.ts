// @vitest-environment jsdom
/**
 * Unit tests for the dashboard socket helpers added by Task 14.3
 * (Dashboard popover indicator).
 *
 * Covers:
 * - `emitAnnotationOpen(id)` emits `annotation:open { id }` on the
 *   `/collab` namespace via the existing socket helper.
 * - Opening a different annotation closes the previously opened one.
 * - `emitAnnotationClose(id)` emits `annotation:close { id }` only when
 *   the socket is connected.
 * - The socket helper exposes the `annotation:viewers` event so callers
 *   can subscribe via `onSocketEvent`.
 *
 * Validates: Requirements 6.6, 6.7
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `socket.io-client` is mocked at module scope so the helpers under test
// see our fake socket instance instead of opening a real network handle.
// `getSocket` only returns the cached instance when it is `connected`, so
// we set `connected: true` on the fake from the start.
type Listener = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  // Helpers for tests
  __listeners: Map<string, Listener[]>;
  __trigger: (event: string, ...args: unknown[]) => void;
}

function makeFakeSocket(): FakeSocket {
  const listeners = new Map<string, Listener[]>();
  const fake: FakeSocket = {
    connected: true,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: Listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    }),
    off: vi.fn((event: string, handler: Listener) => {
      const arr = listeners.get(event);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }),
    disconnect: vi.fn(),
    __listeners: listeners,
    __trigger: (event, ...args) => {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };
  return fake;
}

let fakeSocket: FakeSocket;
const ioMock = vi.fn<(...args: unknown[]) => FakeSocket>();

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

// Task 7.4: `auth.ts` no longer reads from `localStorage` (Req 18.2);
// the bearer JWT is held in a module-level variable. Each test seeds the
// token by calling `setToken` on the freshly-imported module so
// `getSocket` does not throw "Not authenticated".
beforeEach(async () => {
  fakeSocket = makeFakeSocket();
  ioMock.mockClear();
  ioMock.mockImplementation(() => fakeSocket);
  // Reset the socket-helper module between tests so its module-level
  // `socket` / `currentOpenAnnotationId` state does not leak.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importSocketModule() {
  // The socket module imports `auth.ts`; both share module-level state
  // resolved by Vitest's module graph, so seeding the token via the
  // fresh `auth` import affects the same `getToken()` the socket
  // module uses.
  const auth = await import('./auth');
  auth.setToken('test-token');
  return await import('./socket');
}

describe('emitAnnotationOpen / emitAnnotationClose', () => {
  it('emits `annotation:open` with the given id', async () => {
    const mod = await importSocketModule();

    mod.emitAnnotationOpen('ann-1');

    expect(fakeSocket.emit).toHaveBeenCalledWith('annotation:open', { id: 'ann-1' });
  });

  it('opening a second annotation closes the first', async () => {
    const mod = await importSocketModule();

    mod.emitAnnotationOpen('ann-1');
    fakeSocket.emit.mockClear();

    mod.emitAnnotationOpen('ann-2');

    expect(fakeSocket.emit).toHaveBeenCalledWith('annotation:close', { id: 'ann-1' });
    expect(fakeSocket.emit).toHaveBeenCalledWith('annotation:open', { id: 'ann-2' });
  });

  it('emits `annotation:close` for the current open id', async () => {
    const mod = await importSocketModule();

    mod.emitAnnotationOpen('ann-1');
    fakeSocket.emit.mockClear();

    mod.emitAnnotationClose('ann-1');

    expect(fakeSocket.emit).toHaveBeenCalledWith('annotation:close', { id: 'ann-1' });
  });

  it('skips `annotation:close` when no socket is connected', async () => {
    const mod = await importSocketModule();

    // No prior `emitAnnotationOpen` so the module never created a socket.
    mod.emitAnnotationClose('ann-99');

    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });

  it('ignores empty annotation ids', async () => {
    const mod = await importSocketModule();

    mod.emitAnnotationOpen('');
    mod.emitAnnotationClose('');

    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });
});

describe('annotation:viewers subscription', () => {
  it('delivers `annotation:viewers` payloads to the registered handler', async () => {
    const mod = await importSocketModule();

    const handler = vi.fn();
    const unsubscribe = mod.onSocketEvent('annotation:viewers', handler);

    fakeSocket.__trigger('annotation:viewers', { id: 'ann-1', userIds: ['u1', 'u2'] });

    expect(handler).toHaveBeenCalledWith({ id: 'ann-1', userIds: ['u1', 'u2'] });

    unsubscribe();
    fakeSocket.__trigger('annotation:viewers', { id: 'ann-1', userIds: ['u1'] });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
