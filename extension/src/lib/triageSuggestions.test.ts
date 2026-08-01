import { describe, it, expect } from 'vitest';

import { formatTriageHint, DUPLICATE_DISPLAY_THRESHOLD } from './triageSuggestions';
import type { TriageSuggestions } from './api';

function make(overrides: Partial<TriageSuggestions> = {}): TriageSuggestions {
  return {
    suggestedSeverity: 'informational',
    suggestedTags: [],
    duplicates: [],
    suggestedAssignee: null,
    ...overrides,
  };
}

describe('formatTriageHint', () => {
  it('returns empty, hidden hint for null/undefined', () => {
    for (const s of [null, undefined]) {
      const hint = formatTriageHint(s);
      expect(hint.hasContent).toBe(false);
      expect(hint.duplicateHint).toBe('');
      expect(hint.severityHint).toBe('');
      expect(hint.tagsHint).toBe('');
    }
  });

  it('hides everything for the informational default with no dupes/tags', () => {
    const hint = formatTriageHint(make());
    expect(hint.hasContent).toBe(false);
    expect(hint.severityHint).toBe('');
  });

  it('surfaces a non-default severity', () => {
    const hint = formatTriageHint(make({ suggestedSeverity: 'critical' }));
    expect(hint.severityHint).toBe('Suggested severity: Critical');
    expect(hint.hasContent).toBe(true);
  });

  it('formats a single duplicate above the threshold', () => {
    const hint = formatTriageHint(
      make({ duplicates: [{ id: 'a', body: 'x', pinNumber: 12, similarity: 0.9 }] }),
    );
    expect(hint.duplicateHint).toBe('Possible duplicate of #12');
    expect(hint.hasContent).toBe(true);
  });

  it('formats multiple duplicates and caps at 3', () => {
    const hint = formatTriageHint(
      make({
        duplicates: [
          { id: 'a', body: 'x', pinNumber: 12, similarity: 0.95 },
          { id: 'b', body: 'y', pinNumber: 7, similarity: 0.85 },
          { id: 'c', body: 'z', pinNumber: 4, similarity: 0.8 },
          { id: 'd', body: 'w', pinNumber: 2, similarity: 0.75 },
        ],
      }),
    );
    expect(hint.duplicateHint).toBe('Possible duplicates of #12, #7, #4');
  });

  it('ignores duplicates below the display threshold', () => {
    const hint = formatTriageHint(
      make({
        suggestedSeverity: 'informational',
        duplicates: [
          { id: 'a', body: 'x', pinNumber: 12, similarity: DUPLICATE_DISPLAY_THRESHOLD - 0.01 },
        ],
      }),
    );
    expect(hint.duplicateHint).toBe('');
    expect(hint.hasContent).toBe(false);
  });

  it('formats suggested tags', () => {
    const hint = formatTriageHint(make({ suggestedTags: ['mobile', 'performance'] }));
    expect(hint.tagsHint).toBe('Suggested tags: mobile, performance');
    expect(hint.hasContent).toBe(true);
  });

  it('combines duplicate + severity + tags', () => {
    const hint = formatTriageHint(
      make({
        suggestedSeverity: 'major',
        suggestedTags: ['design'],
        duplicates: [{ id: 'a', body: 'x', pinNumber: 3, similarity: 0.8 }],
      }),
    );
    expect(hint.hasContent).toBe(true);
    expect(hint.duplicateHint).toBe('Possible duplicate of #3');
    expect(hint.severityHint).toBe('Suggested severity: Major');
    expect(hint.tagsHint).toBe('Suggested tags: design');
  });
});
