// Postgres adapter for AnalyticsRepo (Phase 1.5 / task 4.8.1).
//
// Backs `GET /api/v1/projects/:id/analytics`. The roll-up is a single SQL
// `GROUP BY` (at most 4 x 3 x 3 x ~10 groups come back) instead of streaming
// every annotation row into Node and counting there, so the cost no longer
// grows with the number of annotations in the project on the wire / heap.

import type { Knex } from 'knex';
import type {
  AnalyticsBuckets,
  AnalyticsRepo,
} from '../../../domain/analytics/ports/AnalyticsRepo.js';

interface AnalyticsGroupRow {
  severity: string;
  type: string;
  status: string;
  browser: string | null;
  n: number | string;
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
    // `jsonb_typeof` guard: only object environments carry a browserFamily;
    // anything else (null, legacy scalar) falls into `unknown` (Req 16.5).
    const result = await this.db.raw<{ rows: AnalyticsGroupRow[] }>(
      `SELECT severity, type, status,
              CASE WHEN jsonb_typeof(environment) = 'object' THEN environment->>'browserFamily' END AS browser,
              count(*)::int AS n
         FROM annotations
        WHERE project_id = ?
        GROUP BY 1, 2, 3, 4`,
      [projectId],
    );

    const buckets: AnalyticsBuckets = {
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

    for (const row of result.rows) {
      const n = Number(row.n);
      buckets.total += n;
      if (row.severity in buckets.bySeverity) {
        buckets.bySeverity[row.severity as keyof AnalyticsBuckets['bySeverity']] += n;
      }
      if (row.type in buckets.byType) {
        buckets.byType[row.type as keyof AnalyticsBuckets['byType']] += n;
      }
      if (row.status in buckets.byStatus) {
        buckets.byStatus[row.status as keyof AnalyticsBuckets['byStatus']] += n;
      }
      if (typeof row.browser === 'string' && (BROWSER_KEYS as readonly string[]).includes(row.browser)) {
        buckets.byBrowser[row.browser as BrowserKey] += n;
      } else {
        buckets.byBrowser.unknown += n;
      }
    }

    return buckets;
  }
}
