/**
 * triageSuggestions — pure formatting for AI triage hints shown in the
 * feedback popover. No DOM, no network: takes the {@link TriageSuggestions}
 * payload from the API and produces short, display-ready strings. Kept
 * separate from the Popover Web Component so the presentation rules are
 * unit-testable in isolation.
 */
import type { TriageSuggestions } from './api';

export interface TriageHint {
  /**
   * Whether there's a *meaningful* signal worth surfacing. The default
   * `informational` severity with no duplicates/tags is treated as "no
   * signal" so the hint stays hidden until triage finds something useful.
   */
  hasContent: boolean;
  /** e.g. "Possible duplicate of #12" or "Possible duplicates of #12, #7". */
  duplicateHint: string;
  /** e.g. "Suggested severity: Critical" — empty for the informational default. */
  severityHint: string;
  /** e.g. "Suggested tags: mobile, performance" — empty when none. */
  tagsHint: string;
}

const SEVERITY_LABELS: Record<TriageSuggestions['suggestedSeverity'], string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  informational: 'Informational',
};

/** Only surface a duplicate when the similarity is at least this high. */
export const DUPLICATE_DISPLAY_THRESHOLD = 0.7;

/** Cap how many duplicate pin numbers are listed in the hint. */
export const MAX_DUPLICATES_SHOWN = 3;

const EMPTY: TriageHint = {
  hasContent: false,
  duplicateHint: '',
  severityHint: '',
  tagsHint: '',
};

/**
 * Build display-ready triage hints. Deterministic and side-effect free.
 *
 * Rules:
 *  - Duplicates below {@link DUPLICATE_DISPLAY_THRESHOLD} are ignored.
 *  - The `informational` severity is the "no signal" default and is not
 *    surfaced (avoids nagging on every keystroke).
 *  - `hasContent` is true only when there's a duplicate, a non-default
 *    severity, or at least one tag.
 */
export function formatTriageHint(
  suggestions: TriageSuggestions | null | undefined,
): TriageHint {
  if (!suggestions) return EMPTY;

  const strongDuplicates = (suggestions.duplicates ?? [])
    .filter((d) => d.similarity >= DUPLICATE_DISPLAY_THRESHOLD)
    .slice(0, MAX_DUPLICATES_SHOWN);

  let duplicateHint = '';
  if (strongDuplicates.length === 1) {
    duplicateHint = `Possible duplicate of #${strongDuplicates[0]!.pinNumber}`;
  } else if (strongDuplicates.length > 1) {
    const pins = strongDuplicates.map((d) => `#${d.pinNumber}`).join(', ');
    duplicateHint = `Possible duplicates of ${pins}`;
  }

  const severity = suggestions.suggestedSeverity;
  const severityHint =
    severity && severity !== 'informational'
      ? `Suggested severity: ${SEVERITY_LABELS[severity] ?? severity}`
      : '';

  const tags = suggestions.suggestedTags ?? [];
  const tagsHint = tags.length > 0 ? `Suggested tags: ${tags.join(', ')}` : '';

  return {
    hasContent: Boolean(duplicateHint || severityHint || tagsHint),
    duplicateHint,
    severityHint,
    tagsHint,
  };
}
