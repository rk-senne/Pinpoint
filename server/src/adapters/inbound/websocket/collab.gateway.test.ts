// Unit test: collab.gateway.ts — join & annotation:open authorization.
//
// Verifies that the gateway rejects cross-tenant room joins by checking
// project/annotation ownership against the user's orgId before calling
// socket.join(). Uses mocked Socket.IO and db (no real server or network).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installCollabGateway, type CollabGatewayDeps } from './collab.gateway.js';

// ---------- helpers for mocking Socket.IO ----------

interface MockSocket {
  id: string;
  handshake: { auth: { token: string } };
  join: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  rooms: Set<string>;
}

function createMockSocket(id = 'socket-1'): MockSocket {
  return {
    id,
    handshake: { auth: { token: 'valid-token' } },
    join: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
    rooms: new Set([id]),
  };
}

interface MockNamespace {
  use: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  to: ReturnType<typeof vi.fn>;
  adapter: { rooms: Map<string, Set<string>> };
  sockets: Map<string, unknown>;
}

function createMockIo() {
  const namespace: MockNamespace = {
    use: vi.fn(),
    on: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    adapter: { rooms: new Map() },
    sockets: new Map(),
  };
  const io = {
    of: vi.fn().mockReturnValue(namespace),
  };
  return { io, namespace };
}

// ---------- helpers for mocking Knex ----------

function createMockDb(projectRows: Record<string, { org_id: string }>, annotationRows: Record<string, { org_id: string }>) {
  return vi.fn((table: string) => ({
    where: vi.fn((filter: Record<string, string>) => ({
      first: vi.fn(() => {
        if (table === 'projects') {
          const row = projectRows[filter.id];
          if (row && row.org_id === filter.org_id) return Promise.resolve({ id: filter.id });
          return Promise.resolve(undefined);
        }
        if (table === 'annotations') {
          const row = annotationRows[filter.id];
          if (row && row.org_id === filter.org_id) return Promise.resolve({ id: filter.id });
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      }),
    })),
  })) as unknown as import('knex').Knex;
}

// ---------- test suite ----------

describe('collab.gateway — join authorization', () => {
  const ORG_ID = 'org-owner';
  const OTHER_ORG_ID = 'org-attacker';
  const PROJECT_ID = 'proj-1';
  const ANNOTATION_ID = 'ann-1';

  let mockDb: ReturnType<typeof createMockDb>;
  let deps: CollabGatewayDeps;
  let connectionHandler: (socket: MockSocket) => void;
  let authMiddleware: (socket: MockSocket, next: (err?: Error) => void) => void;

  beforeEach(() => {
    mockDb = createMockDb(
      { [PROJECT_ID]: { org_id: ORG_ID } },
      { [ANNOTATION_ID]: { org_id: ORG_ID } },
    );

    const tokenIssuer = {
      verify: vi.fn().mockReturnValue({
        userId: 'user-1',
        email: 'user@test.com',
        orgId: ORG_ID,
        role: 'owner',
        tokenVersion: 0,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      sign: vi.fn(),
      decodeIgnoreExpiration: vi.fn(),
      graceWindowSeconds: 604800,
    };

    deps = { tokenIssuer, db: mockDb };

    const { io, namespace } = createMockIo();
    installCollabGateway(io as never, deps);

    // Capture middleware and connection handler registered on the namespace.
    authMiddleware = namespace.use.mock.calls[0][0];
    connectionHandler = namespace.on.mock.calls[0][1];
  });

  /** Simulate authenticating a socket and triggering the connection handler. */
  function connectSocket(socket: MockSocket, orgId: string) {
    // Override tokenIssuer to return the specified orgId.
    (deps.tokenIssuer.verify as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: socket.id,
      email: 'user@test.com',
      orgId,
      role: 'member',
      tokenVersion: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // Run auth middleware to attach user to socket.
    authMiddleware(socket, () => {});
    // Trigger connection handler.
    connectionHandler(socket);
  }

  /** Extract a registered socket.on handler by event name. */
  function getHandler(socket: MockSocket, event: string): (...args: unknown[]) => unknown {
    const call = socket.on.mock.calls.find(
      (c: unknown[]) => c[0] === event,
    );
    if (!call) throw new Error(`No handler registered for event '${event}'`);
    return call[1] as (...args: unknown[]) => unknown;
  }

  describe('join event', () => {
    it('allows join when user org owns the project', async () => {
      const socket = createMockSocket('socket-owner');
      connectSocket(socket, ORG_ID);

      const joinHandler = getHandler(socket, 'join');
      await joinHandler({ projectId: PROJECT_ID });

      expect(socket.join).toHaveBeenCalledWith(`project:${PROJECT_ID}`);
      expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('rejects join and emits error when user org does NOT own the project (cross-tenant)', async () => {
      const socket = createMockSocket('socket-attacker');
      connectSocket(socket, OTHER_ORG_ID);

      const joinHandler = getHandler(socket, 'join');
      await joinHandler({ projectId: PROJECT_ID });

      expect(socket.join).not.toHaveBeenCalledWith(`project:${PROJECT_ID}`);
      expect(socket.emit).toHaveBeenCalledWith('error', {
        code: 'PROJECT_NOT_FOUND',
        message: 'Not found or access denied',
      });
    });

    it('rejects join for a non-existent project', async () => {
      const socket = createMockSocket('socket-missing');
      connectSocket(socket, ORG_ID);

      const joinHandler = getHandler(socket, 'join');
      await joinHandler({ projectId: 'non-existent-project' });

      expect(socket.join).not.toHaveBeenCalledWith('project:non-existent-project');
      expect(socket.emit).toHaveBeenCalledWith('error', {
        code: 'PROJECT_NOT_FOUND',
        message: 'Not found or access denied',
      });
    });

    it('silently returns for invalid input (no projectId)', async () => {
      const socket = createMockSocket('socket-invalid');
      connectSocket(socket, ORG_ID);

      // Clear the auto-join call (user:<id> room) so we can assert only on join handler calls.
      socket.join.mockClear();

      const joinHandler = getHandler(socket, 'join');
      await joinHandler({});
      await joinHandler(null);
      await joinHandler({ projectId: 123 });

      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });
  });

  describe('annotation:open event', () => {
    it('allows annotation:open when user org owns the annotation', async () => {
      const socket = createMockSocket('socket-owner');
      connectSocket(socket, ORG_ID);

      const handler = getHandler(socket, 'annotation:open');
      await handler({ id: ANNOTATION_ID });

      expect(socket.join).toHaveBeenCalledWith(`annotation:${ANNOTATION_ID}`);
      expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('rejects annotation:open when user org does NOT own the annotation (cross-tenant)', async () => {
      const socket = createMockSocket('socket-attacker');
      connectSocket(socket, OTHER_ORG_ID);

      const handler = getHandler(socket, 'annotation:open');
      await handler({ id: ANNOTATION_ID });

      expect(socket.join).not.toHaveBeenCalledWith(`annotation:${ANNOTATION_ID}`);
      expect(socket.emit).toHaveBeenCalledWith('error', {
        code: 'ANNOTATION_NOT_FOUND',
        message: 'Not found or access denied',
      });
    });

    it('rejects annotation:open for a non-existent annotation', async () => {
      const socket = createMockSocket('socket-missing');
      connectSocket(socket, ORG_ID);

      const handler = getHandler(socket, 'annotation:open');
      await handler({ id: 'non-existent-annotation' });

      expect(socket.join).not.toHaveBeenCalledWith('annotation:non-existent-annotation');
      expect(socket.emit).toHaveBeenCalledWith('error', {
        code: 'ANNOTATION_NOT_FOUND',
        message: 'Not found or access denied',
      });
    });
  });

  describe('auth middleware', () => {
    it('attaches orgId to socket.user from the verified token', () => {
      const socket = createMockSocket('socket-auth');
      connectSocket(socket, ORG_ID);

      // The socket should have `user` attached with orgId
      expect((socket as any).user).toEqual({
        userId: 'socket-auth',
        email: 'user@test.com',
        orgId: ORG_ID,
      });
    });
  });
});
