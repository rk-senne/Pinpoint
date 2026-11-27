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

interface MockDbState {
  projects: Record<string, { org_id: string; owner_id?: string | null; team_id?: string | null }>;
  annotations: Record<string, { org_id: string; project_id: string }>;
  /** `${teamId}:${userId}` pairs that are team members. */
  teamMembers: Set<string>;
  /** Current server-side session state per user (token_version + org role). */
  users: Record<string, { token_version: number; name: string; role: string | null }>;
}

/**
 * Table-aware Knex stand-in. Supports exactly the query shapes the gateway
 * and `access.ts` issue: `users as u` (leftJoin/where/first), and
 * `<table>.where(filter).first(...)`.
 */
function createMockDb(state: MockDbState) {
  return vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    let filter: Record<string, string> | string | undefined;
    let value: string | undefined;
    const chain = () => builder;
    builder.leftJoin = vi.fn(chain);
    builder.where = vi.fn((f: Record<string, string> | string, v?: string) => {
      filter = f;
      value = v;
      return builder;
    });
    builder.first = vi.fn(() => {
      if (table === 'users as u') return Promise.resolve(state.users[value as string]);
      const f = filter as Record<string, string>;
      if (table === 'projects') {
        const row = state.projects[f.id];
        return Promise.resolve(row && row.org_id === f.org_id ? { id: f.id, ...row } : undefined);
      }
      if (table === 'annotations') {
        const row = state.annotations[f.id];
        return Promise.resolve(row && row.org_id === f.org_id ? { id: f.id, ...row } : undefined);
      }
      if (table === 'team_members') {
        return Promise.resolve(state.teamMembers.has(`${f.team_id}:${f.user_id}`) ? { user_id: f.user_id } : undefined);
      }
      return Promise.resolve(undefined);
    });
    return builder;
  }) as unknown as import('knex').Knex;
}

// ---------- test suite ----------

describe('collab.gateway — join authorization', () => {
  const ORG_ID = 'org-owner';
  const OTHER_ORG_ID = 'org-attacker';
  const PROJECT_ID = 'proj-1';
  const ANNOTATION_ID = 'ann-1';

  let state: MockDbState;
  let mockDb: ReturnType<typeof createMockDb>;
  let deps: CollabGatewayDeps;
  let connectionHandler: (socket: MockSocket) => void;
  let authMiddleware: (socket: MockSocket, next: (err?: Error) => void) => void | Promise<void>;

  beforeEach(() => {
    // `socket-owner` owns PROJECT_ID; every test user has a live membership
    // (token_version 0) so the handshake passes unless a test revokes it.
    state = {
      projects: { [PROJECT_ID]: { org_id: ORG_ID, owner_id: 'socket-owner', team_id: 'team-1' } },
      annotations: { [ANNOTATION_ID]: { org_id: ORG_ID, project_id: PROJECT_ID } },
      teamMembers: new Set(['team-1:socket-teammate']),
      users: {},
    };
    for (const id of ['socket-owner', 'socket-attacker', 'socket-missing', 'socket-invalid', 'socket-auth', 'socket-teammate', 'socket-other-member']) {
      state.users[id] = { token_version: 0, name: `Name ${id}`, role: 'member' };
    }
    mockDb = createMockDb(state);

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
  async function connectSocket(socket: MockSocket, orgId: string, tokenVersion = 0): Promise<Error | undefined> {
    // Override tokenIssuer to return the specified orgId.
    (deps.tokenIssuer.verify as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: socket.id,
      email: 'user@test.com',
      orgId,
      role: 'member',
      tokenVersion,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // Run auth middleware (async: it validates token_version + membership).
    let failure: Error | undefined;
    await authMiddleware(socket, (err) => { failure = err; });
    // Only a socket that passed the handshake reaches the connection handler.
    if (!failure) connectionHandler(socket);
    return failure;
  }

  /** Extract a registered socket.on handler by event name. */
  function getHandler(socket: MockSocket, event: string): (...args: unknown[]) => unknown {
    const call = socket.on.mock.calls.find(
      (c: unknown[]) => c[0] === event,
    );
    if (!call) throw new Error(`No handler registered for event '${event}'`);
    return call[1] as (...args: unknown[]) => unknown;
  }

  describe('personal / org rooms (PP-01)', () => {
    it('puts every authenticated socket in user:<id> and org:<orgId> — and nothing broader', async () => {
      const socket = createMockSocket('socket-auth');
      await connectSocket(socket, ORG_ID);
      const joined = socket.join.mock.calls.map((c: unknown[]) => c[0]);
      expect(joined).toContain('user:socket-auth');
      expect(joined).toContain(`org:${ORG_ID}`);
      expect(joined.every((r: unknown) => /^(user|org):/.test(String(r)))).toBe(true);
    });

    it('re-checks the session on every project join, so a revoked user cannot re-join (PP-02)', async () => {
      const socket = createMockSocket('socket-other-member');
      await connectSocket(socket, ORG_ID, 0);
      state.users['socket-other-member']!.token_version = 5; // bumped after the handshake (removal / logout)
      await getHandler(socket, 'join')({ projectId: PROJECT_ID });
      expect(socket.join).not.toHaveBeenCalledWith(`project:${PROJECT_ID}`);
    });
  });

  describe('join event', () => {
    it('allows join when the user owns the project', async () => {
      const socket = createMockSocket('socket-owner');
      await connectSocket(socket, ORG_ID);

      const joinHandler = getHandler(socket, 'join');
      await joinHandler({ projectId: PROJECT_ID });

      expect(socket.join).toHaveBeenCalledWith(`project:${PROJECT_ID}`);
      expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('rejects join and emits error when user org does NOT own the project (cross-tenant)', async () => {
      const socket = createMockSocket('socket-attacker');
      await connectSocket(socket, OTHER_ORG_ID);

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
      await connectSocket(socket, ORG_ID);

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
      await connectSocket(socket, ORG_ID);

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
      await connectSocket(socket, ORG_ID);

      const handler = getHandler(socket, 'annotation:open');
      await handler({ id: ANNOTATION_ID });

      expect(socket.join).toHaveBeenCalledWith(`annotation:${ANNOTATION_ID}`);
      expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('rejects annotation:open when user org does NOT own the annotation (cross-tenant)', async () => {
      const socket = createMockSocket('socket-attacker');
      await connectSocket(socket, OTHER_ORG_ID);

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
      await connectSocket(socket, ORG_ID);

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
    it('attaches orgId and display name (not email) to socket.user from the verified token', async () => {
      const socket = createMockSocket('socket-auth');
      await connectSocket(socket, ORG_ID);

      // The socket should have `user` attached with orgId
      expect((socket as any).user).toMatchObject({
        userId: 'socket-auth',
        orgId: ORG_ID,
        name: 'Name socket-auth',
      });
    });
  });

  describe('project access (F-10) and session validity (F-06)', () => {
    it('rejects a join from an org member who is neither owner nor team member of the project', async () => {
      const socket = createMockSocket('socket-other-member');
      await connectSocket(socket, ORG_ID);

      await getHandler(socket, 'join')({ projectId: PROJECT_ID });

      expect(socket.join).not.toHaveBeenCalledWith(`project:${PROJECT_ID}`);
      expect(socket.emit).toHaveBeenCalledWith('error', { code: 'PROJECT_NOT_FOUND', message: 'Not found or access denied' });
    });

    it('allows a join from a member of the project team', async () => {
      const socket = createMockSocket('socket-teammate');
      await connectSocket(socket, ORG_ID);

      await getHandler(socket, 'join')({ projectId: PROJECT_ID });

      expect(socket.join).toHaveBeenCalledWith(`project:${PROJECT_ID}`);
    });

    it('rejects annotation:open when the user cannot access the annotation\'s project', async () => {
      const socket = createMockSocket('socket-other-member');
      await connectSocket(socket, ORG_ID);

      await getHandler(socket, 'annotation:open')({ id: ANNOTATION_ID });

      expect(socket.join).not.toHaveBeenCalledWith(`annotation:${ANNOTATION_ID}`);
      expect(socket.emit).toHaveBeenCalledWith('error', { code: 'ANNOTATION_NOT_FOUND', message: 'Not found or access denied' });
    });

    it('rejects the handshake when the token_version is stale (logout / revoke-sessions)', async () => {
      state.users['socket-owner']!.token_version = 3;
      const socket = createMockSocket('socket-owner');

      const failure = await connectSocket(socket, ORG_ID, 2);

      expect(failure?.message).toBe('Invalid or expired token');
      expect((socket as any).user).toBeUndefined();
    });

    it('rejects the handshake for a user removed from the org (no membership)', async () => {
      state.users['socket-owner']!.role = null;
      const socket = createMockSocket('socket-owner');

      const failure = await connectSocket(socket, ORG_ID);

      expect(failure?.message).toBe('Invalid or expired token');
    });

    it('rejects a room join on a socket opened before the user was removed', async () => {
      const socket = createMockSocket('socket-owner');
      await connectSocket(socket, ORG_ID); // handshake OK
      state.users['socket-owner']!.role = null; // removed afterwards

      await getHandler(socket, 'join')({ projectId: PROJECT_ID });

      expect(socket.join).not.toHaveBeenCalledWith(`project:${PROJECT_ID}`);
      expect(socket.emit).toHaveBeenCalledWith('error', { code: 'PROJECT_NOT_FOUND', message: 'Not found or access denied' });
    });

    it('cursor relay sends userId + display name and never the email', async () => {
      const socket = createMockSocket('socket-owner') as MockSocket & { to: ReturnType<typeof vi.fn> };
      const emit = vi.fn();
      socket.to = vi.fn().mockReturnValue({ emit });
      socket.rooms = new Set(['socket-owner', `project:${PROJECT_ID}`]);
      await connectSocket(socket, ORG_ID);

      getHandler(socket, 'cursor:move')({ x: 1, y: 2, pageUrl: 'https://x.test' });

      expect(emit).toHaveBeenCalledWith('cursor:move', {
        userId: 'socket-owner',
        name: 'Name socket-owner',
        x: 1,
        y: 2,
        pageUrl: 'https://x.test',
      });
      expect(JSON.stringify(emit.mock.calls)).not.toContain('@');
    });
  });
});
