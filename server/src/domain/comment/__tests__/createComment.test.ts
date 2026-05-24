// Unit tests for the createComment use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeCommentRepo,
  FakeEventBus,
} from '../../../__tests__/fakes/index.js';
import { CreateComment } from '../usecases/createComment.js';

const TARGET = {
  cssSelector: 'body',
  xpath: '/html/body',
  pageX: 0,
  pageY: 0,
  tagName: 'body',
  textSnippet: '',
};
const ENV = {
  browserFamily: 'Chrome' as const,
  browserVersion: '120',
  osFamily: 'macOS' as const,
  osVersion: '14',
  deviceType: 'desktop' as const,
  userAgentRaw: 'test-ua',
};

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const annotationRepo = new FakeAnnotationRepo(clock);
  const commentRepo = new FakeCommentRepo(clock);
  const eventBus = new FakeEventBus();

  const annotation = await annotationRepo.insert({
    projectId: 'project-1',
    pageId: 'page-1',
    type: 'note',
    severity: 'minor',
    status: 'active',
    body: 'parent',
    authorId: 'author-1',
    target: TARGET,
    environment: ENV,
    pinNumber: 1,
  });

  const usecase = new CreateComment({ commentRepo, annotationRepo, eventBus });
  return { usecase, annotation, commentRepo, eventBus };
}

describe('createComment use case', () => {
  it('persists the comment, extracts mentions from the body, and emits comment.created', async () => {
    const { usecase, annotation, commentRepo, eventBus } = await buildSut();

    const mentionedId = '11111111-1111-1111-1111-111111111111';
    const result = await usecase.execute({
      authorUserId: 'author-2',
      annotationId: annotation.id,
      body: `Hey @${mentionedId} take a look`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comment.mentions).toEqual([mentionedId]);
    expect(commentRepo.comments.size).toBe(1);
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0]!.type).toBe('comment.created');
  });

  it('returns the cached row on idempotent replay', async () => {
    const { usecase, annotation, commentRepo } = await buildSut();
    const requestId = '22222222-2222-2222-2222-222222222222';

    const first = await usecase.execute({
      authorUserId: 'author-2',
      annotationId: annotation.id,
      body: 'first',
      clientRequestId: requestId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await usecase.execute({
      authorUserId: 'author-2',
      annotationId: annotation.id,
      body: 'this body is ignored',
      clientRequestId: requestId,
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.idempotentReplay).toBe(true);
    expect(replay.value.comment.id).toBe(first.value.comment.id);
    expect(commentRepo.comments.size).toBe(1);
  });

  it('returns NotFound when the annotation is missing', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      authorUserId: 'author-2',
      annotationId: '00000000-0000-0000-0000-000000000000',
      body: 'hi',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });

  it('returns Validation when the body is empty after trim', async () => {
    const { usecase, annotation } = await buildSut();

    const result = await usecase.execute({
      authorUserId: 'author-2',
      annotationId: annotation.id,
      body: '   ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
