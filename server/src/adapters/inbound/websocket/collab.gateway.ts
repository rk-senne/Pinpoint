// Inbound WebSocket gateway for the `/collab` namespace
// (Phase 1.5 / task 4.9.2).
//
// This module is the inbound counterpart to
// `adapters/outbound/socket/SocketIoEventBus.ts`: it owns the
// **client → server** side of the Socket.IO conversation. Use cases
// reach back to clients exclusively through `EventBus`, never by
// importing the gateway directly.
//
// Responsibilities:
//   - Authenticate every handshake by verifying the bearer JWT through
//     the `TokenIssuer` port (Req 18.6 / 33.3). Failures disconnect.
//   - Maintain project-room presence (`presence:update`) so clients
//     learn when a teammate joins or leaves the active project.
//   - Maintain annotation-room co-viewer presence
//     (`annotation:viewers`) so reply threads can highlight peers
//     looking at the same annotation.
//
// The gateway is the only file under `adapters/inbound/websocket/`
// that imports from `socket.io`; that's intentional and matches the
// hexagonal layering rules enforced in `.eslintrc.cjs`.

import type { Namespace, Server, Socket } from 'socket.io';
import type { Knex } from 'knex';

import type { TokenIssuer, VerifiedToken } from '../../../domain/auth/ports/TokenIssuer.js';
import { checkSession } from '../http/auth.middleware.js';
import { canAccessProject, findAccessibleAnnotation } from '../http/access.js';

/**
 * Dependencies the gateway needs from the composition root.
 *
 * - `tokenIssuer` — verifies the JWT on the handshake.
 * - `db` — used to authorize room joins by verifying org ownership.
 */
export interface CollabGatewayDeps {
  readonly tokenIssuer: TokenIssuer;
  readonly db: Knex;
  /**
   * Exact origins (the dashboard) from which the HttpOnly `fl_session`
   * cookie is accepted as handshake credentials. Empty = cookie auth off.
   */
  readonly trustedCookieOrigins?: readonly string[];
}

/** Value of one cookie from a raw `Cookie` header, or null. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim()) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Shape of the user info we attach to each authenticated socket. */
interface SocketUser {
  readonly userId: string;
  readonly email: string;
  readonly orgId: string;
  /** Display name shown to peers (cursor relay). Never the email. */
  readonly name: string;
  /** Token claims re-validated against the DB on every room join. */
  readonly token: VerifiedToken;
}

/**
 * Minimal extension of `Socket` that exposes the authenticated user
 * payload set by the auth middleware. We avoid declaration merging so
 * other adapters can't accidentally rely on the property.
 */
type AuthenticatedSocket = Socket & { user?: SocketUser };

function getRoomId(projectId: string): string {
  return `project:${projectId}`;
}

function getAnnotationRoomId(annotationId: string): string {
  return `annotation:${annotationId}`;
}

/**
 * Install the `/collab` namespace on the given Socket.IO server.
 *
 * The function returns `void` because the namespace and any per-socket
 * state are owned by the Socket.IO server's lifetime; tearing the
 * gateway down means tearing down the server itself.
 */
export function installCollabGateway(
  io: Server,
  deps: CollabGatewayDeps,
): void {
  const { tokenIssuer, db } = deps;
  const trustedCookieOrigins = deps.trustedCookieOrigins ?? [];

  const collabNamespace: Namespace = io.of('/collab');

  // Track online users per project room: roomId -> Set<userId>.
  const roomPresence = new Map<string, Set<string>>();

  // Track co-viewers per annotation: annotationId -> Set<userId>.
  const annotationViewers = new Map<string, Set<string>>();

  /**
   * Compute the current user list for an annotation, broadcast it to
   * the annotation room, and clean up the entry once it empties out.
   */
  const broadcastAnnotationViewers = (annotationId: string): void => {
    const set = annotationViewers.get(annotationId);
    const userIds = set ? Array.from(set) : [];
    collabNamespace
      .to(getAnnotationRoomId(annotationId))
      .emit('annotation:viewers', { id: annotationId, userIds });
    if (set && set.size === 0) {
      annotationViewers.delete(annotationId);
    }
  };

  /**
   * Determine whether the given user still has another socket present
   * in the annotation's room (e.g. a second tab). Used to decide
   * whether to remove the user from the viewer set when one of their
   * sockets leaves or disconnects.
   */
  const userHasOtherSocketInAnnotationRoom = (
    annotationId: string,
    userId: string,
    excludeSocketId: string,
  ): boolean => {
    const room = collabNamespace.adapter.rooms.get(
      getAnnotationRoomId(annotationId),
    );
    if (!room) return false;
    for (const sid of room) {
      if (sid === excludeSocketId) continue;
      const peer = collabNamespace.sockets.get(sid) as
        | AuthenticatedSocket
        | undefined;
      if (peer?.user?.userId === userId) return true;
    }
    return false;
  };

  // --- Authentication middleware --------------------------------------------
  // Verifies a JWT through the `TokenIssuer` port. Sources, in order:
  //   1. `socket.handshake.auth.token` — extension + freshly-logged-in tab.
  //   2. The HttpOnly `fl_session` cookie — a hard-refreshed dashboard tab,
  //      whose in-memory bearer is gone. ONLY accepted when the handshake
  //      Origin is the configured dashboard origin: a WebSocket upgrade
  //      carries cookies but is not covered by CORS, so without this check
  //      any site could open an authenticated socket as the victim (CSWSH).
  // The error messages map to the failure modes the dashboard's reconnect
  // logic recognises.
  collabNamespace.use(async (socket: Socket, next) => {
    let token: unknown = socket.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      const origin = socket.handshake.headers.origin;
      const cookieOk =
        typeof origin === 'string' && trustedCookieOrigins.length > 0 && trustedCookieOrigins.includes(origin);
      token = cookieOk ? (readCookie(socket.handshake.headers.cookie, '__Host-fl_session') ??
          readCookie(socket.handshake.headers.cookie, 'fl_session')) : null;
    }
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication required'));
    }
    let payload: VerifiedToken;
    try {
      payload = tokenIssuer.verify(token);
    } catch {
      return next(new Error('Invalid or expired token'));
    }
    // A valid signature is not enough: the session must still be current
    // (token_version not bumped) and the user still a member of the org.
    try {
      const session = await checkSession(db, payload);
      if (!session.ok) return next(new Error('Invalid or expired token'));
      (socket as AuthenticatedSocket).user = {
        userId: payload.userId,
        email: payload.email,
        orgId: payload.orgId,
        name: session.name ?? 'Teammate',
        token: payload,
      };
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  // --- Per-connection event handlers ---------------------------------------
  collabNamespace.on('connection', (socket: Socket) => {
    const authed = socket as AuthenticatedSocket;
    const user = authed.user;
    if (!user) {
      // Defensive: the auth middleware should have rejected the
      // handshake. If the user payload is missing for any reason,
      // disconnect rather than allow an unauthenticated socket to
      // participate in presence.
      socket.disconnect(true);
      return;
    }

    // Auto-join the user's personal room for notification delivery.
    socket.join(`user:${user.userId}`);
    // Org-wide room (PP-01) for org-scoped events such as invitations.
    socket.join(`org:${user.orgId}`);

    // Track annotations this socket has opened so we can clean them up
    // on disconnect.
    const openAnnotations = new Set<string>();

    // --- join event ---
    socket.on('join', async (data: { projectId: string }) => {
      if (!data?.projectId || typeof data.projectId !== 'string') return;

      // Authorize with the same rule as the HTTP routes: org match AND
      // project owner / team member. The session is re-validated too, so a
      // socket opened before the user was removed from the org can't keep
      // joining rooms.
      let allowed = false;
      try {
        const session = await checkSession(db, user.token);
        allowed = session.ok && (await canAccessProject(db, user, data.projectId));
      } catch {
        allowed = false;
      }
      if (!allowed) {
        socket.emit('error', { code: 'PROJECT_NOT_FOUND', message: 'Not found or access denied' });
        return;
      }

      const room = getRoomId(data.projectId);
      socket.join(room);

      if (!roomPresence.has(room)) {
        roomPresence.set(room, new Set());
      }
      roomPresence.get(room)!.add(user.userId);

      collabNamespace.to(room).emit('presence:update', {
        userId: user.userId,
        online: true,
      });
    });

    // --- leave event ---
    socket.on('leave', (data: { projectId: string }) => {
      if (!data?.projectId || typeof data.projectId !== 'string') return;

      const room = getRoomId(data.projectId);
      socket.leave(room);

      const roomSockets = collabNamespace.adapter.rooms.get(room);
      const userStillInRoom = roomSockets
        ? Array.from(roomSockets).some((sid) => {
            const peer = collabNamespace.sockets.get(sid) as
              | AuthenticatedSocket
              | undefined;
            return (
              peer?.user?.userId === user.userId && peer.id !== socket.id
            );
          })
        : false;

      if (!userStillInRoom) {
        roomPresence.get(room)?.delete(user.userId);
        if (roomPresence.get(room)?.size === 0) {
          roomPresence.delete(room);
        }
        collabNamespace.to(room).emit('presence:update', {
          userId: user.userId,
          online: false,
        });
      }
    });

    // --- annotation:open event (co-viewer presence) ---
    socket.on('annotation:open', async (data: { id: string }) => {
      if (!data?.id || typeof data.id !== 'string') return;
      const annotationId = data.id;

      // Authorize: annotation in the user's org AND its project accessible.
      let annotation: unknown = null;
      try {
        const session = await checkSession(db, user.token);
        annotation = session.ok ? await findAccessibleAnnotation(db, user, annotationId) : null;
      } catch {
        annotation = null;
      }
      if (!annotation) {
        socket.emit('error', { code: 'ANNOTATION_NOT_FOUND', message: 'Not found or access denied' });
        return;
      }

      socket.join(getAnnotationRoomId(annotationId));
      openAnnotations.add(annotationId);

      if (!annotationViewers.has(annotationId)) {
        annotationViewers.set(annotationId, new Set());
      }
      annotationViewers.get(annotationId)!.add(user.userId);

      broadcastAnnotationViewers(annotationId);
    });

    // --- cursor:move event (live cursor relay) ---
    socket.on('cursor:move', (data: { x: number; y: number; pageUrl: string }) => {
      if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;
      // Broadcast to all project rooms this socket is in (excluding sender)
      for (const room of socket.rooms) {
        if (room.startsWith('project:')) {
          socket.to(room).emit('cursor:move', {
            userId: user.userId,
            name: user.name,
            x: data.x,
            y: data.y,
            pageUrl: data.pageUrl ?? '',
          });
        }
      }
    });

    // --- annotation:close event (co-viewer presence) ---
    socket.on('annotation:close', (data: { id: string }) => {
      if (!data?.id || typeof data.id !== 'string') return;
      const annotationId = data.id;

      socket.leave(getAnnotationRoomId(annotationId));
      openAnnotations.delete(annotationId);

      // Only remove the user from the viewer set if no other socket of
      // theirs still has the annotation open in this namespace.
      if (
        !userHasOtherSocketInAnnotationRoom(
          annotationId,
          user.userId,
          socket.id,
        )
      ) {
        annotationViewers.get(annotationId)?.delete(user.userId);
      }

      broadcastAnnotationViewers(annotationId);
    });

    // --- disconnect event ---
    socket.on('disconnect', () => {
      // Broadcast cursor:leave to all project rooms this socket was in.
      for (const room of socket.rooms) {
        if (room.startsWith('project:')) {
          socket.to(room).emit('cursor:leave', { userId: user.userId });
        }
      }

      // Clean up co-viewer presence for any annotations this socket had
      // open.
      for (const annotationId of openAnnotations) {
        if (
          !userHasOtherSocketInAnnotationRoom(
            annotationId,
            user.userId,
            socket.id,
          )
        ) {
          annotationViewers.get(annotationId)?.delete(user.userId);
        }
        broadcastAnnotationViewers(annotationId);
      }
      openAnnotations.clear();

      // Clean up project-room presence from all rooms this socket was
      // in.
      for (const [room, users] of roomPresence.entries()) {
        if (users.has(user.userId)) {
          const roomSockets = collabNamespace.adapter.rooms.get(room);
          const userStillInRoom = roomSockets
            ? Array.from(roomSockets).some((sid) => {
                const peer = collabNamespace.sockets.get(sid) as
                  | AuthenticatedSocket
                  | undefined;
                return peer?.user?.userId === user.userId;
              })
            : false;

          if (!userStillInRoom) {
            users.delete(user.userId);
            if (users.size === 0) {
              roomPresence.delete(room);
            }
            collabNamespace.to(room).emit('presence:update', {
              userId: user.userId,
              online: false,
            });
          }
        }
      }
    });
  });
}
