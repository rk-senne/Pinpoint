import { describe, it, expect, vi } from 'vitest';

import { getSuggestions, extractComponentName } from './smartSuggestions.js';

describe('extractComponentName', () => {
  it('extracts a PascalCase class', () => {
    expect(extractComponentName('.Button')).toBe('Button');
    expect(extractComponentName('nav > .Header')).toBe('Header');
  });

  it('extracts a data-component / data-testid value', () => {
    expect(extractComponentName('[data-component="Sidebar"]')).toBe('Sidebar');
    expect(extractComponentName('button[data-testid="submit-btn"]')).toBe('submit-btn');
  });

  it('falls back to the last plain class name', () => {
    expect(extractComponentName('.nav .nav-item')).toBe('nav-item');
    expect(extractComponentName('div.card > span.card-title')).toBe('card-title');
  });

  it('returns null when nothing component-like is present', () => {
    expect(extractComponentName('div > span')).toBeNull();
    expect(extractComponentName('')).toBeNull();
    expect(extractComponentName('main > article')).toBeNull();
  });
});

/**
 * Chainable Knex mock. Real query builders are both chainable *and* awaitable:
 * `.select()` returns the builder (so `.count().groupBy()...` can follow) and
 * awaiting the builder resolves to the row array; `.first()` resolves a single
 * row. So we make the builder thenable (→ arrayResult) and keep `.select()`
 * chainable, while `.first()` returns the single-row promise.
 */
function chain(arrayResult: unknown, singleResult: unknown): any {
  const b: any = {};
  for (const m of [
    'where',
    'whereRaw',
    'whereNot',
    'whereNotNull',
    'orderBy',
    'limit',
    'groupBy',
    'count',
    'select',
  ]) {
    b[m] = () => b;
  }
  b.first = () => Promise.resolve(singleResult);
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(arrayResult).then(res, rej);
  return b;
}

interface MockDbOpts {
  annotation?: Record<string, unknown>;
  pastFixes?: Array<Record<string, unknown>>;
  topResolver?: { assignee_id: string; count: number } | undefined;
  user?: { id: string; email: string } | undefined;
}

function makeDb(opts: MockDbOpts): any {
  const { annotation, pastFixes = [], topResolver, user } = opts;
  let annCall = 0;
  return vi.fn((table: string) => {
    if (table === 'users') {
      return chain([], user);
    }
    // 'annotations' is queried three times: by-id (first), past-fixes
    // (awaited array), top-resolver (first).
    annCall += 1;
    const single = annCall === 1 ? annotation : topResolver;
    return chain(pastFixes, single);
  });
}

describe('getSuggestions', () => {
  it('returns [] when the annotation is not found', async () => {
    const db = makeDb({ annotation: undefined });
    expect(await getSuggestions(db, 'missing')).toEqual([]);
  });

  it('suggests a component from the selector (target as JSON string)', async () => {
    const db = makeDb({
      annotation: { project_id: 'p1', target: JSON.stringify({ cssSelector: '.Button' }) },
    });
    const result = await getSuggestions(db, 'a1');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'related_component', title: 'Likely component: Button' });
  });

  it('handles target already parsed as an object', async () => {
    const db = makeDb({ annotation: { project_id: 'p1', target: { cssSelector: '.Card' } } });
    const result = await getSuggestions(db, 'a1');
    expect(result[0]).toMatchObject({ title: 'Likely component: Card' });
  });

  it('combines past-fix, component, and assignee, sorted by confidence', async () => {
    const db = makeDb({
      annotation: { project_id: 'p1', target: { cssSelector: '.nav-item' } },
      pastFixes: [
        { id: 'old1', body: 'fixed the nav alignment', assignee_id: 'u1', updated_at: 'x' },
      ],
      topResolver: { assignee_id: 'u1', count: 3 },
      user: { id: 'u1', email: 'dev@example.com' },
    });
    const result = await getSuggestions(db, 'a1');
    // past_fix (0.7) > related_component (0.6) > assignee (0.5)
    expect(result.map((r) => r.type)).toEqual(['past_fix', 'related_component', 'assignee']);
    expect(result[0]!.detail).toBe('fixed the nav alignment');
    expect(result[2]!.title).toBe('Suggest assigning to dev@example.com');
  });

  it('emits no component suggestion when the selector is non-component-like', async () => {
    const db = makeDb({ annotation: { project_id: 'p1', target: { cssSelector: 'div > span' } } });
    const result = await getSuggestions(db, 'a1');
    expect(result.find((r) => r.type === 'related_component')).toBeUndefined();
  });
});
