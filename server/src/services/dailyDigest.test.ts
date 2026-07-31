import { describe, it, expect, vi } from 'vitest';

import { generateDailyDigest } from './dailyDigest.js';

/**
 * Chainable + thenable Knex mock matching the pattern in smartSuggestions.test.ts.
 * Captures raw SQL fragments so we can assert the correct JSONB field is referenced.
 */
function makeMockDb(opts: {
  stats?: Record<string, unknown>;
  contributors?: Array<Record<string, unknown>>;
  hotspots?: Array<Record<string, unknown>>;
}) {
  const rawCalls: string[] = [];
  let queryIndex = 0;

  const results = [opts.stats ?? {}, opts.contributors ?? [], opts.hotspots ?? []];

  function chain(resolvedValue: unknown, isSingle: boolean): any {
    const b: any = {};
    for (const m of [
      'where',
      'whereNot',
      'whereNotNull',
      'whereRaw',
      'join',
      'groupBy',
      'orderBy',
      'orderByRaw',
      'limit',
      'select',
    ]) {
      b[m] = (..._args: unknown[]) => b;
    }
    b.groupByRaw = (...args: unknown[]) => {
      if (typeof args[0] === 'string') rawCalls.push(args[0]);
      return b;
    };
    b.first = () => Promise.resolve(isSingle ? resolvedValue : undefined);
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolvedValue).then(res, rej);
    return b;
  }

  const db: any = vi.fn((_table: string) => {
    const idx = queryIndex++;
    const value = results[idx];
    const isSingle = idx === 0; // stats query uses .first()
    return chain(value, isSingle);
  });

  db.raw = (sql: string) => {
    rawCalls.push(sql);
    return sql;
  };

  return { db, rawCalls };
}

describe('generateDailyDigest', () => {
  it('queries target->>cssSelector (not selector) for hotspots', async () => {
    const { db, rawCalls } = makeMockDb({
      stats: { new_count: 5, resolved_count: 3, avg_hours: 2.5 },
      contributors: [{ email: 'dev@example.com', count: 3 }],
      hotspots: [{ selector: '.Header', count: 4 }],
    });

    const result = await generateDailyDigest(db, 'org-1');

    // Verify the raw SQL references the canonical DOMTarget field 'cssSelector'
    const selectorRaws = rawCalls.filter((s) => s.includes('cssSelector'));
    expect(selectorRaws.length).toBeGreaterThanOrEqual(2); // SELECT and GROUP BY

    // Must NOT reference the wrong field name 'selector' (as a JSONB key)
    const wrongField = rawCalls.filter(
      (s) => s.includes("->>'selector'") && !s.includes("->>'cssSelector'"),
    );
    expect(wrongField).toHaveLength(0);

    // Verify the result is well-formed
    expect(result.hotspots).toEqual([{ selector: '.Header', count: 4 }]);
    expect(result.newAnnotations).toBe(5);
    expect(result.resolved).toBe(3);
    expect(result.avgResolutionHours).toBe(2.5);
  });

  it('handles empty hotspots gracefully', async () => {
    const { db } = makeMockDb({
      stats: { new_count: 0, resolved_count: 0, avg_hours: null },
      contributors: [],
      hotspots: [],
    });

    const result = await generateDailyDigest(db, 'org-1');

    expect(result.hotspots).toEqual([]);
    expect(result.newAnnotations).toBe(0);
    expect(result.insight).toContain('0 feedback items');
  });

  it('insight references the first hotspot selector when present', async () => {
    const { db } = makeMockDb({
      stats: { new_count: 10, resolved_count: 2, avg_hours: 4.0 },
      contributors: [],
      hotspots: [{ selector: '.Card', count: 6 }],
    });

    const result = await generateDailyDigest(db, 'org-1');

    expect(result.insight).toContain('.Card');
  });
});
