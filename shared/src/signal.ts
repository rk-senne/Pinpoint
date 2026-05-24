/**
 * Tiny reactive primitive for vanilla-TS UI code.
 *
 * Per Requirement 31 (UI without React), the Dashboard renders by subscribing to
 * `signal()` slices of in-memory state. The implementation is intentionally
 * minimal — no batching, no derivations, no async scheduling. Callers compose
 * those higher-level behaviors themselves.
 *
 * Contract:
 * - `get()` returns the current value.
 * - `set(next)` short-circuits when `Object.is(prev, next)` to avoid redundant
 *   fan-out work for unchanged primitives or referentially-equal objects.
 * - `subscribe(fn)` fires immediately with the current value, then on every
 *   subsequent change. Returns an unsubscribe function.
 */

export interface Signal<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();

  return {
    get(): T {
      return value;
    },
    set(next: T): void {
      if (Object.is(value, next)) return;
      value = next;
      // Snapshot listeners so a listener that unsubscribes (or subscribes)
      // during dispatch does not mutate the iteration in flight.
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      listener(value);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
