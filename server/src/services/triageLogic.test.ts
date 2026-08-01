import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  classifySeverity,
  suggestTags,
  jaccardSimilarity,
  trigrams,
  rankDuplicates,
  type DuplicateCandidate,
} from './triageLogic.js';

const SEVERITIES = ['critical', 'major', 'minor', 'informational'] as const;
const KNOWN_TAGS = ['mobile', 'performance', 'design', 'copy', 'accessibility', 'security'];

describe('triageLogic.classifySeverity', () => {
  it('classifies crash/error language as critical', () => {
    expect(classifySeverity('The checkout button is broken and throws a 500 error')).toBe('critical');
    expect(classifySeverity("I can't submit the form")).toBe('critical');
    expect(classifySeverity('The dashboard loads to a blank screen')).toBe('critical');
  });

  it('classifies layout defects as major', () => {
    expect(classifySeverity('The header is misaligned on this section')).toBe('major');
    expect(classifySeverity('Text is cut off in the card')).toBe('major');
    expect(classifySeverity('The price is incorrect')).toBe('major');
  });

  it('classifies cosmetic issues as minor', () => {
    expect(classifySeverity('There is a typo in the title')).toBe('minor');
    expect(classifySeverity('The spacing between rows feels off')).toBe('minor');
    expect(classifySeverity('The label font is a little small')).toBe('minor');
  });

  it('defaults to informational when no keywords match', () => {
    expect(classifySeverity('Looks great, love the new hero image')).toBe('informational');
    expect(classifySeverity('')).toBe('informational');
  });

  it('prioritises higher severity when multiple tiers match', () => {
    // "typo" (minor) + "broken" (critical) → critical wins
    expect(classifySeverity('typo here and the whole thing is broken')).toBe('critical');
  });

  it('always returns a valid severity for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(SEVERITIES).toContain(classifySeverity(s));
      }),
    );
  });
});

describe('triageLogic.suggestTags', () => {
  it('detects topical tags', () => {
    expect(suggestTags('The mobile page is slow to load')).toEqual(['mobile', 'performance']);
    expect(suggestTags('typo in the copy')).toEqual(['copy']);
    expect(suggestTags('poor color contrast hurts accessibility')).toEqual(
      ['accessibility', 'design'],
    );
    // "layout" is a design signal, so it is (correctly) included alongside others.
    expect(suggestTags('the mobile layout is slow')).toEqual(['design', 'mobile', 'performance']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(suggestTags('hello world')).toEqual([]);
  });

  it('always returns a sorted, unique subset of known tags', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const tags = suggestTags(s);
        // unique
        expect(new Set(tags).size).toBe(tags.length);
        // sorted
        expect([...tags].sort()).toEqual(tags);
        // subset of known tags
        for (const t of tags) expect(KNOWN_TAGS).toContain(t);
      }),
    );
  });
});

describe('triageLogic.jaccardSimilarity', () => {
  it('is 1 for identical non-empty strings', () => {
    expect(jaccardSimilarity('button is broken', 'button is broken')).toBe(1);
  });

  it('is 1 for strings that differ only by whitespace/case', () => {
    expect(jaccardSimilarity('Button   IS Broken', 'button is broken')).toBe(1);
  });

  it('is 0 for empty input', () => {
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardSimilarity('abc', '')).toBe(0);
  });

  it('is high for near-duplicate text and low for unrelated text', () => {
    const near = jaccardSimilarity(
      'the login button does not work',
      'the login button doesnt work',
    );
    const far = jaccardSimilarity(
      'the login button does not work',
      'please add a dark mode theme',
    );
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(0.3);
    expect(near).toBeGreaterThan(far);
  });

  it('is bounded in [0,1] and symmetric for arbitrary inputs', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = jaccardSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(jaccardSimilarity(a, b)).toBeCloseTo(jaccardSimilarity(b, a), 10);
      }),
    );
  });

  it('scores a non-empty string against itself as exactly 1', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        (s) => {
          expect(jaccardSimilarity(s, s)).toBe(1);
        },
      ),
    );
  });
});

describe('triageLogic.trigrams', () => {
  it('produces sliding character trigrams over normalized text', () => {
    expect([...trigrams('abcd')]).toEqual(['abc', 'bcd']);
  });

  it('is empty for strings shorter than 3 normalized chars', () => {
    expect(trigrams('ab').size).toBe(0);
  });
});

describe('triageLogic.rankDuplicates', () => {
  const candidates: DuplicateCandidate[] = [
    { id: 'a', body: 'the login button does not work', pinNumber: 1 },
    { id: 'b', body: 'login button is not working at all', pinNumber: 2 },
    { id: 'c', body: 'please add dark mode', pinNumber: 3 },
  ];

  it('returns matches above the threshold, highest similarity first', () => {
    const result = rankDuplicates('the login button does not work', candidates, {
      threshold: 0.3,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.id).toBe('a'); // exact match ranks first
    // descending order
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.similarity).toBeGreaterThanOrEqual(result[i]!.similarity);
    }
    // 'c' (unrelated) should not appear
    expect(result.find((m) => m.id === 'c')).toBeUndefined();
  });

  it('excludes the annotation being triaged via excludeId', () => {
    const result = rankDuplicates('the login button does not work', candidates, {
      threshold: 0.3,
      excludeId: 'a',
    });
    expect(result.find((m) => m.id === 'a')).toBeUndefined();
  });

  it('caps results at the requested limit', () => {
    const many: DuplicateCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      body: 'the login button does not work',
      pinNumber: i,
    }));
    const result = rankDuplicates('the login button does not work', many, {
      threshold: 0.3,
      limit: 2,
    });
    expect(result.length).toBe(2);
  });

  it('returns empty when nothing clears the threshold', () => {
    const result = rankDuplicates('completely unrelated feedback text', candidates, {
      threshold: 0.9,
    });
    expect(result).toEqual([]);
  });

  it('never mutates the input candidates array', () => {
    const snapshot = JSON.parse(JSON.stringify(candidates));
    rankDuplicates('the login button does not work', candidates, { threshold: 0.3 });
    expect(candidates).toEqual(snapshot);
  });

  it('honours threshold/limit invariants for arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1 }),
            body: fc.string(),
            pinNumber: fc.integer({ min: 0, max: 10000 }),
          }),
          { maxLength: 20 },
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 5 }),
        (body, cands, threshold, limit) => {
          const result = rankDuplicates(body, cands, { threshold, limit });
          expect(result.length).toBeLessThanOrEqual(limit);
          for (const m of result) {
            expect(m.similarity).toBeGreaterThan(threshold);
            expect(m.similarity).toBeGreaterThanOrEqual(0);
            expect(m.similarity).toBeLessThanOrEqual(1);
          }
          for (let i = 1; i < result.length; i++) {
            expect(result[i - 1]!.similarity).toBeGreaterThanOrEqual(result[i]!.similarity);
          }
        },
      ),
    );
  });
});
