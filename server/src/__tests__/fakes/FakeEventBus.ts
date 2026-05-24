// FakeEventBus — in-memory EventBus fake (Phase 1.5 / task 4.11.1).
//
// Appends every emitted event to a public `events` array so use-case
// tests can assert on the broadcast shape without booting Socket.IO.

import type {
  DomainEvent,
  EventBus,
} from '../../domain/shared/ports/EventBus.js';

export class FakeEventBus implements EventBus {
  /** Public for direct assertion in tests. */
  readonly events: DomainEvent[] = [];

  emit(event: DomainEvent): void {
    this.events.push(event);
  }

  /** Convenience: drop everything captured so far. */
  clear(): void {
    this.events.length = 0;
  }
}
