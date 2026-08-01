/**
 * suggestionsFormat — pure formatting for the dashboard's annotation
 * "AI suggestions" panel. Flattens the `GET /annotations/:id/suggestions`
 * response (AI triage + smart suggestions) into an ordered list of display
 * items. No DOM, no network — unit-tested in isolation.
 */
import type { AnnotationSuggestionsResponse } from './api';

export type SuggestionKind =
  | 'duplicate'
  | 'severity'
  | 'tags'
  | 'past_fix'
  | 'related_component'
  | 'assignee';

export interface SuggestionItem {
  kind: SuggestionKind;
  text: string;
}

export interface SuggestionsPanelModel {
  hasContent: boolean;
  items: SuggestionItem[];
}

/** Only surface a duplicate when similarity is at least this high. */
export const DUPLICATE_DISPLAY_THRESHOLD = 0.7;

/** Cap the number of duplicate rows shown. */
export const MAX_DUPLICATES_SHOWN = 3;

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  informational: 'Informational',
};

/**
 * Build the ordered panel model. Deterministic and side-effect free.
 *
 * Order: duplicates → suggested severity → suggested tags → smart
 * suggestions (past fixes, component, assignee). The `informational`
 * severity is treated as "no signal" and omitted.
 */
export function buildSuggestionsPanel(
  data: AnnotationSuggestionsResponse | null | undefined,
): SuggestionsPanelModel {
  const items: SuggestionItem[] = [];
  if (!data) return { hasContent: false, items };

  const triage = data.triage;
  if (triage) {
    const dupes = (triage.duplicates ?? [])
      .filter((d) => d.similarity >= DUPLICATE_DISPLAY_THRESHOLD)
      .slice(0, MAX_DUPLICATES_SHOWN);
    for (const d of dupes) {
      const snippet = (d.body ?? '').trim().slice(0, 60);
      items.push({
        kind: 'duplicate',
        text: `Possible duplicate of #${d.pinNumber}${snippet ? `: ${snippet}` : ''}`,
      });
    }

    if (triage.suggestedSeverity && triage.suggestedSeverity !== 'informational') {
      const label = SEVERITY_LABELS[triage.suggestedSeverity] ?? triage.suggestedSeverity;
      items.push({ kind: 'severity', text: `Suggested severity: ${label}` });
    }

    if ((triage.suggestedTags ?? []).length > 0) {
      items.push({ kind: 'tags', text: `Suggested tags: ${triage.suggestedTags.join(', ')}` });
    }
  }

  for (const s of data.suggestions ?? []) {
    items.push({
      kind: s.type,
      text: s.detail ? `${s.title} — ${s.detail}` : s.title,
    });
  }

  return { hasContent: items.length > 0, items };
}
