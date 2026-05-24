// FakeAnalyticsRepo — in-memory AnalyticsRepo fake
// (Phase 1.5 / task 4.11.1).
//
// Buckets are computed live from the supplied annotation repo so tests
// only need to seed annotations once and the analytics roll-up reflects
// that state. Mirrors the closed-enum fallback to `unknown` from
// PgAnalyticsRepo so behavior stays in step with production.

import type { Annotation } from '../../domain/annotation/Annotation.js';
import type {
  AnalyticsBuckets,
  AnalyticsRepo,
} from '../../domain/analytics/ports/AnalyticsRepo.js';
import type { AnnotationRepo } from '../../domain/annotation/ports/AnnotationRepo.js';

type BrowserKey = keyof AnalyticsBuckets['byBrowser'];

const BROWSER_KEYS: readonly BrowserKey[] = [
  'Chrome',
  'Edge',
  'Safari',
  'Firefox',
  'Opera',
  'Brave',
  'Arc',
  'Other',
  'unknown',
];

function emptyBuckets(): AnalyticsBuckets {
  return {
    total: 0,
    bySeverity: { critical: 0, major: 0, minor: 0, informational: 0 },
    byType: { note: 0, suggestion: 0, guideline: 0 },
    byStatus: { active: 0, in_progress: 0, resolved: 0 },
    byBrowser: {
      Chrome: 0,
      Edge: 0,
      Safari: 0,
      Firefox: 0,
      Opera: 0,
      Brave: 0,
      Arc: 0,
      Other: 0,
      unknown: 0,
    },
  };
}

export class FakeAnalyticsRepo implements AnalyticsRepo {
  constructor(private readonly annotationRepo: AnnotationRepo) {}

  async computeForProject(projectId: string): Promise<AnalyticsBuckets> {
    const annotations = await this.annotationRepo.listByProject(projectId);
    const buckets = emptyBuckets();
    buckets.total = annotations.length;
    for (const a of annotations) {
      this.bucket(a, buckets);
    }
    return buckets;
  }

  private bucket(a: Annotation, buckets: AnalyticsBuckets): void {
    if (a.severity in buckets.bySeverity) {
      buckets.bySeverity[a.severity as keyof AnalyticsBuckets['bySeverity']]++;
    }
    if (a.type in buckets.byType) {
      buckets.byType[a.type as keyof AnalyticsBuckets['byType']]++;
    }
    if (a.status in buckets.byStatus) {
      buckets.byStatus[a.status as keyof AnalyticsBuckets['byStatus']]++;
    }
    const family = a.environment?.browserFamily;
    if (typeof family === 'string' && (BROWSER_KEYS as readonly string[]).includes(family)) {
      buckets.byBrowser[family as BrowserKey]++;
    } else {
      buckets.byBrowser.unknown++;
    }
  }
}
