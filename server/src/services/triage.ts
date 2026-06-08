/**
 * AI Feedback Triage — auto-classify severity, detect duplicates,
 * suggest assignees based on historical patterns.
 */
import type { Knex } from 'knex';

export interface TriageResult {
  suggestedSeverity: string;
  suggestedAssignee: { userId: string; email: string; reason: string } | null;
  duplicates: { id: string; body: string; similarity: number }[];
  tags: string[];
}

export interface TriageService {
  triage(orgId: string, body: string, target: Record<string, unknown>): Promise<TriageResult>;
}

export function createTriageService(db: Knex): TriageService {
  return {
    async triage(orgId, body, target) {
      // 1. Classify severity by keyword heuristics (replace with OpenAI in prod)
      const lowerBody = body.toLowerCase();
      let suggestedSeverity = 'informational';
      if (/crash|broken|500|error|can't|cannot|fail/i.test(lowerBody)) suggestedSeverity = 'critical';
      else if (/wrong|incorrect|misalign|overflow|cut off/i.test(lowerBody)) suggestedSeverity = 'major';
      else if (/typo|spacing|color|font|minor/i.test(lowerBody)) suggestedSeverity = 'minor';

      // 2. Detect duplicates via simple text similarity (trigram matching)
      const selector = (target as any)?.selector ?? '';
      const recentAnnotations = await db('annotations')
        .where('org_id', orgId)
        .where('status', 'active')
        .orderBy('created_at', 'desc')
        .limit(100)
        .select('id', 'body', 'target');

      const duplicates = recentAnnotations
        .map((a) => ({ id: a.id, body: a.body, similarity: textSimilarity(body, a.body) }))
        .filter((d) => d.similarity > 0.6)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 3);

      // 3. Suggest assignee based on who resolved similar items on same selector
      const resolvedBySelector = await db('annotations')
        .where('org_id', orgId)
        .where('status', 'resolved')
        .whereRaw("target->>'selector' = ?", [selector])
        .whereNotNull('assignee_id')
        .select('assignee_id')
        .groupBy('assignee_id')
        .orderByRaw('COUNT(*) DESC')
        .first();

      let suggestedAssignee = null;
      if (resolvedBySelector) {
        const user = await db('users').where('id', resolvedBySelector.assignee_id).select('id', 'email').first();
        if (user) {
          suggestedAssignee = { userId: user.id, email: user.email, reason: `Resolved ${selector} issues before` };
        }
      }

      // 4. Auto-tag
      const tags: string[] = [];
      if (/mobile|responsive|viewport/i.test(lowerBody)) tags.push('mobile');
      if (/performance|slow|load/i.test(lowerBody)) tags.push('performance');
      if (/design|ui|ux|visual/i.test(lowerBody)) tags.push('design');
      if (/copy|text|wording|typo/i.test(lowerBody)) tags.push('copy');

      return { suggestedSeverity, suggestedAssignee, duplicates, tags };
    },
  };
}

function textSimilarity(a: string, b: string): number {
  const trigramsA = new Set(trigrams(a.toLowerCase()));
  const trigramsB = new Set(trigrams(b.toLowerCase()));
  const intersection = [...trigramsA].filter((t) => trigramsB.has(t)).length;
  const union = new Set([...trigramsA, ...trigramsB]).size;
  return union === 0 ? 0 : intersection / union;
}

function trigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i <= s.length - 3; i++) result.push(s.slice(i, i + 3));
  return result;
}
