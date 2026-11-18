// Unit tests for the updateAnnotation use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeEventBus,
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

  const eventBus = new FakeEventBus();
  const usecase = new UpdateAnnotation({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
    eventBus,
  });
  return { usecase, annotation, annotationRepo, eventBus };
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

  it('emits annotation.updated to the project room with the updated annotation', async () => {
    const { usecase, annotation, eventBus } = await seed();

    await usecase.execute({ annotationId: annotation.id, actorUserId: 'owner-1', patch: { body: 'edited' } });

    expect(eventBus.events).toHaveLength(1);
    const [evt] = eventBus.events;
    expect(evt!.type).toBe('annotation.updated');
    expect(evt!.room).toBe(`project:${annotation.projectId}`);
    expect(evt!.payload).toMatchObject({ id: annotation.id, body: 'edited' });
  });

  it('does not emit when the caller is not allowed', async () => {
    const { usecase, annotation, eventBus } = await seed();

    await usecase.execute({ annotationId: annotation.id, actorUserId: 'stranger', patch: { body: 'x' } });

    expect(eventBus.events).toHaveLength(0);
  });
});
