// EventBus port (Phase 1.5 / task 4.6.2).
//
// Use_Cases publish domain events that interested consumers (notably the
// Socket.IO inbound/outbound pair for real-time collaboration) react to.
// Domain code never imports `socket.io` — it only sees this interface.

/**
 * Loose event shape: a string `type` discriminator plus an arbitrary
 * payload. Concrete event types are defined alongside the use cases that
 * emit them (e.g., `AnnotationCreated`, `CommentCreated`).
 */
export interface DomainEvent<TPayload = unknown> {
  type: string;
  /** Optional room identifier (e.g., `project:<id>`) the adapter routes on. */
  room?: string;
  payload: TPayload;
}

export interface EventBus {
  /** Fire-and-forget; the adapter handles delivery + retries. */
  emit(event: DomainEvent): void;
}
