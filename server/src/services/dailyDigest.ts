/**
 * DailyDigest — generates a daily summary of org activity with AI insights.
 * Runs as a scheduled job (cron or worker). Sends via notification system.
 */
import type { Knex } from 'knex';

export interface DigestData {
  period: string;
  newAnnotations: number;
  resolved: number;
  avgResolutionHours: number | null;
  topContributors: { email: string; count: number }[];
  hotspots: { selector: string; count: number }[];
  insight: string; // AI-generated one-liner
}

export async function generateDailyDigest(db: Knex, orgId: string): Promise<DigestData> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [stats, contributors, hotspots] = await Promise.all([
    db('annotations')
      .where('org_id', orgId)
      .where('created_at', '>=', yesterday)
      .select(
        db.raw("COUNT(*) as new_count"),
        db.raw("COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count"),
        db.raw("AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600) FILTER (WHERE status = 'resolved') as avg_hours"),
      )
      .first(),

    db('annotations')
      .join('users', 'users.id', 'annotations.author_id')
      .where('annotations.org_id', orgId)
      .where('annotations.created_at', '>=', yesterday)
      .groupBy('users.email')
      .orderByRaw('COUNT(*) DESC')
      .limit(5)
      .select('users.email', db.raw('COUNT(*) as count')),

    db('annotations')
      .where('org_id', orgId)
      .where('created_at', '>=', yesterday)
      .whereNotNull('target')
      .select(db.raw("target->>'selector' as selector"), db.raw('COUNT(*) as count'))
      .groupByRaw("target->>'selector'")
      .orderByRaw('COUNT(*) DESC')
      .limit(3),
  ]);

  // Simple heuristic insight (replace with OpenAI in prod)
  const resolvedPct = stats?.new_count > 0 ? Math.round((stats.resolved_count / stats.new_count) * 100) : 0;
  let insight = `Your team handled ${stats?.new_count ?? 0} feedback items yesterday.`;
  if (resolvedPct > 80) insight += ' Great resolution rate — keep it up!';
  else if (resolvedPct < 30) insight += ' Resolution rate is low — consider clearing the backlog.';
  if (hotspots.length > 0) insight += ` The ${hotspots[0].selector} area had the most activity.`;

  return {
    period: yesterday,
    newAnnotations: stats?.new_count ?? 0,
    resolved: stats?.resolved_count ?? 0,
    avgResolutionHours: stats?.avg_hours ? Math.round(stats.avg_hours * 10) / 10 : null,
    topContributors: contributors,
    hotspots,
    insight,
  };
}
