import { describe, expect, it } from 'vitest';
import { summarizeAnalytics } from './analyticsSummary';

describe('summarizeAnalytics', () => {
  it('lists the total, critical count and non-zero status buckets', () => {
    const chips = summarizeAnalytics({
      total: 7,
      bySeverity: { critical: 1, major: 2, minor: 3, informational: 1 },
      byStatus: { active: 3, in_progress: 2, resolved: 2 },
    });
    expect(chips.map((c) => c.label)).toEqual([
      '7 annotations',
      '1 critical',
      '3 open',
      '2 in progress',
      '2 resolved',
    ]);
    expect(chips[1]?.tone).toBe('critical');
  });

  it('omits zero buckets and singularises one annotation', () => {
    const chips = summarizeAnalytics({
      total: 1,
      bySeverity: { critical: 0 },
      byStatus: { active: 1, in_progress: 0, resolved: 0 },
    });
    expect(chips.map((c) => c.label)).toEqual(['1 annotation', '1 open']);
  });

  it('handles an empty project', () => {
    expect(summarizeAnalytics({ total: 0, bySeverity: {}, byStatus: {} })).toEqual([
      { label: '0 annotations' },
    ]);
  });
});
