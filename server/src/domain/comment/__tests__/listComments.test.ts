// Unit tests for the listComments use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeCommentRepo,
} from '../../../__tests__/fakes/index.js';
import { ListComments } from '../usecases/listComments.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const annotationRepo = new FakeAnnotationRepo(clock);
  const commentRepo = new FakeCommentRepo(clock);

  const annotation = await annotationRepo.insert({
    projectId: 'project-1',
    pageId: 'page-1',
    type: 'note',
    severity: 'minor',
    status: 'active',
    body: 'parent',
    authorId: 'author-1',
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

  const usecase = new ListComments({ commentRepo, annotationRepo });
  return { usecase, annotation, commentRepo, clock };
}

describe('listComments use case', () => {
  it('returns comments for an existing annotation in chronological order', async () => {
    const { usecase, annotation, commentRepo, clock } = await buildSut();

    await commentRepo.insert({
      annotationId: annotation.id,
      authorId: 'a',
      body: 'first',
      mentions: [],
    });
    clock.advance(1_000);
    await commentRepo.insert({
      annotationId: annotation.id,
      authorId: 'b',
      body: 'second',
      mentions: [],
    });

    const result = await usecase.execute({ annotationId: annotation.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments.map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('returns NotFound when the annotation does not exist', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      annotationId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
