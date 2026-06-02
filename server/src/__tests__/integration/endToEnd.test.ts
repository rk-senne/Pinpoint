// ============================================================
// Integration Test: Annotation creation → WebSocket broadcast
// Validates: Requirements 6.1, 6.2
// ============================================================
//
// Rewired in the legacy-cleanup wave to drive the hex composition:
//
//   - The Socket.IO `Server` is constructed explicitly here (the
//     legacy `setupWebSocket(httpServer)` helper is going away).
//   - The inbound `installCollabGateway` registers the `/collab`
//     namespace, JWT-authenticated via the injected `tokenIssuer`.
//   - REST-side broadcasts now go through the outbound
//     `SocketIoEventBus.emit({ type, room, payload })` adapter,
//     replacing `broadcastToProject(projectId, event, data)`.
//   - Tokens are minted through `JwtTokenIssuer.sign({ userId, email })`
//     instead of importing `jsonwebtoken` directly.
//
// The behavioural assertions are unchanged: same project → both
// members see the broadcast, different project → no leak, status and
// comment events ride the same room.

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIoServer } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import {
  installCollabGateway,
} from '../../adapters/inbound/websocket/collab.gateway.js';
import {
  JwtTokenIssuer,
} from '../../adapters/outbound/jwt/JwtTokenIssuer.js';
import {
  SocketIoEventBus,
} from '../../adapters/outbound/socket/SocketIoEventBus.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

describe('Integration: Annotation creation → WebSocket broadcast → real-time rendering', () => {
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: SocketIoServer;
  let port: number;
  let tokenIssuer: JwtTokenIssuer;
  let eventBus: SocketIoEventBus;
  const clients: ClientSocket[] = [];

  function makeToken(userId: string, email = 'test@test.com'): string {
    return tokenIssuer.sign({ userId, email, orgId: 'org-test', role: 'owner', tokenVersion: 0 });
  }

  function connectClient(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = ioc(`http://localhost:${port}/collab`, {
        auth: { token },
        transports: ['websocket'],
        forceNew: true,
      });
      clients.push(client);
      client.on('connect', () => resolve(client));
      client.on('connect_error', (err) => reject(err));
    });
  }

  beforeAll(async () => {
    const app = express();
    httpServer = createServer(app);

    // Build the hex composition explicitly: Socket.IO server + outbound
    // event bus + inbound collab gateway authenticated by a fresh
    // `JwtTokenIssuer`. CORS uses the same config the production socket
    // setup uses so the dashboard's reconnect logic works against this
    // test.
    ioServer = new SocketIoServer(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        credentials: true,
      },
    });

    tokenIssuer = new JwtTokenIssuer({
      secret: JWT_SECRET,
      accessTtl: '1h',
    });

    eventBus = new SocketIoEventBus(ioServer);

    installCollabGateway(ioServer, { tokenIssuer });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(() => {
    for (const c of clients) {
      if (c.connected) c.disconnect();
    }
    clients.length = 0;
  });

  afterAll(() => {
    ioServer.close();
    httpServer.close();
  });

  it('broadcasts new annotation to all connected members in the same project room', async () => {
    const projectId = 'integration-proj-1';
    const memberA = await connectClient(makeToken('user-a'));
    const memberB = await connectClient(makeToken('user-b'));

    // Both join the same project room
    await new Promise<void>((resolve) => {
      let joined = 0;
      const onPresence = () => { joined++; if (joined >= 2) resolve(); };
      memberA.on('presence:update', onPresence);
      memberB.on('presence:update', onPresence);
      memberA.emit('join', { projectId });
      memberB.emit('join', { projectId });
    });
    memberA.removeAllListeners('presence:update');
    memberB.removeAllListeners('presence:update');

    // Simulate annotation creation (as would happen from REST handler)
    const newAnnotation = {
      id: 'ann-integration-1',
      projectId,
      pageUrl: 'https://example.com',
      type: 'note',
      severity: 'critical',
      status: 'active',
      body: 'Found a bug on the login page',
      authorId: 'user-a',
      target: {
        cssSelector: 'div.login > form',
        xpath: '/html/body/div/form',
        pageX: 100,
        pageY: 200,
        tagName: 'FORM',
        textSnippet: 'Login form',
      },
      browserMeta: {
        userAgent: 'Mozilla/5.0',
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 2,
      },
      pinNumber: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const receivedByA = new Promise<any>((resolve) => {
      memberA.on('annotation:created', (data) => resolve(data));
    });
    const receivedByB = new Promise<any>((resolve) => {
      memberB.on('annotation:created', (data) => resolve(data));
    });

    // Broadcast (simulating what the REST handler does after DB insert).
    // The hex idiom: emit a `DomainEvent` with an explicit `room` field
    // so the bus targets `project:<id>` inside the `/collab` namespace.
    eventBus.emit({
      type: 'annotation:created',
      room: `project:${projectId}`,
      payload: newAnnotation,
    });

    const [dataA, dataB] = await Promise.all([receivedByA, receivedByB]);

    // Both members receive the annotation with all fields intact
    expect(dataA.id).toBe('ann-integration-1');
    expect(dataA.body).toBe('Found a bug on the login page');
    expect(dataA.severity).toBe('critical');
    expect(dataA.target.cssSelector).toBe('div.login > form');
    expect(dataA.pinNumber).toBe(1);

    expect(dataB.id).toBe('ann-integration-1');
    expect(dataB.body).toBe('Found a bug on the login page');
  });

  it('does not broadcast annotation to members in a different project room', async () => {
    const memberA = await connectClient(makeToken('user-a'));
    const memberC = await connectClient(makeToken('user-c'));

    // A joins project-1, C joins project-2
    await new Promise<void>((resolve) => {
      memberA.on('presence:update', () => resolve());
      memberA.emit('join', { projectId: 'project-1' });
    });
    await new Promise<void>((resolve) => {
      memberC.on('presence:update', () => resolve());
      memberC.emit('join', { projectId: 'project-2' });
    });
    memberA.removeAllListeners('presence:update');
    memberC.removeAllListeners('presence:update');

    let memberCReceived = false;
    memberC.on('annotation:created', () => { memberCReceived = true; });

    eventBus.emit({
      type: 'annotation:created',
      room: 'project:project-1',
      payload: { id: 'ann-x', body: 'test' },
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(memberCReceived).toBe(false);
  });

  it('broadcasts status changes to all room members', async () => {
    const projectId = 'integration-status-proj';
    const memberA = await connectClient(makeToken('user-a'));
    const memberB = await connectClient(makeToken('user-b'));

    await new Promise<void>((resolve) => {
      let joined = 0;
      const onPresence = () => { joined++; if (joined >= 2) resolve(); };
      memberA.on('presence:update', onPresence);
      memberB.on('presence:update', onPresence);
      memberA.emit('join', { projectId });
      memberB.emit('join', { projectId });
    });
    memberA.removeAllListeners('presence:update');
    memberB.removeAllListeners('presence:update');

    const statusPromise = new Promise<any>((resolve) => {
      memberB.on('annotation:status', (data) => resolve(data));
    });

    eventBus.emit({
      type: 'annotation:status',
      room: `project:${projectId}`,
      payload: { id: 'ann-1', status: 'resolved' },
    });

    const statusData = await statusPromise;
    expect(statusData.id).toBe('ann-1');
    expect(statusData.status).toBe('resolved');
  });

  it('broadcasts comment creation to room members', async () => {
    const projectId = 'integration-comment-proj';
    const memberA = await connectClient(makeToken('user-a'));
    const memberB = await connectClient(makeToken('user-b'));

    await new Promise<void>((resolve) => {
      let joined = 0;
      const onPresence = () => { joined++; if (joined >= 2) resolve(); };
      memberA.on('presence:update', onPresence);
      memberB.on('presence:update', onPresence);
      memberA.emit('join', { projectId });
      memberB.emit('join', { projectId });
    });
    memberA.removeAllListeners('presence:update');
    memberB.removeAllListeners('presence:update');

    const commentData = {
      id: 'cmt-integration-1',
      annotationId: 'ann-1',
      authorId: 'user-a',
      body: 'This needs fixing @user-b',
      mentions: ['user-b'],
      createdAt: new Date().toISOString(),
    };

    const receivedPromise = new Promise<any>((resolve) => {
      memberB.on('comment:created', (data) => resolve(data));
    });

    eventBus.emit({
      type: 'comment:created',
      room: `project:${projectId}`,
      payload: commentData,
    });

    const received = await receivedPromise;
    expect(received.id).toBe('cmt-integration-1');
    expect(received.body).toContain('@user-b');
    expect(received.mentions).toContain('user-b');
  });
});
