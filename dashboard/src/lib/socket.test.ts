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

describe('session-cookie handshake after a hard refresh', () => {
  it('connects with credentials and no auth payload when no in-memory bearer exists', async () => {
    // A reloaded tab has no bearer in memory; the HttpOnly fl_session cookie
    // authenticates the same-origin handshake (the server only accepts it
    // from the dashboard Origin). Previously getSocket() threw
    // "Not authenticated" and realtime silently died after any reload.
    const { joinProject } = await import('./socket');
    expect(() => joinProject('proj-1')).not.toThrow();
    expect(ioMock).toHaveBeenCalledTimes(1);
    const opts = ioMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts).toMatchObject({ withCredentials: true });
    expect(opts).not.toHaveProperty('auth');
  });

  it('still sends the bearer when one is in memory', async () => {
    const auth = await import('./auth');
    auth.setToken('jwt-abc');
    const { joinProject } = await import('./socket');
    joinProject('proj-1');
    const opts = ioMock.mock.calls[0]![1] as { auth?: { token?: string } };
    expect(opts.auth?.token).toBe('jwt-abc');
  });
});

describe('canonical dotted realtime events', () => {
  it('subscribes to the dotted wire name and delivers the payload untouched', async () => {
    const mod = await importSocketModule();
    const handler = vi.fn();
    const unsubscribe = mod.onSocketEvent('annotation.created', handler);

    expect(fakeSocket.__listeners.has('annotation.created')).toBe(true);
    expect(fakeSocket.__listeners.has('annotation:created')).toBe(false); // no colon alias

    const ann = { id: 'a1', status: 'active' };
    fakeSocket.__trigger('annotation.created', ann);
    expect(handler).toHaveBeenCalledWith(ann);

    unsubscribe();
    fakeSocket.__trigger('annotation.created', ann);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(['annotation.updated', 'annotation.status_changed', 'comment.created'] as const)(
    'listens on %s',
    async (name) => {
      const mod = await importSocketModule();
      const handler = vi.fn();
      mod.onSocketEvent(name, handler);
      fakeSocket.__trigger(name, { id: 'x' });
      expect(handler).toHaveBeenCalledWith({ id: 'x' });
    },
  );
});

describe('single connection while connecting (regression)', () => {
  it('joinProject + several onSocketEvent calls share ONE socket even before it is connected', async () => {
    // Right after `io()` the client is `connected: false` but `active: true`.
    (fakeSocket as unknown as { active: boolean }).active = true;
    fakeSocket.connected = false;
    const mod = await importSocketModule();

    mod.joinProject('p1');
    mod.onSocketEvent('annotation.created', () => {});
    mod.onSocketEvent('annotation.updated', () => {});

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(fakeSocket.emit).toHaveBeenCalledWith('join', { projectId: 'p1' });
    expect(fakeSocket.on).toHaveBeenCalledWith('annotation.created', expect.any(Function));
  });
});
