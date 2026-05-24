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
//   - `event.room` unset  → `io.of(ns).emit(event.type, event.payload)`
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
    if (event.room) {
      namespace.to(event.room).emit(event.type, event.payload);
      return;
    }
    namespace.emit(event.type, event.payload);
  }
}
