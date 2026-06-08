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

import type { TokenIssuer } from '../../../domain/auth/ports/TokenIssuer.js';

/**
 * Dependencies the gateway needs from the composition root. Today only
 * the `TokenIssuer` port is required; future presence/typing use cases
 * would be wired in here so the gateway can stay free of business
 * logic.
 */
export interface CollabGatewayDeps {
  readonly tokenIssuer: TokenIssuer;
}

/** Shape of the user info we attach to each authenticated socket. */
interface SocketUser {
  readonly userId: string;
  readonly email: string;
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
  const { tokenIssuer } = deps;

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
  // Verifies the JWT supplied via `socket.handshake.auth.token` through
  // the `TokenIssuer` port. The error messages map to the failure modes
  // the dashboard's reconnect logic recognises.
  collabNamespace.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = tokenIssuer.verify(token);
      (socket as AuthenticatedSocket).user = {
        userId: payload.userId,
        email: payload.email,
      };
      next();
    } catch {
      next(new Error('Invalid or expired token'));
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

    // Track annotations this socket has opened so we can clean them up
    // on disconnect.
    const openAnnotations = new Set<string>();

    // --- join event ---
    socket.on('join', (data: { projectId: string }) => {
      if (!data?.projectId || typeof data.projectId !== 'string') return;

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
    socket.on('annotation:open', (data: { id: string }) => {
      if (!data?.id || typeof data.id !== 'string') return;
      const annotationId = data.id;

      socket.join(getAnnotationRoomId(annotationId));
      openAnnotations.add(annotationId);

      if (!annotationViewers.has(annotationId)) {
        annotationViewers.set(annotationId, new Set());
      }
      annotationViewers.get(annotationId)!.add(user.userId);

      broadcastAnnotationViewers(annotationId);
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
