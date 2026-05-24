// Postgres adapter for AnalyticsRepo (Phase 1.5 / task 4.8.1).
//
// Implements the in-memory roll-up that backs
// `GET /api/projects/:id/analytics`. A future revision can swap this for
// SQL aggregates that exploit the JSONB expression index added by
// migration 20240210000000.

import type { Knex } from 'knex';
import type {
  AnalyticsBuckets,
  AnalyticsRepo,
} from '../../../domain/analytics/ports/AnalyticsRepo.js';

interface AnalyticsAnnotationRow {
  severity: string;
  type: string;
  status: string;
  environment: unknown;
}

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

export class PgAnalyticsRepo implements AnalyticsRepo {
  constructor(private readonly db: Knex) {}

  async computeForProject(projectId: string): Promise<AnalyticsBuckets> {
    const rows = await this.db<AnalyticsAnnotationRow>('annotations')
      .select('severity', 'type', 'status', 'environment')
      .where({ project_id: projectId });

    const buckets: AnalyticsBuckets = {
      total: rows.length,
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

    for (const row of rows) {
      this.mapRow(row, buckets);
    }

    return buckets;
  }

  /**
   * Increment the relevant bucket counters for a single annotation row.
   * Kept as a private helper rather than a pure mapper so the closed-enum
   * fallback to `unknown` (Req 16.5) remains explicit at the call site.
   */
  private mapRow(row: AnalyticsAnnotationRow, buckets: AnalyticsBuckets): void {
    if (row.severity in buckets.bySeverity) {
      buckets.bySeverity[row.severity as keyof AnalyticsBuckets['bySeverity']]++;
    }
    if (row.type in buckets.byType) {
      buckets.byType[row.type as keyof AnalyticsBuckets['byType']]++;
    }
    if (row.status in buckets.byStatus) {
      buckets.byStatus[row.status as keyof AnalyticsBuckets['byStatus']]++;
    }

    let env: unknown = row.environment;
    if (typeof env === 'string') {
      try {
        env = JSON.parse(env);
      } catch {
        env = null;
      }
    }
    const family =
      env && typeof env === 'object' && 'browserFamily' in env
        ? (env as { browserFamily?: unknown }).browserFamily
        : undefined;

    if (typeof family === 'string' && (BROWSER_KEYS as readonly string[]).includes(family)) {
      buckets.byBrowser[family as BrowserKey]++;
    } else {
      buckets.byBrowser.unknown++;
    }
  }
}
