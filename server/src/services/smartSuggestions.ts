/**
 * SmartSuggestions — when a developer views an annotation, suggest relevant
 * components / past fixes / an assignee based on the annotation's CSS selector
 * and the project's resolution history. Backs
 * `GET /api/v1/annotations/:id/suggestions` (alongside AI triage).
 *
 * Scoped by the annotation's `project_id` (always populated and NOT NULL),
 * which is both more robust and more relevant than the old `org_id` filter —
 * "who fixed this element before" is a per-project question. An earlier,
 * never-wired draft filtered by `org_id` and read `target->>'selector'`
 * (the real DOMTarget field is `cssSelector`), so it silently returned nothing.
 */
import type { Knex } from 'knex';

export interface ResolutionSuggestion {
  type: 'past_fix' | 'related_component' | 'assignee';
  title: string;
  detail: string;
  confidence: number; // 0-1
}

/** How many recent past-fix rows to surface. */
const PAST_FIX_LIMIT = 3;

export async function getSuggestions(
  db: Knex,
  annotationId: string,
): Promise<ResolutionSuggestion[]> {
  const annotation = await db('annotations').where({ id: annotationId }).first();
  if (!annotation) return [];

  const projectId = annotation.project_id as string;
  const target =
    typeof annotation.target === 'string'
      ? JSON.parse(annotation.target)
      : annotation.target;
  const selector: string = target?.cssSelector ?? '';
  const suggestions: ResolutionSuggestion[] = [];

  // 1. Past resolutions on a similar selector (same project).
  if (selector) {
    const lastSegment = selector.trim().split(/\s+/).pop() ?? '';
    if (lastSegment) {
      const pastFixes = await db('annotations')
        .where('project_id', projectId)
        .where('status', 'resolved')
        .whereRaw("target->>'cssSelector' LIKE ?", [`%${lastSegment}%`])
        .whereNot('id', annotationId)
        .orderBy('updated_at', 'desc')
        .limit(PAST_FIX_LIMIT)
        .select('id', 'body', 'assignee_id', 'updated_at');

      for (const fix of pastFixes) {
        suggestions.push({
          type: 'past_fix',
          title: 'Similar issue resolved',
          detail: (fix.body as string | undefined)?.slice(0, 100) ?? '',
          confidence: 0.7,
        });
      }
    }
  }

  // 2. Likely component area, derived purely from the selector.
  const component = extractComponentName(selector);
  if (component) {
    suggestions.push({
      type: 'related_component',
      title: `Likely component: ${component}`,
      detail: `Based on selector pattern. Check ${component}.tsx / ${component}.css`,
      confidence: 0.6,
    });
  }

  // 3. Suggest the person who most often resolves issues in this project.
  const topResolver = await db('annotations')
    .where('project_id', projectId)
    .where('status', 'resolved')
    .whereNotNull('assignee_id')
    .select('assignee_id')
    .count('* as count')
    .groupBy('assignee_id')
    .orderBy('count', 'desc')
    .first();

  if (topResolver?.assignee_id) {
    const user = await db('users').where('id', topResolver.assignee_id).first();
    if (user) {
      suggestions.push({
        type: 'assignee',
        title: `Suggest assigning to ${user.email}`,
        detail: `Resolved ${topResolver.count} issue(s) in this project`,
        confidence: 0.5,
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Derive a likely component name from a CSS selector. Pure and deterministic.
 *
 * Priority:
 *  1. A PascalCase class (`.Button`) or `data-component`/`data-testid` value.
 *  2. Otherwise the last plain class name in the selector.
 *  3. `null` when nothing component-like is present.
 */
export function extractComponentName(selector: string): string | null {
  if (!selector) return null;
  // PascalCase class or data-component/data-testid attribute.
  const match = selector.match(
    /\.([A-Z][a-zA-Z0-9]+)|data-(?:component|testid)="([^"]+)"/,
  );
  if (match) return match[1] ?? match[2] ?? null;
  // Fall back to the last plain class name.
  const classes = selector.match(/\.([a-zA-Z][\w-]+)/g);
  if (classes?.length) return classes[classes.length - 1]!.replace('.', '');
  return null;
}
