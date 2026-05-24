// Feature: pinpoint-app, Property 15: Idempotent annotation creation
// **Validates: Requirements 44.3**
//
// For any annotation submission carrying a `clientRequestId` (UUID), the
// first request must be a normal create (fresh row, idempotentReplay
// false) and every subsequent request reusing that same UUID must be
// treated as an idempotent replay: the original row id is returned
// verbatim, the original payload survives the replay (severity, body),
// and the project's pin counter is NOT advanced — regardless of how
// many times the syncer retries.
//
// This is the offline-replay contract from Requirement 44.3 (and the
// outbox/sync design): the Extension queues operations locally, attaches
// a stable client UUID per operation, and on reconnect replays the
// outbox. Network flakiness can cause the same row to be POST'd many
// times; the server must deduplicate by (project_id, client_request_id).
//
// Rewired against the hex `createAnnotation` use case + fakes (FakeAnnotationRepo,
// FakeProjectRepo, FakePageRepo, FakeProjectPinSequence, FakeTeamMemberRepo,
// FakeClock, FakeEventBus). The previous implementation drove the legacy
// Express router against a real Postgres test DB; the property under test
// is the pure idempotent-replay invariant in the use case itself, so the
// in-memory fakes exercise the exact same logic without database scaffolding.
// `FakeAnnotationRepo.findByClientRequestId` is scoped per project, mirroring
// the production partial UNIQUE index that backs the dedup contract.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeEventBus,
  FakePageRepo,
  FakeProjectPinSequence,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../fakes/index.js';
import { CreateAnnotation } from '../../domain/annotation/usecases/createAnnotation.js';
import type { DOMTarget } from '../../domain/annotation/DOMTarget.js';
import type { EnvironmentMetadata } from '../../domain/annotation/EnvironmentMetadata.js';

const TARGET: DOMTarget = {
  cssSelector: 'div.idem',
  xpath: '/html/body/div[1]',
  pageX: 100,
  pageY: 200,
  tagName: 'DIV',
  textSnippet: 'idem',
};

const ENV: EnvironmentMetadata = {
  browserFamily: 'Chrome',
  browserVersion: '120',
  osFamily: 'macOS',
  osVersion: '14',
  deviceType: 'desktop',
  userAgentRaw: 'test-ua',
};

// Adapters that don't need a transaction handle (in-memory fakes) accept
// any truthy value, so this no-op runner is sufficient at the seam.
const noopRunInTransaction = async <T>(
  fn: (tx: unknown) => Promise<T>,
): Promise<T> => fn({});

describe('Property 15: Idempotent annotation creation (Requirement 44.3)', () => {
  it('replays of createAnnotation with the same clientRequestId always return the original annotation', async () => {
    // --- Arbitraries ---
    //
    // `fc.uuid()` would also work, but we want to align with the
    // Extension's `crypto.randomUUID()` output, which is always v4. The
    // server's `ClientRequestIdSchema` accepts any RFC 4122 UUID, so any
    // version generated here is fine; we explicitly pick v4 to mirror
    // production traffic.
    const arbClientRequestId = fc.uuid({ version: 4 });

    // Annotation body must be a non-empty trimmed string. Use a simple
    // printable-ASCII generator with at least one non-space character to
    // satisfy the use case's `body.trim()` semantics without being so wide
    // that we generate invalid UTF-8 or control characters.
    const arbBody = fc
      .string({ minLength: 1, maxLength: 64 })
      .filter((s) => s.trim().length > 0);

    // 1..5 replays per the original task spec.
    const arbReplayCount = fc.integer({ min: 1, max: 5 });

    await fc.assert(
      fc.asyncProperty(
        arbClientRequestId,
        arbBody,
        arbReplayCount,
        async (clientRequestId, body, K) => {
          // Fresh fakes per iteration so iterations cannot bleed pin counter
          // state across runs. Each input gets a clean project + page +
          // counter so we can directly assert on `pinSequence.peek()`.
          const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
          const teamMemberRepo = new FakeTeamMemberRepo({ clock });
          const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
          const pageRepo = new FakePageRepo(clock);
          const annotationRepo = new FakeAnnotationRepo(clock);
          const pinSequence = new FakeProjectPinSequence();
          const eventBus = new FakeEventBus();

          const project = await projectRepo.insert({
            name: `idempotency-${clientRequestId.slice(0, 8)}`,
            urls: ['https://example.com/idempotency'],
            ownerId: 'owner-1',
          });

          const usecase = new CreateAnnotation({
            annotationRepo,
            projectRepo,
            pageRepo,
            teamMemberRepo,
            pinSequence,
            runInTransaction: noopRunInTransaction,
            clock,
            eventBus,
          });

          const baseInput = {
            projectId: project.id,
            authorUserId: 'owner-1',
            pageUrl: 'https://example.com/idempotency',
            type: 'note' as const,
            severity: 'informational' as const,
            body,
            target: TARGET,
            environment: ENV,
            clientRequestId,
          };

          // --- First request: must be a fresh create ---
          const first = await usecase.execute(baseInput);
          expect(first.ok).toBe(true);
          if (!first.ok) return;
          expect(first.value.idempotentReplay).toBe(false);
          expect(first.value.annotation.clientRequestId).toBe(clientRequestId);
          expect(first.value.annotation.pinNumber).toBe(1);

          const originalId = first.value.annotation.id;
          const originalBody = first.value.annotation.body; // trimmed
          const originalSeverity = first.value.annotation.severity;

          // --- K replays with the SAME clientRequestId ---
          //
          // Vary the payload on each replay so we additionally verify the
          // server returns the ORIGINAL row's body, not the payload we sent
          // in the replay (the contract from task 35.2: "the server ignores
          // the new payload and returns the original row verbatim"). The
          // pin counter must also be unchanged across replays.
          for (let i = 0; i < K; i++) {
            const replay = await usecase.execute({
              ...baseInput,
              severity: 'critical', // intentionally different
              body: `replay #${i} payload — should be ignored`,
            });

            expect(replay.ok).toBe(true);
            if (!replay.ok) return;
            expect(replay.value.idempotentReplay).toBe(true);
            expect(replay.value.annotation.id).toBe(originalId);
            expect(replay.value.annotation.clientRequestId).toBe(clientRequestId);
            // Original body and severity survive the replay (the use case
            // short-circuits before reading the new payload).
            expect(replay.value.annotation.body).toBe(originalBody);
            expect(replay.value.annotation.severity).toBe(originalSeverity);
          }

          // --- Repo invariant: exactly one row per (project_id, client_request_id) ---
          const stored = Array.from(annotationRepo.annotations.values()).filter(
            (a) =>
              a.projectId === project.id &&
              a.clientRequestId === clientRequestId,
          );
          expect(stored).toHaveLength(1);
          expect(stored[0]!.id).toBe(originalId);

          // The pin counter advanced exactly once across the create + K replays.
          expect(pinSequence.peek(project.id)).toBe(1);

          // Only the initial create emits an event; replays are silent.
          expect(eventBus.events).toHaveLength(1);
          expect(eventBus.events[0]!.type).toBe('annotation.created');
        },
      ),
      { numRuns: 25 },
    );
  });
});
