// Unit tests for the createCustomGuideline use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import { FakeGuidelineRepo } from '../../../__tests__/fakes/index.js';
import { CreateCustomGuideline } from '../usecases/createCustomGuideline.js';

describe('createCustomGuideline use case', () => {
  it('persists a non-default guideline credited to the caller', async () => {
    const repo = new FakeGuidelineRepo();
    const usecase = new CreateCustomGuideline({ guidelineRepo: repo });

    const result = await usecase.execute({
      userId: 'user-1',
      name: '  My Heuristic  ',
      description: '  Useful in QA  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('My Heuristic');
    expect(result.value.description).toBe('Useful in QA');
    expect(result.value.isDefault).toBe(false);
    expect(result.value.createdByUserId).toBe('user-1');
    expect(repo.guidelines.size).toBe(1);
  });

  it('returns Validation when the name is empty after trim', async () => {
    const repo = new FakeGuidelineRepo();
    const usecase = new CreateCustomGuideline({ guidelineRepo: repo });

    const result = await usecase.execute({
      userId: 'user-1',
      name: '   ',
      description: 'desc',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Validation when the description is empty after trim', async () => {
    const repo = new FakeGuidelineRepo();
    const usecase = new CreateCustomGuideline({ guidelineRepo: repo });

    const result = await usecase.execute({
      userId: 'user-1',
      name: 'name',
      description: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
