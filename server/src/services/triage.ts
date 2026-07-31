/**
 * AI Feedback Triage — auto-classify severity, detect duplicate annotations,
 * suggest tags, and suggest an assignee based on historical resolution
 * patterns. Human-in-the-loop by design: this produces *suggestions* that a
 * user confirms, which is how the best-in-class tools (BugHerd AI, Usersnap
 * AI) surface triage — it never mutates an annotation on its own.
 *
 * The heuristics live in the pure, DB-free `triageLogic` module so they can be
 * unit/property tested in isolation. This service is the thin data-access
 * layer that feeds project-scoped rows into that logic.
 *
 * Scoped by `project_id` (the real annotations column) and matches historical
 * work by `target->>'cssSelector'` (the real DOMTarget field). An earlier,
 * never-wired draft of this file queried `org_id` / `target->>'selector'`,
 * which do not exist — hence it silently returned nothing.
 */
import type { Knex } from 'knex';
import type { Severity } from '@pinpoint/shared';

import {
  classifySeverity,
  suggestTags,
  rankDuplicates,
  type DuplicateMatch,
} from './triageLogic.js';

/** How many recent open annotations to scan for duplicates. */
const DUPLICATE_SCAN_LIMIT = 100;

export interface TriageInput {
  /** The feedback text being triaged. */
  body: string;
  /** The DOM target of the new annotation (used for assignee routing). */
  target?: { cssSelector?: string | null } | null;
  /** Exclude this annotation id from duplicate results (when re-triaging). */
  excludeId?: string;
}

export interface TriageResult {
  suggestedSeverity: Severity;
  suggestedTags: string[];
  duplicates: DuplicateMatch[];
  suggestedAssignee: { userId: string; email: string; reason: string } | null;
}

export interface TriageService {
  triage(projectId: string, input: TriageInput): Promise<TriageResult>;
}

export function createTriageService(db: Knex): TriageService {
  return {
    async triage(projectId, input): Promise<TriageResult> {
      const body = input.body ?? '';
      const cssSelector = input.target?.cssSelector ?? '';

      // 1 + 2. Severity + tag classification are pure functions of the text.
      const suggestedSeverity = classifySeverity(body);
      const suggestedTags = suggestTags(body);

      // 3. Duplicate detection over recent OPEN annotations in this project.
      const recent = await db('annotations')
        .where({ project_id: projectId, status: 'active' })
        .orderBy('created_at', 'desc')
        .limit(DUPLICATE_SCAN_LIMIT)
        .select('id', 'body', 'pin_number');

      const duplicates = rankDuplicates(
        body,
        recent.map((r) => ({
          id: r.id,
          body: r.body ?? '',
          pinNumber: r.pin_number,
        })),
        { excludeId: input.excludeId },
      );

      // 4. Assignee suggestion: who most often resolved issues on this element.
      let suggestedAssignee: TriageResult['suggestedAssignee'] = null;
      if (cssSelector) {
        const topResolver = await db('annotations')
          .where({ project_id: projectId, status: 'resolved' })
          .whereRaw("target->>'cssSelector' = ?", [cssSelector])
          .whereNotNull('assignee_id')
          .groupBy('assignee_id')
          .orderByRaw('COUNT(*) DESC')
          .first('assignee_id');

        if (topResolver?.assignee_id) {
          const user = await db('users')
            .where({ id: topResolver.assignee_id })
            .first('id', 'email');
          if (user) {
            suggestedAssignee = {
              userId: user.id,
              email: user.email,
              reason: 'Resolved similar issues on this element before',
            };
          }
        }
      }

      return { suggestedSeverity, suggestedTags, duplicates, suggestedAssignee };
    },
  };
}
