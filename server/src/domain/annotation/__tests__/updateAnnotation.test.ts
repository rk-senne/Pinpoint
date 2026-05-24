// Unit tests for the updateAnnotation use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { UpdateAnnotation } from '../usecases/updateAnnotation.js';
import type { Annotation } from '../Annotation.js';

async function seed() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const annotationRepo = new FakeAnnotationRepo(clock);

  const project = await projectRepo.insert({
    name: 'P',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  const annotation: Annotation = await annotationRepo.insert({
    projectId: project.id,
    pageId: 'page-1',
    type: 'note',
    severity: 'minor',
    status: 'active',
    body: 'original',
    authorId: 'owner-1',
    target: {
      cssSelector: 'body',
      xpath: '/html/body',
      pageX: 0,
      pageY: 0,
      tagName: 'body',
      textSnippet: '',
    },
    environment: {
      browserFamily: 'Chrome',
      browserVersion: '120',
      osFamily: 'macOS',
      osVersion: '14',
      deviceType: 'desktop',
      userAgentRaw: 'test-ua',
    },
    pinNumber: 1,
  });

  const usecase = new UpdateAnnotation({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
  });
  return { usecase, annotation, annotationRepo };
}

describe('updateAnnotation use case', () => {
  it('applies a body patch for a project-owner caller', async () => {
    const { usecase, annotation, annotationRepo } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'owner-1',
      patch: { body: 'updated body' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.annotation.body).toBe('updated body');
    expect(annotationRepo.annotations.get(annotation.id)?.body).toBe('updated body');
  });

  it('returns Forbidden for a non-member caller', async () => {
    const { usecase, annotation } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'stranger',
      patch: { body: 'updated body' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns NotFound when the annotation is missing', async () => {
    const { usecase } = await seed();

    const result = await usecase.execute({
      annotationId: '00000000-0000-0000-0000-000000000000',
      actorUserId: 'owner-1',
      patch: { body: 'x' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });

  it('returns Validation when the patch is empty', async () => {
    const { usecase, annotation } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'owner-1',
      patch: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
