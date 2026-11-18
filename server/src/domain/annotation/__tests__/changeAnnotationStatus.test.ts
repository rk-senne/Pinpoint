// Unit tests for the changeAnnotationStatus use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeEventBus,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { ChangeAnnotationStatus } from '../usecases/changeAnnotationStatus.js';

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
  const annotation = await annotationRepo.insert({
    projectId: project.id,
    pageId: 'page-1',
    type: 'note',
    severity: 'minor',
    status: 'active',
    body: 'b',
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
  const usecase = new ChangeAnnotationStatus({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
    eventBus,
  });

  return { usecase, annotation, eventBus };
}

describe('changeAnnotationStatus use case', () => {
  it('transitions status to resolved for a project owner', async () => {
    const { usecase, annotation } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'owner-1',
      status: 'resolved',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.annotation.status).toBe('resolved');
  });

  it('returns Forbidden for a non-member', async () => {
    const { usecase, annotation } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'stranger',
      status: 'in_progress',
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
      status: 'resolved',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });

  it('emits annotation.status_changed to the project room with the previous status', async () => {
    const { usecase, annotation, eventBus } = await seed();

    await usecase.execute({ annotationId: annotation.id, actorUserId: 'owner-1', status: 'resolved' });

    expect(eventBus.events).toHaveLength(1);
    const [evt] = eventBus.events;
    expect(evt!.type).toBe('annotation.status_changed');
    expect(evt!.room).toBe(`project:${annotation.projectId}`);
    expect(evt!.payload).toMatchObject({
      id: annotation.id,
      projectId: annotation.projectId,
      status: 'resolved',
      previousStatus: 'active',
    });
  });

  it('does not emit when the status is unchanged or access is denied', async () => {
    const { usecase, annotation, eventBus } = await seed();

    await usecase.execute({ annotationId: annotation.id, actorUserId: 'owner-1', status: 'active' });
    await usecase.execute({ annotationId: annotation.id, actorUserId: 'stranger', status: 'resolved' });

    expect(eventBus.events).toHaveLength(0);
  });
});
