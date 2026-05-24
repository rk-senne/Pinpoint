// FakeClock — in-memory deterministic Clock fake (Phase 1.5 / task 4.11.1).
//
// Use cases that need the current time inject a Clock so tests can advance
// time without touching `Date.now()`. The default seed
// `2024-01-01T00:00:00Z` keeps every fixture stable; tests advance the
// clock with `setNow(date)` or `advance(ms)`.

import type { Clock } from '../../domain/shared/ports/Clock.js';

const DEFAULT_NOW = new Date('2024-01-01T00:00:00Z');

export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date = DEFAULT_NOW) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    // Hand back a defensive copy so callers cannot mutate our internal
    // clock by holding the returned `Date` and calling `setTime`.
    return new Date(this.current.getTime());
  }

  /** Reset the clock to a specific instant. */
  setNow(date: Date): void {
    this.current = new Date(date.getTime());
  }

  /** Advance the clock by the supplied number of milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
