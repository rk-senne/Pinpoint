// Unit tests for the attachScreenshot use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeProjectRepo,
  FakeScreenshotStore,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { AttachScreenshot } from '../usecases/attachScreenshot.js';

async function seed() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const annotationRepo = new FakeAnnotationRepo(clock);
  const screenshotStore = new FakeScreenshotStore();

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

  const usecase = new AttachScreenshot({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
    screenshotStore,
  });

  return { usecase, annotation, annotationRepo, screenshotStore };
}

describe('attachScreenshot use case', () => {
  it('uploads the PNG and links the object key to the annotation', async () => {
    const { usecase, annotation, annotationRepo, screenshotStore } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'owner-1',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.screenshotObjectKey.length).toBeGreaterThan(0);
    expect(screenshotStore.objects.has(result.value.screenshotObjectKey)).toBe(true);
    expect(annotationRepo.annotations.get(annotation.id)?.screenshotObjectKey).toBe(
      result.value.screenshotObjectKey,
    );
  });

  it('also persists a markup document when supplied', async () => {
    const { usecase, annotation, screenshotStore } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'owner-1',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      markupDocument: { shapes: [], version: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markupObjectKey).toBeTruthy();
    expect(screenshotStore.objects.has(result.value.markupObjectKey!)).toBe(true);
  });

  it('returns Forbidden for a stranger', async () => {
    const { usecase, annotation } = await seed();

    const result = await usecase.execute({
      annotationId: annotation.id,
      actorUserId: 'stranger',
      body: Buffer.from([0]),
      contentType: 'image/png',
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
      body: Buffer.from([0]),
      contentType: 'image/png',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
