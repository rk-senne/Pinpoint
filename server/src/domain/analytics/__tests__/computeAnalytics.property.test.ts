// Feature: pinpoint-app, Property 10: Analytics aggregation invariant
// **Validates: Requirements 16.1, 16.5**
//
// Domain-layer property test (Phase 1.5 / task 4.11.3). Drives the
// `ComputeAnalytics` use case through `FakeAnnotationRepo` +
// `FakeAnalyticsRepo` (which mirrors the closed-enum fallback to
// `unknown` from PgAnalyticsRepo) so the dimension-sum invariant holds
// independently of Express or Postgres.
//
// Invariants asserted across every generated annotation list:
//   (a) sum(bySeverity)  === total
//   (b) sum(byType)      === total
//   (c) sum(byStatus)    === total
//   (d) sum(byBrowser)   === total      (Req 16.5)
//   (e) per-bucket counts equal a manual group-by on the raw input.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  FakeAnalyticsRepo,
  FakeAnnotationRepo,
  FakeClock,
} from '../../../__tests__/fakes/index.js';
import { ComputeAnalytics } from '../usecases/computeAnalytics.js';
import { FakeProjectRepo, FakeTeamMemberRepo } from '../../../__tests__/fakes/index.js';
import type {
  AnnotationStatus,
  AnnotationType,
  Severity,
} from '../../annotation/Annotation.js';

type BrowserFamily =
  | 'Chrome'
  | 'Edge'
  | 'Safari'
  | 'Firefox'
  | 'Opera'
  | 'Brave'
  | 'Arc'
  | 'Other'
  | 'unknown';

const ALL_BROWSER_FAMILIES: readonly BrowserFamily[] = [
  'Chrome',
  'Edge',
  'Safari',
  'Firefox',
  'Opera',
  'Brave',
  'Arc',
  'Other',
  'unknown',
] as const;

interface AnnotationSeed {
  type: AnnotationType;
  severity: Severity;
  status: AnnotationStatus;
  browserFamily: BrowserFamily;
}

const arbSeverity = fc.constantFrom<Severity>(
  'critical',
  'major',
  'minor',
  'informational',
);
const arbType = fc.constantFrom<AnnotationType>(
  'note',
  'suggestion',
  'guideline',
);
const arbStatus = fc.constantFrom<AnnotationStatus>(
  'active',
  'in_progress',
  'resolved',
);
const arbBrowserFamily = fc.constantFrom<BrowserFamily>(
  ...ALL_BROWSER_FAMILIES,
);

const arbAnnotationSeed: fc.Arbitrary<AnnotationSeed> = fc.record({
  type: arbType,
  severity: arbSeverity,
  status: arbStatus,
  browserFamily: arbBrowserFamily,
});

const arbAnnotationList = fc.array(arbAnnotationSeed, {
  minLength: 0,
  maxLength: 50,
});

const TARGET = {
  cssSelector: 'body',
  xpath: '/html/body',
  pageX: 0,
  pageY: 0,
  tagName: 'body',
  textSnippet: '',
};

describe('Property 10: Analytics aggregation invariant (use-case layer)', () => {
  it('ComputeAnalytics dimension sums equal total and per-bucket counts equal manual group-bys', async () => {
    await fc.assert(
      fc.asyncProperty(arbAnnotationList, async (seeds) => {
        const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
        const teamMemberRepo = new FakeTeamMemberRepo({ clock });
        const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
        const annotationRepo = new FakeAnnotationRepo(clock);
        const analyticsRepo = new FakeAnalyticsRepo(annotationRepo);

        const ownerId = 'owner-prop10';
        const project = await projectRepo.insert({
          name: 'Property 10 Project',
          urls: ['https://example.com'],
          ownerId,
        });

        for (let i = 0; i < seeds.length; i++) {
          const seed = seeds[i]!;
          await annotationRepo.insert({
            projectId: project.id,
            pageId: 'page-prop10',
            type: seed.type,
            severity: seed.severity,
            status: seed.status,
            body: `body-${i}`,
            authorId: ownerId,
            target: TARGET,
            environment: {
              browserFamily: seed.browserFamily,
              browserVersion: '120',
              osFamily: 'macOS',
              osVersion: '14',
              deviceType: 'desktop',
              userAgentRaw: 'test-ua',
            },
            pinNumber: i + 1,
          });
        }

        const usecase = new ComputeAnalytics({
          projectRepo,
          teamMemberRepo,
          analyticsRepo,
        });
        const result = await usecase.execute({
          userId: ownerId,
          projectId: project.id,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const buckets = result.value;

        const total = seeds.length;
        expect(buckets.total).toBe(total);

        // (a) severity dimension sum == total
        const severitySum = Object.values(buckets.bySeverity).reduce(
          (s, n) => s + n,
          0,
        );
        expect(severitySum).toBe(total);

        // (b) type dimension sum == total
        const typeSum = Object.values(buckets.byType).reduce(
          (s, n) => s + n,
          0,
        );
        expect(typeSum).toBe(total);

        // (c) status dimension sum == total
        const statusSum = Object.values(buckets.byStatus).reduce(
          (s, n) => s + n,
          0,
        );
        expect(statusSum).toBe(total);

        // (d) browser dimension sum == total (Req 16.5)
        const browserSum = Object.values(buckets.byBrowser).reduce(
          (s, n) => s + n,
          0,
        );
        expect(browserSum).toBe(total);

        // (e) per-bucket counts equal manual group-bys.
        for (const sev of [
          'critical',
          'major',
          'minor',
          'informational',
        ] as Severity[]) {
          const expected = seeds.filter((a) => a.severity === sev).length;
          expect(buckets.bySeverity[sev]).toBe(expected);
        }
        for (const t of [
          'note',
          'suggestion',
          'guideline',
        ] as AnnotationType[]) {
          const expected = seeds.filter((a) => a.type === t).length;
          expect(buckets.byType[t]).toBe(expected);
        }
        for (const st of [
          'active',
          'in_progress',
          'resolved',
        ] as AnnotationStatus[]) {
          const expected = seeds.filter((a) => a.status === st).length;
          expect(buckets.byStatus[st]).toBe(expected);
        }
        for (const fam of ALL_BROWSER_FAMILIES) {
          const expected = seeds.filter((a) => a.browserFamily === fam).length;
          expect(buckets.byBrowser[fam]).toBe(expected);
        }
      }),
      { numRuns: 50 },
    );
  });
});
