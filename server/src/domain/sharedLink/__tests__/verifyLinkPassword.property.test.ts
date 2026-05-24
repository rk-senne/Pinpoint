// Feature: pinpoint-app, Property 13: Shared link lockout state machine
// **Validates: Requirements 15.3, 15.4, 15.5, 15.6**
//
// Domain-layer property test (Phase 1.5 / task 4.11.3). Drives the
// `VerifyLinkPassword` use case through `FakeSharedLinkRepo` +
// `FakePasswordHasher` + `FakeClock` so the FSM holds independently of
// Express, Postgres, and bcrypt.
//
// For any sequence of (correct|incorrect, advanceClockMinutes) events,
// the use case's persisted `failedAttempts` / `lockedUntil` columns
// and the returned outcome shall track a pure FSM:
//
//   - locked   iff failed_attempts >= MAX AND locked_until > now
//   - a correct password while not locked clears counters and returns ok
//   - an attempt arriving after locked_until expiry resets counters
//     before evaluating the password (so a correct password right
//     after expiry succeeds and leaves attempts at 0)
//   - an incorrect attempt that brings failed_attempts up to MAX writes
//     locked_until = now + LOCKOUT_MINUTES and returns Locked

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  FakeClock,
  FakePasswordHasher,
  FakeSharedLinkRepo,
} from '../../../__tests__/fakes/index.js';
import {
  LOCKOUT_MINUTES,
  MAX_FAILED_ATTEMPTS,
  VerifyLinkPassword,
} from '../usecases/verifyLinkPassword.js';

const PASSWORD = 'correct-horse-battery-staple';
const LOCKOUT_MS = LOCKOUT_MINUTES * 60 * 1000;

// --- Pure FSM model (mirrors the use case) ---

type ResultStatus = 'ok' | 'invalid' | 'locked';

interface ModelState {
  failedAttempts: number;
  lockedUntil: number | null;
}

interface Event {
  kind: 'correct' | 'incorrect';
  advanceMinutes: number;
}

function applyModel(
  state: ModelState,
  event: Event,
  now: number,
): { state: ModelState; result: ResultStatus } {
  // Active lock: no state change.
  if (state.lockedUntil !== null && state.lockedUntil > now) {
    return { state, result: 'locked' };
  }

  // Stale lock: reset counters before evaluating (Req 15.6).
  let s: ModelState = state;
  if (s.lockedUntil !== null && s.lockedUntil <= now) {
    s = { failedAttempts: 0, lockedUntil: null };
  }

  if (event.kind === 'correct') {
    return { state: { failedAttempts: 0, lockedUntil: null }, result: 'ok' };
  }

  const newAttempts = s.failedAttempts + 1;
  if (newAttempts >= MAX_FAILED_ATTEMPTS) {
    return {
      state: { failedAttempts: newAttempts, lockedUntil: now + LOCKOUT_MS },
      result: 'locked',
    };
  }
  return {
    state: { failedAttempts: newAttempts, lockedUntil: null },
    result: 'invalid',
  };
}

// --- Arbitraries ---

const arbEvent: fc.Arbitrary<Event> = fc.record({
  kind: fc.constantFrom<'correct' | 'incorrect'>('correct', 'incorrect'),
  // 0–30 minutes between events lets traces straddle the 15-minute
  // lockout boundary in either direction.
  advanceMinutes: fc.integer({ min: 0, max: 30 }),
});

const arbEventSeq = fc.array(arbEvent, { minLength: 1, maxLength: 12 });

describe('Property 13: Shared link lockout state machine (use-case layer)', () => {
  it('FSM state matches the model after every (correct|incorrect, advanceClockMinutes) event', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSeq, async (events) => {
        const baseTime = Date.UTC(2025, 0, 1, 12, 0, 0);
        const clock = new FakeClock(new Date(baseTime));
        const passwordHasher = new FakePasswordHasher();
        const sharedLinkRepo = new FakeSharedLinkRepo(clock);

        // Seed a fresh password-protected link. `FakePasswordHasher`
        // hashes as the literal string `'hashed:<plain>'`, so we
        // store the hash that matches `PASSWORD`.
        const link = await sharedLinkRepo.insert({
          projectId: 'project-prop13',
          passwordHash: `hashed:${PASSWORD}`,
        });

        const usecase = new VerifyLinkPassword({
          sharedLinkRepo,
          passwordHasher,
          clock,
        });

        let model: ModelState = { failedAttempts: 0, lockedUntil: null };
        let now = baseTime;

        for (const ev of events) {
          now += ev.advanceMinutes * 60_000;
          clock.setNow(new Date(now));

          const { state: expectedState, result: expectedResult } = applyModel(
            model,
            ev,
            now,
          );

          const passwordToTry =
            ev.kind === 'correct' ? PASSWORD : 'definitely-not-the-password';
          const actual = await usecase.execute({
            linkId: link.id,
            password: passwordToTry,
          });

          // Map use-case outcome to the model's three-state result.
          let actualResult: ResultStatus;
          if (actual.ok) {
            actualResult = 'ok';
          } else {
            const kind = actual.error.kind;
            if (kind === 'Locked') actualResult = 'locked';
            else if (kind === 'Unauthorized') actualResult = 'invalid';
            else {
              // Validation/NotFound/etc. would indicate a broken
              // generator or use case; fail loudly.
              throw new Error(
                `unexpected use-case error kind: ${kind}`,
              );
            }
          }

          expect(actualResult).toBe(expectedResult);

          // Persisted state matches the model.
          const row = sharedLinkRepo.links.get(link.id)!;
          expect(row.failedAttempts).toBe(expectedState.failedAttempts);
          if (expectedState.lockedUntil === null) {
            expect(row.lockedUntil).toBeNull();
          } else {
            const persisted = new Date(row.lockedUntil!).getTime();
            expect(persisted).toBe(expectedState.lockedUntil);
          }

          model = expectedState;
        }
      }),
      { numRuns: 40 },
    );
  });
});
