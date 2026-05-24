// Feature: pinpoint-app, Property 5: Comments are ordered chronologically
// **Validates: Requirements 12.1**
//
// Domain-layer property test (Phase 1.5 / task 4.11.3). Drives the
// `ListComments` use case through `FakeCommentRepo` + `FakeAnnotationRepo`
// so the chronological-ordering invariant holds independently of
// Express or Postgres.
//
// Invariant: for any sequence of comment inserts (each at its own
// generated `createdAt` timestamp), `ListComments.execute` returns
// exactly those comments, ordered by `createdAt` ascending.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeCommentRepo,
} from '../../../__tests__/fakes/index.js';
import { ListComments } from '../usecases/listComments.js';

const TARGET = {
  cssSelector: 'body',
  xpath: '/html/body',
  pageX: 0,
  pageY: 0,
  tagName: 'body',
  textSnippet: '',
};
const ENV = {
  browserFamily: 'Chrome' as const,
  browserVersion: '120',
  osFamily: 'macOS' as const,
  osVersion: '14',
  deviceType: 'desktop' as const,
  userAgentRaw: 'test-ua',
};

// Years 2020–2030 — a wide-but-bounded window that avoids fast-check's
// `fc.date(...)` "Invalid Date" pitfall.
const MIN_TS = Date.UTC(2020, 0, 1);
const MAX_TS = Date.UTC(2030, 11, 31, 23, 59, 59);

const arbTimestampMs = fc.integer({ min: MIN_TS, max: MAX_TS });

interface CommentSeed {
  body: string;
  createdAtMs: number;
}

const arbCommentSeed: fc.Arbitrary<CommentSeed> = fc.record({
  body: fc.string({ minLength: 1, maxLength: 200 }),
  createdAtMs: arbTimestampMs,
});

const arbCommentSeedList = fc.array(arbCommentSeed, {
  minLength: 0,
  maxLength: 30,
});

describe('Property 5: Comments are ordered chronologically (use-case layer)', () => {
  it('ListComments returns the comments in ascending createdAt order, with no losses or duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(arbCommentSeedList, async (seeds) => {
        const clock = new FakeClock(new Date(MIN_TS));
        const annotationRepo = new FakeAnnotationRepo(clock);
        const commentRepo = new FakeCommentRepo(clock);

        const annotation = await annotationRepo.insert({
          projectId: 'project-prop5',
          pageId: 'page-prop5',
          type: 'note',
          severity: 'minor',
          status: 'active',
          body: 'parent annotation',
          authorId: 'author-prop5',
          target: TARGET,
          environment: ENV,
          pinNumber: 1,
        });

        // Seed the comments at their generated timestamps. The fake
        // commentRepo stamps `createdAt` from the clock, so we move
        // the clock to each generated instant before inserting.
        for (const seed of seeds) {
          clock.setNow(new Date(seed.createdAtMs));
          await commentRepo.insert({
            annotationId: annotation.id,
            authorId: 'author-prop5',
            body: seed.body,
            mentions: [],
          });
        }

        const usecase = new ListComments({ commentRepo, annotationRepo });
        const result = await usecase.execute({
          annotationId: annotation.id,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const { comments } = result.value;

        // (1) No comments lost or duplicated.
        expect(comments).toHaveLength(seeds.length);

        // (2) Every adjacent pair is in non-decreasing createdAt order.
        for (let i = 1; i < comments.length; i++) {
          const prev = new Date(comments[i - 1]!.createdAt).getTime();
          const curr = new Date(comments[i]!.createdAt).getTime();
          expect(prev).toBeLessThanOrEqual(curr);
        }

        // (3) The multiset of returned createdAt timestamps equals the
        //     multiset of generated timestamps. This rules out
        //     reordering bugs that would still happen to produce a
        //     sorted output (e.g., dropping one row + duplicating
        //     another that shares the same instant).
        const sortedSeeds = [...seeds]
          .map((s) => s.createdAtMs)
          .sort((a, b) => a - b);
        const sortedActual = comments
          .map((c) => new Date(c.createdAt).getTime())
          .sort((a, b) => a - b);
        expect(sortedActual).toEqual(sortedSeeds);
      }),
      { numRuns: 50 },
    );
  });
});
