// Unit tests for the createAnnotation use case (Phase 1.5 / task 4.11.2).
//
// Covers the happy path, idempotent replay (Req 44.3 — same
// `clientRequestId` returns the cached row without bumping the pin
// counter), the access-control reject, and the missing-project reject.

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeEventBus,
  FakePageRepo,
  FakeProjectPinSequence,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { CreateAnnotation } from '../usecases/createAnnotation.js';
import type { DOMTarget } from '../DOMTarget.js';
import type { EnvironmentMetadata } from '../EnvironmentMetadata.js';

const TARGET: DOMTarget = {
  cssSelector: 'button',
  xpath: '/html/body/button',
  pageX: 100,
  pageY: 200,
  tagName: 'button',
  textSnippet: 'Click me',
};

const ENV: EnvironmentMetadata = {
  browserFamily: 'Chrome',
  browserVersion: '120',
  osFamily: 'macOS',
  osVersion: '14',
  deviceType: 'desktop',
  userAgentRaw: 'test-ua',
};

const noopRunInTransaction = async <T>(
  fn: (tx: unknown) => Promise<T>,
): Promise<T> => fn({});

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const pageRepo = new FakePageRepo(clock);
  const annotationRepo = new FakeAnnotationRepo(clock);
  const pinSequence = new FakeProjectPinSequence();
  const eventBus = new FakeEventBus();

  const project = await projectRepo.insert({
    name: 'Project',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  const usecase = new CreateAnnotation({
    annotationRepo,
    projectRepo,
    pageRepo,
    teamMemberRepo,
    pinSequence,
    runInTransaction: noopRunInTransaction,
    clock,
    eventBus,
  });

  return {
    usecase,
    project,
    annotationRepo,
    pageRepo,
    pinSequence,
    eventBus,
  };
}

const baseInput = {
  authorUserId: 'owner-1',
  pageUrl: 'https://example.com/page',
  type: 'note' as const,
  severity: 'minor' as const,
  body: 'Looks broken',
  target: TARGET,
  environment: ENV,
};

describe('createAnnotation use case', () => {
  it('creates a page-on-the-fly, allocates pin #1, and emits annotation.created', async () => {
    const { usecase, project, annotationRepo, pageRepo, pinSequence, eventBus } =
      await buildSut();

    const result = await usecase.execute({
      ...baseInput,
      projectId: project.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.annotation.pinNumber).toBe(1);
    expect(result.value.idempotentReplay).toBe(false);
    expect(pageRepo.pages.size).toBe(1);
    expect(annotationRepo.annotations.size).toBe(1);
    expect(pinSequence.peek(project.id)).toBe(1);
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0]!.type).toBe('annotation.created');
  });

  it('returns the cached row on idempotent replay without bumping the pin counter', async () => {
    const { usecase, project, annotationRepo, pinSequence } = await buildSut();

    const first = await usecase.execute({
      ...baseInput,
      projectId: project.id,
      clientRequestId: 'req-uuid-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await usecase.execute({
      ...baseInput,
      projectId: project.id,
      clientRequestId: 'req-uuid-1',
      body: 'this body is ignored on replay',
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.idempotentReplay).toBe(true);
    expect(replay.value.annotation.id).toBe(first.value.annotation.id);
    expect(replay.value.annotation.pinNumber).toBe(1);
    // Only one annotation row exists, and the pin counter is still 1.
    expect(annotationRepo.annotations.size).toBe(1);
    expect(pinSequence.peek(project.id)).toBe(1);
  });

  it('returns Forbidden when the caller is not on the project team', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      ...baseInput,
      projectId: project.id,
      authorUserId: 'stranger',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns NotFound when the project does not exist', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      ...baseInput,
      projectId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });

  it('allocates monotonically increasing pin numbers for sequential creates', async () => {
    const { usecase, project, pinSequence } = await buildSut();

    const a = await usecase.execute({ ...baseInput, projectId: project.id });
    const b = await usecase.execute({ ...baseInput, projectId: project.id });
    const c = await usecase.execute({ ...baseInput, projectId: project.id });

    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect([
      a.value.annotation.pinNumber,
      b.value.annotation.pinNumber,
      c.value.annotation.pinNumber,
    ]).toEqual([1, 2, 3]);
    expect(pinSequence.peek(project.id)).toBe(3);
  });
});
