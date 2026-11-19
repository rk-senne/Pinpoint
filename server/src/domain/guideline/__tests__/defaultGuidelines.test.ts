import { describe, it, expect } from 'vitest';

import { DEFAULT_GUIDELINES } from '../DEFAULT_GUIDELINES.js';
import { FakeGuidelineRepo } from '../../../__tests__/fakes/FakeGuidelineRepo.js';

describe('DEFAULT_GUIDELINES (GAP 1)', () => {
  it('exports exactly 10 Nielsen heuristics, all isDefault', () => {
    expect(DEFAULT_GUIDELINES).toHaveLength(10);
    for (const g of DEFAULT_GUIDELINES) {
      expect(g.isDefault).toBe(true);
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(0);
    }
  });

  it('has unique guideline names', () => {
    const names = new Set(DEFAULT_GUIDELINES.map((g) => g.name));
    expect(names.size).toBe(DEFAULT_GUIDELINES.length);
  });

  it('seeds once and is idempotent across restarts (hasDefaults/insertMany)', async () => {
    const repo = new FakeGuidelineRepo();

    // Simulated boot #1: no defaults yet → seed.
    if (!(await repo.hasDefaults())) {
      await repo.insertMany([...DEFAULT_GUIDELINES]);
    }
    expect((await repo.list('org-1')).filter((g) => g.isDefault)).toHaveLength(10);

    // Simulated boot #2: defaults present → skip, no duplicates.
    if (!(await repo.hasDefaults())) {
      await repo.insertMany([...DEFAULT_GUIDELINES]);
    }
    expect((await repo.list('org-1')).filter((g) => g.isDefault)).toHaveLength(10);
  });
});
