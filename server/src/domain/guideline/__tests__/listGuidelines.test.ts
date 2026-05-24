// Unit tests for the listGuidelines use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import { FakeGuidelineRepo } from '../../../__tests__/fakes/index.js';
import { ListGuidelines } from '../usecases/listGuidelines.js';

describe('listGuidelines use case', () => {
  it('returns defaults first, then custom entries alphabetical by name', async () => {
    const repo = new FakeGuidelineRepo();
    await repo.insertMany([
      { name: 'Visibility of system status', description: 'd', isDefault: true },
      { name: 'Match between system and the real world', description: 'd', isDefault: true },
    ]);
    await repo.insert({
      name: 'Custom Beta',
      description: 'd',
      isDefault: false,
    });
    await repo.insert({
      name: 'Custom Alpha',
      description: 'd',
      isDefault: false,
    });

    const usecase = new ListGuidelines({ guidelineRepo: repo });
    const result = await usecase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((g) => g.name);
    // Defaults first.
    expect(names.slice(0, 2)).toEqual([
      'Match between system and the real world',
      'Visibility of system status',
    ]);
    // Customs alphabetical.
    expect(names.slice(2)).toEqual(['Custom Alpha', 'Custom Beta']);
  });

  it('returns an empty list when the catalogue is empty', async () => {
    const repo = new FakeGuidelineRepo();
    const usecase = new ListGuidelines({ guidelineRepo: repo });

    const result = await usecase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});
