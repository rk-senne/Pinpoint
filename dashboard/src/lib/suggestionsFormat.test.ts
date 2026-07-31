import { describe, it, expect } from 'vitest';

import { buildSuggestionsPanel, DUPLICATE_DISPLAY_THRESHOLD } from './suggestionsFormat';
import type { AnnotationSuggestionsResponse } from './api';

function make(overrides: Partial<AnnotationSuggestionsResponse> = {}): AnnotationSuggestionsResponse {
  return {
    triage: {
      suggestedSeverity: 'informational',
      suggestedTags: [],
      duplicates: [],
      suggestedAssignee: null,
      ...(overrides.triage ?? {}),
    },
    suggestions: overrides.suggestions ?? [],
  };
}

describe('buildSuggestionsPanel', () => {
  it('returns empty for null', () => {
    expect(buildSuggestionsPanel(null)).toEqual({ hasContent: false, items: [] });
  });

  it('hides the informational default with no dupes/tags/suggestions', () => {
    const model = buildSuggestionsPanel(make());
    expect(model.hasContent).toBe(false);
    expect(model.items).toEqual([]);
  });

  it('lists strong duplicates with a body snippet, capped at 3', () => {
    const model = buildSuggestionsPanel(
      make({
        triage: {
          suggestedSeverity: 'informational',
          suggestedTags: [],
          suggestedAssignee: null,
          duplicates: [
            { id: '1', body: 'the login button is broken', pinNumber: 12, similarity: 0.95 },
            { id: '2', body: 'login btn broken', pinNumber: 7, similarity: 0.8 },
            { id: '3', body: 'x', pinNumber: 4, similarity: 0.72 },
            { id: '4', body: 'y', pinNumber: 2, similarity: 0.71 },
          ],
        },
      }),
    );
    const dupes = model.items.filter((i) => i.kind === 'duplicate');
    expect(dupes).toHaveLength(3);
    expect(dupes[0]!.text).toBe('Possible duplicate of #12: the login button is broken');
  });

  it('ignores duplicates below the threshold', () => {
    const model = buildSuggestionsPanel(
      make({
        triage: {
          suggestedSeverity: 'informational',
          suggestedTags: [],
          suggestedAssignee: null,
          duplicates: [{ id: '1', body: 'x', pinNumber: 12, similarity: DUPLICATE_DISPLAY_THRESHOLD - 0.01 }],
        },
      }),
    );
    expect(model.items.filter((i) => i.kind === 'duplicate')).toHaveLength(0);
  });

  it('surfaces non-default severity and tags', () => {
    const model = buildSuggestionsPanel(
      make({
        triage: {
          suggestedSeverity: 'critical',
          suggestedTags: ['mobile', 'performance'],
          duplicates: [],
          suggestedAssignee: null,
        },
      }),
    );
    expect(model.items).toContainEqual({ kind: 'severity', text: 'Suggested severity: Critical' });
    expect(model.items).toContainEqual({ kind: 'tags', text: 'Suggested tags: mobile, performance' });
  });

  it('maps smart suggestions with title + detail', () => {
    const model = buildSuggestionsPanel(
      make({
        suggestions: [
          { type: 'related_component', title: 'Likely component: Button', detail: 'Check Button.tsx', confidence: 0.6 },
          { type: 'assignee', title: 'Suggest assigning to dev@x.com', detail: 'Resolved 3 issue(s)', confidence: 0.5 },
        ],
      }),
    );
    expect(model.items).toContainEqual({
      kind: 'related_component',
      text: 'Likely component: Button — Check Button.tsx',
    });
    expect(model.items.find((i) => i.kind === 'assignee')?.text).toContain('dev@x.com');
    expect(model.hasContent).toBe(true);
  });

  it('orders triage before smart suggestions', () => {
    const model = buildSuggestionsPanel(
      make({
        triage: {
          suggestedSeverity: 'major',
          suggestedTags: ['design'],
          duplicates: [{ id: '1', body: 'dupe', pinNumber: 9, similarity: 0.9 }],
          suggestedAssignee: null,
        },
        suggestions: [
          { type: 'past_fix', title: 'Similar issue resolved', detail: 'fixed it', confidence: 0.7 },
        ],
      }),
    );
    expect(model.items.map((i) => i.kind)).toEqual(['duplicate', 'severity', 'tags', 'past_fix']);
  });
});
