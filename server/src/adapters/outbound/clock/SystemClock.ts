// System Clock adapter (Phase 1.5 / task 4.8.7).
//
// Wraps `Date.now()` so use cases can inject a fake clock in tests
// rather than depending on the global `Date`. The Clock port (see
// `domain/shared/ports/Clock.ts`) currently exposes a single `now()`
// method returning a `Date`; we implement that exactly.

import type { Clock } from '../../../domain/shared/ports/Clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date(Date.now());
  }
}
