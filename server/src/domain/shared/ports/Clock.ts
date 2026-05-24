// Clock port (Phase 1.5 / task 4.6.2).
//
// Use_Cases inject this rather than calling `new Date()` directly so
// time-dependent behavior (token TTLs, lockout windows, scheduled
// notifications) can be tested deterministically with a fake.

export interface Clock {
  /** Current wall-clock time. */
  now(): Date;
}
