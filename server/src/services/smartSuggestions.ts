/**
 * SmartSuggestions — when a developer views an annotation, suggest relevant
 * code files/past fixes based on the CSS selector and past resolution patterns.
 */
import type { Knex } from 'knex';

export interface ResolutionSuggestion {
  type: 'past_fix' | 'related_component' | 'assignee';
  title: string;
  detail: string;
  confidence: number; // 0-1
}

export async function getSuggestions(
  db: Knex,
  orgId: string,
  annotationId: string,
): Promise<ResolutionSuggestion[]> {
  const annotation = await db('annotations').where({ id: annotationId, org_id: orgId }).first();
  if (!annotation) return [];

  const target = typeof annotation.target === 'string' ? JSON.parse(annotation.target) : annotation.target;
  const selector = target?.selector ?? '';
  const suggestions: ResolutionSuggestion[] = [];

  // 1. Find past resolutions on same/similar selector
  if (selector) {
    const pastFixes = await db('annotations')
      .where('org_id', orgId)
      .where('status', 'resolved')
      .whereRaw("target->>'selector' LIKE ?", [`%${selector.split(' ').pop()}%`])
      .where('id', '!=', annotationId)
      .orderBy('updated_at', 'desc')
      .limit(3)
      .select('id', 'body', 'assignee_id', 'updated_at');

    for (const fix of pastFixes) {
      suggestions.push({
        type: 'past_fix',
        title: `Similar issue resolved`,
        detail: fix.body?.slice(0, 100) ?? '',
        confidence: 0.7,
      });
    }
  }

  // 2. Suggest component area based on selector
  const component = extractComponentName(selector);
  if (component) {
    suggestions.push({
      type: 'related_component',
      title: `Likely component: ${component}`,
      detail: `Based on selector pattern. Check ${component}.tsx / ${component}.css`,
      confidence: 0.6,
    });
  }

  // 3. Suggest assignee from history
  const topResolver = await db('annotations')
    .where('org_id', orgId)
    .where('status', 'resolved')
    .whereNotNull('assignee_id')
    .groupBy('assignee_id')
    .orderByRaw('COUNT(*) DESC')
    .first()
    .select('assignee_id', db.raw('COUNT(*) as count'));

  if (topResolver) {
    const user = await db('users').where('id', topResolver.assignee_id).first();
    if (user) {
      suggestions.push({
        type: 'assignee',
        title: `Suggest assigning to ${user.email}`,
        detail: `Resolved ${topResolver.count} issues in this project`,
        confidence: 0.5,
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

function extractComponentName(selector: string): string | null {
  // Match common component patterns: .Button, [data-component="Header"], .nav-item
  const match = selector.match(/\.([A-Z][a-zA-Z]+)|data-(?:component|testid)="([^"]+)"/);
  if (match) return match[1] ?? match[2] ?? null;
  // Try last class name
  const classes = selector.match(/\.([a-zA-Z][\w-]+)/g);
  if (classes?.length) return classes[classes.length - 1]!.replace('.', '');
  return null;
}
