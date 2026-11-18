// SocketIoEventBus — outbound adapter for the `EventBus` port
// (Phase 1.5 / task 4.8.4).
//
// Use cases publish `DomainEvent`s and never know how those events
// reach connected clients. This adapter is the **only** place in the
// codebase that imports `socket.io`; it translates the domain event
// shape into the corresponding Socket.IO emit, optionally scoped to a
// specific room.
//
// Routing rules:
//   - `event.room` set    → `io.of(ns).to(room).emit(event.type, event.payload)`
//   - `event.room` unset  → dropped (never broadcast namespace-wide; PP-01)
//
// The `EventBus.emit` method is fire-and-forget per the port contract;
// any send failures are swallowed at the Socket.IO layer (clients will
// recover via their next state-sync request).

import type { Server } from 'socket.io';
import type {
  DomainEvent,
  EventBus,
} from '../../../domain/shared/ports/EventBus.js';

/**
 * Default namespace path. Matches the `/collab` namespace used by
 * `setupWebSocket` so emits from use cases reach the same set of
 * sockets that the inbound gateway authenticates and joins to project
 * rooms.
 */
const DEFAULT_NAMESPACE_PATH = '/collab';

/** Control event: disconnect every socket in `event.room` (access was revoked). */
export const SESSION_REVOKED_EVENT = 'session.revoked';

/**
 * Canonical realtime event names are the dotted domain names
 * (`annotation.created`, `annotation.updated`, `annotation.status_changed`,
 * `comment.created` — also the webhook vocabulary). They are always emitted
 * as-is.
 *
 * @deprecated The colon aliases below (`annotation:created`, `annotation:updated`,
 * `annotation:status`, `comment:created`) exist only for clients that have not
 * migrated yet — today that is the Chrome extension's OverlayHost/Syncer, which
 * still listens to the colon names for updated/status. REMOVAL CONDITION: delete
 * this table (and the second emit in `emit()`) once the extension subscribes to
 * the dotted names and no supported extension release older than that is still
 * in the field. The dashboard (`dashboard/src/lib/socket.ts`) is already on the
 * dotted names. Clients dedupe by annotation/comment id, so receiving an event
 * under both names is harmless.
 */
const CLIENT_ALIASES: Record<string, { name: string; shape: (payload: unknown) => unknown }> = {
  'annotation.created': { name: 'annotation:created', shape: (p) => p },
  'annotation.updated': { name: 'annotation:updated', shape: (p) => p },
  'annotation.status_changed': {
    name: 'annotation:status',
    shape: (p) => {
      const a = (p ?? {}) as { id?: string; status?: string; projectId?: string };
      return { id: a.id, status: a.status, projectId: a.projectId };
    },
  },
  'comment.created': {
    name: 'comment:created',
    // The dashboard expects the bare comment; the dotted event wraps it.
    shape: (p) => (p && typeof p === 'object' && 'comment' in p ? (p as { comment: unknown }).comment : p),
  },
};

export class SocketIoEventBus implements EventBus {
  private readonly namespacePath: string;

  constructor(
    private readonly io: Server,
    namespacePath: string = DEFAULT_NAMESPACE_PATH,
  ) {
    this.namespacePath = namespacePath;
  }

  emit(event: DomainEvent): void {
    const namespace = this.io.of(this.namespacePath);
    // Default-deny (PP-01): a room-less event would reach every socket of every
    // tenant, so it is dropped rather than broadcast to the whole namespace.
    if (!event.room) return;
    // Control event (PP-02): cut every socket of that room (user:<id>) instead of
    // delivering a payload. Clients reconnect and are re-authorised from scratch.
    if (event.type === SESSION_REVOKED_EVENT) {
      namespace.in(event.room).disconnectSockets(true);
      return;
    }
    const target = namespace.to(event.room);
    target.emit(event.type, event.payload);
    // Deprecated colon alias — see CLIENT_ALIASES for the removal condition.
    const alias = CLIENT_ALIASES[event.type];
    if (alias) target.emit(alias.name, alias.shape(event.payload));
  }
}
