// AnalyticsRepo outbound port (Phase 1.5 / task 4.6.2).
//
// Read-side projection: computes the project-scoped aggregates surfaced
// by GET /api/projects/:id/analytics (Req 16). Implementation details
// (raw SQL aggregates vs in-memory roll-up) are owned by the adapter; the
// domain only sees the resulting buckets.

export interface AnalyticsBuckets {
  total: number;
  bySeverity: {
    critical: number;
    major: number;
    minor: number;
    informational: number;
  };
  byType: {
    note: number;
    suggestion: number;
    guideline: number;
  };
  byStatus: {
    active: number;
    in_progress: number;
    resolved: number;
  };
  byBrowser: {
    Chrome: number;
    Edge: number;
    Safari: number;
    Firefox: number;
    Opera: number;
    Brave: number;
    Arc: number;
    Other: number;
    unknown: number;
  };
}

export interface AnalyticsRepo {
  computeForProject(projectId: string): Promise<AnalyticsBuckets>;
}
