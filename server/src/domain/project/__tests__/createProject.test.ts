// Unit tests for the createProject use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakePageRepo,
  FakeProjectRepo,
} from '../../../__tests__/fakes/index.js';
import { CreateProject } from '../usecases/createProject.js';

const noopRunInTransaction = async <T>(
  fn: (tx: unknown) => Promise<T>,
): Promise<T> => fn({});

function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const projectRepo = new FakeProjectRepo({ clock });
  const pageRepo = new FakePageRepo(clock);

  const usecase = new CreateProject({
    projectRepo,
    pageRepo,
    runInTransaction: noopRunInTransaction,
  });
  return { usecase, projectRepo, pageRepo };
}

describe('createProject use case', () => {
  it('persists the project and seeds one page per unique URL', async () => {
    const { usecase, projectRepo, pageRepo } = buildSut();

    const result = await usecase.execute({
      ownerUserId: 'user-1',
      name: 'My Project',
      urls: ['https://example.com', '  https://example.com  ', 'https://other.test'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(projectRepo.projects.size).toBe(1);
    // Duplicates should be collapsed.
    expect(result.value.pages).toHaveLength(2);
    expect(pageRepo.pages.size).toBe(2);
  });

  it('returns Validation when the name is empty after trim', async () => {
    const { usecase } = buildSut();

    const result = await usecase.execute({
      ownerUserId: 'user-1',
      name: '   ',
      urls: ['https://example.com'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Validation when no URLs are supplied', async () => {
    const { usecase } = buildSut();

    const result = await usecase.execute({
      ownerUserId: 'user-1',
      name: 'My Project',
      urls: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
